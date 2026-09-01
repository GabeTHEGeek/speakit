# SpeakIt

A free, local, Mac-first dictation app. Focus a text box, hold your shortcut, speak, and release to transcribe and paste.

## Features

- Detects the focused macOS text field and returns focus to the correct app before pasting
- Customizable global push-to-talk shortcut, saved between launches
- Non-focus-stealing bottom overlay with a live microphone waveform
- Local Whisper transcription with no account or paid API

## Development

```sh
npm install
npm run tauri dev
```

On first launch, SpeakIt downloads the free Whisper `small.en` model (about 466 MB). Audio and transcripts stay on the Mac. macOS will ask for Microphone permission; automatic paste also requires Accessibility permission.
