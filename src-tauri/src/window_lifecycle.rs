use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{WebviewWindow, Window};

use crate::logging::append_log;

static MAIN_WINDOW_PARKED: AtomicBool = AtomicBool::new(false);

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
