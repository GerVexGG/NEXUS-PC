use qrcode::{Color, QrCode};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug)]
pub struct DropSessionInfo {
    pub is_running: bool,
    pub local_ip: String,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub save_dir: String,
    pub qr_svg: String,
    pub transfer: Option<DropTransfer>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DropTransfer {
    pub filename: String,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: f64,
}

struct LiveTransfer {
    filename: String,
    received_bytes: u64,
    total_bytes: u64,
    speed_bps: f64,
    sample_bytes: u64,
    sample_at: Instant,
}

#[derive(Serialize, Clone, Debug)]
pub struct DroppedFileItem {
    pub id: String,
    pub filename: String,
    pub size_bytes: u64,
    pub received_at: String,
    pub status: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DropTextItem {
    pub id: String,
    pub body: String,
    pub received_at: String,
}

struct DropInner {
    running: bool,
    info: DropSessionInfo,
    files: Vec<DroppedFileItem>,
    texts: Vec<DropTextItem>,
    transfer: Option<LiveTransfer>,
}

struct DropHubInner {
    inner: Mutex<DropInner>,
    shutdown: AtomicBool,
    alive: AtomicBool,
    generation: AtomicU64,
    seq: AtomicU64,
}

pub struct DropHub {
    shared: Arc<DropHubInner>,
}

impl Drop for DropHub {
    fn drop(&mut self) {
        let _ = self.stop();
        self.wait_until_stopped();
    }
}

impl DropHub {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(DropHubInner {
                inner: Mutex::new(DropInner {
                    running: false,
                    info: idle_info(),
                    files: Vec::new(),
                    texts: Vec::new(),
                    transfer: None,
                }),
                shutdown: AtomicBool::new(true),
                alive: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                seq: AtomicU64::new(1),
            }),
        }
    }

    pub fn session(&self) -> DropSessionInfo {
        self.shared
            .inner
            .lock()
            .map(|guard| {
                let mut info = guard.info.clone();
                info.transfer = guard.transfer.as_ref().map(|item| DropTransfer {
                    filename: item.filename.clone(),
                    received_bytes: item.received_bytes,
                    total_bytes: item.total_bytes,
                    speed_bps: item.speed_bps,
                });
                info
            })
            .unwrap_or_else(|_| idle_info())
    }

    pub fn history(&self) -> Vec<DroppedFileItem> {
        self.shared
            .inner
            .lock()
            .map(|guard| guard.files.clone())
            .unwrap_or_default()
    }

    pub fn texts(&self) -> Vec<DropTextItem> {
        self.shared
            .inner
            .lock()
            .map(|guard| guard.texts.clone())
            .unwrap_or_default()
    }

    pub fn open_folder(&self) -> Result<(), String> {
        let dir = self
            .shared
            .inner
            .lock()
            .map(|guard| {
                if guard.info.save_dir.is_empty() {
                    default_save_dir().display().to_string()
                } else {
                    guard.info.save_dir.clone()
                }
            })
            .unwrap_or_else(|_| default_save_dir().display().to_string());
        let path = PathBuf::from(&dir);
        fs::create_dir_all(&path).map_err(|err| format!("Не удалось создать папку: {err}"))?;
        open_in_explorer(&path)
    }

    pub fn start(&self) -> Result<DropSessionInfo, String> {
        if let Ok(guard) = self.shared.inner.lock() {
            if guard.running {
                return Ok(guard.info.clone());
            }
        }
        self.stop()?;
        self.wait_until_stopped();

        let save_dir = default_save_dir();
        fs::create_dir_all(&save_dir).map_err(|err| format!("Не удалось создать папку загрузок: {err}"))?;
        let ip = detect_local_ipv4();
        let token = random_token();
        let listener = bind_listener()?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("Не удалось узнать порт: {err}"))?
            .port();
        let url = format!("http://{ip}:{port}/?token={token}");
        let qr_svg = render_qr_svg(&url)?;
        let info = DropSessionInfo {
            is_running: true,
            local_ip: ip,
            port,
            token: token.clone(),
            url,
            save_dir: save_dir.display().to_string(),
            qr_svg,
            transfer: None,
        };

        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.shutdown.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.shared.inner.lock() {
            guard.running = true;
            guard.info = info.clone();
        }

        let shared = Arc::clone(&self.shared);
        std::thread::Builder::new()
            .name("nexus-drop".into())
            .spawn(move || {
                shared.alive.store(true, Ordering::SeqCst);
                serve(listener, generation, &shared);
                shared.alive.store(false, Ordering::SeqCst);
            })
            .map_err(|err| format!("Не удалось запустить поток приёма: {err}"))?;

        Ok(info)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.shared.inner.lock() {
            guard.running = false;
            guard.info.is_running = false;
            guard.info.token.clear();
            guard.info.url.clear();
            guard.info.qr_svg.clear();
            guard.info.transfer = None;
            guard.transfer = None;
        }
        Ok(())
    }

    fn wait_until_stopped(&self) {
        for _ in 0..40 {
            if !self.shared.alive.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn serve(listener: TcpListener, generation: u64, hub: &DropHubInner) {
    let _ = listener.set_nonblocking(true);
    loop {
        if hub.shutdown.load(Ordering::SeqCst) || hub.generation.load(Ordering::SeqCst) != generation {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = handle_client(stream, generation, hub);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => break,
        }
    }
    drop(listener);
    if hub.generation.load(Ordering::SeqCst) == generation {
        if let Ok(mut guard) = hub.inner.lock() {
            guard.running = false;
            guard.info.is_running = false;
            guard.transfer = None;
            guard.info.transfer = None;
        }
    }
}

const BODY_CHUNK: usize = 128 * 1024;
const READ_WAIT: Duration = Duration::from_secs(60);
const MAX_UPLOAD: u64 = 200_000_000;

fn handle_client(mut stream: TcpStream, generation: u64, hub: &DropHubInner) -> Result<(), ()> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(READ_WAIT));
    let _ = stream.set_write_timeout(Some(READ_WAIT));

    let (headers, pending) = match read_headers(&mut stream) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    let request_line = headers.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let token = query_param(target, "token").unwrap_or_default();
    let path = target.split('?').next().unwrap_or("/");
    let stopped = hub.shutdown.load(Ordering::SeqCst) || hub.generation.load(Ordering::SeqCst) != generation;

    if method == "GET" && (path == "/" || path.is_empty()) {
        if stopped || !session_token_ok(hub, &token) {
            let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", "Неверный или пустой токен сессии".as_bytes());
            return Ok(());
        }
        let _ = respond(&mut stream, 200, "text/html; charset=utf-8", PHONE_PAGE.as_bytes());
        return Ok(());
    }

    if method == "POST" && path == "/upload" {
        match receive_upload(&mut stream, hub, &headers, pending, &token, stopped) {
            UploadOutcome::Ok => {
                let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
            }
            UploadOutcome::Forbidden => {
                let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
            }
            UploadOutcome::Failed(err) => {
                let _ = respond(&mut stream, 400, "text/plain; charset=utf-8", err.as_bytes());
            }
        }
        return Ok(());
    }

    if method == "POST" && path == "/send_text" {
        match receive_text(&mut stream, hub, &headers, pending, &token, stopped) {
            UploadOutcome::Ok => {
                let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
            }
            UploadOutcome::Forbidden => {
                let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
            }
            UploadOutcome::Failed(err) => {
                let _ = respond(&mut stream, 400, "text/plain; charset=utf-8", err.as_bytes());
            }
        }
        return Ok(());
    }

    let _ = respond(&mut stream, 404, "text/plain; charset=utf-8", b"not found");
    Ok(())
}

enum UploadOutcome {
    Ok,
    Forbidden,
    Failed(String),
}

fn receive_upload(
    stream: &mut TcpStream,
    hub: &DropHubInner,
    headers: &str,
    pending: Vec<u8>,
    token: &str,
    stopped: bool,
) -> UploadOutcome {
    let Some(length) = content_length(headers) else {
        return UploadOutcome::Failed("Нет заголовка Content-Length".to_string());
    };
    if length > MAX_UPLOAD {
        let mut reader = BodyReader::new(stream, pending, MAX_UPLOAD);
        let _ = reader.discard_rest();
        return UploadOutcome::Failed("Файл больше 200 МБ".to_string());
    }
    let mut reader = BodyReader::new(stream, pending, length);
    if stopped || !session_token_ok(hub, token) {
        let _ = reader.discard_rest();
        return UploadOutcome::Forbidden;
    }
    let save_dir = hub_save_dir(hub);
    if let Err(err) = fs::create_dir_all(&save_dir) {
        let _ = reader.discard_rest();
        return UploadOutcome::Failed(format!("Папка недоступна: {err}"));
    }
    let saved = if let Some(boundary) = content_boundary(headers) {
        save_multipart(hub, &mut reader, &save_dir, &boundary, length)
    } else {
        save_raw(hub, &mut reader, &save_dir, length)
    };
    clear_transfer(hub);
    let drained = reader.discard_rest();
    match saved.and(drained) {
        Ok(()) => UploadOutcome::Ok,
        Err(err) => UploadOutcome::Failed(err),
    }
}

fn receive_text(
    stream: &mut TcpStream,
    hub: &DropHubInner,
    headers: &str,
    pending: Vec<u8>,
    token: &str,
    stopped: bool,
) -> UploadOutcome {
    let Some(length) = content_length(headers) else {
        return UploadOutcome::Failed("Нет заголовка Content-Length".to_string());
    };
    if length > 1_000_000 {
        let mut reader = BodyReader::new(stream, pending, 1_000_000);
        let _ = reader.discard_rest();
        return UploadOutcome::Failed("Слишком длинный текст".to_string());
    }
    let mut reader = BodyReader::new(stream, pending, length);
    if stopped || !session_token_ok(hub, token) {
        let _ = reader.discard_rest();
        return UploadOutcome::Forbidden;
    }
    if let Err(err) = reader.pull_all() {
        return UploadOutcome::Failed(err);
    }
    let text = String::from_utf8_lossy(&reader.pending).trim().to_string();
    if text.is_empty() {
        return UploadOutcome::Failed("Пустой текст".to_string());
    }
    let clipped = if text.chars().count() > 8000 {
        text.chars().take(8000).collect()
    } else {
        text
    };
    let _ = copy_to_clipboard(&clipped);
    let _ = append_text_log(hub, &clipped);
    if let Ok(mut guard) = hub.inner.lock() {
        guard.texts.insert(
            0,
            DropTextItem {
                id: next_seq(hub, "text"),
                body: clipped,
                received_at: local_now(),
            },
        );
        guard.texts.truncate(40);
    }
    UploadOutcome::Ok
}

fn session_token_ok(hub: &DropHubInner, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    hub.inner
        .lock()
        .map(|guard| guard.running && guard.info.token == token)
        .unwrap_or(false)
}

fn note_transfer(hub: &DropHubInner, filename: &str, received: u64, total: u64) {
    let Ok(mut guard) = hub.inner.lock() else {
        return;
    };
    let now = Instant::now();
    let speed = match &guard.transfer {
        Some(prev) => {
            let elapsed = now.saturating_duration_since(prev.sample_at).as_secs_f64();
            if elapsed >= 0.2 {
                let delta = received.saturating_sub(prev.sample_bytes) as f64;
                if elapsed > 0.0 { delta / elapsed } else { prev.speed_bps }
            } else {
                prev.speed_bps
            }
        }
        None => 0.0,
    };
    let (sample_bytes, sample_at) = match &guard.transfer {
        Some(prev) if now.saturating_duration_since(prev.sample_at).as_secs_f64() < 0.2 => {
            (prev.sample_bytes, prev.sample_at)
        }
        _ => (received, now),
    };
    guard.transfer = Some(LiveTransfer {
        filename: filename.to_string(),
        received_bytes: received,
        total_bytes: total,
        speed_bps: speed,
        sample_bytes,
        sample_at,
    });
}

fn clear_transfer(hub: &DropHubInner) {
    if let Ok(mut guard) = hub.inner.lock() {
        guard.transfer = None;
        guard.info.transfer = None;
    }
}

fn hub_save_dir(hub: &DropHubInner) -> PathBuf {
    hub.inner
        .lock()
        .map(|guard| PathBuf::from(&guard.info.save_dir))
        .unwrap_or_else(|_| default_save_dir())
}

struct BodyReader<'a> {
    stream: &'a mut TcpStream,
    pending: Vec<u8>,
    remaining: u64,
}

impl<'a> BodyReader<'a> {
    fn new(stream: &'a mut TcpStream, pending: Vec<u8>, length: u64) -> Self {
        let take = (pending.len() as u64).min(length) as usize;
        Self {
            stream,
            pending: pending[..take].to_vec(),
            remaining: length - take as u64,
        }
    }

    fn pull(&mut self) -> Result<(), String> {
        if self.remaining == 0 {
            return Err("Тело запроса обрезано".to_string());
        }
        let want = BODY_CHUNK.min(self.remaining as usize);
        let mut buf = vec![0u8; want];
        let read = read_chunk(self.stream, &mut buf)?;
        if read == 0 {
            return Err("Соединение закрыто до конца файла".to_string());
        }
        self.pending.extend_from_slice(&buf[..read]);
        self.remaining -= read as u64;
        Ok(())
    }

    fn pull_all(&mut self) -> Result<(), String> {
        while self.remaining > 0 {
            self.pull()?;
        }
        Ok(())
    }

    fn ensure(&mut self, bytes: usize) -> Result<(), String> {
        while self.pending.len() < bytes && self.remaining > 0 {
            self.pull()?;
        }
        Ok(())
    }

    fn fill_until(&mut self, limit: usize, found: impl Fn(&[u8]) -> bool) -> Result<(), String> {
        while !found(&self.pending) {
            if self.pending.len() > limit {
                return Err("Заголовок multipart слишком большой".to_string());
            }
            if self.remaining == 0 {
                return Err("Тело запроса обрезано".to_string());
            }
            self.pull()?;
        }
        Ok(())
    }

    fn discard_rest(&mut self) -> Result<(), String> {
        self.pending.clear();
        let mut buf = vec![0u8; BODY_CHUNK];
        while self.remaining > 0 {
            let want = BODY_CHUNK.min(self.remaining as usize);
            let read = read_chunk(self.stream, &mut buf[..want])?;
            if read == 0 {
                return Err("Соединение закрыто до конца файла".to_string());
            }
            self.remaining -= read as u64;
        }
        Ok(())
    }
}

fn read_chunk(stream: &mut TcpStream, buf: &mut [u8]) -> Result<usize, String> {
    let deadline = Instant::now() + READ_WAIT;
    loop {
        match stream.read(buf) {
            Ok(read) => return Ok(read),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Таймаут чтения файла по Wi-Fi".to_string());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) if err.kind() == std::io::ErrorKind::TimedOut => {
                return Err("Таймаут чтения файла по Wi-Fi".to_string());
            }
            Err(err) => return Err(format!("Чтение сокета: {err}")),
        }
    }
}

fn read_headers(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let read = read_chunk(stream, &mut buf)?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..read]);
        if let Some(pos) = find_slice(&raw, b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&raw[..pos]).to_string();
            return Ok((headers, raw[pos + 4..].to_vec()));
        }
        if raw.len() > 128 * 1024 {
            return Err("Слишком большие заголовки".to_string());
        }
    }
    Err("Заголовки не завершены".to_string())
}

fn save_raw(hub: &DropHubInner, reader: &mut BodyReader<'_>, save_dir: &Path, total: u64) -> Result<(), String> {
    let path = unique_path(save_dir, "upload.bin");
    let mut file = fs::File::create(&path).map_err(|err| format!("Не удалось создать файл: {err}"))?;
    file.write_all(&reader.pending).map_err(|err| format!("Запись файла: {err}"))?;
    let mut size = reader.pending.len() as u64;
    reader.pending.clear();
    let mut buf = vec![0u8; BODY_CHUNK];
    while reader.remaining > 0 {
        let want = BODY_CHUNK.min(reader.remaining as usize);
        let read = read_chunk(reader.stream, &mut buf[..want])?;
        if read == 0 {
            let _ = fs::remove_file(&path);
            return Err("Соединение закрыто до конца файла".to_string());
        }
        file.write_all(&buf[..read]).map_err(|err| format!("Запись файла: {err}"))?;
        reader.remaining -= read as u64;
        size += read as u64;
        note_transfer(hub, "Входящий файл", total.saturating_sub(reader.remaining), total);
    }
    file.flush().map_err(|err| format!("Запись файла: {err}"))?;
    remember_file(hub, &path, size, "SUCCESS");
    Ok(())
}

fn save_multipart(
    hub: &DropHubInner,
    reader: &mut BodyReader<'_>,
    save_dir: &Path,
    boundary: &str,
    total: u64,
) -> Result<(), String> {
    let open = format!("--{boundary}").into_bytes();
    let next_mark = format!("\r\n--{boundary}").into_bytes();
    reader.fill_until(256 * 1024, |buf| find_slice(buf, &open).is_some())?;
    let pos = find_slice(&reader.pending, &open).ok_or("Нет границы multipart")?;
    reader.pending.drain(..pos + open.len());
    let mut saved = 0u32;
    loop {
        reader.ensure(2)?;
        if reader.pending.starts_with(b"--") {
            break;
        }
        if reader.pending.starts_with(b"\r\n") {
            reader.pending.drain(..2);
        }
        reader.fill_until(64 * 1024, |buf| find_slice(buf, b"\r\n\r\n").is_some())?;
        let sep = find_slice(&reader.pending, b"\r\n\r\n").ok_or("Нет заголовка части")?;
        let head = String::from_utf8_lossy(&reader.pending[..sep]).to_string();
        reader.pending.drain(..sep + 4);
        if let Some(name) = filename_from_disposition(&head) {
            let filename = sanitize_filename(&name);
            let path = unique_path(save_dir, &filename);
            note_transfer(hub, &filename, total.saturating_sub(reader.remaining), total);
            match write_until_mark(hub, reader, &path, &next_mark, &filename, total) {
                Ok(size) => {
                    remember_file(hub, &path, size, "SUCCESS");
                    saved += 1;
                }
                Err(err) => {
                    let _ = fs::remove_file(&path);
                    push_file(
                        hub,
                        DroppedFileItem {
                            id: next_seq(hub, "file"),
                            filename,
                            size_bytes: 0,
                            received_at: local_now(),
                            status: format!("ERROR: {err}"),
                            path: String::new(),
                        },
                    );
                    return Err(err);
                }
            }
        } else {
            skip_until_mark(reader, &next_mark)?;
        }
    }
    if saved == 0 {
        return Err("Файл не найден в запросе".to_string());
    }
    Ok(())
}

fn write_until_mark(
    hub: &DropHubInner,
    reader: &mut BodyReader<'_>,
    path: &Path,
    mark: &[u8],
    filename: &str,
    total: u64,
) -> Result<u64, String> {
    let mut file = fs::File::create(path).map_err(|err| format!("Не удалось создать файл: {err}"))?;
    let mut tail = Vec::new();
    let mut written = 0u64;
    loop {
        if reader.pending.is_empty() {
            if reader.remaining == 0 {
                return Err("Файл обрезан до границы multipart".to_string());
            }
            reader.pull()?;
        }
        let mut data = std::mem::take(&mut tail);
        data.append(&mut reader.pending);
        if let Some(pos) = find_slice(&data, mark) {
            file.write_all(&data[..pos]).map_err(|err| format!("Запись файла: {err}"))?;
            written += pos as u64;
            reader.pending = data[pos + mark.len()..].to_vec();
            file.flush().map_err(|err| format!("Запись файла: {err}"))?;
            return Ok(written);
        }
        let keep = mark.len().saturating_sub(1);
        if data.len() > keep {
            let cut = data.len() - keep;
            file.write_all(&data[..cut]).map_err(|err| format!("Запись файла: {err}"))?;
            written += cut as u64;
            tail = data[cut..].to_vec();
            note_transfer(hub, filename, total.saturating_sub(reader.remaining), total);
        } else {
            tail = data;
        }
    }
}

fn skip_until_mark(reader: &mut BodyReader<'_>, mark: &[u8]) -> Result<(), String> {
    let mut tail = Vec::new();
    loop {
        if reader.pending.is_empty() {
            if reader.remaining == 0 {
                return Err("Тело запроса обрезано".to_string());
            }
            reader.pull()?;
        }
        let mut data = std::mem::take(&mut tail);
        data.append(&mut reader.pending);
        if let Some(pos) = find_slice(&data, mark) {
            reader.pending = data[pos + mark.len()..].to_vec();
            return Ok(());
        }
        let keep = mark.len().saturating_sub(1);
        if data.len() > keep {
            tail = data[data.len() - keep..].to_vec();
        } else {
            tail = data;
        }
    }
}

fn remember_file(hub: &DropHubInner, path: &Path, size: u64, status: &str) {
    push_file(
        hub,
        DroppedFileItem {
            id: next_seq(hub, "file"),
            filename: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "nexus-file".to_string()),
            size_bytes: size,
            received_at: local_now(),
            status: status.to_string(),
            path: path.display().to_string(),
        },
    );
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).map_err(|err| err.to_string())?;
    stream.write_all(body).map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())?;
    Ok(())
}

fn append_text_log(hub: &DropHubInner, text: &str) -> Result<(), String> {
    let save_dir = hub
        .inner
        .lock()
        .map(|guard| PathBuf::from(&guard.info.save_dir))
        .unwrap_or_else(|_| default_save_dir());
    fs::create_dir_all(&save_dir).map_err(|err| err.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(save_dir.join("messages.txt"))
        .map_err(|err| err.to_string())?;
    writeln!(file, "[{}] {text}", local_now()).map_err(|err| err.to_string())
}

fn push_file(hub: &DropHubInner, item: DroppedFileItem) {
    if let Ok(mut guard) = hub.inner.lock() {
        guard.files.insert(0, item);
        guard.files.truncate(120);
    }
}

fn next_seq(hub: &DropHubInner, prefix: &str) -> String {
    format!("{prefix}-{}", hub.seq.fetch_add(1, Ordering::SeqCst))
}

fn content_length(headers: &str) -> Option<u64> {
    header_value(headers, "content-length")?.parse().ok()
}

fn content_boundary(headers: &str) -> Option<String> {
    let value = header_value(headers, "content-type")?;
    let lower = value.to_ascii_lowercase();
    let pos = lower.find("boundary=")?;
    let raw = value[pos + "boundary=".len()..]
        .split([';', ' ', '\r', '\n'])
        .next()
        .unwrap_or("")
        .trim_matches('"')
        .trim();
    if raw.is_empty() { None } else { Some(raw.to_string()) }
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

fn query_param(target: &str, key: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(value.replace('+', " ").to_string());
        }
    }
    None
}

fn filename_from_disposition(headers: &str) -> Option<String> {
    let value = header_value(headers, "content-disposition")?;
    if let Some(pos) = value.find("filename=\"") {
        let rest = &value[pos + "filename=\"".len()..];
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    if let Some(pos) = value.find("filename=") {
        let rest = value[pos + "filename=".len()..].trim().trim_matches('"');
        let end = rest.find(';').unwrap_or(rest.len());
        return Some(rest[..end].trim().to_string());
    }
    None
}

fn sanitize_filename(raw: &str) -> String {
    let base = raw.rsplit(['\\', '/']).next().unwrap_or(raw);
    let mut cleaned = String::new();
    for ch in base.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\') {
            continue;
        }
        cleaned.push(ch);
    }
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() || cleaned == ".." || cleaned.contains("..") {
        "nexus-file".to_string()
    } else if cleaned.chars().count() > 160 {
        cleaned.chars().take(160).collect()
    } else {
        cleaned
    }
}

fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("nexus-file");
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    for index in 1..500 {
        let name = if ext.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{ext}")
        };
        let next = dir.join(name);
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{filename}-{}", local_now().replace([':', ' '], "-")))
}

fn find_slice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|window| window == needle)
}

fn detect_local_ipv4() -> String {
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if let std::net::IpAddr::V4(ip) = addr.ip() {
                    if !ip.is_unspecified() {
                        return ip.to_string();
                    }
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

fn bind_listener() -> Result<TcpListener, String> {
    for port in 47321..=47340 {
        if let Ok(listener) = TcpListener::bind(("0.0.0.0", port)) {
            return Ok(listener);
        }
    }
    TcpListener::bind("0.0.0.0:0").map_err(|err| format!("Порт приёма занят: {err}"))
}

fn default_save_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidate = exe_dir.join("NexusDrop");
            if fs::create_dir_all(&candidate).is_ok() {
                return candidate;
            }
        }
    }
    if let Ok(base) = std::env::var("LOCALAPPDATA").or_else(|_| std::env::var("APPDATA")) {
        let candidate = PathBuf::from(base).join("nexus").join("NexusDrop");
        let _ = fs::create_dir_all(&candidate);
        return candidate;
    }
    let fallback = PathBuf::from("NexusDrop");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

fn random_token() -> String {
    let mut bytes = [0u8; 8];
    fill_random(&mut bytes);
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    bytes
        .iter()
        .map(|byte| ALPHABET[(*byte as usize) % ALPHABET.len()] as char)
        .collect()
}

fn fill_random(buf: &mut [u8]) {
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn SystemFunction036(buffer: *mut u8, length: u32) -> u8;
        }
        let _ = SystemFunction036(buf.as_mut_ptr(), buf.len() as u32);
    }
    #[cfg(not(target_os = "windows"))]
    {
        for (index, byte) in buf.iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(37).wrapping_add(11);
        }
    }
}

fn render_qr_svg(url: &str) -> Result<String, String> {
    let code = QrCode::new(url.as_bytes()).map_err(|err| format!("Не удалось построить QR: {err}"))?;
    let size = code.width();
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><rect width=\"{size}\" height=\"{size}\" fill=\"#ffffff\"/>"
    );
    for y in 0..size {
        for x in 0..size {
            if code[(x, y)] == Color::Dark {
                svg.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"1\" height=\"1\" fill=\"#111722\"/>"));
            }
        }
    }
    svg.push_str("</svg>");
    Ok(svg)
}

fn local_now() -> String {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct SystemTime {
            year: u16,
            month: u16,
            day_of_week: u16,
            day: u16,
            hour: u16,
            minute: u16,
            second: u16,
            millis: u16,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetLocalTime(time: *mut SystemTime);
        }
        let mut time = SystemTime {
            year: 0,
            month: 0,
            day_of_week: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            millis: 0,
        };
        unsafe { GetLocalTime(&mut time) };
        return format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            time.year, time.month, time.day, time.hour, time.minute, time.second
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        "local".to_string()
    }
}

fn copy_to_clipboard(text: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn OpenClipboard(hwnd: isize) -> i32;
            fn CloseClipboard() -> i32;
            fn EmptyClipboard() -> i32;
            fn SetClipboardData(format: u32, memory: isize) -> isize;
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
            fn GlobalLock(memory: isize) -> *mut u8;
            fn GlobalUnlock(memory: isize) -> i32;
            fn GlobalFree(memory: isize) -> isize;
        }
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let bytes = units.len() * 2;
        unsafe {
            if OpenClipboard(0) == 0 {
                return false;
            }
            let _ = EmptyClipboard();
            let memory = GlobalAlloc(0x0002, bytes);
            if memory == 0 {
                let _ = CloseClipboard();
                return false;
            }
            let locked = GlobalLock(memory);
            if locked.is_null() {
                let _ = GlobalFree(memory);
                let _ = CloseClipboard();
                return false;
            }
            std::ptr::copy_nonoverlapping(units.as_ptr() as *const u8, locked, bytes);
            let _ = GlobalUnlock(memory);
            let ok = SetClipboardData(13, memory) != 0;
            let _ = CloseClipboard();
            ok
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        false
    }
}

fn open_in_explorer(path: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(path.as_os_str());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map_err(|err| format!("Не удалось открыть Проводник: {err}"))?;
    Ok(())
}

fn idle_info() -> DropSessionInfo {
    DropSessionInfo {
        is_running: false,
        local_ip: String::new(),
        port: 0,
        token: String::new(),
        url: String::new(),
        save_dir: default_save_dir().display().to_string(),
        qr_svg: String::new(),
        transfer: None,
    }
}

const PHONE_PAGE: &str = r####"<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NEXUS Drop</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #07080b; color: #e8edf4; font-family: ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 28px 18px 40px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: .04em; }
  p { color: #8793a5; font-size: 13px; line-height: 1.45; }
  .card { background: #111722; border: 1px solid #222b38; border-radius: 16px; padding: 16px; margin-top: 14px; }
  button, .pick { display: flex; width: 100%; justify-content: center; align-items: center; gap: 8px; border: 0; border-radius: 12px; padding: 14px; font-weight: 700; background: #0ea5e9; color: #041018; }
  .ghost { background: transparent; color: #e8edf4; border: 1px solid #222b38; margin-top: 10px; }
  textarea { width: 100%; min-height: 96px; border-radius: 12px; border: 1px solid #222b38; background: #151c27; color: #e8edf4; padding: 12px; resize: vertical; }
  #drop { margin-top: 12px; border: 1px dashed #38bdf8; border-radius: 14px; padding: 22px 12px; text-align: center; color: #8793a5; }
  #bar { height: 6px; background: #151c27; border-radius: 99px; overflow: hidden; margin-top: 12px; }
  #bar span { display: block; height: 100%; width: 0; background: #38bdf8; }
  #log { font-size: 12px; color: #38bdf8; min-height: 18px; }
  input[type=file] { display: none; }
</style>
</head>
<body>
<main>
  <h1>NEXUS DROP</h1>
  <p>Отправьте фото, файлы или ссылку на этот компьютер по локальной сети.</p>
  <div class="card">
    <label class="pick">Выбрать файлы<input id="file" type="file" multiple></label>
    <div id="drop">Или перетащите файлы сюда</div>
    <div id="bar"><span></span></div>
    <div id="log"></div>
  </div>
  <div class="card">
    <textarea id="text" placeholder="Ссылка или короткий текст"></textarea>
    <button class="ghost" id="send" type="button">Отправить текст</button>
  </div>
</main>
<script>
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const log = document.getElementById("log");
const bar = document.querySelector("#bar span");
const zone = document.getElementById("drop");
function setLog(msg) { log.textContent = msg; }
function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const data = new FormData();
    data.append("file", file, file.name);
    xhr.open("POST", "/upload?token=" + encodeURIComponent(token));
    xhr.timeout = 180000;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round(event.loaded / event.total * 100);
      bar.style.width = pct + "%";
      setLog("Загрузка " + file.name + ": " + pct + "%");
    };
    xhr.onload = () => {
      if (xhr.status === 200) resolve();
      else reject(xhr.responseText || ("Ошибка " + xhr.status));
    };
    xhr.onerror = () => reject("Передача прервана: сеть недоступна");
    xhr.ontimeout = () => reject("Передача прервана: таймаут Wi-Fi");
    xhr.send(data);
  });
}
async function sendFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  for (let i = 0; i < files.length; i++) {
    setLog("Отправка " + (i + 1) + " / " + files.length + ": " + files[i].name);
    bar.style.width = "0%";
    try {
      await upload(files[i]);
      bar.style.width = "100%";
      setLog("Файл успешно получен ПК: " + files[i].name);
    } catch (err) {
      setLog(String(err));
      break;
    }
  }
}
document.getElementById("file").addEventListener("change", (event) => sendFiles(event.target.files));
zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.style.background = "#151c27"; });
zone.addEventListener("dragleave", () => { zone.style.background = "transparent"; });
zone.addEventListener("drop", (event) => { event.preventDefault(); zone.style.background = "transparent"; sendFiles(event.dataTransfer.files); });
document.getElementById("send").addEventListener("click", async () => {
  const value = document.getElementById("text").value.trim();
  if (!value) return;
  setLog("Отправка текста...");
  try {
    const response = await fetch("/send_text?token=" + encodeURIComponent(token), { method: "POST", body: value });
    if (!response.ok) throw new Error(await response.text());
    document.getElementById("text").value = "";
    setLog("Текст доставлен на компьютер");
  } catch (err) { setLog(String(err)); }
});
</script>
</body>
</html>
"####;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn upload_reads_full_body_before_response() {
        let hub = DropHub::new();
        let info = hub.start().expect("session");
        let boundary = "nexusbound";
        let payload = vec![0xA5u8; 5 * 1024 * 1024];
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let mut stream = TcpStream::connect(("127.0.0.1", info.port)).expect("connect");
        stream.set_write_timeout(Some(Duration::from_secs(20))).ok();
        stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
        let header = format!(
            "POST /upload?token={} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            info.token,
            body.len()
        );
        stream.write_all(header.as_bytes()).expect("headers");
        for chunk in body.chunks(4096) {
            stream.write_all(chunk).expect("body chunk");
        }
        stream.flush().ok();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).expect("response");
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("Access-Control-Allow-Origin: *"));

        let files = hub.history();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "SUCCESS");
        assert_eq!(files[0].size_bytes, payload.len() as u64);
        let saved = fs::read(&files[0].path).expect("saved file");
        assert_eq!(saved, payload);
        let _ = fs::remove_file(&files[0].path);
        hub.stop().ok();
    }
}
