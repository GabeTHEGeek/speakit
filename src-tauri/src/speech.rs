use futures_util::StreamExt;
use std::{path::PathBuf, sync::OnceLock, time::Instant};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::logging::append_log;

const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin";
static WHISPER_CONTEXT: OnceLock<WhisperContext> = OnceLock::new();

pub(crate) fn model_path() -> Result<PathBuf, String> {
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

#[tauri::command]
pub(crate) fn model_ready() -> Result<bool, String> {
    Ok(model_path()?.is_file())
}

#[tauri::command]
pub(crate) async fn prepare_model() -> Result<(), String> {
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
pub(crate) async fn download_model(app: tauri::AppHandle) -> Result<(), String> {
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
pub(crate) async fn transcribe(samples: Vec<f32>) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
