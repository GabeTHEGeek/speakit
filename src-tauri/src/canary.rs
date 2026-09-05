use futures_util::StreamExt;
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use transcribe_rs::onnx::{
    canary::{CanaryModel, CanaryParams},
    Quantization,
};

use crate::{logging::append_log, speech::finalize_transcript};

const FILES: [(&str, &str); 4] = [
    ("nemo128.onnx", "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx"),
    ("encoder-model.int8.onnx", "https://huggingface.co/istupakov/canary-180m-flash-onnx/resolve/main/encoder-model.int8.onnx"),
    ("decoder-model.int8.onnx", "https://huggingface.co/istupakov/canary-180m-flash-onnx/resolve/main/decoder-model.int8.onnx"),
    ("vocab.txt", "https://huggingface.co/istupakov/canary-180m-flash-onnx/resolve/main/vocab.txt"),
];
static CANARY_MODEL: OnceLock<Mutex<CanaryModel>> = OnceLock::new();

fn model_dir() -> Result<PathBuf, String> {
    let mut path = dirs::data_local_dir().ok_or("Could not find the app data folder")?;
    path.push("SpeakIt");
    path.push("models");
    path.push("canary-180m-flash");
    Ok(path)
}

fn files_ready(path: &Path) -> bool {
    FILES.iter().all(|(name, _)| path.join(name).is_file())
}

pub(crate) fn model_size_bytes() -> u64 {
    let Ok(path) = model_dir() else {
        return 0;
    };
    FILES
        .iter()
        .filter_map(|(name, _)| std::fs::metadata(path.join(name)).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn canary_model() -> Result<&'static Mutex<CanaryModel>, String> {
    if let Some(model) = CANARY_MODEL.get() {
        return Ok(model);
    }
    let path = model_dir()?;
    if !files_ready(&path) {
        return Err("Canary Flash has not finished downloading".into());
    }
    let model = CanaryModel::load(&path, &Quantization::Int8)
        .map_err(|error| format!("Could not load Canary Flash: {error}"))?;
    let _ = CANARY_MODEL.set(Mutex::new(model));
    CANARY_MODEL
        .get()
        .ok_or_else(|| "Could not keep Canary Flash ready".into())
}

#[tauri::command]
pub(crate) fn canary_ready() -> Result<bool, String> {
    Ok(files_ready(&model_dir()?))
}

#[tauri::command]
pub(crate) async fn prepare_canary_model() -> Result<(), String> {
    append_log("canary.prepare.start", "");
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(|| canary_model().map(|_| ()))
        .await
        .map_err(|error| error.to_string())?;
    match &result {
        Ok(()) => append_log(
            "canary.prepare.complete",
            &format!("elapsed_ms={}", started.elapsed().as_millis()),
        ),
        Err(error) => append_log("canary.prepare.failed", error),
    }
    result
}

#[tauri::command]
pub(crate) async fn download_canary_model(app: tauri::AppHandle) -> Result<(), String> {
    let directory = model_dir()?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    append_log("canary.download.start", "Canary 180M Flash int8");
    for (index, (name, url)) in FILES.iter().enumerate() {
        let destination = directory.join(name);
        if destination.is_file() {
            let _ = app.emit_to(
                "main",
                "canary-download-progress",
                (index + 1) as f64 / FILES.len() as f64 * 100.0,
            );
            continue;
        }
        download_file(&app, url, &destination, index).await?;
    }
    append_log("canary.download.complete", "ok");
    Ok(())
}

async fn download_file(
    app: &tauri::AppHandle,
    url: &str,
    destination: &Path,
    index: usize,
) -> Result<(), String> {
    let response = reqwest::get(url)
        .await
        .map_err(|error| format!("Canary download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Canary download returned {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let temporary = destination.with_extension("download");
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| error.to_string())?;
    let mut received = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        file.write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
        received += chunk.len() as u64;
        if total > 0 {
            let file_progress = received as f64 / total as f64;
            let overall = (index as f64 + file_progress) / FILES.len() as f64 * 100.0;
            let _ = app.emit_to("main", "canary-download-progress", overall);
        }
    }
    file.flush().await.map_err(|error| error.to_string())?;
    drop(file);
    tokio::fs::rename(temporary, destination)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn transcribe_canary(samples: &[f32]) -> Result<String, String> {
    let model = canary_model()?;
    let mut guard = model
        .lock()
        .map_err(|_| "Canary Flash became unavailable".to_string())?;
    let result = guard
        .transcribe_with(
            samples,
            &CanaryParams {
                language: Some("en".into()),
                target_language: Some("en".into()),
                use_pnc: true,
                ..Default::default()
            },
        )
        .map_err(|error| format!("Canary transcription failed: {error}"))?;
    Ok(finalize_transcript(&result.text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the separately downloaded Canary model and a 16 kHz WAV fixture"]
    fn canary_model_transcribes_fixture() {
        let model_path = std::env::var("SPEAKIT_CANARY_TEST_MODEL").expect("model fixture path");
        let audio_path = std::env::var("SPEAKIT_CANARY_TEST_AUDIO").expect("audio fixture path");
        let mut model = CanaryModel::load(Path::new(&model_path), &Quantization::Int8)
            .expect("Canary model should load");
        let samples = transcribe_rs::audio::read_wav_samples(Path::new(&audio_path))
            .expect("audio fixture should load");
        let started = Instant::now();
        let result = model
            .transcribe_with(
                &samples,
                &CanaryParams {
                    language: Some("en".into()),
                    target_language: Some("en".into()),
                    use_pnc: true,
                    ..Default::default()
                },
            )
            .expect("Canary should transcribe the fixture");
        eprintln!("Canary fixture: {:?} — {}", started.elapsed(), result.text);
        assert!(!result.text.trim().is_empty());
    }
}
