import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  History,
  Home,
  KeyRound,
  Mic,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
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
  saveHistory,
  saveSettings,
  setOverlay,
  transcribe,
  type CredentialUpdate,
} from "./lib/bridge";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  PROVIDER_DEFAULTS,
  type AppSettings,
  type DictationProfile,
  type HistoryItem,
  type ModelOption,
  type PipelineStage,
  type ProviderId,
  type ProviderSettings,
  type RecordingState,
  type View,
} from "./types";

const timeAgo = (timestamp: number) => {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
};

const formatShortcut = (shortcut: string) =>
  shortcut
    .replace("CommandOrControl", navigator.platform.includes("Mac") ? "⌘" : "Ctrl")
    .replaceAll("+", " + ");

const normalizeHistory = (item: HistoryItem): HistoryItem => ({
  ...item,
  profileId: item.profileId || item.mode || "legacy",
  profileName: item.profileName || (item.mode === "polish" ? "Polish my words" : "Raw dictation"),
  usedCleanup: item.profileId ? item.usedCleanup : item.mode === "polish",
});

function Logo() {
  return <div className="logo-mark" aria-label="HushType"><i /><i /><i /><i /><i /></div>;
}

function Sidebar({ view, setView }: { view: View; setView: (view: View) => void }) {
  const links = [
    { id: "home" as View, label: "Home", icon: Home },
    { id: "history" as View, label: "History", icon: History },
  ];
  return (
    <aside className="sidebar">
      <div className="brand"><Logo /><span>HushType</span></div>
      <nav>{links.map(({ id, label, icon: Icon }) => (
        <button className={view === id ? "active" : ""} onClick={() => setView(id)} key={id}><Icon size={18} strokeWidth={1.8} />{label}</button>
      ))}</nav>
      <div className="sidebar-footer">
        <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={18} strokeWidth={1.8} />Settings</button>
        <div className="local-badge"><span className="status-dot" />Local-first</div>
      </div>
    </aside>
  );
}

function Shortcut({ value }: { value: string }) {
  if (!value) return <span className="no-shortcut">No hotkey</span>;
  return <span className="shortcut">{formatShortcut(value).split(" + ").map((key) => <kbd key={key}>{key}</kbd>)}</span>;
}

function Waveform({ levels }: { levels: number[] }) {
  return <div className="waveform active" aria-hidden="true">{levels.map((level, index) => <span key={index} style={{ height: `${Math.round(5 + level * 25)}px` }} />)}</div>;
}

interface DictationBarProps {
  state: RecordingState;
  profiles: DictationProfile[];
  activeProfile: DictationProfile;
  levels: number[];
  error: string;
  onProfile: (id: string) => void;
  onToggle: () => void;
  onCancel: () => void;
}

function DictationBar({ state, profiles, activeProfile, levels, error, onProfile, onToggle, onCancel }: DictationBarProps) {
  const labels: Record<RecordingState, string> = {
    idle: `Ready · ${activeProfile.name}`,
    recording: "Listening…",
    processing: activeProfile.cleanupEnabled ? "Running your pipeline…" : "Transcribing…",
    success: "Pasted at your cursor",
    error: error || "Something went wrong",
  };
  return (
    <div className={`dictation-bar state-${state}`}>
      <button className="cancel-button" onClick={onCancel} aria-label="Cancel"><X size={17} /></button>
      <div className="bar-mode-select">
        {activeProfile.cleanupEnabled ? <Sparkles size={15} /> : <Mic size={15} />}
        <select value={activeProfile.id} onChange={(event) => onProfile(event.target.value)} disabled={state === "recording" || state === "processing"}>
          {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
        </select>
        <ChevronDown size={13} />
      </div>
      <button className="bar-center" onClick={onToggle} disabled={state === "processing"}>
        {state === "recording" ? <Waveform levels={levels} /> : state === "processing" ? <span className="spinner" /> : state === "success" ? <Check size={21} /> : <span className="mic-orb"><Mic size={18} /></span>}
        <strong>{labels[state]}</strong>
      </button>
      <span className="bar-hint">{state === "recording" ? "Click to finish" : "Click or use hotkey"}</span>
    </div>
  );
}

function HistoryCard({ item, onCopy, onDelete }: { item: HistoryItem; onCopy: () => void; onDelete: () => void }) {
  return (
    <article className="history-card">
      <div className={`history-mode ${item.usedCleanup ? "polish" : ""}`}>{item.usedCleanup ? <Sparkles size={14} /> : <Mic size={14} />}</div>
      <div className="history-body"><p>{item.finalText}</p><div className="history-meta"><span>{item.profileName}</span><i /><span>{timeAgo(item.createdAt)}</span><i /><span>{Math.max(1, Math.round(item.durationMs / 1000))}s</span></div></div>
      <div className="card-actions"><button onClick={onCopy} title="Copy"><Copy size={16} /></button><button onClick={onDelete} title="Delete"><Trash2 size={16} /></button></div>
    </article>
  );
}

function EmptyHistory({ onStart }: { onStart: () => void }) {
  return <div className="empty-history"><div className="empty-icon"><Mic size={22} /></div><h3>Your words will land here</h3><p>Every dictation stays on this device so you can copy, compare, or reuse it.</p><button className="primary-button" onClick={onStart}><Mic size={16} /> Start dictating</button></div>;
}

interface HomeViewProps {
  history: HistoryItem[];
  settings: AppSettings;
  activeProfile: DictationProfile;
  start: (profileId?: string) => void;
  goSettings: () => void;
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
}

function HomeView({ history, settings, activeProfile, start, goSettings, onCopy, onDelete }: HomeViewProps) {
  const today = history.filter((item) => new Date(item.createdAt).toDateString() === new Date().toDateString());
  const wordCount = today.reduce((sum, item) => sum + item.finalText.trim().split(/\s+/).filter(Boolean).length, 0);
  return (
    <main className="page home-page">
      <header className="page-heading"><div><span className="eyebrow">VOICE, IN YOUR WORDS</span><h1>Say it. We'll type it.</h1><p>Build a mode for every way you write.</p></div><button className="icon-button"><MoreHorizontal size={20} /></button></header>
      <section className="hero-card profiles-hero">
        <div className="hero-copy"><div className="live-pill"><span /> Ready</div><h2>Speak freely.<br /><em>Route it your way.</em></h2><p>Each mode has its own hotkey, speech model, and optional AI instruction.</p></div>
        <div className="mode-cards scrollable-modes">
          {settings.profiles.map((profile) => (
            <button className={`mode-card ${profile.cleanupEnabled ? "polish" : "raw"}`} onClick={() => start(profile.id)} key={profile.id}>
              <div className="mode-icon">{profile.cleanupEnabled ? <Sparkles size={20} /> : <Mic size={20} />}</div>
              <div><strong>{profile.name}</strong><span>{profile.transcription.model}{profile.cleanupEnabled ? ` → ${profile.cleanup.model}` : ""}</span></div>
              <Shortcut value={profile.shortcut} />
            </button>
          ))}
          <button className="add-mode-card" onClick={goSettings}><Plus size={15} /> Create a mode</button>
        </div>
      </section>
      {!activeProfile.transcription.apiKeySet && <button className="setup-banner" onClick={goSettings}><span className="setup-icon"><KeyRound size={18} /></span><span><strong>Finish setting up {activeProfile.name}</strong><small>Add its transcription API key before your first dictation.</small></span><span className="setup-action">Set up <ArrowUpRight size={14} /></span></button>}
      <section className="section-block recent-section"><div className="section-heading"><div><h2>Recent</h2><span>{today.length} dictations · {wordCount} words today</span></div></div>{history.length === 0 ? <EmptyHistory onStart={() => start()} /> : <div className="history-list">{history.slice(0, 4).map((item) => <HistoryCard key={item.id} item={item} onCopy={() => onCopy(item.finalText)} onDelete={() => onDelete(item.id)} />)}</div>}</section>
    </main>
  );
}

function HistoryView({ history, onCopy, onDelete }: { history: HistoryItem[]; onCopy: (text: string) => void; onDelete: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const filtered = history.filter((item) => `${item.profileName} ${item.finalText}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="page"><header className="page-heading compact"><div><span className="eyebrow">YOUR PRIVATE ARCHIVE</span><h1>History</h1><p>Stored locally on this device.</p></div></header><div className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search dictations or modes" /></div><section className="history-page-list">{filtered.length ? filtered.map((item) => <HistoryCard key={item.id} item={item} onCopy={() => onCopy(item.finalText)} onDelete={() => onDelete(item.id)} />) : <EmptyHistory onStart={() => undefined} />}</section></main>;
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
  return <div className={`shortcut-recorder ${capturing ? "capturing" : ""}`}><input readOnly value={capturing ? "Press your shortcut…" : value ? formatShortcut(value) : "Click to record a hotkey"} onFocus={() => setCapturing(true)} onBlur={() => setCapturing(false)} onKeyDown={onKeyDown} /><button type="button" onClick={() => onChange("")} title="Remove hotkey"><X size={14} /></button></div>;
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
  const voiceDetected = enabled && monitorState === "active" && levelDb >= thresholdDb;
  const status = monitorState === "starting"
    ? "Starting microphone…"
    : monitorState === "unavailable"
      ? "Microphone preview unavailable"
      : monitorState === "active"
        ? voiceDetected ? "Voice detected" : "Listening for your voice"
        : "Enable to set the cutoff";
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
      <div className="sensitivity-heading">
        <div><strong>Silence threshold</strong><small>Filter ambient noise and trim quiet gaps before upload.</small></div>
        <label className="switch-control">
          <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
          <span aria-hidden="true" />
          <i>{enabled ? "On" : "Off"}</i>
        </label>
      </div>
      <div className="sensitivity-body" aria-disabled={!enabled}>
        <div className="sensitivity-readout">
          <span className={`monitor-status ${voiceDetected ? "voice" : ""}`}><i />{status}</span>
          <strong>{thresholdDb} dB</strong>
        </div>
        <div className={`sensitivity-meter ${voiceDetected ? "voice-detected" : ""}`}>
          <div className="input-level-fill" style={{ width: `${levelPosition}%` }} />
          <input aria-label="Silence threshold" type="range" min={SENSITIVITY_MIN_DB} max={SENSITIVITY_MAX_DB} step="1" value={thresholdDb} disabled={!enabled} onPointerDown={updateFromPointer} onPointerMove={updateFromPointer} onKeyDown={adjustWithKeyboard} onChange={(event) => onThreshold(Number(event.target.value))} />
        </div>
        <div className="sensitivity-scale"><span>Quieter speech</span><span>More noise filtered</span></div>
      </div>
    </section>
  );
}

const providerLabel = (provider: ProviderId) => ({ groq: "Groq", cerebras: "Cerebras", gemini: "Google Gemini", openai: "OpenAI", custom: "Custom compatible API" })[provider];

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
      if (replacesExistingKey) void refreshModels(key);
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
    const defaults = PROVIDER_DEFAULTS[providerId][stage];
    if (defaults) onChange({ ...defaults });
  };
  const options: ProviderId[] = stage === "transcription" ? ["groq", "openai", "custom"] : ["cerebras", "gemini", "groq", "openai", "custom"];
  const listId = `models-${profile.id}-${stage}`;
  return (
    <div className="provider-editor">
      <div className="provider-heading"><div className={`pipeline-node ${stage}`} >{stage === "transcription" ? <Mic size={16} /> : <Sparkles size={16} />}</div><div><strong>{stage === "transcription" ? "Speech to text" : "Second-stage model"}</strong><span>{stage === "transcription" ? "Turns the recording into text" : "Transforms the transcript using your instruction"}</span></div></div>
      <div className="form-grid">
        <label><span>Provider</span><div className="select-wrap"><select value={provider.provider} onChange={(event) => changeProvider(event.target.value as ProviderId)}>{options.map((id) => <option value={id} key={id}>{providerLabel(id)}</option>)}</select><ChevronDown size={15} /></div></label>
        <label><span>Model</span><div className="model-combobox"><input list={listId} value={provider.model} onChange={(event) => onChange({ ...provider, model: event.target.value })} placeholder={modelsState === "loading" ? "Loading models…" : "Select or type a model ID"} /><datalist id={listId}>{models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</datalist><button type="button" onClick={() => void refreshModels(apiKey || undefined)} disabled={modelsState === "loading"} title="Refresh available models"><RefreshCw size={14} className={modelsState === "loading" ? "spinning" : ""} /></button></div></label>
        <label className="span-two"><span>API endpoint</span><input value={provider.endpoint} onChange={(event) => onChange({ ...provider, endpoint: event.target.value })} /></label>
        <label className="span-two"><span>Models endpoint <small>Queried to build the model list</small></span><input value={provider.modelsEndpoint} onChange={(event) => onChange({ ...provider, modelsEndpoint: event.target.value })} /></label>
        <label className="span-two"><span>API key {provider.apiKeySet && <small>Saved securely · type to replace</small>}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onBlur={() => commitKey(apiKey)} placeholder={provider.apiKeySet ? "••••••••••••••••" : `Paste your ${providerLabel(provider.provider)} key`} /></label>
      </div>
      {modelsState === "ready" && <div className="models-message success"><Check size={12} /> {models.length} models available</div>}
      {modelsState === "error" && <div className="models-message error">{modelsError}</div>}
    </div>
  );
}

interface SettingsViewProps {
  settings: AppSettings;
  saveState: "idle" | "saving" | "saved" | "error";
  saveError: string;
  onSettings: (settings: AppSettings) => void;
  onSaveKey: (update: CredentialUpdate) => Promise<void>;
  isRecording: boolean;
  recordingLevelDb: number;
}

function SettingsView({ settings, saveState, saveError, onSettings, onSaveKey, isRecording, recordingLevelDb }: SettingsViewProps) {
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) ?? settings.profiles[0];
  const overlaySuccessDurationMs = settings.overlaySuccessDurationMs ?? 650;
  const updateProfile = (changes: Partial<DictationProfile>) => onSettings({ ...settings, profiles: settings.profiles.map((item) => item.id === profile.id ? { ...item, ...changes } : item) });
  const addProfile = () => {
    const next: DictationProfile = { ...profile, id: crypto.randomUUID(), name: "New mode", shortcut: "", transcription: { ...profile.transcription }, cleanup: { ...profile.cleanup } };
    onSettings({ ...settings, profiles: [...settings.profiles, next], activeProfileId: next.id });
  };
  const deleteProfile = (id: string) => {
    if (settings.profiles.length === 1 || !window.confirm("Delete this mode and unregister its hotkey?")) return;
    const profiles = settings.profiles.filter((item) => item.id !== id);
    onSettings({ ...settings, profiles, activeProfileId: settings.activeProfileId === id ? profiles[0].id : settings.activeProfileId });
  };
  return (
    <main className="page settings-page modes-settings-page">
      <header className="page-heading compact"><div><span className="eyebrow">ROUTE YOUR VOICE</span><h1>Modes</h1><p>Give every writing workflow its own pipeline and hotkey.</p></div><div className={`autosave-status ${saveState}`}>{saveState === "saving" && <span className="spinner small" />}{saveState === "saved" && <Check size={14} />}{saveState === "error" ? saveError : saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved automatically" : "Changes save automatically"}</div></header>
      <section className="global-controls-card">
        <div className="global-control-item cancel-shortcut-setting"><div className="global-control-copy"><span className="global-control-icon"><X size={15} /></span><div><strong>Cancel recording</strong><small>Discards the audio immediately. Nothing is sent to an API.</small></div></div><div className="global-hotkey"><span>Hotkey</span><ShortcutRecorder value={settings.cancelShortcut} onChange={(cancelShortcut) => onSettings({ ...settings, cancelShortcut })} /></div></div>
        <div className="global-control-item overlay-control">
          <label className="overlay-toggle"><div><strong>Floating pop-up</strong><small>Show the compact recording control over other apps.</small></div><input type="checkbox" checked={settings.overlayEnabled} onChange={(event) => onSettings({ ...settings, overlayEnabled: event.target.checked })} /></label>
          <label className={`overlay-speed ${settings.overlayEnabled ? "" : "disabled"}`}>
            <span><small>Disappear after pasting</small><strong>{overlaySuccessDurationMs < 1000 ? `${overlaySuccessDurationMs} ms` : `${(overlaySuccessDurationMs / 1000).toFixed(overlaySuccessDurationMs % 1000 ? 1 : 0)} s`}</strong></span>
            <input type="range" min="200" max="2500" step="50" value={overlaySuccessDurationMs} disabled={!settings.overlayEnabled} onChange={(event) => onSettings({ ...settings, overlaySuccessDurationMs: Number(event.target.value) })} />
            <span className="overlay-speed-scale"><i>Faster</i><i>Slower</i></span>
          </label>
        </div>
      </section>
      <div className="modes-workspace">
        <aside className="modes-list"><div className="modes-list-heading"><span>Your modes</span><button onClick={addProfile} title="Add mode"><Plus size={15} /></button></div>{settings.profiles.map((item) => <button className={`mode-list-item ${item.id === profile.id ? "active" : ""}`} onClick={() => onSettings({ ...settings, activeProfileId: item.id })} key={item.id}><span className={`mini-mode-icon ${item.cleanupEnabled ? "polish" : ""}`}>{item.cleanupEnabled ? <Sparkles size={13} /> : <Mic size={13} />}</span><span><strong>{item.name}</strong><small>{item.shortcut ? formatShortcut(item.shortcut) : "No hotkey"}</small></span>{settings.profiles.length > 1 && <i role="button" tabIndex={0} title="Delete mode" onClick={(event) => { event.stopPropagation(); deleteProfile(item.id); }}><Trash2 size={13} /></i>}</button>)}<button className="new-mode-button" onClick={addProfile}><Plus size={14} /> New mode</button></aside>
        <section className="mode-editor">
          <div className="mode-identity"><div className="mode-avatar">{profile.cleanupEnabled ? <Sparkles size={21} /> : <Mic size={21} />}</div><label><span>Mode name</span><input value={profile.name} onChange={(event) => updateProfile({ name: event.target.value })} /></label><label><span>Global hotkey</span><ShortcutRecorder value={profile.shortcut} onChange={(shortcut) => updateProfile({ shortcut })} /></label></div>
          <div className="pipeline-map"><span>MICROPHONE</span><i /><strong>{profile.transcription.model || "Choose speech model"}</strong>{profile.cleanupEnabled && <><i /><strong>{profile.cleanup.model || "Choose second stage"}</strong></>}<i /><span>CURSOR</span></div>
          <ProviderEditor profile={profile} stage="transcription" onChange={(transcription) => updateProfile({ transcription })} onSaveKey={onSaveKey} />
          <div className="stage-toggle"><div><strong>Run a second model</strong><span>Polish, translate, format, summarize, or transform the transcript.</span></div><input type="checkbox" checked={profile.cleanupEnabled} onChange={(event) => updateProfile({ cleanupEnabled: event.target.checked })} /></div>
          {profile.cleanupEnabled && <><ProviderEditor profile={profile} stage="cleanup" onChange={(cleanup) => updateProfile({ cleanup })} onSaveKey={onSaveKey} /><label className="system-prompt-card"><span>System instruction <small>Sent with every dictation in this mode</small></span><textarea rows={7} value={profile.systemPrompt} onChange={(event) => updateProfile({ systemPrompt: event.target.value })} placeholder="For example: Translate the transcript into concise, natural Italian. Return only the translation." /><div className="prompt-meta"><span>{profile.systemPrompt.length} characters</span><button type="button" onClick={() => updateProfile({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}><RotateCcw size={12} /> Reset default</button></div></label></>}
          <section className="mode-behavior">
            <label><span>Language</span><div className="select-wrap"><select value={profile.language} onChange={(event) => updateProfile({ language: event.target.value })}><option value="auto">Auto-detect</option><option value="en">English</option><option value="it">Italian</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option></select><ChevronDown size={15} /></div></label>
            <label className="toggle-row"><div><strong>Paste automatically</strong><small>Insert the finished text at the active cursor.</small></div><input type="checkbox" checked={profile.pasteAfterDictation} onChange={(event) => updateProfile({ pasteAfterDictation: event.target.checked })} /></label>
            <SensitivityControl enabled={profile.trimSilence} thresholdDb={profile.silenceThresholdDb} isRecording={isRecording} recordingLevelDb={recordingLevelDb} onEnabled={(trimSilence) => updateProfile({ trimSilence })} onThreshold={(silenceThresholdDb) => updateProfile({ silenceThresholdDb })} />
          </section>
        </section>
      </div>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [recordingProfileId, setRecordingProfileId] = useState(DEFAULT_SETTINGS.activeProfileId);
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const recorder = useRecorder();
  const settingsRef = useRef(settings);
  const lastSaved = useRef("");
  const sessionRef = useRef(0);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    void Promise.all([loadSettings(), loadHistory()]).then(([savedSettings, savedHistory]) => {
      const browserSettings = JSON.parse(localStorage.getItem("hushtype-settings") ?? "null") as AppSettings | null;
      const next = savedSettings ?? (browserSettings?.profiles?.length ? browserSettings : null) ?? DEFAULT_SETTINGS;
      setSettings(next); settingsRef.current = next; lastSaved.current = JSON.stringify(next);
      setRecordingProfileId(next.activeProfileId);
      setHistory(savedHistory.map(normalizeHistory));
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
      void saveSettings(candidate).then((saved) => {
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
      const saved = await saveSettings(candidate, credential);
      lastSaved.current = JSON.stringify(saved); setSettings(saved); setSaveState("saved");
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : String(cause)); setSaveState("error"); throw cause; }
  }, []);

  const persistHistory = useCallback((items: HistoryItem[]) => { setHistory(items); void saveHistory(items); }, []);
  const profile = settings.profiles.find((item) => item.id === recordingProfileId) ?? settings.profiles[0];
  const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId) ?? settings.profiles[0];

  const finish = useCallback(async () => {
    if (!recorder.isRecording) return;
    setState("processing");
    const current = settingsRef.current.profiles.find((item) => item.id === recordingProfileId) ?? settingsRef.current.profiles[0];
    const session = sessionRef.current;
    if (settingsRef.current.overlayEnabled) void setOverlay({ visible: true, state: "processing", profileName: current.name, cleanupEnabled: current.cleanupEnabled });
    try {
      const recording = await recorder.stop({ trimSilence: current.trimSilence, thresholdDb: current.silenceThresholdDb });
      if (recording.durationMs < 350 || recording.bytes.length < 100) throw new Error("That recording was too short. Try again.");
      const result = await transcribe(recording.bytes, recording.mimeType, current.id, current.cleanupEnabled);
      if (session !== sessionRef.current) return;
      const item: HistoryItem = { id: crypto.randomUUID(), createdAt: Date.now(), profileId: current.id, profileName: current.name, usedCleanup: current.cleanupEnabled, rawText: result.rawText, finalText: result.finalText, durationMs: recording.durationMs };
      const nextHistory = [item, ...history].slice(0, 250); persistHistory(nextHistory);
      if (current.pasteAfterDictation) await pasteText(result.finalText);
      setState("success");
      if (settingsRef.current.overlayEnabled) void setOverlay({ visible: true, state: "success", profileName: current.name, cleanupEnabled: current.cleanupEnabled });
      window.setTimeout(() => { setState("idle"); void setOverlay({ visible: false, state: "idle", profileName: current.name, cleanupEnabled: current.cleanupEnabled }); }, settingsRef.current.overlaySuccessDurationMs ?? 650);
    } catch (cause) {
      if (session !== sessionRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause)); setState("error");
      if (settingsRef.current.overlayEnabled) {
        void setOverlay({ visible: true, state: "error", profileName: current.name, cleanupEnabled: current.cleanupEnabled });
        window.setTimeout(() => void setOverlay({ visible: false, state: "idle", profileName: current.name, cleanupEnabled: current.cleanupEnabled }), 2300);
      }
    }
  }, [history, persistHistory, recorder, recordingProfileId]);

  const start = useCallback(async (requestedProfileId?: string) => {
    if (state === "processing") return;
    if (recorder.isRecording) { await finish(); return; }
    const id = requestedProfileId ?? settingsRef.current.activeProfileId;
    const current = settingsRef.current.profiles.find((item) => item.id === id) ?? settingsRef.current.profiles[0];
    sessionRef.current += 1;
    setRecordingProfileId(id);
    setSettings((current) => ({ ...current, activeProfileId: id }));
    setError("");
    try {
      await recorder.start(); setState("recording");
      if (settingsRef.current.overlayEnabled) void setOverlay({ visible: true, state: "recording", profileName: current.name, cleanupEnabled: current.cleanupEnabled });
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Microphone access was denied."); setState("error"); }
  }, [finish, recorder, state]);

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    recorder.cancel(); setError(""); setState("idle");
    const current = settingsRef.current.profiles.find((item) => item.id === recordingProfileId) ?? settingsRef.current.profiles[0];
    void setOverlay({ visible: false, state: "idle", profileName: current.name, cleanupEnabled: current.cleanupEnabled });
  }, [recorder, recordingProfileId]);
  useEffect(() => {
    let disposed = false; let unlisten: () => void = () => undefined;
    void onShortcut((profileId) => { if (recorder.isRecording) void finish(); else void start(profileId); }).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten(); };
  }, [finish, recorder.isRecording, start]);
  useEffect(() => {
    let disposed = false;
    let stopCancel: () => void = () => undefined;
    let stopOverlay: () => void = () => undefined;
    void Promise.all([onCancelShortcut(cancel), onOverlayCancel(cancel)]).then(([cancelListener, overlayListener]) => {
      if (disposed) { cancelListener(); overlayListener(); } else { stopCancel = cancelListener; stopOverlay = overlayListener; }
    });
    return () => { disposed = true; stopCancel(); stopOverlay(); };
  }, [cancel]);
  useEffect(() => {
    if (!settings.overlayEnabled) {
      void setOverlay({ visible: false, state: "idle", profileName: activeProfile.name, cleanupEnabled: activeProfile.cleanupEnabled });
    }
  }, [activeProfile.cleanupEnabled, activeProfile.name, settings.overlayEnabled]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [cancel]);

  const deleteItem = (id: string) => persistHistory(history.filter((item) => item.id !== id));
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const content = useMemo(() => {
    if (view === "history") return <HistoryView history={history} onCopy={copy} onDelete={deleteItem} />;
    if (view === "settings") return <SettingsView settings={settings} saveState={saveState} saveError={saveError} onSettings={setSettings} onSaveKey={saveKey} isRecording={recorder.isRecording} recordingLevelDb={recorder.inputLevelDb} />;
    return <HomeView history={history} settings={settings} activeProfile={activeProfile} start={start} goSettings={() => setView("settings")} onCopy={copy} onDelete={deleteItem} />;
  }, [activeProfile, history, recorder.inputLevelDb, recorder.isRecording, saveError, saveKey, saveState, settings, start, view]);

  return <div className="app-shell"><Sidebar view={view} setView={setView} /><div className="content-shell">{content}<DictationBar state={state} profiles={settings.profiles} activeProfile={state === "idle" ? activeProfile : profile} levels={recorder.levels} error={error} onProfile={(id) => { setRecordingProfileId(id); setSettings({ ...settings, activeProfileId: id }); }} onToggle={() => void start()} onCancel={cancel} /></div></div>;
}
