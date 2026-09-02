use serde::Serialize;

use crate::{
    logging::log_path,
    permissions::{accessibility_ready, app_install_location},
    speech::model_path,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticReport {
    version: String,
    accessibility_ready: bool,
    model_ready: bool,
    model_size_mb: f64,
    install_location: String,
    executable_path: String,
    log_path: String,
    recent_log: String,
}

#[tauri::command]
pub(crate) fn diagnostics() -> DiagnosticReport {
    let model = model_path().unwrap_or_default();
    let model_size = std::fs::metadata(&model).map(|m| m.len()).unwrap_or(0);
    let log = log_path().unwrap_or_default();
    let contents = std::fs::read_to_string(&log).unwrap_or_default();
    let mut lines: Vec<&str> = contents.lines().rev().take(80).collect();
    lines.reverse();
    DiagnosticReport {
        version: env!("CARGO_PKG_VERSION").into(),
        accessibility_ready: accessibility_ready(),
        model_ready: model.is_file(),
        model_size_mb: model_size as f64 / 1_048_576.0,
        install_location: app_install_location(),
        executable_path: std::env::current_exe()
            .unwrap_or_default()
            .display()
            .to_string(),
        log_path: log.display().to_string(),
        recent_log: lines.join("\n"),
    }
}
