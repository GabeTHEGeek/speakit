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
pub(crate) async fn transcribe(
    samples: Vec<f32>,
    engine: Option<String>,
) -> Result<String, String> {
    let started = Instant::now();
    let engine = engine.unwrap_or_else(|| "whisper".into());
    let (samples, audio) = level_audio(samples);
    append_log(
        "transcription.native.start",
        &format!(
            "engine={engine} samples={} threads=4 rms={:.6} peak={:.6} gain={:.2}",
            samples.len(),
            audio.rms,
            audio.peak,
            audio.gain
        ),
    );
    let result: Result<String, String> =
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            if engine == "canary" {
                let canary = crate::canary::transcribe_canary(&samples)?;
                if !canary.is_empty() || !audio.has_signal || !model_path()?.is_file() {
                    return Ok(canary);
                }
                append_log(
                    "transcription.fallback",
                    "Canary returned no text; retrying with installed Whisper model",
                );
            }
            transcribe_whisper(&samples)
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

#[derive(Clone, Copy)]
struct AudioLevel {
    rms: f32,
    peak: f32,
    gain: f32,
    has_signal: bool,
}

fn level_audio(mut samples: Vec<f32>) -> (Vec<f32>, AudioLevel) {
    if samples.is_empty() {
        return (
            samples,
            AudioLevel {
                rms: 0.0,
                peak: 0.0,
                gain: 1.0,
                has_signal: false,
            },
        );
    }
    let mut power = 0.0_f64;
    let mut peak = 0.0_f32;
    for sample in &samples {
        power += f64::from(*sample) * f64::from(*sample);
        peak = peak.max(sample.abs());
    }
    let rms = (power / samples.len() as f64).sqrt() as f32;
    let has_signal = peak >= 0.002 || rms >= 0.0005;
    let gain = if has_signal {
        (0.06 / rms.max(0.000_001))
            .min(0.85 / peak.max(0.000_001))
            .clamp(1.0, 8.0)
    } else {
        1.0
    };
    if gain > 1.0 {
        for sample in &mut samples {
            *sample = (*sample * gain).clamp(-1.0, 1.0);
        }
    }
    (
        samples,
        AudioLevel {
            rms,
            peak,
            gain,
            has_signal,
        },
    )
}

fn transcribe_whisper(samples: &[f32]) -> Result<String, String> {
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
        .full(params, samples)
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
}

pub(crate) fn finalize_transcript(text: &str) -> String {
    let output = text.split_whitespace().collect::<Vec<_>>().join(" ");
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
    format_dictation(&output)
}

fn format_dictation(text: &str) -> String {
    let words = text.split_whitespace().collect::<Vec<_>>();
    let mut output = String::new();
    let mut words_in_sentence = 0_usize;
    let mut question_sentence = false;
    let mut capitalize_next = true;
    let mut index = 0_usize;

    while index < words.len() {
        let word = words[index];
        let lower = normalized_word(word);
        let next = words.get(index + 1).map(|word| normalized_word(word));

        let spoken_mark = match (lower.as_str(), next.as_deref()) {
            ("comma", _) => Some((",", 1)),
            ("period", _) | ("full", Some("stop")) => Some((".", if lower == "full" { 2 } else { 1 })),
            ("question", Some("mark")) => Some(("?", 2)),
            ("exclamation", Some("mark" | "point")) => Some(("!", 2)),
            ("new", Some("paragraph")) => Some(("\n\n", 2)),
            ("new", Some("line")) => Some(("\n", 2)),
            _ => None,
        };
        if let Some((mark, consumed)) = spoken_mark {
            trim_space(&mut output);
            output.push_str(mark);
            if matches!(mark, "." | "?" | "!" | "\n" | "\n\n") {
                words_in_sentence = 0;
                question_sentence = false;
                capitalize_next = true;
            }
            index += consumed;
            continue;
        }

        let starts_question = question_opening(&lower, next.as_deref());
        let transition = matches!(lower.as_str(), "maybe" | "additionally" | "secondly" | "thirdly" | "finally")
            || (lower == "so" && next.as_deref() != Some("that"));
        let needs_sentence_break = words_in_sentence >= 7 && (starts_question || transition);
        if needs_sentence_break {
            finish_sentence(&mut output, question_sentence);
            words_in_sentence = 0;
            question_sentence = false;
            capitalize_next = true;
        } else if matches!(lower.as_str(), "but" | "yet")
            && words_in_sentence >= 4
            && !ends_with_punctuation(&output)
        {
            trim_space(&mut output);
            output.push_str(", ");
        }

        if words_in_sentence == 0 && starts_question {
            question_sentence = true;
        }
        let written = if capitalize_next { capitalize(word) } else { word.to_string() };
        push_word(&mut output, &written);
        words_in_sentence += 1;
        capitalize_next = false;

        if word_ends_sentence(word) {
            words_in_sentence = 0;
            question_sentence = false;
            capitalize_next = true;
        } else if words_in_sentence == 1
            && matches!(lower.as_str(), "however" | "additionally" | "secondly" | "thirdly" | "finally")
        {
            trim_space(&mut output);
            output.push_str(", ");
        }
        index += 1;
    }

    finish_sentence(&mut output, question_sentence);
    output
}

fn normalized_word(word: &str) -> String {
    word.chars()
        .filter(|character| character.is_alphanumeric() || *character == '\'')
        .flat_map(char::to_lowercase)
        .collect()
}

fn question_opening(word: &str, next: Option<&str>) -> bool {
    match word {
        "how" | "why" | "when" | "where" | "who" => true,
        "is" => matches!(next, Some("there" | "this" | "that" | "it")),
        "are" => matches!(next, Some("there" | "you" | "we")),
        "can" | "could" | "would" | "should" | "will" | "do" | "does" | "did" =>
            matches!(next, Some("i" | "you" | "we" | "it" | "this" | "that" | "there")),
        "what" => matches!(next, Some("is" | "are" | "can" | "could" | "do" | "does" | "did" | "would" | "should")),
        _ => false,
    }
}

fn push_word(output: &mut String, word: &str) {
    if !output.is_empty() && !output.ends_with([' ', '\n']) {
        output.push(' ');
    }
    output.push_str(word);
}

fn capitalize(word: &str) -> String {
    let mut characters = word.chars();
    let Some(first) = characters.next() else { return String::new() };
    first.to_uppercase().chain(characters).collect()
}

fn trim_space(output: &mut String) {
    while output.ends_with(' ') {
        output.pop();
    }
}

fn word_ends_sentence(word: &str) -> bool {
    word.trim_end_matches(['"', '\'', ')', ']', '}']).ends_with(['.', '!', '?', '…'])
}

fn ends_with_punctuation(output: &str) -> bool {
    output.trim_end().ends_with([',', '.', '!', '?', '…', ':', ';', '\n'])
}

fn finish_sentence(output: &mut String, question: bool) {
    trim_space(output);
    if output.is_empty() || word_ends_sentence(output) {
        return;
    }
    output.push(if question { '?' } else { '.' });
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
    fn conversational_run_ons_gain_conservative_structure() {
        assert_eq!(
            finalize_transcript("I will keep using this until something happens but it may need another fix maybe it does not know how to switch between microphones so right now every thought becomes one sentence is there a way to improve that"),
            "I will keep using this until something happens, but it may need another fix. Maybe it does not know how to switch between microphones. So right now every thought becomes one sentence. Is there a way to improve that?"
        );
    }

    #[test]
    fn spoken_punctuation_commands_are_written_not_transcribed() {
        assert_eq!(
            finalize_transcript("This is the first thought comma and this is the second period new paragraph can we continue question mark"),
            "This is the first thought, and this is the second.\n\nCan we continue?"
        );
    }

    #[test]
    fn model_punctuation_is_preserved() {
        assert_eq!(
            finalize_transcript("This already works, but does it stay intact? Yes, it does!"),
            "This already works, but does it stay intact? Yes, it does!"
        );
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
    fn quiet_speech_is_leveled_without_clipping() {
        let input = vec![0.01_f32, -0.02, 0.015, -0.01];
        let (output, level) = level_audio(input);
        assert!(level.has_signal);
        assert!(level.gain > 1.0);
        assert!(output.iter().all(|sample| sample.abs() <= 1.0));
        assert!(output[1].abs() > 0.02);
    }

    #[test]
    fn near_silence_is_not_amplified() {
        let input = vec![0.0001_f32, -0.0002, 0.0001];
        let (output, level) = level_audio(input.clone());
        assert!(!level.has_signal);
        assert_eq!(level.gain, 1.0);
        assert_eq!(output, input);
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

    #[test]
    #[ignore = "requires the local Whisper model and a 16 kHz WAV fixture"]
    fn whisper_model_transcribes_fixture() {
        let audio_path = std::env::var("SPEAKIT_WHISPER_TEST_AUDIO").expect("audio fixture path");
        let samples = transcribe_rs::audio::read_wav_samples(std::path::Path::new(&audio_path))
            .expect("audio fixture should load");
        let started = Instant::now();
        let text = tauri::async_runtime::block_on(transcribe(samples, Some("whisper".into())))
            .expect("Whisper should transcribe the fixture");
        eprintln!("Whisper fixture: {:?} — {text}", started.elapsed());
        assert!(!text.trim().is_empty());
    }
}
