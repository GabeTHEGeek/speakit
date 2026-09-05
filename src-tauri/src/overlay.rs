use tauri::{Emitter, Manager};

use crate::{insertion::ActiveTarget, logging::append_log};

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
    const OVERLAY_WIDTH: f64 = 258.0;
    const OVERLAY_HEIGHT: f64 = 62.0;
    const BOTTOM_MARGIN: f64 = 20.0;
    (
        work_x + (work_width - OVERLAY_WIDTH) / 2.0,
        work_y + work_height - OVERLAY_HEIGHT - BOTTOM_MARGIN,
    )
}

#[tauri::command]
pub(crate) fn show_overlay(
    app: tauri::AppHandle,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<(), String> {
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
pub(crate) fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
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
pub(crate) fn main_window_target(app: tauri::AppHandle) -> Result<ActiveTarget, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_is_bottom_centered_on_a_monitor_left_of_primary() {
        let (x, y) = centered_overlay_position(-1920.0, 0.0, 1920.0, 1080.0);
        assert_eq!(x, -1089.0);
        assert_eq!(y, 998.0);
    }
}
