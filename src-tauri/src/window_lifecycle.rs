use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WebviewWindow, Window};

use crate::{insertion::activate_process, logging::append_log};

static MAIN_WINDOW_PARKED: AtomicBool = AtomicBool::new(false);
static AUDIO_HOST_WOKEN: AtomicBool = AtomicBool::new(false);

pub(crate) fn park_main_window(window: &Window) -> Result<(), String> {
    set_native_window_state(window.ns_window().map_err(|error| error.to_string())?, true);
    window
        .set_focusable(false)
        .map_err(|error| error.to_string())?;
    MAIN_WINDOW_PARKED.store(true, Ordering::Release);
    append_log(
        "window.parked",
        "close button; invisible audio host remains awake",
    );
    Ok(())
}

pub(crate) fn restore_main_window(window: &WebviewWindow) -> Result<(), String> {
    set_native_window_state(
        window.ns_window().map_err(|error| error.to_string())?,
        false,
    );
    window
        .set_focusable(true)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    MAIN_WINDOW_PARKED.store(false, Ordering::Release);
    append_log("window.reopened", "dock icon; restored parked window");
    Ok(())
}

pub(crate) fn main_window_is_parked() -> bool {
    MAIN_WINDOW_PARKED.load(Ordering::Acquire)
}

#[tauri::command]
pub(crate) fn wake_audio_host(app: tauri::AppHandle) -> Result<bool, String> {
    if !main_window_is_parked() {
        return Ok(false);
    }
    let window = app
        .get_webview_window("main")
        .ok_or("SpeakIt audio host is unavailable")?;
    window
        .set_focusable(true)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    AUDIO_HOST_WOKEN.store(true, Ordering::Release);
    append_log(
        "microphone.host.woken",
        "parked webview focused invisibly for microphone reacquisition",
    );
    Ok(true)
}

#[tauri::command]
pub(crate) fn release_audio_host(app: tauri::AppHandle, target_pid: i32) -> Result<(), String> {
    if !AUDIO_HOST_WOKEN.swap(false, Ordering::AcqRel) || !main_window_is_parked() {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("SpeakIt audio host is unavailable")?;
    window
        .set_focusable(false)
        .map_err(|error| error.to_string())?;
    activate_process(target_pid)?;
    append_log(
        "microphone.host.released",
        &format!("parked webview returned focus to pid={target_pid}"),
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_native_window_state(pointer: *mut std::ffi::c_void, parked: bool) {
    // SAFETY: Tauri owns this NSWindow for the full lifetime of WebviewWindow,
    // and window lifecycle callbacks run on the macOS main thread.
    let native: &objc2::runtime::AnyObject = unsafe { &*pointer.cast() };
    let alpha = if parked { 0.001_f64 } else { 1.0_f64 };
    unsafe {
        let _: () = objc2::msg_send![native, setIgnoresMouseEvents: parked];
        let _: () = objc2::msg_send![native, setAlphaValue: alpha];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_native_window_state(_pointer: *mut std::ffi::c_void, _parked: bool) {}
