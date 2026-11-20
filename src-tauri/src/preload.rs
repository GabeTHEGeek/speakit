//! Loads the speech model in the background as soon as SpeakIt launches.
//!
//! The engine choice lives in the webview's localStorage, which Rust cannot
//! read before the page loads. Instead, every successful prepare records the
//! engine in a small file, and the next launch preloads that engine while the
//! webview is still starting. The webview's own prepare call then finds the
//! model already loaded, or waits on the same in-progress load.

use std::{path::PathBuf, time::Instant};

use crate::logging::append_log;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Engine {
    Canary,
    Whisper,
}

impl Engine {
    fn as_str(self) -> &'static str {
        match self {
            Engine::Canary => "canary",
            Engine::Whisper => "whisper",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "canary" => Some(Engine::Canary),
            "whisper" => Some(Engine::Whisper),
            _ => None,
        }
    }
}

fn engine_file() -> Option<PathBuf> {
    let mut path = dirs::data_local_dir()?;
    path.push("SpeakIt");
    path.push("preferred-engine");
    Some(path)
}

pub(crate) fn remember_engine(engine: Engine) {
    let Some(path) = engine_file() else { return };
    if std::fs::read_to_string(&path)
        .ok()
        .as_deref()
        .and_then(Engine::parse)
        == Some(engine)
    {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(&path, engine.as_str()) {
        append_log("preload.remember.failed", &error.to_string());
    }
}

/// Picks the engine to preload. With no remembered choice, only preload when
/// exactly one engine is installed, since that is the only one the app can use.
fn choose_engine(
    remembered: Option<Engine>,
    canary_installed: bool,
    whisper_installed: bool,
) -> Option<Engine> {
    match remembered {
        Some(Engine::Canary) if canary_installed => Some(Engine::Canary),
        Some(Engine::Whisper) if whisper_installed => Some(Engine::Whisper),
        Some(_) => None,
        None => match (canary_installed, whisper_installed) {
            (true, false) => Some(Engine::Canary),
            (false, true) => Some(Engine::Whisper),
            _ => None,
        },
    }
}

pub(crate) fn start() {
    let remembered = engine_file()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .as_deref()
        .and_then(Engine::parse);
    let canary_installed = crate::canary::canary_ready().unwrap_or(false);
    let whisper_installed = crate::speech::model_ready().unwrap_or(false);
    let Some(engine) = choose_engine(remembered, canary_installed, whisper_installed) else {
        append_log("preload.skipped", "no installed engine to preload");
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("speakit-model-preload".into())
        .spawn(move || {
            let started = Instant::now();
            append_log("preload.start", engine.as_str());
            let result = match engine {
                Engine::Canary => crate::canary::preload(),
                Engine::Whisper => crate::speech::preload(),
            };
            match result {
                Ok(()) => append_log(
                    "preload.complete",
                    &format!(
                        "engine={} elapsed_ms={}",
                        engine.as_str(),
                        started.elapsed().as_millis()
                    ),
                ),
                Err(error) => append_log("preload.failed", &error),
            }
        });
    if let Err(error) = spawned {
        append_log("preload.spawn.failed", &error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembered_engine_is_preloaded_when_installed() {
        assert_eq!(
            choose_engine(Some(Engine::Whisper), true, true),
            Some(Engine::Whisper)
        );
        assert_eq!(
            choose_engine(Some(Engine::Canary), true, true),
            Some(Engine::Canary)
        );
        assert_eq!(choose_engine(Some(Engine::Canary), false, true), None);
    }

    #[test]
    fn without_a_remembered_engine_only_an_unambiguous_install_is_preloaded() {
        assert_eq!(choose_engine(None, true, false), Some(Engine::Canary));
        assert_eq!(choose_engine(None, false, true), Some(Engine::Whisper));
        assert_eq!(choose_engine(None, true, true), None);
        assert_eq!(choose_engine(None, false, false), None);
    }

    #[test]
    fn engine_names_round_trip() {
        for engine in [Engine::Canary, Engine::Whisper] {
            assert_eq!(Engine::parse(engine.as_str()), Some(engine));
        }
        assert_eq!(Engine::parse("whisper\n"), Some(Engine::Whisper));
        assert_eq!(Engine::parse("other"), None);
    }
}
