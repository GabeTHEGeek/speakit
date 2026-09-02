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

fn position_overlay_window(
    app: &tauri::AppHandle,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or("Waveform window is unavailable")?;
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let active_monitor = monitors.into_iter().find(|monitor| {
        let scale = monitor.scale_factor();
        let position = monitor.position();
        let size = monitor.size();
        let logical_x = position.x as f64 / scale;
        let logical_y = position.y as f64 / scale;
        let logical_width = size.width as f64 / scale;
        let logical_height = size.height as f64 / scale;
        anchor_x >= logical_x
            && anchor_x < logical_x + logical_width
            && anchor_y >= logical_y
            && anchor_y < logical_y + logical_height
    });
    let selected_monitor = match active_monitor {
        Some(monitor) => Some(monitor),
        None => {
            append_log(
                "overlay.monitor.fallback",
                &format!("anchor_x={anchor_x:.1} anchor_y={anchor_y:.1}"),
            );
            window.primary_monitor().map_err(|e| e.to_string())?
        }
    };
    if let Some(monitor) = selected_monitor {
        let scale = monitor.scale_factor();
        let work_area = monitor.work_area();
        let logical_work_x = work_area.position.x as f64 / scale;
        let logical_work_y = work_area.position.y as f64 / scale;
        let logical_work_width = work_area.size.width as f64 / scale;
        let logical_work_height = work_area.size.height as f64 / scale;
        let (x, y) = centered_overlay_position(
            logical_work_x,
            logical_work_y,
            logical_work_width,
            logical_work_height,
        );
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        append_log(
            "overlay.positioned",
            &format!(
                "monitor={} x={x:.1} y={y:.1} anchor_x={anchor_x:.1} anchor_y={anchor_y:.1} work_x={logical_work_x:.1} work_y={logical_work_y:.1} work_width={logical_work_width:.1} work_height={logical_work_height:.1} scale={scale:.2}",
                monitor.name().map(String::as_str).unwrap_or("unknown")
            ),
        );
    }
    Ok(())
}

fn centered_overlay_position(
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
) -> (f64, f64) {
    const OVERLAY_WIDTH: f64 = 352.0;
    const OVERLAY_HEIGHT: f64 = 88.0;
    const BOTTOM_MARGIN: f64 = 20.0;
    (
        work_x + (work_width - OVERLAY_WIDTH) / 2.0,
        work_y + work_height - OVERLAY_HEIGHT - BOTTOM_MARGIN,
    )
}

#[tauri::command]
fn show_overlay(app: tauri::AppHandle, anchor_x: f64, anchor_y: f64) -> Result<(), String> {
    position_overlay_window(&app, anchor_x, anchor_y)?;
    app.emit_to("overlay", "overlay-visibility", true)
        .map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window("overlay")
        .ok_or("Waveform window is unavailable")?;
    window.show().map_err(|e| e.to_string())?;
    append_log("overlay.shown", "native window visible");
    Ok(())
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    app.emit_to("overlay", "overlay-visibility", false)
        .map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window("overlay")
        .ok_or("Waveform window is unavailable")?;
    window.hide().map_err(|e| e.to_string())?;
    append_log("overlay.hidden", "native window sleeping");
    Ok(())
}

#[tauri::command]
fn main_window_target(app: tauri::AppHandle) -> Result<ActiveTarget, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("SpeakIt window is unavailable")?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Could not identify the SpeakIt monitor")?;
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    Ok(ActiveTarget {
        app_name: "SpeakIt".into(),
        pid: std::process::id() as i32,
        anchor_x: position.x as f64 / scale + size.width as f64 / scale / 2.0,
        anchor_y: position.y as f64 / scale + size.height as f64 / scale / 2.0,
    })
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

fn play_feedback_sound(
    name: &'static str,
    file: &'static str,
    volume: &'static str,
    duration: &'static str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut playback = Command::new("/usr/bin/afplay")
            .args(["--volume", volume, "--time", duration, file])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not play the {name} sound: {e}"))?;
        append_log(
            &format!("sound.{name}.started"),
            &format!("volume={volume} duration={duration}s file={file}"),
        );
        std::thread::spawn(move || match playback.wait() {
            Ok(status) if status.success() => {
                append_log(&format!("sound.{name}.complete"), "status=success")
            }
            Ok(status) => append_log(&format!("sound.{name}.failed"), &format!("status={status}")),
            Err(error) => append_log(&format!("sound.{name}.failed"), &error.to_string()),
        });
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
fn play_activation_sound() -> Result<(), String> {
    play_feedback_sound("start", "/System/Library/Sounds/Ping.aiff", "0.62", "0.55")
}

#[tauri::command]
fn play_stop_sound() -> Result<(), String> {
    play_feedback_sound("stop", "/System/Library/Sounds/Pop.aiff", "0.58", "0.40")
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
        &format!("samples={} threads=4", samples.len()),
    );
    let result: Result<String, String> =
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let context = whisper_context()?;
            let mut state = context.create_state().map_err(|e| e.to_string())?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("en"));
            // Four performance cores are consistently faster than spreading this
            // short interactive workload across every M-series core.
            params.set_n_threads(4);
            params.set_no_context(true);
            params.set_no_timestamps(true);
            params.set_single_segment(true);
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
            Ok(finalize_transcript(&result))
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

fn text_for_paste(text: &str) -> String {
    let mut output = text.trim_end().to_string();
    output.push(' ');
    output
}

fn finalize_transcript(text: &str) -> String {
    let mut output = text.trim().to_string();
    if output.is_empty() {
        return output;
    }
    let sound_label = output
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if matches!(
        sound_label.as_str(),
        "beep"
            | "beep beep"
            | "ping"
            | "pop"
            | "chime"
            | "bell"
            | "bell rings"
            | "music"
            | "blank audio"
            | "silence"
    ) {
        append_log(
            "transcription.native.filtered",
            &format!("label={sound_label}"),
        );
        return String::new();
    }
    let has_terminal_punctuation = output
        .trim_end_matches(['"', '\'', ')', ']', '}'])
        .ends_with(['.', '!', '?', '…']);
    if !has_terminal_punctuation {
        output.push('.');
    }
    output
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
    clipboard
        .set_text(text_for_paste(&text))
        .map_err(|e| e.to_string())?;

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
  delay 0.06
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
    anchor_x: f64,
    anchor_y: f64,
}

fn parse_active_target(value: &str) -> ActiveTarget {
    let mut parts = value.trim().splitn(4, "||");
    let pid = parts.next().unwrap_or("0").parse::<i32>().unwrap_or(0);
    let app_name = parts.next().unwrap_or_default().to_string();
    let anchor_x = parts.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
    let anchor_y = parts.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
    ActiveTarget {
        app_name,
        pid,
        anchor_x,
        anchor_y,
    }
}

#[tauri::command]
fn frontmost_target() -> Result<ActiveTarget, String> {
    let script = r#"
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set anchorX to 0
  set anchorY to 0
  try
    set windowPosition to position of front window of frontProcess
    set windowSize to size of front window of frontProcess
    set anchorX to (item 1 of windowPosition) + ((item 1 of windowSize) / 2)
    set anchorY to (item 2 of windowPosition) + ((item 2 of windowSize) / 2)
  end try
  return (unix id of frontProcess as string) & "||" & (name of frontProcess) & "||" & (anchorX as string) & "||" & (anchorY as string)
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
    let target = parse_active_target(&value);
    append_log(
        "target.captured",
        &format!(
            "app={} pid={} anchor_x={:.1} anchor_y={:.1}",
            target.app_name, target.pid, target.anchor_x, target.anchor_y
        ),
    );
    Ok(target)
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    append_log("window.hidden", "close button; app remains active");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            model_ready,
            prepare_model,
            download_model,
            transcribe,
            play_activation_sound,
            play_stop_sound,
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
            main_window_target,
            log_event,
            diagnostics
        ])
        .build(tauri::generate_context!())
        .expect("error while building SpeakIt");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if !has_visible_windows {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    append_log("window.reopened", "dock icon; no visible windows");
                }
            } else {
                append_log("window.reopen.ignored", "another SpeakIt window is visible");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_target_parser_preserves_monitor_coordinates() {
        let target = parse_active_target("90220||Google Chrome||-1889.0||713.0\n");
        assert_eq!(target.pid, 90220);
        assert_eq!(target.app_name, "Google Chrome");
        assert_eq!(target.anchor_x, -1889.0);
        assert_eq!(target.anchor_y, 713.0);
    }

    #[test]
    fn overlay_is_bottom_centered_on_a_monitor_left_of_primary() {
        let (x, y) = centered_overlay_position(-1920.0, 0.0, 1920.0, 1080.0);
        assert_eq!(x, -1136.0);
        assert_eq!(y, 972.0);
    }

    #[test]
    fn consecutive_dictation_is_pasted_with_one_separator_space() {
        assert_eq!(text_for_paste("Next sentence."), "Next sentence. ");
        assert_eq!(text_for_paste("Next sentence.   "), "Next sentence. ");
    }

    #[test]
    fn transcription_always_has_terminal_punctuation() {
        assert_eq!(
            finalize_transcript("This is a sentence"),
            "This is a sentence."
        );
        assert_eq!(finalize_transcript("Is this ready?"), "Is this ready?");
        assert_eq!(finalize_transcript("Yes!"), "Yes!");
        assert_eq!(finalize_transcript(""), "");
    }

    #[test]
    fn isolated_sound_labels_are_not_pasted() {
        assert_eq!(finalize_transcript("(beep)"), "");
        assert_eq!(finalize_transcript("[PING]"), "");
        assert_eq!(
            finalize_transcript("The beep means recording started"),
            "The beep means recording started."
        );
    }

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
