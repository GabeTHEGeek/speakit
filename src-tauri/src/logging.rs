use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn log_path() -> Result<PathBuf, String> {
    let mut path = dirs::data_local_dir().ok_or("Could not find the app data folder")?;
    path.push("SpeakIt");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("speakit.log");
    Ok(path)
}

pub(crate) fn append_log(event: &str, details: &str) {
    let Ok(path) = log_path() else { return };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let clean = details.replace(['\n', '\r'], " ");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{timestamp:.3}\t{event}\t{clean}");
    }
}

#[tauri::command]
pub(crate) fn log_event(event: String, details: Option<String>) {
    append_log(&event, details.as_deref().unwrap_or(""));
}
