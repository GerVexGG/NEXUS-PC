use qrcode::{Color, QrCode};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Serialize, Clone, Debug)]
pub struct DropSessionInfo {
    pub is_running: bool,
    pub local_ip: String,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub save_dir: String,
    pub qr_svg: String,
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
}

pub struct DropHub {
    inner: Mutex<DropInner>,
    shutdown: AtomicBool,
    alive: AtomicBool,
    generation: AtomicU64,
    seq: AtomicU64,
}

impl DropHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DropInner {
                running: false,
                info: idle_info(),
                files: Vec::new(),
                texts: Vec::new(),
            }),
            shutdown: AtomicBool::new(true),
            alive: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            seq: AtomicU64::new(1),
        }
    }

    pub fn session(&self) -> DropSessionInfo {
        self.inner
            .lock()
            .map(|guard| guard.info.clone())
            .unwrap_or_else(|_| idle_info())
    }

    pub fn history(&self) -> Vec<DroppedFileItem> {
        self.inner
            .lock()
            .map(|guard| guard.files.clone())
            .unwrap_or_default()
    }

    pub fn texts(&self) -> Vec<DropTextItem> {
        self.inner
            .lock()
            .map(|guard| guard.texts.clone())
            .unwrap_or_default()
    }

    pub fn open_folder(&self) -> Result<(), String> {
        let dir = self
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
        if let Ok(guard) = self.inner.lock() {
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
        };

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shutdown.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.lock() {
            guard.running = true;
            guard.info = info.clone();
        }

        let handle = unsafe_share(self);
        std::thread::Builder::new()
            .name("nexus-drop".into())
            .spawn(move || {
                unsafe { &*handle.alive }.store(true, Ordering::SeqCst);
                serve(listener, generation, handle);
                unsafe { &*handle.alive }.store(false, Ordering::SeqCst);
            })
            .map_err(|err| format!("Не удалось запустить поток приёма: {err}"))?;

        Ok(info)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.shutdown.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.lock() {
            guard.running = false;
            guard.info.is_running = false;
            guard.info.token.clear();
            guard.info.url.clear();
            guard.info.qr_svg.clear();
        }
        Ok(())
    }

    fn wait_until_stopped(&self) {
        for _ in 0..40 {
            if !self.alive.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn unsafe_share(hub: &DropHub) -> HubHandle {
    HubHandle {
        files: &hub.inner,
        shutdown_gen: &hub.generation,
        seq: &hub.seq,
        alive: &hub.alive,
    }
}

#[derive(Copy, Clone)]
struct HubHandle {
    files: *const Mutex<DropInner>,
    shutdown_gen: *const AtomicU64,
    seq: *const AtomicU64,
    alive: *const AtomicBool,
}

unsafe impl Send for HubHandle {}

fn serve(listener: TcpListener, generation: u64, hub: HubHandle) {
    let _ = listener.set_nonblocking(true);
    loop {
        let current = unsafe { &*hub.shutdown_gen }.load(Ordering::SeqCst);
        if current != generation {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = handle_client(stream, generation, &hub);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => break,
        }
    }
    drop(listener);
    if unsafe { &*hub.shutdown_gen }.load(Ordering::SeqCst) == generation {
        if let Ok(mut guard) = unsafe { &*hub.files }.lock() {
            guard.running = false;
            guard.info.is_running = false;
        }
    }
}

fn handle_client(mut stream: TcpStream, generation: u64, hub: &HubHandle) -> Result<(), ()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(45)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(45)));
    let (headers, body) = read_request(&mut stream).map_err(|_| ())?;
    let request_line = headers.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let token = query_param(target, "token").unwrap_or_default();
    let path = target.split('?').next().unwrap_or("/");

    if unsafe { &*hub.shutdown_gen }.load(Ordering::SeqCst) != generation {
        let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"stopped");
        return Ok(());
    }

    if method == "GET" && (path == "/" || path.is_empty()) {
        if !session_token_ok(hub, &token) {
            let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", "Неверный или пустой токен сессии".as_bytes());
            return Ok(());
        }
        let _ = respond(&mut stream, 200, "text/html; charset=utf-8", PHONE_PAGE.as_bytes());
        return Ok(());
    }

    if method == "POST" && path == "/upload" {
        if !session_token_ok(hub, &token) {
            let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
            return Ok(());
        }
        match store_upload(hub, &headers, &body) {
            Ok(()) => {
                let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
            }
            Err(err) => {
                let _ = respond(&mut stream, 400, "text/plain; charset=utf-8", err.as_bytes());
            }
        }
        return Ok(());
    }

    if method == "POST" && path == "/send_text" {
        if !session_token_ok(hub, &token) {
            let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
            return Ok(());
        }
        let text = String::from_utf8_lossy(&body).trim().to_string();
        if text.is_empty() {
            let _ = respond(&mut stream, 400, "text/plain; charset=utf-8", b"empty");
            return Ok(());
        }
        let clipped = if text.chars().count() > 8000 {
            text.chars().take(8000).collect()
        } else {
            text
        };
        let _ = copy_to_clipboard(&clipped);
        let _ = append_text_log(hub, &clipped);
        let item = DropTextItem {
            id: next_seq(hub, "text"),
            body: clipped,
            received_at: local_now(),
        };
        if let Ok(mut guard) = unsafe { &*hub.files }.lock() {
            guard.texts.insert(0, item);
            guard.texts.truncate(40);
        }
        let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
        return Ok(());
    }

    let _ = respond(&mut stream, 404, "text/plain; charset=utf-8", b"not found");
    Ok(())
}

fn session_token_ok(hub: &HubHandle, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    unsafe { &*hub.files }
        .lock()
        .map(|guard| guard.running && guard.info.token == token)
        .unwrap_or(false)
}

fn store_upload(hub: &HubHandle, headers: &str, body: &[u8]) -> Result<(), String> {
    let save_dir = unsafe { &*hub.files }
        .lock()
        .map(|guard| PathBuf::from(&guard.info.save_dir))
        .unwrap_or_else(|_| default_save_dir());
    fs::create_dir_all(&save_dir).map_err(|err| format!("Папка недоступна: {err}"))?;

    let files = if let Some(boundary) = content_boundary(headers) {
        multipart_files(body, &boundary)
    } else if !body.is_empty() {
        vec![("upload.bin".to_string(), body.to_vec())]
    } else {
        Vec::new()
    };
    if files.is_empty() {
        return Err("Файл не найден в запросе".to_string());
    }

    for (raw_name, bytes) in files {
        let filename = sanitize_filename(&raw_name);
        let path = unique_path(&save_dir, &filename);
        let id = next_seq(hub, "file");
        let stamp = local_now();
        match fs::write(&path, &bytes) {
            Ok(()) => {
                push_file(
                    hub,
                    DroppedFileItem {
                        id,
                        filename: path
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string())
                            .unwrap_or(filename),
                        size_bytes: bytes.len() as u64,
                        received_at: stamp,
                        status: "SUCCESS".to_string(),
                        path: path.display().to_string(),
                    },
                );
            }
            Err(err) => {
                push_file(
                    hub,
                    DroppedFileItem {
                        id,
                        filename,
                        size_bytes: bytes.len() as u64,
                        received_at: stamp,
                        status: format!("ERROR: {err}"),
                        path: String::new(),
                    },
                );
                return Err(format!("Не удалось сохранить файл: {err}"));
            }
        }
    }
    Ok(())
}

fn append_text_log(hub: &HubHandle, text: &str) -> Result<(), String> {
    let save_dir = unsafe { &*hub.files }
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

fn push_file(hub: &HubHandle, item: DroppedFileItem) {
    if let Ok(mut guard) = unsafe { &*hub.files }.lock() {
        guard.files.insert(0, item);
        guard.files.truncate(120);
    }
}

fn next_seq(hub: &HubHandle, prefix: &str) -> String {
    format!("{prefix}-{}", unsafe { &*hub.seq }.fetch_add(1, Ordering::SeqCst))
}

fn read_request(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = stream.read(&mut chunk).map_err(|err| format!("Чтение запроса: {err}"))?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
        if find_slice(&raw, b"\r\n\r\n").is_some() {
            break;
        }
        if raw.len() > 128 * 1024 {
            return Err("Слишком большие заголовки".to_string());
        }
    }
    if raw.len() < 4 {
        return Err("Пустой запрос".to_string());
    }
    let header_end = find_slice(&raw, b"\r\n\r\n").ok_or("Заголовки не завершены")?;
    let header_text = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut body = raw[header_end + 4..].to_vec();
    let length = content_length(&header_text).unwrap_or(0);
    if length > 200_000_000 {
        return Err("Файл больше 200 МБ".to_string());
    }
    while body.len() < length {
        let read = stream.read(&mut chunk).map_err(|err| format!("Чтение тела: {err}"))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    if body.len() > length {
        body.truncate(length);
    }
    Ok((header_text, body))
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
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).map_err(|err| err.to_string())?;
    stream.write_all(body).map_err(|err| err.to_string())?;
    Ok(())
}

fn content_length(headers: &str) -> Option<usize> {
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

fn multipart_files(body: &[u8], boundary: &str) -> Vec<(String, Vec<u8>)> {
    let marker = format!("--{boundary}").into_bytes();
    let mut files = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = find_slice(&body[cursor..], &marker) {
        let mut part_at = cursor + rel + marker.len();
        if body.get(part_at..part_at + 2) == Some(b"--") {
            break;
        }
        if body.get(part_at..part_at + 2) == Some(b"\r\n") {
            part_at += 2;
        }
        let Some(next) = find_slice(&body[part_at..], &marker) else {
            break;
        };
        let mut part = &body[part_at..part_at + next];
        if part.ends_with(b"\r\n") {
            part = &part[..part.len() - 2];
        }
        if let Some(sep) = find_slice(part, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&part[..sep]);
            if let Some(name) = filename_from_disposition(&head) {
                files.push((name, part[sep + 4..].to_vec()));
            }
        }
        cursor = part_at + next;
    }
    files
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
    let profile = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(profile).join("Downloads").join("NEXUS Drop")
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
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><rect width=\"{size}\" height=\"{size}\" fill=\"#111722\"/>"
    );
    for y in 0..size {
        for x in 0..size {
            if code[(x, y)] == Color::Dark {
                svg.push_str(&format!("<rect x=\"{x}\" y=\"{y}\" width=\"1\" height=\"1\" fill=\"#e8edf4\"/>"));
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
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) bar.style.width = Math.round(event.loaded / event.total * 100) + "%";
    };
    xhr.onload = () => xhr.status === 200 ? resolve() : reject(xhr.responseText || "Ошибка");
    xhr.onerror = () => reject("Сеть недоступна");
    xhr.send(data);
  });
}
async function sendFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  for (let i = 0; i < files.length; i++) {
    setLog("Отправка " + (i + 1) + " / " + files.length + ": " + files[i].name);
    bar.style.width = "0%";
    try { await upload(files[i]); setLog("Сохранено: " + files[i].name); }
    catch (err) { setLog(String(err)); break; }
  }
  bar.style.width = "100%";
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
