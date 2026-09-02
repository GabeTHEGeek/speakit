use serde::Serialize;
use std::process::Command;

use crate::{logging::append_log, permissions::accessibility_ready};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteResult {
    focused_role: String,
    focused_subrole: String,
}

fn text_for_paste(text: &str) -> String {
    let mut output = text.trim_end().to_string();
    output.push(' ');
    output
}

#[tauri::command]
pub(crate) fn paste_text(
    text: String,
    app_name: String,
    target_pid: i32,
) -> Result<PasteResult, String> {
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
pub(crate) fn frontmost_app() -> Result<String, String> {
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
pub(crate) struct ActiveTarget {
    pub(crate) app_name: String,
    pub(crate) pid: i32,
    pub(crate) anchor_x: f64,
    pub(crate) anchor_y: f64,
}

fn parse_active_target(value: &str) -> ActiveTarget {
    let mut parts = value.trim().splitn(4, "||");
    ActiveTarget {
        pid: parts.next().unwrap_or("0").parse::<i32>().unwrap_or(0),
        app_name: parts.next().unwrap_or_default().to_string(),
        anchor_x: parts.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0),
        anchor_y: parts.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0),
    }
}

#[tauri::command]
pub(crate) fn frontmost_target() -> Result<ActiveTarget, String> {
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
pub(crate) fn erase_trigger_space() -> Result<(), String> {
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
pub(crate) struct FocusTarget {
    app_name: String,
    role: String,
    can_paste: bool,
}

#[tauri::command]
pub(crate) fn focused_text_target() -> Result<FocusTarget, String> {
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
    fn consecutive_dictation_is_pasted_with_one_separator_space() {
        assert_eq!(text_for_paste("Next sentence."), "Next sentence. ");
        assert_eq!(text_for_paste("Next sentence.   "), "Next sentence. ");
    }
}
