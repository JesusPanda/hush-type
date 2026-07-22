use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use keyring::Entry;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet, fs, path::PathBuf, str::FromStr, sync::Mutex, thread, time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, State,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const KEYRING_SERVICE: &str = "com.hushtype.desktop";
const LEGACY_TRANSCRIPTION_KEY: &str = "transcription-api-key";
const LEGACY_CLEANUP_KEY: &str = "cleanup-api-key";
const DEFAULT_SYSTEM_PROMPT: &str = "Clean up this dictated text. Remove filler words and false starts, fix punctuation and capitalization, preserve the speaker's meaning and tone, and return only the edited text.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSettings {
    provider: String,
    endpoint: String,
    #[serde(default)]
    models_endpoint: String,
    model: String,
    #[serde(default)]
    api_key_set: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DictationProfile {
    id: String,
    name: String,
    shortcut: String,
    transcription: ProviderSettings,
    cleanup_enabled: bool,
    cleanup: ProviderSettings,
    language: String,
    transcription_prompt: String,
    system_prompt: String,
    paste_after_dictation: bool,
    #[serde(default = "default_true")]
    trim_silence: bool,
    #[serde(default = "default_silence_threshold")]
    silence_threshold_db: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    profiles: Vec<DictationProfile>,
    active_profile_id: String,
    #[serde(default)]
    launch_at_startup: bool,
    #[serde(default = "default_cancel_shortcut")]
    cancel_shortcut: String,
    #[serde(default = "default_true")]
    overlay_enabled: bool,
    #[serde(default = "default_overlay_success_duration_ms")]
    overlay_success_duration_ms: u64,
    #[serde(default)]
    overlay_position: Option<OverlayPosition>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OverlayPosition {
    x: i32,
    y: i32,
}

fn default_true() -> bool {
    true
}

fn default_silence_threshold() -> f32 {
    -45.0
}

fn default_cancel_shortcut() -> String {
    "CommandOrControl+Shift+Escape".into()
}

fn default_overlay_success_duration_ms() -> u64 {
    650
}

fn groq_transcription() -> ProviderSettings {
    ProviderSettings {
        provider: "groq".into(),
        endpoint: "https://api.groq.com/openai/v1/audio/transcriptions".into(),
        models_endpoint: "https://api.groq.com/openai/v1/models".into(),
        model: "whisper-large-v3-turbo".into(),
        api_key_set: false,
    }
}

fn cerebras_cleanup() -> ProviderSettings {
    ProviderSettings {
        provider: "cerebras".into(),
        endpoint: "https://api.cerebras.ai/v1/chat/completions".into(),
        models_endpoint: "https://api.cerebras.ai/v1/models".into(),
        model: "gpt-oss-120b".into(),
        api_key_set: false,
    }
}

fn default_profile(
    id: &str,
    name: &str,
    shortcut: &str,
    cleanup_enabled: bool,
) -> DictationProfile {
    DictationProfile {
        id: id.into(),
        name: name.into(),
        shortcut: shortcut.into(),
        transcription: groq_transcription(),
        cleanup_enabled,
        cleanup: cerebras_cleanup(),
        language: "auto".into(),
        transcription_prompt: String::new(),
        system_prompt: DEFAULT_SYSTEM_PROMPT.into(),
        paste_after_dictation: true,
        trim_silence: true,
        silence_threshold_db: default_silence_threshold(),
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            profiles: vec![
                default_profile("raw", "Raw dictation", "CommandOrControl+Shift+D", false),
                default_profile(
                    "polish",
                    "Polish my words",
                    "CommandOrControl+Shift+P",
                    true,
                ),
            ],
            active_profile_id: "polish".into(),
            launch_at_startup: false,
            cancel_shortcut: default_cancel_shortcut(),
            overlay_enabled: true,
            overlay_success_duration_ms: default_overlay_success_duration_ms(),
            overlay_position: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySettings {
    transcription: ProviderSettings,
    cleanup: ProviderSettings,
    language: String,
    prompt: String,
    cleanup_prompt: String,
    raw_shortcut: String,
    polish_shortcut: String,
    paste_after_dictation: bool,
    #[serde(default)]
    launch_at_startup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayPayload {
    visible: bool,
    state: String,
    profile_name: String,
    cleanup_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryItem {
    id: String,
    created_at: u64,
    #[serde(default)]
    profile_id: String,
    #[serde(default)]
    profile_name: String,
    #[serde(default)]
    used_cleanup: bool,
    raw_text: String,
    final_text: String,
    duration_ms: u64,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionResult {
    raw_text: String,
    final_text: String,
}

#[derive(Debug, Serialize)]
struct ModelOption {
    id: String,
    name: String,
}

struct AppState {
    settings: Mutex<AppSettings>,
    config_dir: PathBuf,
}

fn settings_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("settings.json")
}

fn history_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("history.json")
}

fn default_models_endpoint(provider: &str) -> &'static str {
    match provider {
        "groq" => "https://api.groq.com/openai/v1/models",
        "cerebras" => "https://api.cerebras.ai/v1/models",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/models",
        "openai" => "https://api.openai.com/v1/models",
        _ => "",
    }
}

fn hydrate_provider(provider: &mut ProviderSettings) {
    if provider.models_endpoint.is_empty() {
        provider.models_endpoint = default_models_endpoint(&provider.provider).into();
    }
}

fn hydrate_settings(mut settings: AppSettings) -> AppSettings {
    settings.overlay_success_duration_ms = settings.overlay_success_duration_ms.clamp(200, 2_500);
    for profile in &mut settings.profiles {
        hydrate_provider(&mut profile.transcription);
        hydrate_provider(&mut profile.cleanup);
        if profile.system_prompt.is_empty() {
            profile.system_prompt = DEFAULT_SYSTEM_PROMPT.into();
        }
    }
    if settings.profiles.is_empty() {
        return AppSettings::default();
    }
    if !settings
        .profiles
        .iter()
        .any(|profile| profile.id == settings.active_profile_id)
    {
        settings.active_profile_id = settings.profiles[0].id.clone();
    }
    settings
}

fn migrate_legacy_settings(legacy: LegacySettings) -> AppSettings {
    let base = DictationProfile {
        id: "raw".into(),
        name: "Raw dictation".into(),
        shortcut: legacy.raw_shortcut,
        transcription: legacy.transcription,
        cleanup_enabled: false,
        cleanup: legacy.cleanup,
        language: legacy.language,
        transcription_prompt: legacy.prompt,
        system_prompt: legacy.cleanup_prompt,
        paste_after_dictation: legacy.paste_after_dictation,
        trim_silence: true,
        silence_threshold_db: default_silence_threshold(),
    };
    let mut polish = base.clone();
    polish.id = "polish".into();
    polish.name = "Polish my words".into();
    polish.shortcut = legacy.polish_shortcut;
    polish.cleanup_enabled = true;
    hydrate_settings(AppSettings {
        profiles: vec![base, polish],
        active_profile_id: "polish".into(),
        launch_at_startup: legacy.launch_at_startup,
        cancel_shortcut: default_cancel_shortcut(),
        overlay_enabled: true,
        overlay_success_duration_ms: default_overlay_success_duration_ms(),
        overlay_position: None,
    })
}

fn read_settings(config_dir: &PathBuf) -> AppSettings {
    let Some(text) = fs::read_to_string(settings_path(config_dir)).ok() else {
        return AppSettings::default();
    };
    if let Ok(settings) = serde_json::from_str::<AppSettings>(&text) {
        return hydrate_settings(settings);
    }
    if let Ok(legacy) = serde_json::from_str::<LegacySettings>(&text) {
        return migrate_legacy_settings(legacy);
    }
    AppSettings::default()
}

fn write_settings(config_dir: &PathBuf, settings: &AppSettings) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    fs::write(
        settings_path(config_dir),
        serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not save settings: {error}"))
}

fn credential_exists(account: &str) -> bool {
    Entry::new(KEYRING_SERVICE, account)
        .and_then(|entry| entry.get_password())
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn custom_endpoint_suffix(endpoint: &str) -> String {
    endpoint
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(80)
        .collect()
}

fn credential_account(stage: &str, provider: &ProviderSettings) -> String {
    if provider.provider == "custom" {
        format!(
            "{stage}-api-key-custom-{}",
            custom_endpoint_suffix(&provider.endpoint)
        )
    } else {
        format!("{stage}-api-key-{}", provider.provider)
    }
}

fn get_credential(account: &str) -> Result<String, String> {
    Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("Could not open the system credential store: {error}"))?
        .get_password()
        .map_err(|_| "No API key is saved for this provider. Open Settings to add one.".to_string())
}

fn set_credential(account: &str, value: &str) -> Result<(), String> {
    Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("Could not open the system credential store: {error}"))?
        .set_password(value)
        .map_err(|error| format!("Could not save the API key: {error}"))
}

fn providers_can_share_key(a: &ProviderSettings, b: &ProviderSettings) -> bool {
    a.provider == b.provider && (a.provider != "custom" || a.endpoint == b.endpoint)
}

fn migrate_legacy_credential(legacy_account: &str, stage: &str, provider: &ProviderSettings) {
    let provider_account = credential_account(stage, provider);
    if credential_exists(&provider_account) {
        return;
    }
    if let Ok(value) = get_credential(legacy_account) {
        let _ = set_credential(&provider_account, &value);
    }
}

fn settings_with_key_status(mut settings: AppSettings) -> AppSettings {
    for profile in &mut settings.profiles {
        let transcription_exists =
            credential_exists(&credential_account("transcription", &profile.transcription));
        profile.transcription.api_key_set = transcription_exists;
        profile.cleanup.api_key_set =
            credential_exists(&credential_account("cleanup", &profile.cleanup))
                || (providers_can_share_key(&profile.cleanup, &profile.transcription)
                    && transcription_exists);
    }
    settings
}

fn parsed_shortcuts(settings: &AppSettings) -> Result<Vec<Shortcut>, String> {
    let mut shortcuts = Vec::new();
    let mut seen = HashSet::new();
    if !settings.cancel_shortcut.trim().is_empty() {
        let cancel = Shortcut::from_str(&settings.cancel_shortcut)
            .map_err(|error| format!("The cancel shortcut is invalid: {error}"))?;
        seen.insert(cancel);
        shortcuts.push(cancel);
    }
    for profile in &settings.profiles {
        if profile.shortcut.trim().is_empty() {
            continue;
        }
        let shortcut = Shortcut::from_str(&profile.shortcut)
            .map_err(|error| format!("The shortcut for ‘{}’ is invalid: {error}", profile.name))?;
        if !seen.insert(shortcut) {
            return Err(format!(
                "The shortcut for ‘{}’ is already assigned to another mode.",
                profile.name
            ));
        }
        shortcuts.push(shortcut);
    }
    Ok(shortcuts)
}

fn position_overlay(window: &tauri::WebviewWindow, saved: Option<OverlayPosition>) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    if let Some(saved) = saved {
        if let Ok(monitors) = window.available_monitors() {
            for monitor in monitors {
                let area = monitor.work_area();
                let right = area.position.x.saturating_add(area.size.width as i32);
                let bottom = area.position.y.saturating_add(area.size.height as i32);
                if saved.x >= area.position.x
                    && saved.x < right
                    && saved.y >= area.position.y
                    && saved.y < bottom
                {
                    let max_x = area
                        .position
                        .x
                        .saturating_add(area.size.width.saturating_sub(size.width) as i32);
                    let max_y = area
                        .position
                        .y
                        .saturating_add(area.size.height.saturating_sub(size.height) as i32);
                    let x = saved.x.clamp(area.position.x, max_x);
                    let y = saved.y.clamp(area.position.y, max_y);
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                    return;
                }
            }
        }
    }
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let area = monitor.work_area();
        let x = area.position.x + ((area.size.width.saturating_sub(size.width)) / 2) as i32;
        let y = area.position.y + area.size.height.saturating_sub(size.height + 28) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[tauri::command]
fn set_overlay(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: OverlayPayload,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    window
        .emit("overlay-state", payload.clone())
        .map_err(|error| error.to_string())?;
    if !payload.visible {
        return window.hide().map_err(|error| error.to_string());
    }
    let saved = state
        .settings
        .lock()
        .map_err(|_| "Settings are busy".to_string())?
        .overlay_position;
    position_overlay(&window, saved);
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn start_overlay_drag(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    window.start_dragging().map_err(|error| error.to_string())
}

fn register_shortcuts(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let shortcuts = parsed_shortcuts(settings)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| format!("Could not reset global shortcuts: {error}"))?;
    for shortcut in shortcuts {
        if let Err(error) = app.global_shortcut().register(shortcut) {
            let _ = app.global_shortcut().unregister_all();
            return Err(format!(
                "A shortcut is already in use by another application: {error}"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn load_settings(state: State<'_, AppState>) -> AppSettings {
    settings_with_key_status(state.settings.lock().expect("settings lock").clone())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: AppSettings,
    profile_id: Option<String>,
    stage: Option<String>,
    api_key: Option<String>,
) -> Result<AppSettings, String> {
    settings = hydrate_settings(settings);
    if let (Some(profile_id), Some(stage), Some(key)) = (profile_id, stage, api_key) {
        if !key.trim().is_empty() {
            let profile = settings
                .profiles
                .iter()
                .find(|profile| profile.id == profile_id)
                .ok_or_else(|| "That mode no longer exists.".to_string())?;
            let provider = if stage == "transcription" {
                &profile.transcription
            } else {
                &profile.cleanup
            };
            set_credential(&credential_account(&stage, provider), key.trim())?;
        }
    }

    let previous = state
        .settings
        .lock()
        .map_err(|_| "Settings are busy".to_string())?
        .clone();
    settings.overlay_position = previous.overlay_position;
    if let Err(error) = register_shortcuts(&app, &settings) {
        let _ = register_shortcuts(&app, &previous);
        return Err(error);
    }

    for profile in &mut settings.profiles {
        profile.transcription.api_key_set = false;
        profile.cleanup.api_key_set = false;
    }
    let mut current = state
        .settings
        .lock()
        .map_err(|_| "Settings are busy".to_string())?;
    // The overlay window owns this value. Re-read it under the same lock used
    // for the disk write so an older settings form cannot win a move/save race.
    settings.overlay_position = current.overlay_position;
    write_settings(&state.config_dir, &settings)?;
    *current = settings.clone();
    Ok(settings_with_key_status(settings))
}

#[tauri::command]
fn load_history(state: State<'_, AppState>) -> Vec<HistoryItem> {
    fs::read_to_string(history_path(&state.config_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_history(state: State<'_, AppState>, items: Vec<HistoryItem>) -> Result<(), String> {
    fs::create_dir_all(&state.config_dir).map_err(|error| error.to_string())?;
    fs::write(
        history_path(&state.config_dir),
        serde_json::to_string_pretty(&items).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not save history: {error}"))
}

fn profile_provider<'a>(profile: &'a DictationProfile, stage: &str) -> &'a ProviderSettings {
    if stage == "transcription" {
        &profile.transcription
    } else {
        &profile.cleanup
    }
}

fn credential_for_profile(
    profile: &DictationProfile,
    stage: &str,
    supplied_key: Option<String>,
) -> Result<String, String> {
    if let Some(key) = supplied_key.filter(|key| !key.trim().is_empty()) {
        return Ok(key);
    }
    let provider = profile_provider(profile, stage);
    get_credential(&credential_account(stage, provider)).or_else(|_| {
        if stage == "cleanup" && providers_can_share_key(&profile.cleanup, &profile.transcription) {
            get_credential(&credential_account("transcription", &profile.transcription))
        } else {
            Err(format!(
                "No API key is saved for the {} provider.",
                provider.provider
            ))
        }
    })
}

#[tauri::command]
async fn list_models(
    state: State<'_, AppState>,
    profile_id: String,
    stage: String,
    provider: ProviderSettings,
    api_key: Option<String>,
) -> Result<Vec<ModelOption>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are busy".to_string())?
        .clone();
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "That mode no longer exists.".to_string())?;
    if provider.models_endpoint.trim().is_empty() {
        return Err("Add a Models endpoint before refreshing the model list.".into());
    }
    let key = if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        key
    } else {
        get_credential(&credential_account(&stage, &provider)).or_else(|_| {
            if stage == "cleanup" && providers_can_share_key(&provider, &profile.transcription) {
                get_credential(&credential_account("transcription", &profile.transcription))
            } else {
                Err(format!(
                    "No API key is saved for the {} provider.",
                    provider.provider
                ))
            }
        })?
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let request = client.get(&provider.models_endpoint);
    let response = if provider.provider == "gemini" {
        request.header("x-goog-api-key", key).send().await
    } else {
        request.bearer_auth(key).send().await
    }
    .map_err(|error| format!("Could not reach the models endpoint: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("The models endpoint returned unreadable data: {error}"))?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("The provider rejected the models request.");
        return Err(format!("Could not list models ({status}): {message}"));
    }

    let mut models: Vec<ModelOption> = Vec::new();
    if let Some(data) = body.get("data").and_then(|value| value.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
                models.push(ModelOption {
                    id: id.into(),
                    name: item
                        .get("display_name")
                        .or_else(|| item.get("name"))
                        .and_then(|value| value.as_str())
                        .unwrap_or(id)
                        .into(),
                });
            }
        }
    }
    if let Some(data) = body.get("models").and_then(|value| value.as_array()) {
        for item in data {
            if let Some(raw_id) = item.get("name").and_then(|value| value.as_str()) {
                let id = raw_id.strip_prefix("models/").unwrap_or(raw_id);
                models.push(ModelOption {
                    id: id.into(),
                    name: item
                        .get("displayName")
                        .and_then(|value| value.as_str())
                        .unwrap_or(id)
                        .into(),
                });
            }
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    if stage == "transcription" {
        let speech_models: Vec<ModelOption> = models
            .iter()
            .filter(|model| {
                let id = model.id.to_ascii_lowercase();
                id.contains("whisper") || id.contains("transcrib")
            })
            .map(|model| ModelOption {
                id: model.id.clone(),
                name: model.name.clone(),
            })
            .collect();
        if !speech_models.is_empty() {
            return Ok(speech_models);
        }
    }
    Ok(models)
}

fn audio_extension(mime_type: &str) -> &'static str {
    if mime_type.contains("mp4") {
        "m4a"
    } else if mime_type.contains("ogg") {
        "ogg"
    } else if mime_type.contains("wav") {
        "wav"
    } else {
        "webm"
    }
}

async fn request_transcription(
    client: &reqwest::Client,
    audio: Vec<u8>,
    mime_type: &str,
    profile: &DictationProfile,
) -> Result<String, String> {
    let key = credential_for_profile(profile, "transcription", None)?;
    let file = Part::bytes(audio)
        .file_name(format!("dictation.{}", audio_extension(mime_type)))
        .mime_str(mime_type.split(';').next().unwrap_or("audio/webm"))
        .map_err(|error| format!("Unsupported recording format: {error}"))?;
    let mut form = Form::new()
        .part("file", file)
        .text("model", profile.transcription.model.clone())
        .text("response_format", "json");
    if profile.language != "auto" && !profile.language.is_empty() {
        form = form.text("language", profile.language.clone());
    }
    if !profile.transcription_prompt.trim().is_empty() {
        form = form.text("prompt", profile.transcription_prompt.clone());
    }
    let response = client
        .post(&profile.transcription.endpoint)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Could not reach the transcription provider: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|error| {
        format!("The transcription provider returned an unreadable response: {error}")
    })?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Unknown provider error");
        return Err(format!("Transcription failed ({status}): {message}"));
    }
    body.get("text")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The transcription provider returned no text.".to_string())
}

async fn request_cleanup(
    client: &reqwest::Client,
    text: &str,
    profile: &DictationProfile,
) -> Result<String, String> {
    let key = credential_for_profile(profile, "cleanup", None)?;
    let response = client
        .post(&profile.cleanup.endpoint)
        .bearer_auth(key)
        .json(&json!({
            "model": profile.cleanup.model,
            "temperature": 0.2,
            "messages": [
                { "role": "system", "content": profile.system_prompt },
                { "role": "user", "content": text }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach the second-stage provider: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|error| {
        format!("The second-stage provider returned an unreadable response: {error}")
    })?;
    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Unknown provider error");
        return Err(format!(
            "Second-stage processing failed ({status}): {message}"
        ));
    }
    body.pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The second-stage provider returned no text.".to_string())
}

#[tauri::command]
async fn transcribe_audio(
    state: State<'_, AppState>,
    audio: Vec<u8>,
    mime_type: String,
    profile_id: String,
) -> Result<TranscriptionResult, String> {
    if audio.is_empty() {
        return Err("The recording was empty.".into());
    }
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are busy".to_string())?
        .clone();
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "That dictation mode no longer exists.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?;
    let raw_text = request_transcription(&client, audio, &mime_type, profile).await?;
    let final_text = if profile.cleanup_enabled {
        request_cleanup(&client, &raw_text, profile).await?
    } else {
        raw_text.clone()
    };
    Ok(TranscriptionResult {
        raw_text,
        final_text,
    })
}

#[tauri::command]
fn paste_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("Could not open the clipboard: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("Could not copy the transcript: {error}"))?;
    thread::sleep(Duration::from_millis(85));
    let mut enigo = Enigo::new(&EnigoSettings::default())
        .map_err(|error| format!("Could not control the keyboard: {error}"))?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    enigo
        .key(modifier, Direction::Press)
        .map_err(|error| error.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|error| error.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let settings = app
                        .state::<AppState>()
                        .settings
                        .lock()
                        .expect("settings lock")
                        .clone();
                    if Shortcut::from_str(&settings.cancel_shortcut).ok().as_ref() == Some(shortcut)
                    {
                        let _ = app.emit("dictation-cancel", ());
                        return;
                    }
                    if let Some(profile) = settings.profiles.iter().find(|profile| {
                        Shortcut::from_str(&profile.shortcut).ok().as_ref() == Some(shortcut)
                    }) {
                        let _ = app.emit("dictation-shortcut", profile.id.clone());
                    }
                })
                .build(),
        )
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let settings = read_settings(&config_dir);
            for profile in &settings.profiles {
                migrate_legacy_credential(
                    LEGACY_TRANSCRIPTION_KEY,
                    "transcription",
                    &profile.transcription,
                );
                migrate_legacy_credential(LEGACY_CLEANUP_KEY, "cleanup", &profile.cleanup);
            }
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                config_dir,
            });
            if let Err(error) = register_shortcuts(&app.handle(), &settings) {
                eprintln!("{error}");
            }

            let show = MenuItem::with_id(app, "show", "Open HushType", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit HushType", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new();
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.menu(&menu)
                .tooltip("HushType")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            load_history,
            save_history,
            list_models,
            transcribe_audio,
            paste_text,
            set_overlay,
            start_overlay_drag
        ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building HushType")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent { label, event, .. } = event {
                match event {
                    tauri::WindowEvent::Moved(position) if label == "overlay" => {
                        let state = app.state::<AppState>();
                        let saved = {
                            let Ok(mut settings) = state.settings.lock() else {
                                return;
                            };
                            settings.overlay_position = Some(OverlayPosition {
                                x: position.x,
                                y: position.y,
                            });
                            settings.clone()
                        };
                        if let Err(error) = write_settings(&state.config_dir, &saved) {
                            eprintln!("{error}");
                        }
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } if label == "main" => {
                        api.prevent_close();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    _ => {}
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_hotkeys_are_valid_and_unique() {
        let settings = AppSettings::default();
        let shortcuts = parsed_shortcuts(&settings).expect("default shortcuts should parse");
        assert_eq!(shortcuts.len(), 3);
    }

    #[test]
    fn duplicate_cancel_hotkey_is_rejected() {
        let mut settings = AppSettings::default();
        settings.cancel_shortcut = settings.profiles[0].shortcut.clone();
        assert!(parsed_shortcuts(&settings).is_err());
    }
}
