import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FolderOpen,
  History,
  Mic,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { ExtraParamsEditor, TemplateEditor, TestPanel } from "./components/RequestEditor";
import { Capsule } from "./components/Capsule";
import { useRecorder } from "./hooks/useRecorder";
import { useMicrophoneLevel } from "./hooks/useMicrophoneLevel";
import {
  listModels,
  loadHistory,
  loadSettings,
  onCancelShortcut,
  onOverlayCancel,
  onShortcut,
  pasteText,
  saveFailedRecording,
  saveHistory,
  saveSettings,
  showFailedRecording,
  setOverlay,
  transcribe,
  type CredentialUpdate,
} from "./lib/bridge";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  MODE_PIGMENTS,
  SUGGESTED_MODELS,
  TEMPLATE_PRESETS,
  applyTemplatePreset,
  isNativeGeminiSpeech,
  normalizeSettings,
  pigmentFor,
  providerDefaults,
  unusedPigment,
  type AppSettings,
  type DictationProfile,
  type HistoryItem,
  type ModelOption,
  type PipelineStage,
  type ProviderId,
  type ProviderSettings,
  type RecordingState,
  type RequestFormat,
  type TranscribeMode,
  type View,
} from "./types";

type SaveState = "idle" | "saving" | "saved" | "error";

const isMac = navigator.platform.includes("Mac");

const formatShortcut = (shortcut: string) =>
  shortcut
    .replace("CommandOrControl", isMac ? "⌘" : "Ctrl")
    .replaceAll("+", " + ");

const keyLabel = (key: string) => ({
  CommandOrControl: isMac ? "⌘" : "Ctrl",
  Shift: isMac ? "⇧" : "Shift",
  Alt: isMac ? "⌥" : "Alt",
  Escape: "Esc",
  Space: "Space",
})[key] ?? key;

const normalizeHistory = (item: HistoryItem): HistoryItem => ({
  ...item,
  profileId: item.profileId || item.mode || "legacy",
  profileName: item.profileName || (item.mode === "polish" ? "Polish my words" : "Raw dictation"),
  usedCleanup: item.profileId ? item.usedCleanup : item.mode === "polish",
});

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Sets the mode's pigment as a CSS variable for everything inside. */
const pig = (hex: string) => ({ "--pig": hex }) as CSSProperties;

const pigmentOf = (profiles: DictationProfile[], id: string) => {
  const index = profiles.findIndex((item) => item.id === id);
  return index < 0 ? undefined : pigmentFor(profiles[index], index);
};

function ModeIcon({ profile, size = 15 }: { profile: Pick<DictationProfile, "cleanupEnabled">; size?: number }) {
  return profile.cleanupEnabled ? <Sparkles size={size} strokeWidth={1.9} /> : <Mic size={size} strokeWidth={1.9} />;
}

function Logo() {
  return <span className="logo-mark" aria-hidden="true">{MODE_PIGMENTS.slice(0, 4).map((item) => <i key={item.id} style={{ background: item.hex }} />)}<b /></span>;
}

function Keys({ shortcut, empty = "No hotkey" }: { shortcut: string; empty?: string }) {
  if (!shortcut) return <span className="keys empty">{empty}</span>;
  return <span className="keys" aria-label={formatShortcut(shortcut)}>{shortcut.split("+").map((key, index) => <kbd key={`${key}-${index}`}>{keyLabel(key)}</kbd>)}</span>;
}

function SaveStatus({ state, error }: { state: SaveState; error: string }) {
  return (
    <div className={`save-status ${state}`} title={state === "error" ? error : undefined} role="status">
      {state === "saving" && <span className="spinner small" />}
      {state === "saved" && <Check size={13} strokeWidth={2.4} />}
      {state === "error" && <CircleAlert size={13} />}
      <span>{state === "error" ? error || "Couldn't save" : state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Autosave on"}</span>
    </div>
  );
}

interface ErrorEntry {
  id: string;
  at: number;
  message: string;
  profileName: string;
  /** Saved audio of a recording whose transcription failed. */
  recordingPath?: string;
}

const clockTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
const shortTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp);

function RecordingButton({ path }: { path?: string }) {
  if (!path) return null;
  return <button type="button" onClick={() => { void showFailedRecording(path); }} title={path}><FolderOpen size={13} /> Show recording</button>;
}

const fileStamp = (timestamp: number) => {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button>;
}

function ErrorPopover({ current, earlier, onRetry, onClose, onClear }: { current?: ErrorEntry; earlier: ErrorEntry[]; onRetry: () => void; onClose: () => void; onClear: () => void }) {
  return (
    <div className="error-popover" role="alertdialog" aria-label="Dictation errors">
      <header>
        <span className="error-popover-icon"><CircleAlert size={15} /></span>
        <div>
          <strong>{current ? "Couldn't finish" : "Recent errors"}</strong>
          <small>{current ? <><span>{current.profileName}</span><time>{clockTime(current.at)}</time></> : `${earlier.length} this session`}</small>
        </div>
        <button className="ghost-icon" onClick={onClose} title="Close" aria-label="Close"><X size={15} /></button>
      </header>
      {current && <>
        <pre className="error-message">{current.message}</pre>
        <div className="error-actions"><RecordingButton path={current.recordingPath} /><CopyButton text={current.message} /><button type="button" className="primary" onClick={onRetry}><Mic size={13} /> Try again</button></div>
      </>}
      {earlier.length > 0 && (
        <div className="error-log">
          {current && <span className="error-log-label">Earlier</span>}
          {earlier.map((entry) => (
            <details key={entry.id}>
              <summary><time>{clockTime(entry.at)}</time><span>{entry.message}</span><ChevronDown size={13} /></summary>
              <pre className="error-message">{entry.message}</pre>
              <div className="error-actions"><small>{entry.profileName}</small><RecordingButton path={entry.recordingPath} /><CopyButton text={entry.message} /></div>
            </details>
          ))}
        </div>
      )}
      <footer><button type="button" onClick={onClear}>Clear log</button></footer>
    </div>
  );
}

interface DictateControlProps {
  state: RecordingState;
  profile: DictationProfile;
  color: string;
  levels: number[];
  error: string;
  errorLog: ErrorEntry[];
  logOpen: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onOpenLog: () => void;
  onDismissError: () => void;
  onClearLog: () => void;
}

function DictateControl({ state, profile, color, levels, error, errorLog, logOpen, onToggle, onCancel, onOpenLog, onDismissError, onClearLog }: DictateControlProps) {
  const title: Record<RecordingState, string> = {
    idle: "Dictate",
    recording: "Listening",
    processing: profile.cleanupEnabled ? "Running pipeline" : "Transcribing",
    success: "Done",
    error: "Couldn't finish",
  };
  const icon = state === "recording"
    ? <Square size={11} fill="currentColor" strokeWidth={0} />
    : state === "processing"
      ? <span className="spinner small" />
      : state === "success"
        ? <Check size={15} strokeWidth={2.6} />
        : state === "error"
          ? <CircleAlert size={15} />
          : <ModeIcon profile={profile} />;
  const detail = state === "recording"
    ? <span className="dictate-wave" aria-label="Click to finish">{levels.map((level, index) => <i key={index} style={{ transform: `scaleY(${Math.max(0.12, Math.min(1, level))})` }} />)}</span>
    : <small>{state === "error" ? error || "Something went wrong" : profile.name}</small>;
  const current = state === "error" ? errorLog[0] : undefined;
  return (
    <div className="dictate-wrap" style={pig(color)}>
      {logOpen && (current || errorLog.length > 0) && <ErrorPopover current={current} earlier={current ? errorLog.slice(1) : errorLog} onRetry={onToggle} onClose={onDismissError} onClear={onClearLog} />}
      <div className={`dictate-control state-${state}`}>
        <button className="dictate-main" onClick={state === "error" ? onOpenLog : onToggle} disabled={state === "processing"} title={state === "recording" ? "Click to finish" : undefined}>
          <span className="dictate-icon">{icon}</span>
          <span className="dictate-copy"><strong>{title[state]}</strong>{detail}</span>
        </button>
        {state === "idle" && errorLog.length > 0 && <button className="dictate-log" onClick={logOpen ? onDismissError : onOpenLog} title="Recent errors" aria-label="Recent errors"><CircleAlert size={13} />{errorLog.length}</button>}
        {state !== "idle" && state !== "success" && <button className="dictate-cancel" onClick={onCancel} title="Cancel and discard" aria-label="Cancel and discard"><X size={14} strokeWidth={2.2} /></button>}
      </div>
    </div>
  );
}

interface SidebarProps {
  view: View;
  settings: AppSettings;
  historyCount: number;
  onView: (view: View) => void;
  onSelectMode: (id: string) => void;
  onAddMode: () => void;
  onDeleteMode: (id: string) => void;
  dictate: DictateControlProps;
}

function Sidebar({ view, settings, historyCount, onView, onSelectMode, onAddMode, onDeleteMode, dictate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand"><Logo /><span>HushType</span></div>
      <div className="nav-group modes-group">
        <div className="nav-label"><span>Modes</span><button onClick={onAddMode} title="New mode" aria-label="New mode"><Plus size={14} /></button></div>
        <div className="mode-nav">
          {settings.profiles.map((item, index) => {
            const active = view === "mode" && item.id === settings.activeProfileId;
            return (
              <button className={`mode-tab ${active ? "active" : ""}`} style={pig(pigmentFor(item, index).hex)} onClick={() => onSelectMode(item.id)} key={item.id} aria-current={active ? "page" : undefined}>
                <span className="mode-tab-ink" aria-hidden="true" />
                <span className="mode-tab-text">
                  <strong>{item.name || "Untitled mode"}{item.cleanupEnabled && <Sparkles size={11} strokeWidth={2.2} aria-label="Runs a second model" />}</strong>
                  <Keys shortcut={item.shortcut} />
                </span>
                {!item.transcription.apiKeySet && <span className="needs-key" title="Add an API key to use this mode" />}
                {settings.profiles.length > 1 && <i role="button" tabIndex={0} title="Delete mode" aria-label={`Delete ${item.name || "mode"}`} onClick={(event) => { event.stopPropagation(); onDeleteMode(item.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onDeleteMode(item.id); } }}><Trash2 size={13} /></i>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="nav-group">
        <button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => onView("history")} aria-current={view === "history" ? "page" : undefined}><History size={15} strokeWidth={1.9} /><span>History</span>{historyCount > 0 && <span className="nav-count">{historyCount}</span>}</button>
        <button className={`nav-item ${view === "general" ? "active" : ""}`} onClick={() => onView("general")} aria-current={view === "general" ? "page" : undefined}><SlidersHorizontal size={15} strokeWidth={1.9} /><span>General</span></button>
      </div>
      <div className="sidebar-footer"><DictateControl {...dictate} /></div>
    </aside>
  );
}

function HistoryEntry({ item, color, onCopy, onDelete }: { item: HistoryItem; color?: string; onCopy: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { onCopy(); setCopied(true); window.setTimeout(() => setCopied(false), 1200); };
  return (
    <li className={`entry ${color ? "" : "orphan"}`} style={color ? pig(color) : undefined}>
      <time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{shortTime(item.createdAt)}</time>
      <div className="entry-body">
        <p>{item.finalText}</p>
        <div className="entry-meta">
          <span className="entry-mode">{item.usedCleanup ? <Sparkles size={11} strokeWidth={2.2} /> : <Mic size={11} strokeWidth={2.2} />}{item.profileName}</span>
          <span>{Math.max(1, Math.round(item.durationMs / 1000))} s of audio</span>
        </div>
      </div>
      <div className="entry-actions"><button onClick={copy} title="Copy" aria-label="Copy">{copied ? <Check size={15} /> : <Copy size={15} />}</button><button className="danger" onClick={onDelete} title="Delete" aria-label="Delete"><Trash2 size={15} /></button></div>
    </li>
  );
}

function EmptyHistory({ searching, onStart }: { searching: boolean; onStart: () => void }) {
  if (searching) return <div className="empty-history"><h3>No matches</h3><p>Try a different word or mode name.</p></div>;
  return <div className="empty-history"><h3>Nothing here yet</h3><p>Every dictation stays on this device so you can copy or reuse it later.</p><button className="primary-button" onClick={onStart}><Mic size={15} /> Start dictating</button></div>;
}

const dayLabel = (timestamp: number) => {
  const day = new Date(timestamp).toDateString();
  const now = new Date();
  if (day === now.toDateString()) return "Today";
  if (day === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: new Date(timestamp).getFullYear() === now.getFullYear() ? undefined : "numeric" }).format(timestamp);
};

function HistoryView({ history, profiles, onCopy, onDelete, onStart }: { history: HistoryItem[]; profiles: DictationProfile[]; onCopy: (text: string) => void; onDelete: (id: string) => void; onStart: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = history.filter((item) => `${item.profileName} ${item.finalText}`.toLowerCase().includes(query.toLowerCase()));
  const today = history.filter((item) => new Date(item.createdAt).toDateString() === new Date().toDateString());
  const wordCount = today.reduce((sum, item) => sum + countWords(item.finalText), 0);
  const groups = filtered.reduce<Array<{ label: string; items: HistoryItem[] }>>((list, item) => {
    const label = dayLabel(item.createdAt);
    const last = list[list.length - 1];
    if (last?.label === label) last.items.push(item); else list.push({ label, items: [item] });
    return list;
  }, []);
  return (
    <main className="page history-page">
      <header className="history-head">
        <h1>History</h1>
        <p className="tally"><span className="num">{today.length}</span> {today.length === 1 ? "dictation" : "dictations"} and <span className="num">{wordCount.toLocaleString()}</span> {wordCount === 1 ? "word" : "words"} today.</p>
        <p className="history-note">Stored only on this device.</p>
      </header>
      <div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search dictations or modes" aria-label="Search history" />{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}</div>
      {groups.length
        ? groups.map((group) => (
          <section className="day" key={group.label}>
            <h2>{group.label}</h2>
            <ol className="entries">{group.items.map((item) => <HistoryEntry key={item.id} item={item} color={pigmentOf(profiles, item.profileId)?.hex} onCopy={() => onCopy(item.finalText)} onDelete={() => onDelete(item.id)} />)}</ol>
          </section>
        ))
        : <EmptyHistory searching={!!query} onStart={onStart} />}
    </main>
  );
}

function ShortcutRecorder({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    if (event.key === "Escape") { setCapturing(false); event.currentTarget.blur(); return; }
    if (event.key === "Backspace" || event.key === "Delete") { onChange(""); return; }
    if (["Control", "Meta", "Shift", "Alt"].includes(event.key)) return;
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    const aliases: Record<string, string> = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
    const key = aliases[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
    parts.push(key);
    onChange(parts.join("+"));
    setCapturing(false);
    event.currentTarget.blur();
  };
  return (
    <div className={`shortcut-recorder ${capturing ? "capturing" : ""} ${value ? "" : "unset"}`}>
      <input readOnly aria-label="Hotkey" value={capturing ? "Press your shortcut…" : value ? formatShortcut(value) : "Click to record a hotkey"} onFocus={() => setCapturing(true)} onBlur={() => setCapturing(false)} onKeyDown={onKeyDown} />
      {!capturing && value && <Keys shortcut={value} />}
      {value && <button type="button" onClick={() => onChange("")} title="Remove hotkey" aria-label="Remove hotkey"><X size={13} /></button>}
    </div>
  );
}

const SENSITIVITY_MIN_DB = -60;
const SENSITIVITY_MAX_DB = -20;

function SensitivityControl({ enabled, thresholdDb, isRecording, recordingLevelDb, onEnabled, onThreshold }: {
  enabled: boolean;
  thresholdDb: number;
  isRecording: boolean;
  recordingLevelDb: number;
  onEnabled: (enabled: boolean) => void;
  onThreshold: (thresholdDb: number) => void;
}) {
  const microphoneMonitor = useMicrophoneLevel(enabled && !isRecording);
  const levelDb = isRecording ? recordingLevelDb : microphoneMonitor.levelDb;
  const monitorState = isRecording ? "active" : microphoneMonitor.state;
  const clampedLevel = Math.max(SENSITIVITY_MIN_DB, Math.min(SENSITIVITY_MAX_DB, levelDb));
  const levelPosition = ((clampedLevel - SENSITIVITY_MIN_DB) / (SENSITIVITY_MAX_DB - SENSITIVITY_MIN_DB)) * 100;
  const thresholdPosition = ((thresholdDb - SENSITIVITY_MIN_DB) / (SENSITIVITY_MAX_DB - SENSITIVITY_MIN_DB)) * 100;
  const voiceDetected = enabled && monitorState === "active" && levelDb >= thresholdDb;
  const status = monitorState === "starting"
    ? "Starting microphone…"
    : monitorState === "unavailable"
      ? "Microphone preview unavailable"
      : monitorState === "active"
        ? voiceDetected ? "Voice detected" : "Listening for your voice"
        : "Turn on to set the cutoff";
  const updateFromPointer = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!enabled || (event.type === "pointermove" && event.buttons === 0)) return;
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onThreshold(Math.round(SENSITIVITY_MIN_DB + position * (SENSITIVITY_MAX_DB - SENSITIVITY_MIN_DB)));
  };
  const adjustWithKeyboard = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const next = event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? thresholdDb - 1
      : event.key === "ArrowRight" || event.key === "ArrowUp"
        ? thresholdDb + 1
        : event.key === "Home"
          ? SENSITIVITY_MIN_DB
          : event.key === "End"
            ? SENSITIVITY_MAX_DB
            : null;
    if (next === null) return;
    event.preventDefault();
    onThreshold(Math.max(SENSITIVITY_MIN_DB, Math.min(SENSITIVITY_MAX_DB, next)));
  };

  return (
    <section className={`sensitivity-control ${enabled ? "enabled" : "disabled"}`}>
      <label className="setting-row">
        <div><strong>Silence threshold</strong><small>Filter ambient noise and trim quiet gaps before upload.</small></div>
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
      </label>
      <div className="sensitivity-body" aria-disabled={!enabled}>
        <div className="sensitivity-readout">
          <span className={`monitor-status ${voiceDetected ? "voice" : ""}`}><i />{status}</span>
          <strong>{thresholdDb} dB</strong>
        </div>
        <div className={`sensitivity-meter ${voiceDetected ? "voice-detected" : ""}`}>
          <div className="meter-quiet" style={{ width: `${thresholdPosition}%` }} />
          <div className="input-level-fill" style={{ width: `${levelPosition}%` }} />
          <input aria-label="Silence threshold" type="range" min={SENSITIVITY_MIN_DB} max={SENSITIVITY_MAX_DB} step="1" value={thresholdDb} disabled={!enabled} onPointerDown={updateFromPointer} onPointerMove={updateFromPointer} onKeyDown={adjustWithKeyboard} onChange={(event) => onThreshold(Number(event.target.value))} />
        </div>
        <div className="sensitivity-scale"><span>Keeps quieter speech</span><span>Filters more noise</span></div>
      </div>
    </section>
  );
}

const providerLabel = (provider: ProviderId) => ({
  groq: "Groq",
  cerebras: "Cerebras",
  gemini: "Google Gemini",
  openai: "OpenAI",
  "azure-speech": "Microsoft Azure Speech (MAI-Transcribe)",
  "azure-openai": "Azure OpenAI",
  deepgram: "Deepgram",
  anthropic: "Anthropic Claude",
  custom: "Custom API",
})[provider];

interface ProviderEditorProps {
  profile: DictationProfile;
  stage: PipelineStage;
  onChange: (provider: ProviderSettings) => void;
  onSaveKey: (update: CredentialUpdate) => Promise<void>;
}

function ProviderEditor({ profile, stage, onChange, onSaveKey }: ProviderEditorProps) {
  const provider = stage === "transcription" ? profile.transcription : profile.cleanup;
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsState, setModelsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [modelsError, setModelsError] = useState("");
  const saveTimer = useRef<number | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;

  const refreshModels = useCallback(async (key?: string) => {
    setModelsState("loading"); setModelsError("");
    try { const found = await listModels(profile.id, stage, providerRef.current, key); setModels(found); setModelsState("ready"); }
    catch (cause) { setModelsError(cause instanceof Error ? cause.message : String(cause)); setModelsState("error"); }
  }, [profile.id, stage]);

  const commitKey = useCallback((value: string) => {
    const key = value.trim();
    if (key.length < 4) return;
    const replacesExistingKey = providerRef.current.apiKeySet;
    setApiKey("");
    void onSaveKey({ profileId: profile.id, stage, apiKey: key }).then(() => {
      if (replacesExistingKey && providerRef.current.modelsEndpoint) void refreshModels(key);
    });
  }, [onSaveKey, profile.id, refreshModels, stage]);

  useEffect(() => {
    setModels([]); setModelsState("idle"); setModelsError(""); setApiKey("");
    if (provider.apiKeySet && provider.modelsEndpoint) void refreshModels();
  }, [profile.id, provider.provider, provider.modelsEndpoint, provider.apiKeySet, refreshModels]);

  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (apiKey.trim().length < 4) return;
    saveTimer.current = window.setTimeout(() => commitKey(apiKey), 850);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [apiKey, commitKey]);

  const changeProvider = (providerId: ProviderId) => {
    const defaults = providerDefaults(providerId, stage);
    if (defaults) onChange(defaults);
  };
  const changeFormat = (format: RequestFormat) => {
    if (format === provider.format) return;
    const template = provider.template;
    const isBlank = !template.headers.length && !template.fields.length && !template.body.trim();
    const generic = TEMPLATE_PRESETS[stage].find((preset) => preset.id === (stage === "transcription" ? "openai-multipart" : "openai-chat"));
    if (format === "template" && isBlank && generic) onChange(applyTemplatePreset(provider, generic));
    else onChange({ ...provider, format });
  };
  const options: ProviderId[] = stage === "transcription"
    ? ["groq", "gemini", "openai", "azure-speech", "azure-openai", "deepgram", "custom"]
    : ["cerebras", "gemini", "groq", "openai", "anthropic", "azure-openai", "custom"];
  const suggested = (SUGGESTED_MODELS[provider.provider] ?? []).filter((item) => !models.some((model) => model.id === item.id));
  const listId = `models-${profile.id}-${stage}`;
  const geminiSpeech = stage === "transcription" && provider.provider === "gemini";
  return (
    <div className="provider-editor">
      <div className="form-grid">
        <label><span>Provider</span><div className="select-wrap"><select value={provider.provider} onChange={(event) => changeProvider(event.target.value as ProviderId)}>{options.map((id) => <option value={id} key={id}>{providerLabel(id)}</option>)}</select><ChevronDown size={15} /></div></label>
        <label><span>Model {modelsState === "ready" && <small className="ok"><Check size={11} strokeWidth={2.6} /> {models.length} available</small>}</span><div className="model-combobox"><input list={listId} value={provider.model} onChange={(event) => onChange({ ...provider, model: event.target.value })} placeholder={modelsState === "loading" ? "Loading models…" : "Select or type a model ID"} /><datalist id={listId}>{[...suggested, ...models].map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</datalist><button type="button" onClick={() => void refreshModels(apiKey || undefined)} disabled={modelsState === "loading" || !provider.modelsEndpoint} title={provider.modelsEndpoint ? "Refresh available models" : "No models endpoint for this provider"} aria-label="Refresh available models"><RefreshCw size={14} className={modelsState === "loading" ? "spinning" : ""} /></button></div></label>
        <label className={`span-two ${!provider.apiKeySet ? "needs-attention" : ""}`}><span>API key {provider.apiKeySet ? <small className="ok"><Check size={11} strokeWidth={2.6} /> Saved in your keychain. Type to replace it.</small> : <small className="warn">Required</small>}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onBlur={() => commitKey(apiKey)} placeholder={provider.apiKeySet ? "••••••••••••••••" : `Paste your ${providerLabel(provider.provider)} key`} /></label>
        <div className="span-two format-switch" role="radiogroup" aria-label="Request format">
          <span>Request format</span>
          <div>
            <button type="button" role="radio" aria-checked={provider.format === "openai"} className={provider.format === "openai" ? "active" : ""} onClick={() => changeFormat("openai")}>{geminiSpeech ? "Gemini Transcribe" : "OpenAI-compatible"}</button>
            <button type="button" role="radio" aria-checked={provider.format === "template"} className={provider.format === "template" ? "active" : ""} onClick={() => changeFormat("template")}>Custom request</button>
          </div>
        </div>
        <label className="span-two"><span>API endpoint {provider.endpoint.includes("YOUR-RESOURCE") && <small className="warn">Replace YOUR-RESOURCE with your resource name</small>}</span><input className="code" spellCheck={false} value={provider.endpoint} onChange={(event) => onChange({ ...provider, endpoint: event.target.value })} /></label>
        <label className="span-two"><span>Models endpoint <small>Optional. Used to list available models.</small></span><input className="code" spellCheck={false} value={provider.modelsEndpoint} onChange={(event) => onChange({ ...provider, modelsEndpoint: event.target.value })} /></label>
        {isNativeGeminiSpeech(provider, stage) && <GeminiModePicker value={provider.transcribeMode} onChange={(transcribeMode) => onChange({ ...provider, transcribeMode })} />}
        {stage === "transcription" && <label className="span-two setting-row"><div><strong>Always send WAV audio</strong><small>Needed by APIs that reject WebM (Microsoft MAI accepts WAV, MP3, FLAC). Silence trimming already sends WAV.</small></div><input type="checkbox" checked={provider.forceWav} onChange={(event) => onChange({ ...provider, forceWav: event.target.checked })} /></label>}
      </div>
      {modelsState === "error" && <div className="models-message error">{modelsError}</div>}
      {provider.format === "template"
        ? <TemplateEditor provider={provider} stage={stage} onChange={onChange} onDetectedKey={setApiKey} />
        : <ExtraParamsEditor provider={provider} stage={stage} onChange={onChange} />}
      <TestPanel profileId={profile.id} stage={stage} provider={provider} systemPrompt={profile.systemPrompt} />
    </div>
  );
}

const GEMINI_MODES: Array<{ id: TranscribeMode; label: string; description: string }> = [
  {
    id: "smart",
    label: "Smart",
    description: "Removes fillers and false starts, keeps only your final self-correction, formats lists, numbers, dates, and money, and applies spoken edits such as “delete the last sentence” or “make that a bulleted list”.",
  },
  {
    id: "verbatim",
    label: "Direct",
    description: "Verbatim: an exact word-for-word transcript. Keeps every “um”, repetition, and false start, and treats spoken edits as words.",
  },
];

/** Gemini 3.5 Transcribe's two modes. */
function GeminiModePicker({ value, onChange }: { value: TranscribeMode; onChange: (mode: TranscribeMode) => void }) {
  const active = GEMINI_MODES.find((mode) => mode.id === value) ?? GEMINI_MODES[0];
  return (
    <div className="span-two format-switch" role="radiogroup" aria-label="Transcription mode">
      <span>Transcription mode <small>{active.description}</small></span>
      <div>
        {GEMINI_MODES.map((mode) => (
          <button type="button" role="radio" key={mode.id} aria-checked={mode.id === value} className={mode.id === value ? "active" : ""} onClick={() => onChange(mode.id)}>{mode.label}</button>
        ))}
      </div>
    </div>
  );
}

/** One step hanging off the pipeline wire. */
function Stage({ id, title, description, action, children, off }: { id: string; title: string; description: string; action?: React.ReactNode; children?: React.ReactNode; off?: boolean }) {
  return (
    <section className={`stage ${off ? "off" : ""}`} id={id} aria-labelledby={`${id}-title`}>
      <span className="stage-node" aria-hidden="true" />
      <header className="stage-header"><div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div>{action}</header>
      {children && <div className="stage-body">{children}</div>}
    </section>
  );
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });

function Pipeline({ profile }: { profile: DictationProfile }) {
  return (
    <nav className="pipeline" aria-label="Pipeline">
      <span className="pipe-end"><Mic size={14} strokeWidth={2} />Microphone</span>
      <i className="pipe-wire" />
      <button type="button" className="pipe-stage" onClick={() => jumpTo("stage-speech")}><small>Speech to text</small><strong>{profile.transcription.model || "Choose a model"}</strong></button>
      <i className={`pipe-wire ${profile.cleanupEnabled ? "" : "bypass"}`} />
      <button type="button" className={`pipe-stage ${profile.cleanupEnabled ? "" : "off"}`} onClick={() => jumpTo("stage-second")}><small>Second model</small><strong>{profile.cleanupEnabled ? profile.cleanup.model || "Choose a model" : "Skipped"}</strong></button>
      <i className="pipe-wire" />
      <button type="button" className="pipe-end" onClick={() => jumpTo("stage-delivery")}>{profile.pasteAfterDictation ? "Cursor" : "History only"}</button>
    </nav>
  );
}

interface ModeViewProps {
  settings: AppSettings;
  saveState: SaveState;
  saveError: string;
  onSettings: (settings: AppSettings) => void;
  onSaveKey: (update: CredentialUpdate) => Promise<void>;
  onDelete: (id: string) => void;
  isRecording: boolean;
  recordingLevelDb: number;
}

function ModeView({ settings, saveState, saveError, onSettings, onSaveKey, onDelete, isRecording, recordingLevelDb }: ModeViewProps) {
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) ?? settings.profiles[0];
  const index = settings.profiles.indexOf(profile);
  const pigment = pigmentFor(profile, index);
  const updateProfile = (changes: Partial<DictationProfile>) => onSettings({ ...settings, profiles: settings.profiles.map((item) => item.id === profile.id ? { ...item, ...changes } : item) });
  return (
    <main className="page mode-page" style={pig(pigment.hex)}>
      <header className="mode-header">
        <div className="mode-title-row">
          <input className="title-input" value={profile.name} onChange={(event) => updateProfile({ name: event.target.value })} placeholder="Name this mode" aria-label="Mode name" />
          <SaveStatus state={saveState} error={saveError} />
          {settings.profiles.length > 1 && <button className="ghost-icon danger" onClick={() => onDelete(profile.id)} title="Delete mode" aria-label="Delete mode"><Trash2 size={15} /></button>}
        </div>
        <div className="mode-meta-row">
          <div className="hotkey-field"><span>Hotkey</span><ShortcutRecorder value={profile.shortcut} onChange={(shortcut) => updateProfile({ shortcut })} /></div>
          <div className="pigment-picker" role="radiogroup" aria-label="Mode color">
            {MODE_PIGMENTS.map((item) => (
              <button type="button" role="radio" key={item.id} aria-checked={item.id === pigment.id} aria-label={item.name} title={item.name} style={{ background: item.hex }} onClick={() => updateProfile({ color: item.id })} />
            ))}
          </div>
        </div>
        <Pipeline profile={profile} />
      </header>

      <div className="wire">
        <Stage id="stage-speech" title="Speech to text" description="Turns the recording into text.">
          <ProviderEditor profile={profile} stage="transcription" onChange={(transcription) => updateProfile({ transcription })} onSaveKey={onSaveKey} />
          {isNativeGeminiSpeech(profile.transcription, "transcription")
            ? <label className="field-block"><span>Custom vocabulary <small>Names and terms to spell exactly, separated by commas or new lines. Sent as custom_vocabulary: up to 1,000 terms, best under 100.</small></span><textarea rows={2} value={profile.transcriptionPrompt} onChange={(event) => updateProfile({ transcriptionPrompt: event.target.value })} placeholder="T3 Code, subagents, Claude Code, Tauri" /></label>
            : <label className="field-block"><span>Speech prompt <small>Optional vocabulary or style hint. Sent as the prompt field, or as {"{{prompt}}"} in custom requests.</small></span><textarea rows={2} value={profile.transcriptionPrompt} onChange={(event) => updateProfile({ transcriptionPrompt: event.target.value })} placeholder="For example: HushType, Kubernetes, Tauri. Spell product names exactly like this." /></label>}
        </Stage>

        <Stage
          id="stage-second"
          title="Second model"
          description={profile.cleanupEnabled ? "Polish, translate, format, summarize, or transform the transcript." : "Off. The transcript goes straight to the cursor."}
          off={!profile.cleanupEnabled}
          action={<input type="checkbox" aria-label="Run a second model" checked={profile.cleanupEnabled} onChange={(event) => updateProfile({ cleanupEnabled: event.target.checked })} />}
        >
          {profile.cleanupEnabled && <>
            <ProviderEditor profile={profile} stage="cleanup" onChange={(cleanup) => updateProfile({ cleanup })} onSaveKey={onSaveKey} />
            <label className="field-block"><span>System instruction <small>Sent with every dictation in this mode</small></span><textarea rows={7} value={profile.systemPrompt} onChange={(event) => updateProfile({ systemPrompt: event.target.value })} placeholder="For example: Translate the transcript into concise, natural Italian. Return only the translation." /><div className="prompt-meta"><span>{profile.systemPrompt.length.toLocaleString()} characters</span><button type="button" onClick={() => updateProfile({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}><RotateCcw size={12} /> Reset to default</button></div></label>
          </>}
        </Stage>

        <Stage id="stage-delivery" title="Delivery" description="Language, pasting, and noise handling.">
          <div className="behavior-grid">
            <label className="setting-row"><div><strong>Language</strong><small>Leave on auto-detect unless you only speak one language.</small></div><div className="select-wrap compact"><select value={profile.language} onChange={(event) => updateProfile({ language: event.target.value })}><option value="auto">Auto-detect</option><option value="en">English</option><option value="it">Italian</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt">Portuguese</option><option value="ja">Japanese</option><option value="zh">Chinese</option></select><ChevronDown size={15} /></div></label>
            <label className="setting-row"><div><strong>Paste automatically</strong><small>Insert the finished text at the active cursor.</small></div><input type="checkbox" checked={profile.pasteAfterDictation} onChange={(event) => updateProfile({ pasteAfterDictation: event.target.checked })} /></label>
            <SensitivityControl enabled={profile.trimSilence} thresholdDb={profile.silenceThresholdDb} isRecording={isRecording} recordingLevelDb={recordingLevelDb} onEnabled={(trimSilence) => updateProfile({ trimSilence })} onThreshold={(silenceThresholdDb) => updateProfile({ silenceThresholdDb })} />
          </div>
        </Stage>
      </div>
    </main>
  );
}

const CAPSULE_PREVIEW_STATES: RecordingState[] = ["recording", "processing", "success", "error"];
const capsuleStateLabel: Partial<Record<RecordingState, string>> = { recording: "Listening", processing: "Working", success: "Pasted", error: "Failed" };

function GeneralView({ settings, saveState, saveError, onSettings }: { settings: AppSettings; saveState: SaveState; saveError: string; onSettings: (settings: AppSettings) => void }) {
  const overlaySuccessDurationMs = settings.overlaySuccessDurationMs ?? 650;
  const activeIndex = Math.max(0, settings.profiles.findIndex((item) => item.id === settings.activeProfileId));
  const color = pigmentFor(settings.profiles[activeIndex], activeIndex).hex;
  return (
    <main className="page general-page" style={pig(color)}>
      <header className="page-header"><div><h1>General</h1><p>Applies to every mode.</p></div><SaveStatus state={saveState} error={saveError} /></header>
      <section className="settings-list">
        <div className="setting-row">
          <div><strong>Cancel recording</strong><small>Discards the audio immediately. Nothing is sent to an API.</small></div>
          <div className="hotkey-control"><ShortcutRecorder value={settings.cancelShortcut} onChange={(cancelShortcut) => onSettings({ ...settings, cancelShortcut })} /></div>
        </div>
        <div className="setting-row overlay-setting">
          <label className="setting-row-main">
            <div><strong>Floating pop-up</strong><small>Show a small recording pill over other apps. It wears the color of the mode you're using.</small></div>
            <input type="checkbox" checked={settings.overlayEnabled} onChange={(event) => onSettings({ ...settings, overlayEnabled: event.target.checked })} />
          </label>
          <div className={`capsule-gallery ${settings.overlayEnabled ? "" : "disabled"}`} aria-hidden="true">
            {CAPSULE_PREVIEW_STATES.map((state) => <figure key={state}><Capsule state={state} color={color} preview /><figcaption>{capsuleStateLabel[state]}</figcaption></figure>)}
          </div>
        </div>
        <div className={`setting-row stacked ${settings.overlayEnabled ? "" : "disabled"}`}>
          <div className="range-heading"><div><strong>Hide after pasting</strong><small>How long the pop-up stays once text is pasted.</small></div><span className="value-pill">{overlaySuccessDurationMs < 1000 ? `${overlaySuccessDurationMs} ms` : `${(overlaySuccessDurationMs / 1000).toFixed(overlaySuccessDurationMs % 1000 ? 1 : 0)} s`}</span></div>
          <input className="range" type="range" aria-label="Hide after pasting" min="200" max="2500" step="50" value={overlaySuccessDurationMs} disabled={!settings.overlayEnabled} onChange={(event) => onSettings({ ...settings, overlaySuccessDurationMs: Number(event.target.value) })} style={{ "--fill": `${((overlaySuccessDurationMs - 200) / 2300) * 100}%` } as CSSProperties} />
          <div className="range-scale"><span>Faster</span><span>Slower</span></div>
        </div>
      </section>
      <p className="footnote"><span className="status-dot" />Local-first. API keys live in your system keychain, and history never leaves this device.</p>
    </main>
  );
}

type Phase = "idle" | "starting" | "recording" | "finishing";

export default function App() {
  const [view, setView] = useState<View>("mode");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [recordingProfileId, setRecordingProfileId] = useState(DEFAULT_SETTINGS.activeProfileId);
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState("");
  const [errorLog, setErrorLog] = useState<ErrorEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const recorder = useRecorder();
  const settingsRef = useRef(settings);
  const historyRef = useRef(history);
  const lastSaved = useRef("");
  const sessionRef = useRef(0);
  // Source of truth for the recording lifecycle. React state lags a render behind, so a
  // second hotkey press arriving mid-transition must be judged against this ref instead.
  const phaseRef = useRef<Phase>("idle");
  const recordingProfileRef = useRef(DEFAULT_SETTINGS.activeProfileId);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    void Promise.all([loadSettings(), loadHistory()]).then(([savedSettings, savedHistory]) => {
      const browserSettings = JSON.parse(localStorage.getItem("hushtype-settings") ?? "null") as AppSettings | null;
      const next = normalizeSettings(savedSettings ?? (browserSettings?.profiles?.length ? browserSettings : null) ?? DEFAULT_SETTINGS);
      setSettings(next); settingsRef.current = next; lastSaved.current = JSON.stringify(next);
      setRecordingProfileId(next.activeProfileId); recordingProfileRef.current = next.activeProfileId;
      const items = savedHistory.map(normalizeHistory);
      setHistory(items); historyRef.current = items;
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const serialized = JSON.stringify(settings);
    if (serialized === lastSaved.current) return;
    setSaveState("saving"); setSaveError("");
    const timer = window.setTimeout(() => {
      const candidate = settings;
      void saveSettings(candidate).then((result) => {
        const saved = normalizeSettings(result);
        lastSaved.current = JSON.stringify(saved);
        if (JSON.stringify(settingsRef.current) === serialized) setSettings(saved);
        setSaveState("saved");
      }).catch((cause) => { setSaveError(cause instanceof Error ? cause.message : String(cause)); setSaveState("error"); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [loaded, settings]);

  const saveKey = useCallback(async (credential: CredentialUpdate) => {
    setSaveState("saving"); setSaveError("");
    try {
      const candidate = settingsRef.current;
      const saved = normalizeSettings(await saveSettings(candidate, credential));
      lastSaved.current = JSON.stringify(saved); setSettings(saved); setSaveState("saved");
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : String(cause)); setSaveState("error"); throw cause; }
  }, []);

  const persistHistory = useCallback((items: HistoryItem[]) => { historyRef.current = items; setHistory(items); void saveHistory(items); }, []);
  const profile = settings.profiles.find((item) => item.id === recordingProfileId) ?? settings.profiles[0];
  const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId) ?? settings.profiles[0];

  /** What the floating pop-up shows for a mode, including the mode's pigment. */
  const overlayFor = useCallback((current: DictationProfile, overlayState: RecordingState, visible = true) => ({
    visible,
    state: overlayState,
    profileName: current.name,
    cleanupEnabled: current.cleanupEnabled,
    color: pigmentOf(settingsRef.current.profiles, current.id)?.hex,
  }), []);

  const fail = useCallback((message: string, profileName: string, recordingPath?: string) => {
    setError(message); setState("error");
    setErrorLog((log) => [{ id: crypto.randomUUID(), at: Date.now(), message, profileName, recordingPath }, ...log].slice(0, 20));
  }, []);

  const finish = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    phaseRef.current = "finishing";
    setState("processing");
    const current = settingsRef.current.profiles.find((item) => item.id === recordingProfileRef.current) ?? settingsRef.current.profiles[0];
    const session = sessionRef.current;
    if (settingsRef.current.overlayEnabled) void setOverlay(overlayFor(current, "processing"));
    let failedAudio: { bytes: Uint8Array; mimeType: string } | undefined;
    try {
      const recording = await recorder.stop({ trimSilence: current.trimSilence, thresholdDb: current.silenceThresholdDb, forceWav: current.transcription.forceWav });
      if (recording.durationMs < 350 || recording.bytes.length < 100) throw new Error("That recording was too short. Try again.");
      let result;
      try {
        result = await transcribe(recording.bytes, recording.mimeType, current.id, current.cleanupEnabled);
      } catch (cause) {
        // Only keep audio when the API request failed; successful recordings are never written to disk.
        failedAudio = { bytes: recording.bytes, mimeType: recording.mimeType };
        throw cause;
      }
      if (session !== sessionRef.current) return;
      const item: HistoryItem = { id: crypto.randomUUID(), createdAt: Date.now(), profileId: current.id, profileName: current.name, usedCleanup: current.cleanupEnabled, rawText: result.rawText, finalText: result.finalText, durationMs: recording.durationMs };
      persistHistory([item, ...historyRef.current].slice(0, 250));
      if (current.pasteAfterDictation) await pasteText(result.finalText);
      if (session !== sessionRef.current) return;
      phaseRef.current = "idle";
      setState("success");
      if (settingsRef.current.overlayEnabled) void setOverlay(overlayFor(current, "success"));
      window.setTimeout(() => {
        // A newer dictation owns the pop-up now; don't hide it.
        if (session !== sessionRef.current || phaseRef.current !== "idle") return;
        setState("idle"); void setOverlay(overlayFor(current, "idle", false));
      }, settingsRef.current.overlaySuccessDurationMs ?? 650);
    } catch (cause) {
      if (session !== sessionRef.current) return;
      phaseRef.current = "idle";
      let message = cause instanceof Error ? cause.message : String(cause);
      let recordingPath: string | undefined;
      if (failedAudio) {
        try { recordingPath = (await saveFailedRecording(failedAudio.bytes, failedAudio.mimeType, fileStamp(Date.now()))) ?? undefined; }
        catch (saveCause) { message += `

The recording could not be saved: ${saveCause instanceof Error ? saveCause.message : String(saveCause)}`; }
      }
      if (session !== sessionRef.current) return;
      fail(message, current.name, recordingPath);
      if (settingsRef.current.overlayEnabled) {
        void setOverlay(overlayFor(current, "error"));
        window.setTimeout(() => {
          if (session !== sessionRef.current || phaseRef.current !== "idle") return;
          void setOverlay(overlayFor(current, "idle", false));
        }, 2300);
      }
    }
  }, [fail, overlayFor, persistHistory, recorder]);

  const start = useCallback(async (requestedProfileId?: string) => {
    if (phaseRef.current === "recording") { await finish(); return; }
    if (phaseRef.current !== "idle") return;
    phaseRef.current = "starting";
    const id = requestedProfileId ?? settingsRef.current.activeProfileId;
    const current = settingsRef.current.profiles.find((item) => item.id === id) ?? settingsRef.current.profiles[0];
    sessionRef.current += 1;
    const session = sessionRef.current;
    recordingProfileRef.current = id;
    setRecordingProfileId(id);
    setSettings((value) => ({ ...value, activeProfileId: id }));
    setError(""); setLogOpen(false);
    try {
      await recorder.start();
      // Cancelled while the microphone was still opening.
      if (session !== sessionRef.current) { recorder.cancel(); return; }
      phaseRef.current = "recording";
      setState("recording");
      if (settingsRef.current.overlayEnabled) void setOverlay(overlayFor(current, "recording"));
    } catch (cause) {
      if (session !== sessionRef.current) return;
      phaseRef.current = "idle";
      fail(cause instanceof Error ? cause.message : "Microphone access was denied.", current.name);
    }
  }, [fail, finish, overlayFor, recorder]);

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    phaseRef.current = "idle";
    recorder.cancel(); setError(""); setState("idle");
    const current = settingsRef.current.profiles.find((item) => item.id === recordingProfileRef.current) ?? settingsRef.current.profiles[0];
    void setOverlay(overlayFor(current, "idle", false));
  }, [overlayFor, recorder]);

  // Subscribe once and always call the latest handlers. Re-subscribing on every render (the mic
  // level meter re-renders ~60 times a second) briefly left two listeners alive, so one hotkey
  // press could run finish() twice and flash a bogus "No recording is active." error.
  const startRef = useRef(start);
  const cancelRef = useRef(cancel);
  startRef.current = start;
  cancelRef.current = cancel;
  useEffect(() => {
    let disposed = false;
    let stops: Array<() => void> = [];
    void Promise.all([
      onShortcut((profileId) => void startRef.current(profileId)),
      onCancelShortcut(() => cancelRef.current()),
      onOverlayCancel(() => cancelRef.current()),
    ]).then((listeners) => { if (disposed) listeners.forEach((stop) => stop()); else stops = listeners; });
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, []);
  useEffect(() => {
    if (!settings.overlayEnabled) {
      void setOverlay({ visible: false, state: "idle", profileName: activeProfile.name, cleanupEnabled: activeProfile.cleanupEnabled });
    }
  }, [activeProfile.cleanupEnabled, activeProfile.name, settings.overlayEnabled]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") { setLogOpen(false); cancelRef.current(); } };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const selectMode = (id: string) => { setSettings({ ...settings, activeProfileId: id }); setView("mode"); };
  const addMode = () => {
    const base = activeProfile;
    const next: DictationProfile = { ...base, id: crypto.randomUUID(), name: "New mode", shortcut: "", color: unusedPigment(settings.profiles), transcription: structuredClone(base.transcription), cleanup: structuredClone(base.cleanup) };
    setSettings({ ...settings, profiles: [...settings.profiles, next], activeProfileId: next.id });
    setView("mode");
  };
  const deleteMode = (id: string) => {
    if (settings.profiles.length === 1 || !window.confirm("Delete this mode and unregister its hotkey?")) return;
    const profiles = settings.profiles.filter((item) => item.id !== id);
    setSettings({ ...settings, profiles, activeProfileId: settings.activeProfileId === id ? profiles[0].id : settings.activeProfileId });
  };
  const dismissError = () => { setLogOpen(false); if (state === "error") cancel(); };

  const deleteItem = (id: string) => persistHistory(history.filter((item) => item.id !== id));
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const content = useMemo(() => {
    if (view === "history") return <HistoryView history={history} profiles={settings.profiles} onCopy={copy} onDelete={deleteItem} onStart={() => void start()} />;
    if (view === "general") return <GeneralView settings={settings} saveState={saveState} saveError={saveError} onSettings={setSettings} />;
    return <ModeView settings={settings} saveState={saveState} saveError={saveError} onSettings={setSettings} onSaveKey={saveKey} onDelete={deleteMode} isRecording={recorder.isRecording} recordingLevelDb={recorder.inputLevelDb} />;
  }, [history, recorder.inputLevelDb, recorder.isRecording, saveError, saveKey, saveState, settings, start, view]);

  const dictateProfile = state === "idle" ? activeProfile : profile;

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        settings={settings}
        historyCount={history.length}
        onView={setView}
        onSelectMode={selectMode}
        onAddMode={addMode}
        onDeleteMode={deleteMode}
        dictate={{
          state,
          profile: dictateProfile,
          color: pigmentOf(settings.profiles, dictateProfile.id)?.hex ?? MODE_PIGMENTS[0].hex,
          levels: recorder.levels,
          error,
          errorLog,
          logOpen: logOpen || state === "error",
          onToggle: () => void start(),
          onCancel: cancel,
          onOpenLog: () => setLogOpen(true),
          onDismissError: dismissError,
          onClearLog: () => { setErrorLog([]); dismissError(); },
        }}
      />
      <div className="content-shell">{content}</div>
    </div>
  );
}
