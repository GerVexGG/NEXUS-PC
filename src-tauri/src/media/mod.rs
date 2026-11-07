pub mod session;

pub use session::MediaTrackInfo;

#[tauri::command]
pub async fn get_media_track() -> Result<Option<MediaTrackInfo>, String> {
    tauri::async_runtime::spawn_blocking(session::get_current_media_track)
        .await
        .map_err(|e| format!("Ошибка потока чтения медиа-сессии: {e}"))?
}

#[tauri::command]
pub async fn media_play_pause() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(session::media_play_pause)
        .await
        .map_err(|e| format!("Ошибка потока Play/Pause: {e}"))?
}

#[tauri::command]
pub async fn media_next() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(session::media_next)
        .await
        .map_err(|e| format!("Ошибка потока переключения трека: {e}"))?
}

#[tauri::command]
pub async fn media_previous() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(session::media_previous)
        .await
        .map_err(|e| format!("Ошибка потока возврата трека: {e}"))?
}

#[tauri::command]
pub async fn media_seek(position_secs: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || session::media_seek(position_secs))
        .await
        .map_err(|e| format!("Ошибка потока перемотки трека: {e}"))?
}
