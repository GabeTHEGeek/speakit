# SpeakIt

SpeakIt is a free, local, Mac-first dictation app. Focus a text box, hold your shortcut, speak, and release. SpeakIt transcribes your voice on-device and pastes the result back into the app you were using.

No account, subscription, cloud transcription, or paid API is required.

## Features

- Local English transcription with Whisper `small.en`
- Apple Silicon Metal acceleration
- Customizable global push-to-talk shortcut
- Automatic paste into the previously focused application
- A click-through listening waveform that does not steal focus
- Bottom-center overlay placement on the monitor containing the focused app
- Start and stop sound cues
- A built-in diagnostics report for microphone, Accessibility, model, installation, and recent events
- One separator space after each dictation so consecutive sentences do not run together

## Requirements

- macOS 13 or newer
- Apple Silicon Mac for the current packaged build
- Approximately 466 MB of disk space for the local speech model
- Microphone permission for recording
- Accessibility permission for detecting the active app and pasting text

## Installation

1. Open the SpeakIt DMG.
2. Drag SpeakIt into the Applications folder.
3. Quit any older copy before opening the new Applications copy.
4. Allow Microphone and Accessibility access when macOS asks.
5. Download the local speech model from the setup screen.

Run SpeakIt from Applications rather than directly from the mounted installer. macOS permissions are associated with the installed and signed application copy.

## Using SpeakIt

1. Click the text field where you want the result.
2. Hold the configured shortcut.
3. Begin speaking after the start sound and listening waveform appear.
4. Release the shortcut when finished.
5. SpeakIt transcribes locally, restores the original app, and pastes the text.

The shortcut can be changed from the SpeakIt window and is saved between launches. The listening overlay appears on the monitor containing the focused application window and remains there for that recording.

## Privacy

Audio and transcripts remain on the Mac. SpeakIt does not send dictation to a transcription service. The only network download required by the app is the initial open-source Whisper model.

The model is stored under:

```text
~/Library/Application Support/SpeakIt/models/
```

## Permissions and troubleshooting

SpeakIt needs two macOS permissions:

- **Microphone:** records audio only while dictation is active.
- **Accessibility:** identifies the active application, restores it after transcription, and performs the paste command.

If automatic paste stops working, open **System Settings → Privacy & Security → Accessibility**, verify that the installed SpeakIt application is enabled, then restart SpeakIt.

Use **Run check** in SpeakIt's System diagnostics section to verify the microphone signal, Accessibility status, model installation, app location, and recent event timing. The report can be copied when filing an issue.

## Current scope

SpeakIt currently focuses on English voice-to-text dictation for macOS. Google Calendar integration and local note storage are not included in the current version.
