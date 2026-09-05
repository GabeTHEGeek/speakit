mod canary;
mod diagnostics;
mod feedback;
mod insertion;
mod logging;
mod overlay;
mod permissions;
mod speech;

use canary::{canary_ready, download_canary_model, prepare_canary_model};
use diagnostics::diagnostics;
use feedback::{play_activation_sound, play_stop_sound};
use insertion::{
    erase_trigger_space, focused_text_target, frontmost_app, frontmost_target, paste_text,
};
use logging::{append_log, log_event};
use overlay::{hide_overlay, main_window_target, show_overlay};
use permissions::{accessibility_ready, app_install_location, request_accessibility_permission};
use speech::{download_model, model_ready, prepare_model, transcribe};
use tauri::Manager;

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
            canary_ready,
            download_canary_model,
            prepare_canary_model,
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
