# HushType

HushType is a small, cross-platform desktop dictation app built for one person and their own API keys. It ships with two starting modes:

- **Raw:** microphone → speech-to-text → paste at the active cursor
- **Polish:** microphone → speech-to-text → AI cleanup → paste at the active cursor

You can add, rename, duplicate by configuration, or delete modes. Every mode owns its hotkey, transcription provider, optional second-stage model, system instruction, language, and paste behavior. The default speech model is Groq's `whisper-large-v3-turbo`; the default correction model is Cerebras `gpt-oss-120b`.

## What is implemented

- Native Windows and macOS app from one Tauri + React codebase
- Global shortcuts for Raw and Polish dictation
- Any number of user-created modes with independent global hotkeys
- Per-mode pipelines: speech-to-text followed by an optional transformation model
- Groq, Cerebras, Gemini, OpenAI, Anthropic, Azure OpenAI, and custom correction providers
- Microsoft Azure Speech (MAI-Transcribe-2, LLM Speech, Fast Transcription) and Deepgram speech-to-text
- Custom request templates for APIs that are not OpenAI-compatible, with cURL import and a live test panel
- Extra request parameters for OpenAI-compatible providers (reasoning effort, temperature, timestamps…)
- Provider model discovery through editable Models API endpoints
- Automatically saved settings and API keys
- Configurable global cancel hotkey that discards audio before any API request
- Optional lime floating recording pop-up with a red cancel control
- Per-mode silence trimming with an adjustable dB threshold
- Browser microphone capture with a live waveform
- Groq/OpenAI-compatible multipart speech-to-text calls
- Optional OpenAI-compatible chat-completions cleanup step
- First-class Cerebras correction support at `https://api.cerebras.ai/v1/chat/completions`
- Editable cleanup system prompt in Settings, sent with every Polish dictation
- Automatic clipboard paste at the previously focused cursor
- Local transcript history with search, copy, and delete
- API keys stored in Windows Credential Manager or macOS Keychain
- Tray/menu-bar process so shortcuts keep working when the main window is closed
- Configurable models, endpoints, language, cleanup prompt, and shortcuts

## Quick start

Prerequisites: Node.js 20+, Rust stable, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```powershell
npm install
npm run tauri dev
```

Open **Settings → Modes**, select a mode, and add the keys for its pipeline. Available models are fetched from the provider when the key is saved, and can be refreshed beside the model field. Settings save automatically. If both stages use the same provider, the second stage can reuse the transcription key. Then place the cursor in another app and use the hotkey shown for that mode.

- Raw starter mode: `Ctrl/Cmd + Shift + D`
- Polish starter mode: `Ctrl/Cmd + Shift + P`

Press the same shortcut again to finish recording. The transcript is pasted where the cursor was left.

The global cancel shortcut defaults to `Ctrl/Cmd + Shift + Escape`. It stops and discards the active recording without calling the transcription or correction providers. It can be changed or removed under **Settings → Modes**.

## Custom requests (any API)

Every pipeline stage has a **Request format** switch:

- **OpenAI-compatible** sends the standard multipart transcription or chat-completions request. *Extra request parameters* are merged in: form fields for speech (`temperature = 0`), JSON fields for chat (`reasoning_effort = low`, `reasoning.effort` nests). A value of `null` drops a default field, such as `temperature`.
- **Custom request** describes the whole HTTP call: method, URL, headers, body (multipart, JSON, raw audio, URL-encoded, or text), and the **response path** where the text lives (`combinedPhrases.0.text`, `choices[0].message.content`, `/content/0/text`, or `output.*.content.*.text` to join matches). Leave the path empty to auto-detect common shapes.

**Import from cURL** turns the example in an API's docs into a template. The audio file becomes `{{audio}}`, the model becomes `{{model}}`, and a key found in the command is moved to the system keychain and replaced with `{{api_key}}`. For cleanup models, the sample message becomes `{{text}}` and a system instruction is added as `{{system_prompt}}`.

Placeholders are escaped for where they appear (URL, JSON, header); `{{raw:name}}` inserts a value untouched. Empty form fields and headers are skipped, so `{{language}}` disappears on auto-detect. The full list is under *Placeholders you can use* in the editor.

**Test this stage** re-sends your most recent recording (or a sample transcript for the second stage) with the unsaved settings and shows the HTTP status, the extracted text, and the raw response.

### Microsoft MAI-Transcribe

Choose **Microsoft Azure Speech (MAI-Transcribe)** as the speech provider, replace `YOUR-RESOURCE` in the endpoint with your Speech resource name (from a region that serves MAI-Transcribe, such as `eastus`), and paste the resource key. The *Start from a template* menu switches between MAI **clean** (Microsoft removes fillers), **verbatim** (raw), **clean + vocabulary** (phrase list), **LLM Speech** (prompt-tuned), and **classic Fast Transcription**, keeping your resource name. MAI accepts WAV, MP3, and FLAC, so *Always send WAV audio* is on by default for this provider.

## Silence trimming

Silence trimming is enabled per mode at a conservative `-45 dB` threshold. HushType removes silent leading and trailing audio plus internal quiet gaps longer than 650 ms, preserves padding around speech, and sends 16 kHz mono WAV. The threshold slider can retain quieter speech or trim more aggressively.

Groq bills ASR by audio duration with a minimum billed length of 10 seconds per request. Trimming can reduce billed duration for longer recordings, but cannot reduce a request below that minimum.

## Build installers

Build on the operating system you want to target:

```powershell
npm run tauri build
```

- Windows produces an `.exe`/MSI installer under `src-tauri/target/release/bundle/`.
- macOS produces a `.app` and `.dmg` under the same bundle directory.

Tauri does not cross-compile a macOS `.app` from Windows; run the same command on a Mac for that artifact. Apple distribution outside your own machine may require signing and notarization.

Version tags matching `v*` trigger the GitHub release workflow. It builds Windows x64 installers and macOS installers for both Apple Silicon and Intel, then attaches them to the matching GitHub Release.

## Permissions

- **Windows:** approve microphone access if WebView2 asks for it.
- **macOS:** approve Microphone access. If automatic paste is blocked, allow HushType under **System Settings → Privacy & Security → Accessibility**.

Audio is sent only to the configured speech provider. In Polish mode, the resulting transcript is then sent to the configured cleanup provider. History stays on the device. HushType has no account or telemetry layer.

## Project map

- `src/App.tsx` — application views and dictation workflow
- `src/hooks/useRecorder.ts` — microphone capture and waveform levels
- `src/lib/bridge.ts` — typed frontend/native bridge
- `src-tauri/src/lib.rs` — providers, keychain, shortcuts, storage, and paste
- `src-tauri/tauri.conf.json` — native app and packaging configuration

## Current MVP boundaries

- The app records a complete utterance, then transcribes it; it does not stream partial text live.
- Custom requests cover one HTTP call per stage. APIs that need polling (batch transcription jobs), streaming responses, or request signing (AWS SigV4) are not supported.
- Model-list endpoints should return an OpenAI-style `data` array, a Gemini-style `models` array, a Deepgram-style `stt` array, or a bare array.
- Hotkeys are recorded directly in the mode editor and can be cleared without deleting the mode.
