#[cfg(target_os = "macos")]
use core_foundation::{
    base::TCFType,
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::CFString,
};
use std::process::Command;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

#[tauri::command]
pub(crate) fn accessibility_ready() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        AXIsProcessTrusted()
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
pub(crate) fn app_install_location() -> String {
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
pub(crate) fn request_accessibility_permission() -> Result<(), String> {
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
