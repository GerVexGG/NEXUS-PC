use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "windows")]
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    },
    Storage::Streams::{DataReader, IRandomAccessStreamReference},
};

const TICKS_PER_SECOND: f64 = 10_000_000.0;
const WINDOWS_TO_UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MediaTrackInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playback_status: String,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub cover_base64: Option<String>,
    pub source_app_id: String,
}

#[derive(Default)]
struct CoverCache {
    key: String,
    data_url: Option<String>,
}

fn cover_cache() -> &'static Mutex<CoverCache> {
    static CACHE: OnceLock<Mutex<CoverCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CoverCache::default()))
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;

        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn resolve_active_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> Option<GlobalSystemMediaTransportControlsSession> {
    if let Ok(sessions) = manager.GetSessions() {
        let count = sessions.Size().unwrap_or(0);
        let mut ytmd_session: Option<GlobalSystemMediaTransportControlsSession> = None;
        let mut playing_session: Option<GlobalSystemMediaTransportControlsSession> = None;

        for idx in 0..count {
            let Ok(session) = sessions.GetAt(idx) else {
                continue;
            };
            let app_id = session
                .SourceAppUserModelId()
                .map(|s| s.to_string_lossy())
                .unwrap_or_default()
                .to_lowercase();
            let is_playing = session
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
                .map(|st| st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false);
            let is_ytmd = app_id.contains("youtube")
                || app_id.contains("ytmd")
                || app_id.contains("th-ch");

            if is_ytmd && is_playing {
                return Some(session);
            }
            if is_ytmd && ytmd_session.is_none() {
                ytmd_session = Some(session.clone());
            }
            if is_playing && playing_session.is_none() {
                playing_session = Some(session);
            }
        }

        if let Ok(current) = manager.GetCurrentSession() {
            return Some(current);
        }
        if ytmd_session.is_some() {
            return ytmd_session;
        }
        if playing_session.is_some() {
            return playing_session;
        }
        if count > 0 {
            return sessions.GetAt(0).ok();
        }
    }

    manager.GetCurrentSession().ok()
}

#[cfg(target_os = "windows")]
fn read_thumbnail_base64(thumb_ref: &IRandomAccessStreamReference) -> Option<String> {
    let stream = thumb_ref.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 12 * 1024 * 1024 {
        let _ = stream.Close();
        return None;
    }

    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
    if loaded == 0 {
        let _ = reader.Close();
        let _ = stream.Close();
        return None;
    }

    let mut bytes = vec![0u8; loaded as usize];
    if reader.ReadBytes(&mut bytes).is_err() {
        let _ = reader.Close();
        let _ = stream.Close();
        return None;
    }
    let _ = reader.Close();
    let _ = stream.Close();

    Some(format!("data:image/jpeg;base64,{}", encode_base64(&bytes)))
}

#[cfg(target_os = "windows")]
fn map_playback_status(status: GlobalSystemMediaTransportControlsSessionPlaybackStatus) -> String {
    match status {
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing => "Playing".to_string(),
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused => "Paused".to_string(),
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped => "Stopped".to_string(),
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed => "Closed".to_string(),
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened
        | GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing => "Paused".to_string(),
        _ => "Stopped".to_string(),
    }
}

pub fn get_current_media_track() -> Result<Option<MediaTrackInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|e| format!("Ошибка запроса GSMTC SessionManager: {e}"))?
            .get()
            .map_err(|e| format!("Ошибка инициализации GSMTC SessionManager: {e}"))?;

        let Some(session) = resolve_active_session(&manager) else {
            return Ok(None);
        };

        let source_app_id = session
            .SourceAppUserModelId()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default();

        let playback_status = session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .map(map_playback_status)
            .unwrap_or_else(|_| "Stopped".to_string());

        let (title, artist, album, thumb_ref) = match session
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.get())
        {
            Ok(props) => {
                let title = props.Title().map(|s| s.to_string_lossy()).unwrap_or_default();
                let artist = props.Artist().map(|s| s.to_string_lossy()).unwrap_or_default();
                let album = props
                    .AlbumTitle()
                    .map(|s| s.to_string_lossy())
                    .unwrap_or_default();
                let thumb = props.Thumbnail().ok();
                (title, artist, album, thumb)
            }
            Err(_) => (String::new(), String::new(), String::new(), None),
        };

        if title.trim().is_empty() && artist.trim().is_empty() && playback_status == "Closed" {
            return Ok(None);
        }

        let mut position_secs = 0.0;
        let mut duration_secs = 0.0;

        if let Ok(timeline) = session.GetTimelineProperties() {
            let start_ticks = timeline.StartTime().map(|t| t.Duration).unwrap_or(0).max(0);
            let end_ticks = timeline.EndTime().map(|t| t.Duration).unwrap_or(0).max(0);
            let pos_ticks = timeline.Position().map(|t| t.Duration).unwrap_or(0).max(0);

            if end_ticks > start_ticks {
                duration_secs = (end_ticks - start_ticks) as f64 / TICKS_PER_SECOND;
            }
            if pos_ticks >= start_ticks {
                position_secs = (pos_ticks - start_ticks) as f64 / TICKS_PER_SECOND;
            }

            if playback_status == "Playing" {
                if let Ok(last_updated) = timeline.LastUpdatedTime() {
                    if last_updated.UniversalTime > WINDOWS_TO_UNIX_EPOCH_TICKS {
                        if let Ok(now_unix) =
                            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        {
                            let now_ticks = WINDOWS_TO_UNIX_EPOCH_TICKS
                                + (now_unix.as_secs_f64() * TICKS_PER_SECOND) as i64;
                            let delta_ticks = now_ticks - last_updated.UniversalTime;
                            if delta_ticks > 0 {
                                let delta_secs = delta_ticks as f64 / TICKS_PER_SECOND;
                                if delta_secs <= 3600.0 {
                                    position_secs += delta_secs;
                                }
                            }
                        }
                    }
                }
            }

            if duration_secs > 0.0 && position_secs > duration_secs {
                position_secs = duration_secs;
            }
        }

        let cache_key = format!("{source_app_id}|{title}|{artist}|{album}");
        let cached_cover = cover_cache()
            .lock()
            .ok()
            .and_then(|guard| (guard.key == cache_key).then(|| guard.data_url.clone()).flatten());

        let cover_base64 = if cached_cover.is_some() {
            cached_cover
        } else {
            let loaded = thumb_ref.as_ref().and_then(read_thumbnail_base64);
            if let Ok(mut guard) = cover_cache().lock() {
                guard.key = cache_key;
                guard.data_url = loaded.clone();
            }
            loaded
        };

        Ok(Some(MediaTrackInfo {
            title,
            artist,
            album,
            playback_status,
            position_secs,
            duration_secs,
            cover_base64,
            source_app_id,
        }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
fn with_active_session<F>(action: F) -> Result<(), String>
where
    F: FnOnce(&GlobalSystemMediaTransportControlsSession) -> Result<(), String>,
{
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| format!("Ошибка запроса GSMTC SessionManager: {e}"))?
        .get()
        .map_err(|e| format!("Ошибка инициализации GSMTC SessionManager: {e}"))?;

    let session = resolve_active_session(&manager)
        .ok_or_else(|| "Активная медиа-сессия не найдена".to_string())?;

    action(&session)
}

pub fn media_play_pause() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        with_active_session(|session| {
            session
                .TryTogglePlayPauseAsync()
                .map_err(|e| format!("Ошибка переключения воспроизведения: {e}"))?
                .get()
                .map_err(|e| format!("Ошибка выполнения Play/Pause: {e}"))?;
            Ok(())
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("GSMTC поддерживается только на Windows".to_string())
    }
}

pub fn media_next() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        with_active_session(|session| {
            session
                .TrySkipNextAsync()
                .map_err(|e| format!("Ошибка переключения на следующий трек: {e}"))?
                .get()
                .map_err(|e| format!("Ошибка выполнения SkipNext: {e}"))?;
            Ok(())
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("GSMTC поддерживается только на Windows".to_string())
    }
}

pub fn media_previous() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        with_active_session(|session| {
            session
                .TrySkipPreviousAsync()
                .map_err(|e| format!("Ошибка переключения на предыдущий трек: {e}"))?
                .get()
                .map_err(|e| format!("Ошибка выполнения SkipPrevious: {e}"))?;
            Ok(())
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("GSMTC поддерживается только на Windows".to_string())
    }
}

pub fn media_seek(position_secs: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if !position_secs.is_finite() || position_secs < 0.0 {
            return Err("Некорректная позиция перемотки".to_string());
        }
        let ticks = (position_secs * TICKS_PER_SECOND).round() as i64;
        with_active_session(|session| {
            session
                .TryChangePlaybackPositionAsync(ticks)
                .map_err(|e| format!("Ошибка перемотки трека: {e}"))?
                .get()
                .map_err(|e| format!("Ошибка применения позиции трека: {e}"))?;
            Ok(())
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = position_secs;
        Err("GSMTC поддерживается только на Windows".to_string())
    }
}
