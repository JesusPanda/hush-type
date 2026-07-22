import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  HistoryItem,
  ModelOption,
  PipelineStage,
  ProviderSettings,
  RecordingState,
  TranscriptionResult,
} from "../types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function loadSettings(): Promise<AppSettings | null> {
  if (!isTauri()) return null;
  return invoke<AppSettings>("load_settings");
}

export interface CredentialUpdate {
  profileId: string;
  stage: PipelineStage;
  apiKey: string;
}

export async function saveSettings(
  settings: AppSettings,
  credential?: CredentialUpdate,
): Promise<AppSettings> {
  if (!isTauri()) {
    localStorage.setItem("hushtype-settings", JSON.stringify(settings));
    return settings;
  }
  return invoke<AppSettings>("save_settings", {
    settings,
    profileId: credential?.profileId,
    stage: credential?.stage,
    apiKey: credential?.apiKey,
  });
}

export async function listModels(
  profileId: string,
  stage: PipelineStage,
  provider: ProviderSettings,
  apiKey?: string,
): Promise<ModelOption[]> {
  if (!isTauri()) return [];
  return invoke<ModelOption[]>("list_models", { profileId, stage, provider, apiKey });
}

export async function transcribe(
  audio: Uint8Array,
  mimeType: string,
  profileId: string,
  cleanupEnabled: boolean,
): Promise<TranscriptionResult> {
  if (!isTauri()) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return {
      rawText: "This is a preview transcription recorded in browser mode.",
      finalText: cleanupEnabled
        ? "This is a processed preview transcription recorded in browser mode."
        : "This is a preview transcription recorded in browser mode.",
    };
  }
  return invoke<TranscriptionResult>("transcribe_audio", {
    audio: Array.from(audio),
    mimeType,
    profileId,
  });
}

export async function pasteText(text: string): Promise<void> {
  if (!isTauri()) {
    await navigator.clipboard?.writeText(text);
    return;
  }
  await invoke("paste_text", { text });
}

export async function loadHistory(): Promise<HistoryItem[]> {
  if (!isTauri()) {
    return JSON.parse(localStorage.getItem("hushtype-history") ?? "[]") as HistoryItem[];
  }
  return invoke<HistoryItem[]>("load_history");
}

export async function saveHistory(items: HistoryItem[]): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem("hushtype-history", JSON.stringify(items));
    return;
  }
  await invoke("save_history", { items });
}

export async function onShortcut(callback: (profileId: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<string>("dictation-shortcut", (event) => callback(event.payload));
}

export interface OverlayPayload {
  visible: boolean;
  state: RecordingState;
  profileName: string;
  cleanupEnabled: boolean;
}

export async function setOverlay(payload: OverlayPayload): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_overlay", { payload });
}

export async function onCancelShortcut(callback: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen("dictation-cancel", callback);
}

export async function onOverlayCancel(callback: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen("overlay-cancel", callback);
}

export async function onOverlayState(callback: (payload: OverlayPayload) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<OverlayPayload>("overlay-state", (event) => callback(event.payload));
}

export async function requestOverlayCancel(): Promise<void> {
  if (!isTauri()) return;
  await emit("overlay-cancel");
}

export async function startOverlayDrag(): Promise<void> {
  if (!isTauri()) return;
  await invoke("start_overlay_drag");
}
