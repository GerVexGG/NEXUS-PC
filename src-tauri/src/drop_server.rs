use qrcode::{Color, QrCode};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// Документированные лимиты безопасности и квоты NEXUS Drop (без магических констант)

/// Длина токена доступа: 26 символов из 32-символьного алфавита = 130 бит криптографической энтропии (>= 128 бит).
pub const TOKEN_LENGTH_CHARS: usize = 26;
/// Максимальный размер одного загружаемого файла (200 МБ).
pub const MAX_FILE_SIZE_BYTES: u64 = 200 * 1024 * 1024;
/// Максимальный суммарный объём передач за одну сессию (1 ГБ).
pub const MAX_SESSION_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
/// Максимальное количество файлов, принимаемых за одну сессию.
pub const MAX_SESSION_FILES_COUNT: u32 = 50;
/// Максимальный размер текстовой заметки (64 КБ).
pub const MAX_TEXT_SIZE_BYTES: u64 = 64 * 1024;
/// Максимальный размер блока HTTP-заголовков входящего запроса (32 КБ).
pub const MAX_HTTP_HEADERS_BYTES: usize = 32 * 1024;
/// Максимальный размер заголовка одной части multipart/form-data (16 КБ).
pub const MAX_MULTIPART_PART_HEADER_BYTES: usize = 16 * 1024;
/// Максимальное число одновременно обслуживаемых HTTP-клиентов.
pub const MAX_CONCURRENT_CLIENTS: usize = 4;
/// Жёсткий суммарный таймаут на чтение HTTP-заголовков (защита от Slowloris).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Таймаут простоя между чанками тела загрузки.
pub const BODY_CHUNK_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Максимальное количество неудачных попыток авторизации за окно rate limiter.
pub const MAX_AUTH_FAILURES_PER_WINDOW: u32 = 8;
/// Окно отслеживания неудачных попыток авторизации.
pub const AUTH_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(30);

const BODY_CHUNK: usize = 128 * 1024;
const SOCKET_SLICE_TIMEOUT: Duration = Duration::from_millis(250);

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
    pub session_files_count: u32,
    pub session_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_session_bytes: u64,
    pub max_session_files: u32,
    pub limit_reached_reason: Option<String>,
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
    reserved_files: u32,
    reserved_bytes: u64,
}

struct DropHubInner {
    inner: Mutex<DropInner>,
    shutdown: AtomicBool,
    alive: AtomicBool,
    generation: AtomicU64,
    seq: AtomicU64,
    conn_seq: AtomicU64,
    active_clients: AtomicUsize,
    active_streams: Mutex<HashMap<u64, TcpStream>>,
    auth_failures: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl DropHubInner {
    fn is_stopped(&self, generation: u64) -> bool {
        self.shutdown.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation
    }
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
                    reserved_files: 0,
                    reserved_bytes: 0,
                }),
                shutdown: AtomicBool::new(true),
                alive: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                seq: AtomicU64::new(1),
                conn_seq: AtomicU64::new(1),
                active_clients: AtomicUsize::new(0),
                active_streams: Mutex::new(HashMap::new()),
                auth_failures: Mutex::new(HashMap::new()),
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
        let save_dir = default_save_dir();
        self.start_with_config(save_dir, None)
    }

    fn start_with_config(
        &self,
        save_dir: PathBuf,
        explicit_bind: Option<(&str, u16)>,
    ) -> Result<DropSessionInfo, String> {
        if let Ok(guard) = self.shared.inner.lock() {
            if guard.running {
                return Ok(guard.info.clone());
            }
        }
        self.stop()?;
        self.wait_until_stopped();

        fs::create_dir_all(&save_dir)
            .map_err(|err| format!("Не удалось создать папку загрузок: {err}"))?;
        let canonical_save_dir = fs::canonicalize(&save_dir)
            .map_err(|err| format!("Не удалось проверить каталог загрузок: {err}"))?;

        // Токен формируется исключительно системным CSPRNG (>= 128 бит энтропии).
        // При любой ошибке генератора сервер не запускается.
        let token = generate_secure_token()?;
        let listener = match explicit_bind {
            Some((host, port)) => {
                TcpListener::bind((host, port)).map_err(|err| format!("Порт приёма занят: {err}"))?
            }
            None => bind_listener()?,
        };
        let port = listener
            .local_addr()
            .map_err(|err| format!("Не удалось узнать порт: {err}"))?
            .port();
        let ip = if explicit_bind.is_some() {
            "127.0.0.1".to_string()
        } else {
            detect_local_ipv4()
        };

        // Передаём токен в URL fragment (#token=...), чтобы браузер не отправлял секрет
        // в query string на сервер при загрузке страницы.
        let url = format!("http://{ip}:{port}/#token={token}");
        let qr_svg = render_qr_svg(&url)?;
        let info = DropSessionInfo {
            is_running: true,
            local_ip: ip,
            port,
            token,
            url,
            save_dir: canonical_save_dir.display().to_string(),
            qr_svg,
            transfer: None,
            session_files_count: 0,
            session_total_bytes: 0,
            max_file_bytes: MAX_FILE_SIZE_BYTES,
            max_session_bytes: MAX_SESSION_TOTAL_BYTES,
            max_session_files: MAX_SESSION_FILES_COUNT,
            limit_reached_reason: None,
        };

        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.shutdown.store(false, Ordering::SeqCst);
        if let Ok(mut failures) = self.shared.auth_failures.lock() {
            failures.clear();
        }
        if let Ok(mut guard) = self.shared.inner.lock() {
            guard.running = true;
            guard.info = info.clone();
            guard.reserved_files = 0;
            guard.reserved_bytes = 0;
            guard.transfer = None;
        }

        let shared = Arc::clone(&self.shared);
        std::thread::Builder::new()
            .name("nexus-drop-accept".into())
            .spawn(move || {
                shared.alive.store(true, Ordering::SeqCst);
                serve(listener, generation, &shared);
                shared.alive.store(false, Ordering::SeqCst);
            })
            .map_err(|err| {
                let _ = self.stop();
                format!("Не удалось запустить поток приёма: {err}")
            })?;

        Ok(info)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.generation.fetch_add(1, Ordering::SeqCst);

        // Принудительно прерываем все активные клиентские сокеты, чтобы медленные передачи
        // не блокировали остановку сервера и закрытие приложения.
        if let Ok(mut streams) = self.shared.active_streams.lock() {
            for (_, stream) in streams.drain() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }

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

    pub fn wait_until_stopped(&self) {
        for _ in 0..80 {
            if !self.shared.alive.load(Ordering::SeqCst)
                && self.shared.active_clients.load(Ordering::SeqCst) == 0
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

struct ClientWorkerGuard {
    hub: Arc<DropHubInner>,
    conn_id: u64,
}

impl Drop for ClientWorkerGuard {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.hub.active_streams.lock() {
            streams.remove(&self.conn_id);
        }
        self.hub.active_clients.fetch_sub(1, Ordering::SeqCst);
    }
}

fn serve(listener: TcpListener, generation: u64, hub: &Arc<DropHubInner>) {
    let _ = listener.set_nonblocking(true);
    loop {
        if hub.is_stopped(generation) {
            break;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if hub.is_stopped(generation) {
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                }
                let prev = hub.active_clients.load(Ordering::SeqCst);
                if prev >= MAX_CONCURRENT_CLIENTS {
                    let _ = respond(
                        &mut stream,
                        503,
                        "text/plain; charset=utf-8",
                        "Сервер занят другим клиентом — повторите попытку чуть позже".as_bytes(),
                    );
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }

                let conn_id = hub.conn_seq.fetch_add(1, Ordering::SeqCst);
                if let Ok(cloned) = stream.try_clone() {
                    if let Ok(mut streams) = hub.active_streams.lock() {
                        streams.insert(conn_id, cloned);
                    }
                }
                hub.active_clients.fetch_add(1, Ordering::SeqCst);
                let worker_hub = Arc::clone(hub);
                let spawned = std::thread::Builder::new()
                    .name(format!("nexus-drop-worker-{conn_id}"))
                    .spawn(move || {
                        let _guard = ClientWorkerGuard {
                            hub: Arc::clone(&worker_hub),
                            conn_id,
                        };
                        let _ = handle_client(stream, generation, &worker_hub);
                    });

                if spawned.is_err() {
                    if let Ok(mut streams) = hub.active_streams.lock() {
                        streams.remove(&conn_id);
                    }
                    hub.active_clients.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthCheck {
    Valid,
    InvalidOrMissing,
    RateLimited,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn peer_key(stream: &TcpStream) -> String {
    stream
        .peer_addr()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn extract_request_token(headers: &str, target: &str) -> Option<String> {
    if let Some(tok) = header_value(headers, "x-nexus-token") {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(auth) = header_value(headers, "authorization") {
        let trimmed = auth.trim();
        if trimmed.len() > 7 && trimmed[..7].eq_ignore_ascii_case("bearer ") {
            let tok = trimmed[7..].trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    query_param(target, "token").filter(|s| !s.trim().is_empty())
}

fn authenticate_request(
    hub: &DropHubInner,
    peer: &str,
    supplied_token: Option<&str>,
    generation: u64,
) -> AuthCheck {
    if hub.is_stopped(generation) {
        return AuthCheck::InvalidOrMissing;
    }
    let now = Instant::now();
    {
        if let Ok(mut map) = hub.auth_failures.lock() {
            let queue = map.entry(peer.to_string()).or_default();
            while let Some(&front) = queue.front() {
                if now.saturating_duration_since(front) > AUTH_RATE_LIMIT_WINDOW {
                    queue.pop_front();
                } else {
                    break;
                }
            }
            if queue.len() >= MAX_AUTH_FAILURES_PER_WINDOW as usize {
                return AuthCheck::RateLimited;
            }
        }
    }

    let valid = if let Some(candidate) = supplied_token {
        hub.inner
            .lock()
            .map(|guard| {
                guard.running
                    && !guard.info.token.is_empty()
                    && constant_time_eq(guard.info.token.as_bytes(), candidate.trim().as_bytes())
            })
            .unwrap_or(false)
    } else {
        false
    };

    if valid {
        if let Ok(mut map) = hub.auth_failures.lock() {
            map.remove(peer);
        }
        AuthCheck::Valid
    } else {
        if let Ok(mut map) = hub.auth_failures.lock() {
            let queue = map.entry(peer.to_string()).or_default();
            queue.push_back(now);
            if queue.len() >= MAX_AUTH_FAILURES_PER_WINDOW as usize {
                return AuthCheck::RateLimited;
            }
        }
        AuthCheck::InvalidOrMissing
    }
}

fn handle_client(mut stream: TcpStream, generation: u64, hub: &Arc<DropHubInner>) -> Result<(), ()> {
    let peer = peer_key(&stream);
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(SOCKET_SLICE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(BODY_CHUNK_READ_TIMEOUT));

    let (headers, pending) = match read_headers(&mut stream, hub, generation) {
        Ok(value) => value,
        Err(err) => {
            if !hub.is_stopped(generation) {
                let status = if err.contains("таймаут") { 408 } else { 400 };
                let _ = respond(&mut stream, status, "text/plain; charset=utf-8", err.as_bytes());
            }
            return Ok(());
        }
    };

    let request_line = headers.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let version = parts.next().unwrap_or("");
    if method.is_empty()
        || target.is_empty()
        || !version.starts_with("HTTP/1.")
        || parts.next().is_some()
    {
        let _ = respond(
            &mut stream,
            400,
            "text/plain; charset=utf-8",
            "Некорректный HTTP-запрос".as_bytes(),
        );
        return Ok(());
    }

    if method == "OPTIONS" {
        let _ = respond_cors_preflight(&mut stream);
        return Ok(());
    }

    let path = target.split('?').next().unwrap_or("/");
    let supplied_token = extract_request_token(&headers, target);

    if method == "GET" && (path == "/" || path.is_empty()) {
        if hub.is_stopped(generation) {
            let _ = respond(
                &mut stream,
                403,
                "text/plain; charset=utf-8",
                "Сессия NEXUS Drop остановлена".as_bytes(),
            );
            return Ok(());
        }
        if supplied_token.is_some() {
            match authenticate_request(hub, &peer, supplied_token.as_deref(), generation) {
                AuthCheck::Valid => {}
                AuthCheck::RateLimited => {
                    let _ = respond(
                        &mut stream,
                        429,
                        "text/plain; charset=utf-8",
                        "Слишком много неверных попыток входа — подождите 30 секунд".as_bytes(),
                    );
                    return Ok(());
                }
                AuthCheck::InvalidOrMissing => {
                    let _ = respond(
                        &mut stream,
                        403,
                        "text/plain; charset=utf-8",
                        "Неверный или пустой токен сессии".as_bytes(),
                    );
                    return Ok(());
                }
            }
        }
        let _ = respond(&mut stream, 200, "text/html; charset=utf-8", PHONE_PAGE.as_bytes());
        return Ok(());
    }

    if method == "GET" && path == "/api/auth" {
        match authenticate_request(hub, &peer, supplied_token.as_deref(), generation) {
            AuthCheck::Valid => {
                let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
            }
            AuthCheck::RateLimited => {
                let _ = respond(
                    &mut stream,
                    429,
                    "text/plain; charset=utf-8",
                    "Превышен лимит попыток авторизации".as_bytes(),
                );
            }
            AuthCheck::InvalidOrMissing => {
                let _ = respond(
                    &mut stream,
                    403,
                    "text/plain; charset=utf-8",
                    "Неверный или пустой токен сессии".as_bytes(),
                );
            }
        }
        return Ok(());
    }

    if method == "POST" && path == "/upload" {
        match receive_upload(
            &mut stream,
            hub,
            generation,
            &peer,
            &headers,
            pending,
            supplied_token.as_deref(),
        ) {
            UploadOutcome::Ok => {
                let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
            }
            UploadOutcome::Forbidden => {
                let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
            }
            UploadOutcome::RateLimited => {
                let _ = respond(
                    &mut stream,
                    429,
                    "text/plain; charset=utf-8",
                    "Слишком много неудачных попыток авторизации".as_bytes(),
                );
            }
            UploadOutcome::TooLarge(err) => {
                let _ = respond(&mut stream, 413, "text/plain; charset=utf-8", err.as_bytes());
            }
            UploadOutcome::Failed(err) => {
                let _ = respond(&mut stream, 400, "text/plain; charset=utf-8", err.as_bytes());
            }
        }
        return Ok(());
    }

    if method == "POST" && path == "/send_text" {
        match receive_text(
            &mut stream,
            hub,
            generation,
            &peer,
            &headers,
            pending,
            supplied_token.as_deref(),
        ) {
            UploadOutcome::Ok => {
                let _ = respond(&mut stream, 200, "text/plain; charset=utf-8", b"ok");
            }
            UploadOutcome::Forbidden => {
                let _ = respond(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
            }
            UploadOutcome::RateLimited => {
                let _ = respond(
                    &mut stream,
                    429,
                    "text/plain; charset=utf-8",
                    "Слишком много неудачных попыток авторизации".as_bytes(),
                );
            }
            UploadOutcome::TooLarge(err) => {
                let _ = respond(&mut stream, 413, "text/plain; charset=utf-8", err.as_bytes());
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
    RateLimited,
    TooLarge(String),
    Failed(String),
}

struct QuotaReservation<'a> {
    hub: &'a DropHubInner,
    reserved_files: u32,
    reserved_bytes: u64,
    active: bool,
}

impl<'a> QuotaReservation<'a> {
    fn try_reserve(hub: &'a DropHubInner, declared_bytes: u64) -> Result<Self, String> {
        let mut guard = hub
            .inner
            .lock()
            .map_err(|_| "Состояние сессии заблокировано".to_string())?;
        if guard.info.session_files_count + guard.reserved_files >= MAX_SESSION_FILES_COUNT {
            let msg = format!(
                "Достигнут лимит файлов за сессию (максимум {MAX_SESSION_FILES_COUNT})"
            );
            guard.info.limit_reached_reason = Some(msg.clone());
            return Err(msg);
        }
        let projected = guard
            .info
            .session_total_bytes
            .saturating_add(guard.reserved_bytes)
            .saturating_add(declared_bytes);
        if projected > MAX_SESSION_TOTAL_BYTES {
            let msg = format!(
                "Превышен лимит объёма за сессию ({} МБ)",
                MAX_SESSION_TOTAL_BYTES / (1024 * 1024)
            );
            guard.info.limit_reached_reason = Some(msg.clone());
            return Err(msg);
        }
        guard.reserved_files += 1;
        guard.reserved_bytes = guard.reserved_bytes.saturating_add(declared_bytes);
        Ok(Self {
            hub,
            reserved_files: 1,
            reserved_bytes: declared_bytes,
            active: true,
        })
    }

    fn commit(&mut self, actual_files: u32, actual_bytes: u64) {
        if !self.active {
            return;
        }
        self.active = false;
        if let Ok(mut guard) = self.hub.inner.lock() {
            guard.reserved_files = guard.reserved_files.saturating_sub(self.reserved_files);
            guard.reserved_bytes = guard.reserved_bytes.saturating_sub(self.reserved_bytes);
            guard.info.session_files_count = guard.info.session_files_count.saturating_add(actual_files);
            guard.info.session_total_bytes = guard.info.session_total_bytes.saturating_add(actual_bytes);
        }
    }
}

impl Drop for QuotaReservation<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        if let Ok(mut guard) = self.hub.inner.lock() {
            guard.reserved_files = guard.reserved_files.saturating_sub(self.reserved_files);
            guard.reserved_bytes = guard.reserved_bytes.saturating_sub(self.reserved_bytes);
        }
    }
}

fn can_accept_additional_file_in_request(hub: &DropHubInner) -> Result<(), String> {
    let mut guard = hub
        .inner
        .lock()
        .map_err(|_| "Состояние сессии заблокировано".to_string())?;
    if guard.info.session_files_count + guard.reserved_files >= MAX_SESSION_FILES_COUNT {
        let msg = format!(
            "Достигнут лимит файлов за сессию (максимум {MAX_SESSION_FILES_COUNT})"
        );
        guard.info.limit_reached_reason = Some(msg.clone());
        return Err(msg);
    }
    Ok(())
}

struct TempPartFileGuard {
    path: Option<PathBuf>,
}

impl TempPartFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn path(&self) -> &Path {
        self.path.as_deref().unwrap_or_else(|| Path::new(""))
    }

    fn defuse(&mut self) {
        self.path = None;
    }
}

impl Drop for TempPartFileGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            let _ = fs::remove_file(p);
        }
    }
}

fn drain_small_rejected_body(
    stream: &mut TcpStream,
    pending: Vec<u8>,
    declared_len: Option<u64>,
    hub: &DropHubInner,
    generation: u64,
) {
    const MAX_DRAIN_BYTES: u64 = 64 * 1024;
    if let Some(len) = declared_len {
        if len > 0 && len <= MAX_DRAIN_BYTES {
            let mut reader = BodyReader::new(stream, pending, len);
            let _ = reader.discard_rest(hub, generation);
            return;
        }
    }
    let _ = stream.set_nonblocking(true);
    let mut scratch = [0u8; 4096];
    let mut drained = 0usize;
    while drained < MAX_DRAIN_BYTES as usize {
        match stream.read(&mut scratch) {
            Ok(0) | Err(_) => break,
            Ok(n) => drained += n,
        }
    }
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(SOCKET_SLICE_TIMEOUT));
}

fn receive_upload(
    stream: &mut TcpStream,
    hub: &DropHubInner,
    generation: u64,
    peer: &str,
    headers: &str,
    pending: Vec<u8>,
    token: Option<&str>,
) -> UploadOutcome {
    let parsed_length = header_value(headers, "content-length")
        .and_then(|raw| raw.trim().parse::<u64>().ok());

    match authenticate_request(hub, peer, token, generation) {
        AuthCheck::Valid => {}
        AuthCheck::RateLimited => {
            drain_small_rejected_body(stream, pending, parsed_length, hub, generation);
            return UploadOutcome::RateLimited;
        }
        AuthCheck::InvalidOrMissing => {
            drain_small_rejected_body(stream, pending, parsed_length, hub, generation);
            return UploadOutcome::Forbidden;
        }
    }

    if let Some(te) = header_value(headers, "transfer-encoding") {
        if !te.trim().eq_ignore_ascii_case("identity") {
            drain_small_rejected_body(stream, pending, parsed_length, hub, generation);
            return UploadOutcome::Failed("Transfer-Encoding не поддерживается — передайте Content-Length".to_string());
        }
    }

    let length = match header_value(headers, "content-length") {
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(v) if v > 0 => v,
            Ok(_) => return UploadOutcome::Failed("Пустое тело запроса (Content-Length: 0)".to_string()),
            Err(_) => return UploadOutcome::Failed("Некорректный заголовок Content-Length".to_string()),
        },
        None => return UploadOutcome::Failed("Нет заголовка Content-Length".to_string()),
    };

    if length > MAX_FILE_SIZE_BYTES {
        drain_small_rejected_body(stream, pending, Some(length), hub, generation);
        let msg = format!(
            "Файл больше допустимого лимита ({} МБ)",
            MAX_FILE_SIZE_BYTES / (1024 * 1024)
        );
        if let Ok(mut guard) = hub.inner.lock() {
            guard.info.limit_reached_reason = Some(msg.clone());
        }
        return UploadOutcome::TooLarge(msg);
    }

    let mut reservation = match QuotaReservation::try_reserve(hub, length) {
        Ok(res) => res,
        Err(msg) => {
            drain_small_rejected_body(stream, pending, Some(length), hub, generation);
            return UploadOutcome::TooLarge(msg);
        }
    };

    let save_dir = hub_save_dir(hub);
    if let Err(err) = fs::create_dir_all(&save_dir) {
        return UploadOutcome::Failed(format!("Папка недоступна: {err}"));
    }
    let canon_save_dir = match fs::canonicalize(&save_dir) {
        Ok(d) => d,
        Err(err) => return UploadOutcome::Failed(format!("Ошибка каталога загрузок: {err}")),
    };

    let mut reader = BodyReader::new(stream, pending, length);
    let outcome = if let Some(boundary) = content_boundary(headers) {
        save_multipart(hub, generation, &mut reader, &canon_save_dir, &boundary, length)
    } else {
        save_raw(hub, generation, &mut reader, &canon_save_dir, length)
    };
    clear_transfer(hub);

    match outcome {
        Ok((files_saved, total_written)) => {
            if let Err(err) = reader.discard_rest(hub, generation) {
                return UploadOutcome::Failed(err);
            }
            reservation.commit(files_saved, total_written);
            UploadOutcome::Ok
        }
        Err(err) => UploadOutcome::Failed(err),
    }
}

fn receive_text(
    stream: &mut TcpStream,
    hub: &DropHubInner,
    generation: u64,
    peer: &str,
    headers: &str,
    pending: Vec<u8>,
    token: Option<&str>,
) -> UploadOutcome {
    match authenticate_request(hub, peer, token, generation) {
        AuthCheck::Valid => {}
        AuthCheck::RateLimited => return UploadOutcome::RateLimited,
        AuthCheck::InvalidOrMissing => return UploadOutcome::Forbidden,
    }

    let length = match header_value(headers, "content-length") {
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(v) if v > 0 => v,
            Ok(_) => return UploadOutcome::Failed("Пустой текст".to_string()),
            Err(_) => return UploadOutcome::Failed("Некорректный Content-Length".to_string()),
        },
        None => return UploadOutcome::Failed("Нет заголовка Content-Length".to_string()),
    };

    if length > MAX_TEXT_SIZE_BYTES {
        return UploadOutcome::TooLarge(format!(
            "Слишком длинный текст (лимит {} КБ)",
            MAX_TEXT_SIZE_BYTES / 1024
        ));
    }

    let mut reader = BodyReader::new(stream, pending, length);
    if let Err(err) = reader.pull_all(hub, generation) {
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

    fn pull(&mut self, hub: &DropHubInner, generation: u64) -> Result<(), String> {
        if hub.is_stopped(generation) {
            return Err("Передача отменена: сервер остановлен".to_string());
        }
        if self.remaining == 0 {
            return Err("Тело запроса обрезано".to_string());
        }
        let want = BODY_CHUNK.min(self.remaining as usize);
        let mut buf = vec![0u8; want];
        let read = read_chunk(self.stream, &mut buf, BODY_CHUNK_READ_TIMEOUT, hub, generation)?;
        if read == 0 {
            return Err("Соединение закрыто до конца файла".to_string());
        }
        self.pending.extend_from_slice(&buf[..read]);
        self.remaining -= read as u64;
        Ok(())
    }

    fn pull_all(&mut self, hub: &DropHubInner, generation: u64) -> Result<(), String> {
        while self.remaining > 0 {
            self.pull(hub, generation)?;
        }
        Ok(())
    }

    fn ensure(&mut self, bytes: usize, hub: &DropHubInner, generation: u64) -> Result<(), String> {
        while self.pending.len() < bytes && self.remaining > 0 {
            self.pull(hub, generation)?;
        }
        Ok(())
    }

    fn fill_until(
        &mut self,
        limit: usize,
        hub: &DropHubInner,
        generation: u64,
        found: impl Fn(&[u8]) -> bool,
    ) -> Result<(), String> {
        while !found(&self.pending) {
            if self.pending.len() > limit {
                return Err("Заголовок multipart слишком большой".to_string());
            }
            if self.remaining == 0 {
                return Err("Тело запроса обрезано".to_string());
            }
            self.pull(hub, generation)?;
        }
        Ok(())
    }

    fn discard_rest(&mut self, hub: &DropHubInner, generation: u64) -> Result<(), String> {
        self.pending.clear();
        let mut buf = vec![0u8; BODY_CHUNK];
        while self.remaining > 0 {
            if hub.is_stopped(generation) {
                return Err("Сервер остановлен".to_string());
            }
            let want = BODY_CHUNK.min(self.remaining as usize);
            let read = read_chunk(
                self.stream,
                &mut buf[..want],
                BODY_CHUNK_READ_TIMEOUT,
                hub,
                generation,
            )?;
            if read == 0 {
                return Err("Соединение закрыто до конца файла".to_string());
            }
            self.remaining -= read as u64;
        }
        Ok(())
    }
}

fn read_chunk(
    stream: &mut TcpStream,
    buf: &mut [u8],
    timeout: Duration,
    hub: &DropHubInner,
    generation: u64,
) -> Result<usize, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if hub.is_stopped(generation) {
            return Err("Передача прервана: сервер остановлен".to_string());
        }
        match stream.read(buf) {
            Ok(read) => return Ok(read),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err("Таймаут ожидания данных по сети".to_string());
                }
            }
            Err(err) => return Err(format!("Ошибка чтения сокета: {err}")),
        }
    }
}

fn read_headers(
    stream: &mut TcpStream,
    hub: &DropHubInner,
    generation: u64,
) -> Result<(String, Vec<u8>), String> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let overall_deadline = Instant::now() + HEADER_READ_TIMEOUT;
    loop {
        let remaining = overall_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Превышен таймаут ожидания HTTP-заголовков".to_string());
        }
        let read = read_chunk(stream, &mut buf, remaining, hub, generation)?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..read]);
        if let Some(pos) = find_slice(&raw, b"\r\n\r\n") {
            if pos > MAX_HTTP_HEADERS_BYTES {
                return Err("Слишком большие HTTP-заголовки".to_string());
            }
            let headers = String::from_utf8_lossy(&raw[..pos]).to_string();
            return Ok((headers, raw[pos + 4..].to_vec()));
        }
        if raw.len() > MAX_HTTP_HEADERS_BYTES {
            return Err("Слишком большие HTTP-заголовки".to_string());
        }
    }
    Err("Заголовки HTTP не завершены".to_string())
}

fn new_temp_part_path(save_dir: &Path, hub: &DropHubInner, generation: u64) -> PathBuf {
    let id = hub.seq.fetch_add(1, Ordering::SeqCst);
    save_dir.join(format!(".nexus-upload-{generation}-{id}.part"))
}

fn finalize_temp_file(
    hub: &DropHubInner,
    part_guard: &mut TempPartFileGuard,
    save_dir: &Path,
    clean_filename: &str,
    size: u64,
) -> Result<PathBuf, String> {
    let mut guard = hub
        .inner
        .lock()
        .map_err(|_| "Состояние сессии заблокировано".to_string())?;
    let final_path = unique_path(save_dir, clean_filename)?;
    if final_path.parent() != Some(save_dir) {
        return Err("Выход за пределы каталога сохранения запрещён".to_string());
    }
    fs::rename(part_guard.path(), &final_path)
        .map_err(|err| format!("Не удалось атомарно сохранить файл: {err}"))?;
    part_guard.defuse();
    guard.files.insert(
        0,
        DroppedFileItem {
            id: format!("file-{}", hub.seq.fetch_add(1, Ordering::SeqCst)),
            filename: final_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| clean_filename.to_string()),
            size_bytes: size,
            received_at: local_now(),
            status: "SUCCESS".to_string(),
            path: final_path.display().to_string(),
        },
    );
    guard.files.truncate(120);
    Ok(final_path)
}

fn save_raw(
    hub: &DropHubInner,
    generation: u64,
    reader: &mut BodyReader<'_>,
    save_dir: &Path,
    total: u64,
) -> Result<(u32, u64), String> {
    let part_path = new_temp_part_path(save_dir, hub, generation);
    let mut part_guard = TempPartFileGuard::new(part_path);
    let mut size = reader.pending.len() as u64;
    if size > MAX_FILE_SIZE_BYTES {
        return Err("Превышен лимит одного файла".to_string());
    }
    {
        let mut file = fs::File::create(part_guard.path())
            .map_err(|err| format!("Не удалось создать временный файл: {err}"))?;
        file.write_all(&reader.pending)
            .map_err(|err| format!("Запись временного файла: {err}"))?;
        reader.pending.clear();
        let mut buf = vec![0u8; BODY_CHUNK];
        while reader.remaining > 0 {
            if hub.is_stopped(generation) {
                return Err("Передача отменена: сервер остановлен".to_string());
            }
            let want = BODY_CHUNK.min(reader.remaining as usize);
            let read = read_chunk(
                reader.stream,
                &mut buf[..want],
                BODY_CHUNK_READ_TIMEOUT,
                hub,
                generation,
            )?;
            if read == 0 {
                return Err("Соединение закрыто до конца файла".to_string());
            }
            size = size.saturating_add(read as u64);
            if size > MAX_FILE_SIZE_BYTES {
                return Err("Превышен лимит одного файла".to_string());
            }
            file.write_all(&buf[..read])
                .map_err(|err| format!("Запись файла: {err}"))?;
            reader.remaining -= read as u64;
            note_transfer(hub, "Входящий файл", total.saturating_sub(reader.remaining), total);
        }
        file.flush().map_err(|err| format!("Запись файла: {err}"))?;
    }
    finalize_temp_file(hub, &mut part_guard, save_dir, "upload.bin", size)?;
    Ok((1, size))
}

fn save_multipart(
    hub: &DropHubInner,
    generation: u64,
    reader: &mut BodyReader<'_>,
    save_dir: &Path,
    boundary: &str,
    total: u64,
) -> Result<(u32, u64), String> {
    let open = format!("--{boundary}").into_bytes();
    let next_mark = format!("\r\n--{boundary}").into_bytes();
    reader.fill_until(MAX_HTTP_HEADERS_BYTES, hub, generation, |buf| {
        find_slice(buf, &open).is_some()
    })?;
    let pos = find_slice(&reader.pending, &open).ok_or("Нет границы multipart")?;
    reader.pending.drain(..pos + open.len());
    let mut saved_files = 0u32;
    let mut saved_bytes = 0u64;
    loop {
        if hub.is_stopped(generation) {
            return Err("Передача отменена: сервер остановлен".to_string());
        }
        reader.ensure(2, hub, generation)?;
        if reader.pending.starts_with(b"--") {
            break;
        }
        if reader.pending.starts_with(b"\r\n") {
            reader.pending.drain(..2);
        }
        reader.fill_until(MAX_MULTIPART_PART_HEADER_BYTES, hub, generation, |buf| {
            find_slice(buf, b"\r\n\r\n").is_some()
        })?;
        let sep = find_slice(&reader.pending, b"\r\n\r\n").ok_or("Нет заголовка части")?;
        let head = String::from_utf8_lossy(&reader.pending[..sep]).to_string();
        reader.pending.drain(..sep + 4);
        if let Some(name) = filename_from_disposition(&head) {
            if saved_files >= 1 {
                can_accept_additional_file_in_request(hub)?;
            }
            let filename = sanitize_filename(&name);
            let part_path = new_temp_part_path(save_dir, hub, generation);
            let mut part_guard = TempPartFileGuard::new(part_path);
            note_transfer(hub, &filename, total.saturating_sub(reader.remaining), total);
            match write_until_mark(
                hub,
                generation,
                reader,
                part_guard.path(),
                &next_mark,
                &filename,
                total,
            ) {
                Ok(size) => {
                    finalize_temp_file(hub, &mut part_guard, save_dir, &filename, size)?;
                    saved_files += 1;
                    saved_bytes = saved_bytes.saturating_add(size);
                }
                Err(err) => {
                    drop(part_guard);
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
            skip_until_mark(hub, generation, reader, &next_mark)?;
        }
    }
    if saved_files == 0 {
        return Err("Файл не найден в запросе".to_string());
    }
    Ok((saved_files, saved_bytes))
}

fn write_until_mark(
    hub: &DropHubInner,
    generation: u64,
    reader: &mut BodyReader<'_>,
    path: &Path,
    mark: &[u8],
    filename: &str,
    total: u64,
) -> Result<u64, String> {
    let mut file = fs::File::create(path)
        .map_err(|err| format!("Не удалось создать временный файл: {err}"))?;
    let mut tail = Vec::new();
    let mut written = 0u64;
    loop {
        if hub.is_stopped(generation) {
            return Err("Передача отменена: сервер остановлен".to_string());
        }
        if reader.pending.is_empty() {
            if reader.remaining == 0 {
                return Err("Файл обрезан до границы multipart".to_string());
            }
            reader.pull(hub, generation)?;
        }
        let mut data = std::mem::take(&mut tail);
        data.append(&mut reader.pending);
        if let Some(pos) = find_slice(&data, mark) {
            written = written.saturating_add(pos as u64);
            if written > MAX_FILE_SIZE_BYTES {
                return Err("Превышен максимальный размер файла".to_string());
            }
            file.write_all(&data[..pos])
                .map_err(|err| format!("Запись файла: {err}"))?;
            reader.pending = data[pos + mark.len()..].to_vec();
            file.flush().map_err(|err| format!("Запись файла: {err}"))?;
            return Ok(written);
        }
        let keep = mark.len().saturating_sub(1);
        if data.len() > keep {
            let cut = data.len() - keep;
            written = written.saturating_add(cut as u64);
            if written > MAX_FILE_SIZE_BYTES {
                return Err("Превышен максимальный размер файла".to_string());
            }
            file.write_all(&data[..cut])
                .map_err(|err| format!("Запись файла: {err}"))?;
            tail = data[cut..].to_vec();
            note_transfer(hub, filename, total.saturating_sub(reader.remaining), total);
        } else {
            tail = data;
        }
    }
}

fn skip_until_mark(
    hub: &DropHubInner,
    generation: u64,
    reader: &mut BodyReader<'_>,
    mark: &[u8],
) -> Result<(), String> {
    let mut tail = Vec::new();
    loop {
        if hub.is_stopped(generation) {
            return Err("Передача отменена: сервер остановлен".to_string());
        }
        if reader.pending.is_empty() {
            if reader.remaining == 0 {
                return Err("Тело запроса обрезано".to_string());
            }
            reader.pull(hub, generation)?;
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

fn respond_cors_preflight(stream: &mut TcpStream) -> Result<(), String> {
    let header = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: X-Nexus-Token, Authorization, Content-Type\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n";
    stream
        .write_all(header.as_bytes())
        .map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())?;
    let _ = stream.shutdown(Shutdown::Write);
    Ok(())
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: X-Nexus-Token, Authorization, Content-Type\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    let mut packet = Vec::with_capacity(header.len() + body.len());
    packet.extend_from_slice(header.as_bytes());
    packet.extend_from_slice(body);
    stream.write_all(&packet).map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())?;
    let _ = stream.shutdown(Shutdown::Write);
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

fn is_windows_reserved_name(name: &str) -> bool {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .trim_end_matches('.')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn sanitize_filename(raw: &str) -> String {
    let without_drive = if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        &raw[2..]
    } else {
        raw
    };
    let base = without_drive
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(without_drive);
    let mut cleaned = String::new();
    for ch in base.chars() {
        if ch.is_control()
            || matches!(
                ch,
                '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\'
            )
        {
            continue;
        }
        cleaned.push(ch);
    }
    let mut trimmed = cleaned.trim().trim_matches('.').to_string();
    while trimmed.contains("..") {
        trimmed = trimmed.replace("..", ".");
    }
    trimmed = trimmed.trim().trim_matches('.').to_string();
    if trimmed.is_empty() || is_windows_reserved_name(&trimmed) {
        return "nexus-file".to_string();
    }
    if trimmed.to_ascii_lowercase().ends_with(".part") {
        trimmed.push_str(".bin");
    }
    if trimmed.chars().count() > 160 {
        trimmed.chars().take(160).collect()
    } else {
        trimmed
    }
}

fn unique_path(dir: &Path, filename: &str) -> Result<PathBuf, String> {
    let candidate = dir.join(filename);
    if candidate.parent() != Some(dir) {
        return Err("Некорректный путь файла сохранения".to_string());
    }
    if !candidate.exists() {
        return Ok(candidate);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|v| v.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("nexus-file");
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    for index in 1..10_000 {
        let name = if ext.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{ext}")
        };
        let next = dir.join(name);
        if next.parent() == Some(dir) && !next.exists() {
            return Ok(next);
        }
    }
    Err("Не удалось подобрать уникальное имя файла".to_string())
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

pub fn generate_secure_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_LENGTH_CHARS];
    fill_csprng(&mut bytes)?;
    // Дополнительная страховка от вырожденного нулевого буфера
    if bytes.iter().all(|&b| b == bytes[0]) {
        return Err(
            "Криптографический генератор вернул вырожденную последовательность — запуск NEXUS Drop отменён"
                .to_string(),
        );
    }
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    Ok(bytes
        .iter()
        .map(|byte| ALPHABET[(byte & 0x1F) as usize] as char)
        .collect())
}

fn fill_csprng(buf: &mut [u8]) -> Result<(), String> {
    if buf.is_empty() {
        return Err("Буфер для генерации токена не может быть пустым".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn SystemFunction036(buffer: *mut u8, length: u32) -> u8;
        }
        let ok = unsafe { SystemFunction036(buf.as_mut_ptr(), buf.len() as u32) };
        if ok == 0 {
            return Err(
                "Сбой системного CSPRNG (SystemFunction036 / RtlGenRandom) — небезопасный запуск NEXUS Drop запрещён"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut urandom = fs::File::open("/dev/urandom")
            .map_err(|err| format!("Не удалось открыть /dev/urandom для генерации токена: {err}"))?;
        urandom
            .read_exact(buf)
            .map_err(|err| format!("Не удалось прочитать случайные байты из /dev/urandom: {err}"))
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
        session_files_count: 0,
        session_total_bytes: 0,
        max_file_bytes: MAX_FILE_SIZE_BYTES,
        max_session_bytes: MAX_SESSION_TOTAL_BYTES,
        max_session_files: MAX_SESSION_FILES_COUNT,
        limit_reached_reason: None,
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
  main { max-width: 520px; margin: 0 auto; padding: 24px 18px 40px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: .04em; }
  p { color: #8793a5; font-size: 13px; line-height: 1.45; }
  .warn { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.35); color: #fcd34d; border-radius: 12px; padding: 10px 12px; font-size: 12px; line-height: 1.4; margin-top: 10px; }
  .card { background: #111722; border: 1px solid #222b38; border-radius: 16px; padding: 16px; margin-top: 14px; }
  button, .pick { display: flex; width: 100%; justify-content: center; align-items: center; gap: 8px; border: 0; border-radius: 12px; padding: 14px; font-weight: 700; background: #0ea5e9; color: #041018; }
  .ghost { background: transparent; color: #e8edf4; border: 1px solid #222b38; margin-top: 10px; }
  textarea, input[type=text] { width: 100%; border-radius: 12px; border: 1px solid #222b38; background: #151c27; color: #e8edf4; padding: 11px 12px; font-family: inherit; }
  textarea { min-height: 96px; resize: vertical; }
  #tokenRow { display: none; gap: 8px; margin-top: 10px; }
  #tokenRow.visible { display: flex; }
  #drop { margin-top: 12px; border: 1px dashed #38bdf8; border-radius: 14px; padding: 22px 12px; text-align: center; color: #8793a5; }
  #bar { height: 6px; background: #151c27; border-radius: 99px; overflow: hidden; margin-top: 12px; }
  #bar span { display: block; height: 100%; width: 0; background: #38bdf8; }
  #log { font-size: 12px; color: #38bdf8; min-height: 18px; margin-top: 8px; }
  input[type=file] { display: none; }
</style>
</head>
<body>
<main>
  <h1>NEXUS DROP</h1>
  <p>Отправка файлов и текста на компьютер по домашней сети Wi-Fi (до 200 МБ за файл, до 50 файлов / 1 ГБ за сессию).</p>
  <div class="warn">Локальный HTTP-канал без TLS-шифрования: передаваемые файлы внутри Wi-Fi сети не шифруются. Используйте только в доверенной домашней сети.</div>
  <div id="tokenCard" class="card" style="display:none">
    <div style="font-size:12px;color:#8793a5">Введите токен сессии из окна NEXUS на ПК:</div>
    <div id="tokenRow" class="visible">
      <input id="tokenInput" type="text" placeholder="Токен доступа"/>
      <button id="tokenApply" type="button" style="width:auto;padding:0 16px">ОК</button>
    </div>
  </div>
  <div class="card">
    <label class="pick">Выбрать файлы<input id="file" type="file" multiple></label>
    <div id="drop">Или перетащите файлы сюда</div>
    <div id="bar"><span></span></div>
    <div id="log"></div>
  </div>
  <div class="card">
    <textarea id="text" placeholder="Ссылка или короткий текст (до 64 КБ)"></textarea>
    <button class="ghost" id="send" type="button">Отправить текст</button>
  </div>
</main>
<script>
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const queryParams = new URLSearchParams(location.search);
let token = hashParams.get("token") || queryParams.get("token") || "";
if (location.hash || queryParams.has("token")) {
  try { history.replaceState(null, "", "/"); } catch {}
}
const log = document.getElementById("log");
const bar = document.querySelector("#bar span");
const zone = document.getElementById("drop");
const tokenCard = document.getElementById("tokenCard");
const tokenInput = document.getElementById("tokenInput");
function setLog(msg) { log.textContent = msg; }
async function verifyToken() {
  if (!token) { tokenCard.style.display = "block"; setLog("Требуется токен сессии"); return; }
  try {
    const res = await fetch("/api/auth", { headers: { "X-Nexus-Token": token } });
    if (res.ok) { tokenCard.style.display = "none"; setLog("Готово к передаче"); }
    else { tokenCard.style.display = "block"; setLog(await res.text() || "Неверный токен"); }
  } catch { setLog("Узел NEXUS недоступен"); }
}
document.getElementById("tokenApply").addEventListener("click", () => {
  token = (tokenInput.value || "").trim().toUpperCase();
  void verifyToken();
});
function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const data = new FormData();
    data.append("file", file, file.name);
    xhr.open("POST", "/upload");
    xhr.setRequestHeader("X-Nexus-Token", token);
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
    const response = await fetch("/send_text", {
      method: "POST",
      headers: { "X-Nexus-Token": token },
      body: value
    });
    if (!response.ok) throw new Error(await response.text());
    document.getElementById("text").value = "";
    setLog("Текст доставлен на компьютер");
  } catch (err) { setLog(String(err)); }
});
void verifyToken();
</script>
</body>
</html>
"####;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::io::{Read, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDropDir(PathBuf);
    impl TempDropDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nexus_drop_test_{label}_{}_{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDropDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn http_multipart_upload(
        port: u16,
        token: &str,
        filename: &str,
        payload: &[u8],
    ) -> (u16, String) {
        let boundary = "nexusbound123";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(payload);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.set_write_timeout(Some(Duration::from_secs(20))).ok();
        stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
        let header = format!(
            "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Nexus-Token: {token}\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).expect("headers");
        for chunk in body.chunks(8192) {
            stream.write_all(chunk).expect("body chunk");
        }
        stream.flush().ok();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).expect("response");
        let text = String::from_utf8_lossy(&response).to_string();
        let status = text
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        (status, text)
    }

    #[test]
    fn token_generation_produces_130bit_entropy_unique_tokens() {
        let mut seen = HashSet::new();
        for _ in 0..32 {
            let t = generate_secure_token().expect("CSPRNG must succeed");
            assert_eq!(t.len(), TOKEN_LENGTH_CHARS);
            assert!(t.chars().all(|c| c.is_ascii_alphanumeric()));
            assert!(seen.insert(t), "Duplicate CSPRNG token encountered");
        }
    }

    #[test]
    fn upload_reads_full_body_before_response_and_supports_header_auth() {
        let dir = TempDropDir::new("full_upload");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");
        assert!(info.url.contains("/#token="), "QR URL must use URL fragment instead of query string");

        let payload = vec![0xA5u8; 2 * 1024 * 1024];
        let (status, text) = http_multipart_upload(info.port, &info.token, "photo.jpg", &payload);
        assert_eq!(status, 200, "{text}");
        assert!(text.contains("Access-Control-Allow-Origin: *"));

        let files = hub.history();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "SUCCESS");
        assert_eq!(files[0].size_bytes, payload.len() as u64);
        assert_eq!(fs::read(&files[0].path).unwrap(), payload);

        let updated = hub.session();
        assert_eq!(updated.session_files_count, 1);
        assert_eq!(updated.session_total_bytes, payload.len() as u64);
        hub.stop().ok();
    }

    #[test]
    fn auth_rejects_wrong_token_and_rate_limits_repeated_failures() {
        let dir = TempDropDir::new("rate_limit");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");

        // Первые 7 попыток с неверным токеном -> 403, на 8-й (достижение MAX_AUTH_FAILURES_PER_WINDOW) -> 429
        for attempt in 1..=MAX_AUTH_FAILURES_PER_WINDOW {
            let (status, text) = http_multipart_upload(info.port, "WRONG_TOKEN", "bad.txt", b"hi");
            if attempt < MAX_AUTH_FAILURES_PER_WINDOW {
                assert_eq!(status, 403, "attempt {attempt}: {text}");
            } else {
                assert_eq!(status, 429, "rate limit must trigger on attempt {attempt}: {text}");
            }
        }
        assert!(hub.history().is_empty());
        hub.stop().ok();
    }

    #[test]
    fn filename_sanitizer_blocks_path_traversal_windows_paths_and_reserved_names() {
        assert_eq!(sanitize_filename("../../evil.txt"), "evil.txt");
        assert_eq!(sanitize_filename(r"C:\Windows\System32\cmd.exe"), "cmd.exe");
        assert_eq!(sanitize_filename(r"..\..\..\.."), "nexus-file");
        assert_eq!(sanitize_filename(""), "nexus-file");
        assert_eq!(sanitize_filename("   ...  "), "nexus-file");
        assert_eq!(sanitize_filename("CON.txt"), "nexus-file");
        assert_eq!(sanitize_filename("nul"), "nexus-file");
        assert_eq!(sanitize_filename("LPT1.log"), "nexus-file");
        assert_eq!(sanitize_filename("secret.part"), "secret.part.bin");

        // Сквозной тест через HTTP multipart с traversal и дублирующимся именем
        let dir = TempDropDir::new("traversal");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");

        let (s1, _) = http_multipart_upload(info.port, &info.token, r"C:\..\..\outside.txt", b"first");
        let (s2, _) = http_multipart_upload(info.port, &info.token, r"../outside.txt", b"second");
        assert_eq!(s1, 200);
        assert_eq!(s2, 200);

        let files = hub.history();
        assert_eq!(files.len(), 2);
        let canon_dir = fs::canonicalize(&dir.0).unwrap();
        for item in &files {
            let p = Path::new(&item.path);
            assert_eq!(p.parent(), Some(canon_dir.as_path()), "Saved file escaped save_dir: {}", item.path);
        }
        assert_ne!(files[0].path, files[1].path, "Duplicate names must remain distinct");
        hub.stop().ok();
    }

    #[test]
    fn enforces_file_size_and_session_quotas() {
        let dir = TempDropDir::new("quotas");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");

        // 1. Запрос с Content-Length > MAX_FILE_SIZE_BYTES немедленно отклоняется кодом 413
        let mut stream = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        let oversized = MAX_FILE_SIZE_BYTES + 1024;
        let req = format!(
            "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Nexus-Token: {}\r\nContent-Length: {oversized}\r\nConnection: close\r\n\r\n",
            info.token
        );
        stream.write_all(req.as_bytes()).unwrap();
        let _ = stream.shutdown(Shutdown::Write);
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).unwrap();
        let resp_str = String::from_utf8_lossy(&resp);
        assert!(resp_str.starts_with("HTTP/1.1 413"), "{resp_str}");

        // 2. Превышение суммарного объёма сессии (имитация уже принятого объёма на границе квоты)
        {
            let mut guard = hub.shared.inner.lock().unwrap();
            guard.info.session_total_bytes = MAX_SESSION_TOTAL_BYTES - 10;
        }
        let (st, txt) = http_multipart_upload(info.port, &info.token, "over_quota.bin", &[b'x'; 512]);
        assert_eq!(st, 413, "Session byte quota must return 413: {txt}");
        assert!(hub.session().limit_reached_reason.is_some());

        // 3. Превышение количества файлов за сессию
        {
            let mut guard = hub.shared.inner.lock().unwrap();
            guard.info.session_total_bytes = 0;
            guard.info.session_files_count = MAX_SESSION_FILES_COUNT;
        }
        let (st2, txt2) = http_multipart_upload(info.port, &info.token, "extra.bin", b"tiny");
        assert_eq!(st2, 413, "Session file count quota must return 413: {txt2}");
        hub.stop().ok();
    }

    #[test]
    fn rejects_malformed_and_truncated_http_requests_without_leaving_temp_files() {
        let dir = TempDropDir::new("malformed");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");

        // 1. Некорректная HTTP строка запроса -> 400
        let mut bad = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        bad.write_all(b"GARBAGE_NOT_HTTP\r\n\r\n").unwrap();
        let mut bad_resp = String::new();
        bad.read_to_string(&mut bad_resp).unwrap();
        assert!(bad_resp.starts_with("HTTP/1.1 400"), "{bad_resp}");

        // 2. Обрезанный POST без финальной multipart-границы -> 400 и отсутствие .part / битых файлов
        let mut trunc = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        let partial_body = "--b1\r\nContent-Disposition: form-data; name=\"file\"; filename=\"half.bin\"\r\n\r\npartial_bytes";
        let req = format!(
            "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Nexus-Token: {}\r\nContent-Type: multipart/form-data; boundary=b1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{partial_body}",
            info.token,
            partial_body.len() + 500
        );
        trunc.write_all(req.as_bytes()).unwrap();
        let _ = trunc.shutdown(Shutdown::Write);
        let mut trunc_resp = String::new();
        let _ = trunc.read_to_string(&mut trunc_resp);
        assert!(trunc_resp.starts_with("HTTP/1.1 400"), "{trunc_resp}");

        // Проверяем, что в каталоге сохранения не осталось ни финального, ни .part файла
        let leftover: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(leftover.is_empty(), "No .part or corrupted files may remain: {leftover:?}");
        hub.stop().ok();
    }

    #[test]
    fn slow_client_does_not_block_parallel_uploads() {
        let dir = TempDropDir::new("parallel");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");

        // Открываем медленное соединение (прислали только часть заголовков) и держим его открытым
        let mut slow = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        slow.write_all(b"POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap();
        slow.flush().unwrap();

        // Пока slow клиент висит, быстрый клиент должен немедленно завершить загрузку!
        let (st, txt) = http_multipart_upload(info.port, &info.token, "fast.txt", b"parallel_ok");
        assert_eq!(st, 200, "Fast client must not be blocked by slow client: {txt}");
        assert_eq!(hub.history().len(), 1);

        drop(slow);
        hub.stop().ok();
        hub.wait_until_stopped();
    }

    #[test]
    fn stopping_server_during_active_transfer_aborts_and_cleans_up_part_file() {
        let dir = TempDropDir::new("stop_abort");
        let hub = DropHub::new();
        let info = hub
            .start_with_config(dir.0.clone(), Some(("127.0.0.1", 0)))
            .expect("session");

        let mut active = TcpStream::connect(("127.0.0.1", info.port)).unwrap();
        let declared_len = 5_000_000usize;
        let first_part = format!(
            "--bnd\r\nContent-Disposition: form-data; name=\"file\"; filename=\"unfinished.iso\"\r\n\r\n{}",
            "A".repeat(4096)
        );
        let req = format!(
            "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Nexus-Token: {}\r\nContent-Type: multipart/form-data; boundary=bnd\r\nContent-Length: {declared_len}\r\nConnection: close\r\n\r\n{first_part}",
            info.token
        );
        active.write_all(req.as_bytes()).unwrap();
        active.flush().unwrap();

        // Даём worker-потоку начать запись во временный .part файл
        std::thread::sleep(Duration::from_millis(120));

        // Останавливаем сервер прямо во время незавершённой передачи и ждём остановки
        let started_stop = Instant::now();
        hub.stop().unwrap();
        hub.wait_until_stopped();
        assert!(
            started_stop.elapsed() < Duration::from_secs(3),
            "Server stop must interrupt active transfers promptly"
        );
        assert_eq!(hub.shared.active_clients.load(Ordering::SeqCst), 0);

        let leftover: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            leftover.is_empty(),
            "Aborted upload .part file must be cleaned up on stop: {leftover:?}"
        );
    }
}
