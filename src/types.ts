export type View = "mode" | "history" | "general";
export type ProviderId =
  | "groq"
  | "cerebras"
  | "gemini"
  | "openai"
  | "azure-speech"
  | "azure-openai"
  | "deepgram"
  | "anthropic"
  | "custom";
export type PipelineStage = "transcription" | "cleanup";
export type RequestFormat = "openai" | "template";
export type BodyType = "multipart" | "json" | "binary" | "form" | "text" | "none";

export interface KeyValue {
  key: string;
  value: string;
}

/** A declarative HTTP request. Values may contain {{placeholders}}; see PLACEHOLDERS. */
export interface RequestTemplate {
  method: string;
  url: string;
  headers: KeyValue[];
  bodyType: BodyType;
  /** Multipart or URL-encoded fields. A value of {{audio}} attaches the recording. */
  fields: KeyValue[];
  body: string;
  /** e.g. combinedPhrases.0.text — empty means auto-detect. */
  responsePath: string;
}

export interface ProviderSettings {
  provider: ProviderId;
  endpoint: string;
  modelsEndpoint: string;
  model: string;
  apiKeySet: boolean;
  format: RequestFormat;
  /** Extra fields merged into OpenAI-compatible requests. `null` removes a default field. */
  extraParams: KeyValue[];
  template: RequestTemplate;
  /** Always upload 16 kHz WAV, for APIs that reject WebM. */
  forceWav: boolean;
}

export interface DictationProfile {
  id: string;
  name: string;
  shortcut: string;
  transcription: ProviderSettings;
  cleanupEnabled: boolean;
  cleanup: ProviderSettings;
  language: string;
  transcriptionPrompt: string;
  systemPrompt: string;
  pasteAfterDictation: boolean;
  trimSilence: boolean;
  silenceThresholdDb: number;
}

export interface AppSettings {
  profiles: DictationProfile[];
  activeProfileId: string;
  launchAtStartup: boolean;
  cancelShortcut: string;
  overlayEnabled: boolean;
  overlaySuccessDurationMs?: number;
  overlayPosition?: { x: number; y: number };
}

export interface HistoryItem {
  id: string;
  createdAt: number;
  profileId: string;
  profileName: string;
  usedCleanup: boolean;
  rawText: string;
  finalText: string;
  durationMs: number;
  mode?: "raw" | "polish";
}

export interface ModelOption {
  id: string;
  name: string;
}

export type RecordingState = "idle" | "recording" | "processing" | "success" | "error";

export interface TranscriptionResult {
  rawText: string;
  finalText: string;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number;
  text: string;
  raw: string;
  input: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  "Clean up this dictated text. Remove filler words and false starts, fix punctuation and capitalization, preserve the speaker's meaning and tone, and return only the edited text.";

export const PLACEHOLDERS: Array<{ name: string; description: string; stage?: PipelineStage }> = [
  { name: "api_key", description: "The key saved for this provider" },
  { name: "model", description: "The Model field" },
  { name: "endpoint", description: "The API endpoint field" },
  { name: "audio", description: "The recording, as a multipart file field", stage: "transcription" },
  { name: "audio_base64", description: "The recording, base64-encoded", stage: "transcription" },
  { name: "mime_type", description: "Recording type, e.g. audio/wav", stage: "transcription" },
  { name: "file_name", description: "Recording file name, e.g. dictation.wav", stage: "transcription" },
  { name: "language", description: "Mode language (en, it…), empty on auto-detect" },
  { name: "locale", description: "Regional locale (en-US…), empty on auto-detect" },
  { name: "locales", description: 'JSON list: ["en"], or [] on auto-detect' },
  { name: "locales_regional", description: 'JSON list: ["en-US"], or [] on auto-detect' },
  { name: "prompt", description: "The mode's speech prompt / vocabulary hint" },
  { name: "text", description: "The transcript to transform", stage: "cleanup" },
  { name: "system_prompt", description: "The mode's system instruction", stage: "cleanup" },
];

export const emptyTemplate = (): RequestTemplate => ({
  method: "POST",
  url: "{{endpoint}}",
  headers: [],
  bodyType: "json",
  fields: [],
  body: "",
  responsePath: "",
});

const provider = (settings: Partial<ProviderSettings> & Pick<ProviderSettings, "provider" | "endpoint" | "model">): ProviderSettings => ({
  modelsEndpoint: "",
  apiKeySet: false,
  format: "openai",
  extraParams: [],
  template: emptyTemplate(),
  forceWav: false,
  ...settings,
});

const cloneProvider = (value: ProviderSettings): ProviderSettings => ({
  ...value,
  extraParams: value.extraParams.map((item) => ({ ...item })),
  template: { ...value.template, headers: value.template.headers.map((item) => ({ ...item })), fields: value.template.fields.map((item) => ({ ...item })) },
});

export const normalizeProvider = (value: Partial<ProviderSettings> & Pick<ProviderSettings, "provider">): ProviderSettings => ({
  ...provider({ endpoint: "", model: "", ...value }),
  format: value.format === "template" ? "template" : "openai",
  extraParams: value.extraParams ?? [],
  template: { ...emptyTemplate(), ...(value.template ?? {}) },
  forceWav: value.forceWav ?? false,
});

export const normalizeSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  profiles: settings.profiles.map((profile) => ({
    ...profile,
    transcriptionPrompt: profile.transcriptionPrompt ?? "",
    transcription: normalizeProvider(profile.transcription),
    cleanup: normalizeProvider(profile.cleanup),
  })),
});

// ---- Microsoft Azure Speech (Fast Transcription API, MAI-Transcribe / LLM Speech) ----

const AZURE_SPEECH_ENDPOINT = "https://YOUR-RESOURCE.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15";

const maiDefinition = (style: "clean" | "verbatim") => `{
  "locales": {{locales}},
  "enhancedMode": {
    "enabled": true,
    "model": "{{model}}",
    "modelOptions": {
      "transcribeStyle": "${style}"
    }
  }
}`;

const azureSpeechTemplate = (definition: string): RequestTemplate => ({
  method: "POST",
  url: "{{endpoint}}",
  headers: [{ key: "Ocp-Apim-Subscription-Key", value: "{{api_key}}" }],
  bodyType: "multipart",
  fields: [
    { key: "audio", value: "{{audio}}" },
    { key: "definition", value: definition },
  ],
  body: "",
  responsePath: "combinedPhrases.0.text",
});

const openAiMultipartTemplate = (authHeader: KeyValue): RequestTemplate => ({
  method: "POST",
  url: "{{endpoint}}",
  headers: [authHeader],
  bodyType: "multipart",
  fields: [
    { key: "file", value: "{{audio}}" },
    { key: "model", value: "{{model}}" },
    { key: "response_format", value: "json" },
    { key: "language", value: "{{language}}" },
    { key: "prompt", value: "{{prompt}}" },
  ],
  body: "",
  responsePath: "text",
});

const openAiChatTemplate = (authHeader: KeyValue): RequestTemplate => ({
  method: "POST",
  url: "{{endpoint}}",
  headers: [authHeader],
  bodyType: "json",
  fields: [],
  body: `{
  "model": "{{model}}",
  "temperature": 0.2,
  "messages": [
    { "role": "system", "content": "{{system_prompt}}" },
    { "role": "user", "content": "{{text}}" }
  ]
}`,
  responsePath: "choices.0.message.content",
});

const anthropicTemplate = (): RequestTemplate => ({
  method: "POST",
  url: "{{endpoint}}",
  headers: [
    { key: "x-api-key", value: "{{api_key}}" },
    { key: "anthropic-version", value: "2023-06-01" },
  ],
  bodyType: "json",
  fields: [],
  body: `{
  "model": "{{model}}",
  "max_tokens": 4096,
  "system": "{{system_prompt}}",
  "messages": [
    { "role": "user", "content": "{{text}}" }
  ]
}`,
  responsePath: "content.0.text",
});

const deepgramTemplate = (): RequestTemplate => ({
  method: "POST",
  url: "{{endpoint}}",
  headers: [
    { key: "Authorization", value: "Token {{api_key}}" },
    { key: "Content-Type", value: "{{mime_type}}" },
  ],
  bodyType: "binary",
  fields: [],
  body: "",
  responsePath: "results.channels.0.alternatives.0.transcript",
});

export const PROVIDER_DEFAULTS: Record<ProviderId, { transcription?: ProviderSettings; cleanup?: ProviderSettings }> = {
  groq: {
    transcription: provider({
      provider: "groq",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      modelsEndpoint: "https://api.groq.com/openai/v1/models",
      model: "whisper-large-v3-turbo",
    }),
    cleanup: provider({
      provider: "groq",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      modelsEndpoint: "https://api.groq.com/openai/v1/models",
      model: "openai/gpt-oss-120b",
    }),
  },
  cerebras: {
    cleanup: provider({
      provider: "cerebras",
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      modelsEndpoint: "https://api.cerebras.ai/v1/models",
      model: "gpt-oss-120b",
    }),
  },
  gemini: {
    cleanup: provider({
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
      model: "gemini-3.5-flash",
    }),
  },
  openai: {
    transcription: provider({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      modelsEndpoint: "https://api.openai.com/v1/models",
      model: "gpt-4o-mini-transcribe",
    }),
    cleanup: provider({
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      modelsEndpoint: "https://api.openai.com/v1/models",
      model: "gpt-4.1-mini",
    }),
  },
  "azure-speech": {
    transcription: provider({
      provider: "azure-speech",
      endpoint: AZURE_SPEECH_ENDPOINT,
      model: "MAI-Transcribe-2",
      format: "template",
      template: azureSpeechTemplate(maiDefinition("clean")),
      forceWav: true,
    }),
  },
  "azure-openai": {
    transcription: provider({
      provider: "azure-openai",
      endpoint: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/{{model}}/audio/transcriptions?api-version=2025-03-01-preview",
      model: "gpt-4o-transcribe",
      format: "template",
      template: openAiMultipartTemplate({ key: "api-key", value: "{{api_key}}" }),
    }),
    cleanup: provider({
      provider: "azure-openai",
      endpoint: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/{{model}}/chat/completions?api-version=2024-10-21",
      model: "gpt-4.1-mini",
      format: "template",
      template: openAiChatTemplate({ key: "api-key", value: "{{api_key}}" }),
    }),
  },
  deepgram: {
    transcription: provider({
      provider: "deepgram",
      endpoint: "https://api.deepgram.com/v1/listen?model={{model}}&smart_format=true",
      modelsEndpoint: "https://api.deepgram.com/v1/models",
      model: "nova-3",
      format: "template",
      template: deepgramTemplate(),
    }),
  },
  anthropic: {
    cleanup: provider({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      modelsEndpoint: "https://api.anthropic.com/v1/models",
      model: "claude-sonnet-5",
      format: "template",
      template: anthropicTemplate(),
    }),
  },
  custom: {
    transcription: provider({ provider: "custom", endpoint: "", model: "" }),
    cleanup: provider({ provider: "custom", endpoint: "", model: "" }),
  },
};

export const providerDefaults = (id: ProviderId, stage: PipelineStage) => {
  const defaults = PROVIDER_DEFAULTS[id][stage];
  return defaults ? cloneProvider(defaults) : undefined;
};

/** Models offered in the picker when a provider has no models endpoint. */
export const SUGGESTED_MODELS: Partial<Record<ProviderId, ModelOption[]>> = {
  "azure-speech": [
    { id: "MAI-Transcribe-2", name: "MAI-Transcribe-2 · 60 languages" },
    { id: "MAI-Transcribe-1.5", name: "MAI-Transcribe-1.5" },
  ],
  "azure-openai": [
    { id: "gpt-4o-transcribe", name: "Your deployment name" },
    { id: "gpt-4o-mini-transcribe", name: "Your deployment name" },
  ],
};

export interface TemplatePreset {
  id: string;
  label: string;
  description: string;
  settings: Partial<ProviderSettings>;
}

/** Starting points for the custom request editor. Applying one only replaces the request; see applyTemplatePreset. */
export const TEMPLATE_PRESETS: Record<PipelineStage, TemplatePreset[]> = {
  transcription: [
    {
      id: "mai-clean",
      label: "Microsoft MAI-Transcribe · clean",
      description: "Microsoft removes fillers and false starts on their side.",
      settings: { provider: "azure-speech", endpoint: AZURE_SPEECH_ENDPOINT, model: "MAI-Transcribe-2", forceWav: true, template: azureSpeechTemplate(maiDefinition("clean")) },
    },
    {
      id: "mai-verbatim",
      label: "Microsoft MAI-Transcribe · verbatim",
      description: "Raw output: keeps every “um”, false start, and self-correction.",
      settings: { provider: "azure-speech", endpoint: AZURE_SPEECH_ENDPOINT, model: "MAI-Transcribe-2", forceWav: true, template: azureSpeechTemplate(maiDefinition("verbatim")) },
    },
    {
      id: "mai-vocabulary",
      label: "Microsoft MAI-Transcribe · clean + vocabulary",
      description: "Biases recognition toward names and jargon. Edit the phrases list.",
      settings: {
        provider: "azure-speech", endpoint: AZURE_SPEECH_ENDPOINT, model: "MAI-Transcribe-2", forceWav: true,
        template: azureSpeechTemplate(`{
  "locales": {{locales}},
  "enhancedMode": {
    "enabled": true,
    "model": "{{model}}",
    "modelOptions": { "transcribeStyle": "clean" }
  },
  "phraseList": {
    "phrases": ["HushType", "Your Name", "Product Name"]
  }
}`),
      },
    },
    {
      id: "llm-speech",
      label: "Microsoft LLM Speech · prompt-tuned",
      description: "Azure's LLM-enhanced mode. The prompt steers output style.",
      settings: {
        provider: "azure-speech", endpoint: AZURE_SPEECH_ENDPOINT, model: "", forceWav: true,
        template: azureSpeechTemplate(`{
  "locales": {{locales_regional}},
  "enhancedMode": {
    "enabled": true,
    "task": "transcribe",
    "prompt": ["Output must be in display format with punctuation."]
  }
}`),
      },
    },
    {
      id: "azure-fast",
      label: "Microsoft Fast Transcription · classic",
      description: "The classic Azure speech model with profanity and diarization options.",
      settings: {
        provider: "azure-speech", endpoint: AZURE_SPEECH_ENDPOINT.replace("2025-10-15", "2024-11-15"), model: "", forceWav: true,
        template: azureSpeechTemplate(`{
  "locales": {{locales_regional}},
  "profanityFilterMode": "None"
}`),
      },
    },
    {
      id: "azure-openai-transcribe",
      label: "Azure OpenAI · gpt-4o-transcribe",
      description: "Model field = your deployment name.",
      settings: PROVIDER_DEFAULTS["azure-openai"].transcription!,
    },
    {
      id: "deepgram",
      label: "Deepgram · raw audio body",
      description: "Sends the recording as the request body instead of multipart.",
      settings: PROVIDER_DEFAULTS.deepgram.transcription!,
    },
    {
      id: "openai-multipart",
      label: "Generic OpenAI-style multipart",
      description: "A starting point for any Whisper-like API.",
      settings: { template: openAiMultipartTemplate({ key: "Authorization", value: "Bearer {{api_key}}" }) },
    },
  ],
  cleanup: [
    {
      id: "anthropic",
      label: "Anthropic Claude · Messages API",
      description: "Native Claude API with top-level system prompt.",
      settings: PROVIDER_DEFAULTS.anthropic.cleanup!,
    },
    {
      id: "gemini-native",
      label: "Google Gemini · generateContent",
      description: "Gemini's native API instead of its OpenAI shim.",
      settings: {
        provider: "gemini",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{{model}}:generateContent",
        modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        model: "gemini-3.5-flash",
        template: {
          method: "POST", url: "{{endpoint}}", headers: [{ key: "x-goog-api-key", value: "{{api_key}}" }], bodyType: "json", fields: [],
          body: `{
  "systemInstruction": { "parts": [{ "text": "{{system_prompt}}" }] },
  "contents": [{ "role": "user", "parts": [{ "text": "{{text}}" }] }]
}`,
          responsePath: "candidates.0.content.parts.0.text",
        },
      },
    },
    {
      id: "azure-openai-chat",
      label: "Azure OpenAI · chat completions",
      description: "Model field = your deployment name.",
      settings: PROVIDER_DEFAULTS["azure-openai"].cleanup!,
    },
    {
      id: "openai-chat",
      label: "Generic OpenAI-style chat",
      description: "A starting point for any chat-completions API.",
      settings: { template: openAiChatTemplate({ key: "Authorization", value: "Bearer {{api_key}}" }) },
    },
  ],
};

/**
 * Swaps in a preset's request (method, URL, headers, body, fields, response path) only.
 * Provider, endpoint, and models endpoint stay as the user set them: they also decide which
 * saved API key is used, so replacing them would silently disconnect the key.
 */
export const applyTemplatePreset = (current: ProviderSettings, preset: TemplatePreset): ProviderSettings => {
  const settings = structuredClone(preset.settings);
  return normalizeProvider({
    ...current,
    format: "template",
    template: settings.template ?? current.template,
    // Only fill what is still blank, so a fresh custom request gets a usable starting point.
    endpoint: current.endpoint.trim() ? current.endpoint : settings.endpoint ?? "",
    model: current.model.trim() ? current.model : settings.model ?? "",
    // Presets for APIs that reject WebM turn WAV on; never switch off a choice the user made.
    forceWav: current.forceWav || settings.forceWav === true,
  });
};

const rawProfile = (): DictationProfile => ({
  id: "raw",
  name: "Raw dictation",
  shortcut: "CommandOrControl+Shift+D",
  transcription: providerDefaults("groq", "transcription")!,
  cleanupEnabled: false,
  cleanup: providerDefaults("cerebras", "cleanup")!,
  language: "auto",
  transcriptionPrompt: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  pasteAfterDictation: true,
  trimSilence: true,
  silenceThresholdDb: -45,
});

const polishProfile = (): DictationProfile => ({
  ...rawProfile(),
  id: "polish",
  name: "Polish my words",
  shortcut: "CommandOrControl+Shift+P",
  cleanupEnabled: true,
});

export const createDefaultSettings = (): AppSettings => ({
  profiles: [rawProfile(), polishProfile()],
  activeProfileId: "polish",
  launchAtStartup: false,
  cancelShortcut: "CommandOrControl+Shift+Escape",
  overlayEnabled: true,
  overlaySuccessDurationMs: 650,
});

export const DEFAULT_SETTINGS = createDefaultSettings();
