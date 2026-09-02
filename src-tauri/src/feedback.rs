use std::process::{Command, Stdio};

use crate::logging::append_log;

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
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
pub(crate) fn play_activation_sound() -> Result<(), String> {
    play_feedback_sound("start", "/System/Library/Sounds/Ping.aiff", "0.62", "0.55")
}

#[tauri::command]
pub(crate) fn play_stop_sound() -> Result<(), String> {
    play_feedback_sound("stop", "/System/Library/Sounds/Pop.aiff", "0.58", "0.40")
}
