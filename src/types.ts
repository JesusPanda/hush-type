export type View = "home" | "history" | "settings";
export type ProviderId = "groq" | "cerebras" | "gemini" | "openai" | "custom";
export type PipelineStage = "transcription" | "cleanup";

export interface ProviderSettings {
  provider: ProviderId;
  endpoint: string;
  modelsEndpoint: string;
  model: string;
  apiKeySet: boolean;
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

export const DEFAULT_SYSTEM_PROMPT =
  "Clean up this dictated text. Remove filler words and false starts, fix punctuation and capitalization, preserve the speaker's meaning and tone, and return only the edited text.";

export const PROVIDER_DEFAULTS: Record<ProviderId, { transcription?: ProviderSettings; cleanup?: ProviderSettings }> = {
  groq: {
    transcription: {
      provider: "groq",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      modelsEndpoint: "https://api.groq.com/openai/v1/models",
      model: "whisper-large-v3-turbo",
      apiKeySet: false,
    },
    cleanup: {
      provider: "groq",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      modelsEndpoint: "https://api.groq.com/openai/v1/models",
      model: "openai/gpt-oss-120b",
      apiKeySet: false,
    },
  },
  cerebras: {
    cleanup: {
      provider: "cerebras",
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      modelsEndpoint: "https://api.cerebras.ai/v1/models",
      model: "gpt-oss-120b",
      apiKeySet: false,
    },
  },
  gemini: {
    cleanup: {
      provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
      model: "gemini-3.5-flash",
      apiKeySet: false,
    },
  },
  openai: {
    transcription: {
      provider: "openai",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      modelsEndpoint: "https://api.openai.com/v1/models",
      model: "gpt-4o-mini-transcribe",
      apiKeySet: false,
    },
    cleanup: {
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      modelsEndpoint: "https://api.openai.com/v1/models",
      model: "gpt-4.1-mini",
      apiKeySet: false,
    },
  },
  custom: {
    transcription: { provider: "custom", endpoint: "", modelsEndpoint: "", model: "", apiKeySet: false },
    cleanup: { provider: "custom", endpoint: "", modelsEndpoint: "", model: "", apiKeySet: false },
  },
};

const rawProfile = (): DictationProfile => ({
  id: "raw",
  name: "Raw dictation",
  shortcut: "CommandOrControl+Shift+D",
  transcription: { ...PROVIDER_DEFAULTS.groq.transcription! },
  cleanupEnabled: false,
  cleanup: { ...PROVIDER_DEFAULTS.cerebras.cleanup! },
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
