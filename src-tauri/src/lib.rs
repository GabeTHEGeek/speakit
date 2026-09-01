#[cfg(target_os = "macos")]
use core_foundation::{
    base::TCFType,
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::CFString,
};
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin";
static WHISPER_CONTEXT: OnceLock<WhisperContext> = OnceLock::new();

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

#[tauri::command]
fn accessibility_ready() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        AXIsProcessTrusted()
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn app_install_location() -> String {
    let path = std::env::current_exe().unwrap_or_default();
    let value = path.to_string_lossy();
    if value.starts_with("/Volumes/") {
        "disk-image".into()
    } else if value.starts_with("/Applications/") {
        "applications".into()
    } else {
        "other".into()
    }
}

#[tauri::command]
fn request_accessibility_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let options = CFDictionary::from_CFType_pairs(&[(
            CFString::new("AXTrustedCheckOptionPrompt"),
            CFBoolean::true_value(),
        )]);
        if unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) } {
            return Ok(());
        }
    }
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn()
        .map_err(|e| format!("Could not open Accessibility settings: {e}"))?;
    Ok(())
}

#[tauri::command]
fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or("Waveform window is unavailable")?;
    if let Some(monitor) = window.primary_monitor().map_err(|e| e.to_string())? {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let origin = monitor.position();
        let width = (310.0 * scale) as i32;
        let height = (92.0 * scale) as i32;
        let x = origin.x + (size.width as i32 - width) / 2;
        let y = origin.y + size.height as i32 - height - (26.0 * scale) as i32;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("overlay")
        .ok_or("Waveform window is unavailable")?
        .hide()
        .map_err(|e| e.to_string())
}

fn model_path() -> Result<PathBuf, String> {
    let mut path = dirs::data_local_dir().ok_or("Could not find the app data folder")?;
    path.push("SpeakIt");
    path.push("models");
    path.push("ggml-small.en.bin");
    Ok(path)
}

fn whisper_context() -> Result<&'static WhisperContext, String> {
    if let Some(context) = WHISPER_CONTEXT.get() {
        return Ok(context);
    }
    let path = model_path()?;
    if !path.is_file() {
        return Err("The speech model has not finished downloading".into());
    }
    let context = WhisperContext::new_with_params(
        path.to_str().ok_or("Invalid model path")?,
        WhisperContextParameters::default(),
    )
    .map_err(|e| format!("Could not load Whisper: {e}"))?;
    let _ = WHISPER_CONTEXT.set(context);
    WHISPER_CONTEXT
        .get()
        .ok_or_else(|| "Could not keep the speech model ready".into())
}

fn log_path() -> Result<PathBuf, String> {
    let mut path = dirs::data_local_dir().ok_or("Could not find the app data folder")?;
    path.push("SpeakIt");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("speakit.log");
    Ok(path)
}

fn append_log(event: &str, details: &str) {
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
fn log_event(event: String, details: Option<String>) {
    append_log(&event, details.as_deref().unwrap_or(""));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
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
fn diagnostics() -> DiagnosticReport {
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

#[tauri::command]
fn model_ready() -> Result<bool, String> {
    Ok(model_path()?.is_file())
}

#[tauri::command]
async fn prepare_model() -> Result<(), String> {
    append_log("model.prepare.start", "");
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(|| whisper_context().map(|_| ()))
        .await
        .map_err(|e| e.to_string())?;
    match &result {
        Ok(()) => append_log(
            "model.prepare.complete",
            &format!("elapsed_ms={}", started.elapsed().as_millis()),
        ),
        Err(error) => append_log("model.prepare.failed", error),
    }
    result
}

#[tauri::command]
fn play_activation_sound() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/afplay")
            .args([
                "--volume",
                "0.18",
                "--time",
                "0.16",
                "/System/Library/Sounds/Tink.aiff",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not play the activation sound: {e}"))?;
        append_log("sound.activation.played", "volume=0.18 duration=0.16s");
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
async fn download_model(app: tauri::AppHandle) -> Result<(), String> {
    append_log("model.download.start", MODEL_URL);
    let path = model_path()?;
    if path.is_file() {
        return Ok(());
    }
    let parent = path.parent().ok_or("Invalid model path")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let response = reqwest::get(MODEL_URL)
        .await
        .map_err(|e| format!("Model download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Model download returned {}", response.status()));
    }
    let temporary = path.with_extension("download");
    let total = response.content_length().unwrap_or(0);
    let mut received = 0_u64;
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if total > 0 {
            let _ = app.emit_to(
                "main",
                "model-download-progress",
                received as f64 / total as f64 * 100.0,
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(temporary, path)
        .await
        .map_err(|e| e.to_string())?;
    append_log("model.download.complete", "ok");
    Ok(())
}

#[tauri::command]
async fn transcribe(samples: Vec<f32>) -> Result<String, String> {
    let started = Instant::now();
    append_log(
        "transcription.native.start",
        &format!("samples={}", samples.len()),
    );
    let result: Result<String, String> =
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let context = whisper_context()?;
            let mut state = context.create_state().map_err(|e| e.to_string())?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("en"));
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_suppress_blank(true);
            state
                .full(params, &samples)
                .map_err(|e| format!("Transcription failed: {e}"))?;
            let count = state.full_n_segments().map_err(|e| e.to_string())?;
            let mut result = String::new();
            for index in 0..count {
                result.push_str(
                    &state
                        .full_get_segment_text(index)
                        .map_err(|e| e.to_string())?,
                );
            }
            Ok(result.trim().to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    match &result {
        Ok(text) => append_log(
            "transcription.native.complete",
            &format!(
                "chars={} elapsed_ms={}",
                text.len(),
                started.elapsed().as_millis()
            ),
        ),
        Err(error) => append_log("transcription.native.failed", error),
    }
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteResult {
    focused_role: String,
    focused_subrole: String,
}

#[tauri::command]
fn paste_text(text: String, app_name: String, target_pid: i32) -> Result<PasteResult, String> {
    append_log(
        "paste.start",
        &format!("app={app_name} pid={target_pid} chars={}", text.len()),
    );
    if !accessibility_ready() {
        append_log("paste.denied", "AXIsProcessTrusted=false");
        return Err(
            "Accessibility access is not enabled for this installed copy of SpeakIt".into(),
        );
    }
    if target_pid <= 0 {
        append_log("paste.failed", "target pid is missing");
        return Err("SpeakIt could not identify the app that had focus".into());
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;

    // System Events performs both activation and paste in one accessibility-aware
    // transaction. It is more reliable for browser fields than posting raw HID
    // events immediately after changing the frontmost application.
    let paste_script = r#"
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
  end tell
  delay 0.12
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set focusedRole to "unknown"
    set focusedSubrole to ""
    try
      set focusedElement to value of attribute "AXFocusedUIElement" of targetProcess
      set focusedRole to value of attribute "AXRole" of focusedElement
      try
        set focusedSubrole to value of attribute "AXSubrole" of focusedElement
      end try
    end try
    keystroke "v" using {command down}
  end tell
  return focusedRole & "||" & focusedSubrole
end run
"#;
    let pid = target_pid.to_string();
    let output = Command::new("osascript")
        .args(["-e", paste_script, "--", &pid])
        .output()
        .map_err(|e| {
            let message = format!("Could not run the paste helper: {e}");
            append_log("paste.failed", &message);
            message
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        append_log(
            "paste.failed",
            &format!("app={app_name} pid={target_pid} error={detail}"),
        );
        return Err(if detail.is_empty() {
            format!("Could not paste into {app_name}")
        } else {
            format!("Could not paste into {app_name}: {detail}")
        });
    }
    let response = String::from_utf8_lossy(&output.stdout);
    let mut parts = response.trim().splitn(2, "||");
    let focused_role = parts.next().unwrap_or("unknown").to_string();
    let focused_subrole = parts.next().unwrap_or_default().to_string();
    append_log(
        "paste.complete",
        &format!("app={app_name} pid={target_pid} role={focused_role} subrole={focused_subrole}"),
    );
    Ok(PasteResult {
        focused_role,
        focused_subrole,
    })
}

#[tauri::command]
fn frontmost_app() -> Result<String, String> {
    let output = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Could not identify the active application".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTarget {
    app_name: String,
    pid: i32,
}

#[tauri::command]
fn frontmost_target() -> Result<ActiveTarget, String> {
    let script = r#"
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  return (unix id of frontProcess as string) & "||" & (name of frontProcess)
end tell
"#;
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Could not identify the active application".into());
    }
    let value = String::from_utf8_lossy(&output.stdout);
    let mut parts = value.trim().splitn(2, "||");
    let pid = parts.next().unwrap_or("0").parse::<i32>().unwrap_or(0);
    let app_name = parts.next().unwrap_or_default().to_string();
    Ok(ActiveTarget { app_name, pid })
}

#[tauri::command]
fn erase_trigger_space() -> Result<(), String> {
    let script = r#"
on run
  tell application "System Events"
    delay 0.08
    key code 51
  end tell
end run
"#;
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("SpeakIt needs Accessibility permission to handle this shortcut".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusTarget {
    app_name: String,
    role: String,
    can_paste: bool,
}

#[tauri::command]
fn focused_text_target() -> Result<FocusTarget, String> {
    let script = r#"
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set appName to name of frontProcess
  try
    set focusedElement to value of attribute "AXFocusedUIElement" of frontProcess
    set elementRole to value of attribute "AXRole" of focusedElement
    set isEditable to false
    try
      set isEditable to value of attribute "AXEditable" of focusedElement
    end try
    return appName & "||" & elementRole & "||" & (isEditable as string)
  on error
    return appName & "||unknown||false"
  end try
end tell
"#;
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Accessibility permission is required to detect the focused text box".into());
    }
    let value = String::from_utf8_lossy(&output.stdout);
    let mut parts = value.trim().split("||");
    let app_name = parts.next().unwrap_or_default().to_string();
    let role = parts.next().unwrap_or("unknown").to_string();
    let _editable = parts.next().unwrap_or("false").eq_ignore_ascii_case("true");
    let can_paste = !app_name.is_empty() && app_name != "SpeakIt";
    Ok(FocusTarget {
        app_name,
        role,
        can_paste,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            model_ready,
            prepare_model,
            download_model,
            transcribe,
            play_activation_sound,
            paste_text,
            erase_trigger_space,
            focused_text_target,
            frontmost_app,
            frontmost_target,
            accessibility_ready,
            request_accessibility_permission,
            app_install_location,
            show_overlay,
            hide_overlay,
            log_event,
            diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running SpeakIt");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_whisper_model_can_transcribe_audio() {
        let path = model_path().expect("model path");
        assert!(path.is_file(), "local Whisper model is missing");
        let context = whisper_context().expect("Whisper model should load");
        let cached_context = whisper_context().expect("Whisper model should remain loaded");
        assert!(std::ptr::eq(context, cached_context));
        let mut state = context.create_state().expect("Whisper state");
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state
            .full(params, &vec![0.0_f32; 32_000])
            .expect("Whisper should accept 16 kHz mono audio");
    }
}
