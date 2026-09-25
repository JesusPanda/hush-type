import { useState } from "react";
import { Braces, Check, ChevronDown, ClipboardPaste, Copy, FlaskConical, Plus, X } from "lucide-react";
import { importCurl } from "../lib/curl";
import { testProvider } from "../lib/bridge";
import {
  PLACEHOLDERS,
  TEMPLATE_PRESETS,
  applyTemplatePreset,
  type BodyType,
  type KeyValue,
  type PipelineStage,
  type ProviderSettings,
  type ProviderTestResult,
  type RequestTemplate,
} from "../types";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const hostOf = (url: string) => {
  try { return new URL(url.replace(/\{\{[^}]+\}\}/g, "x")).host; } catch { return ""; }
};

interface KeyValueEditorProps {
  items: KeyValue[];
  onChange: (items: KeyValue[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}

export function KeyValueEditor({ items, onChange, keyPlaceholder, valuePlaceholder, addLabel }: KeyValueEditorProps) {
  const update = (index: number, patch: Partial<KeyValue>) => onChange(items.map((item, current) => (current === index ? { ...item, ...patch } : item)));
  return (
    <div className="kv-editor">
      {items.map((item, index) => (
        <div className="kv-row" key={index}>
          <input className="kv-key" value={item.key} placeholder={keyPlaceholder} onChange={(event) => update(index, { key: event.target.value })} />
          {/* Always a textarea so values like JSON definitions can grow without losing focus. */}
          <textarea className="kv-value" spellCheck={false} rows={Math.min(16, item.value.split("\n").length)} value={item.value} placeholder={valuePlaceholder} onChange={(event) => update(index, { value: event.target.value })} />
          <button type="button" onClick={() => onChange(items.filter((_, current) => current !== index))} title="Remove"><X size={13} /></button>
        </div>
      ))}
      <button type="button" className="kv-add" onClick={() => onChange([...items, { key: "", value: "" }])}><Plus size={12} /> {addLabel}</button>
    </div>
  );
}

function PlaceholderLegend({ stage }: { stage: PipelineStage }) {
  const [copied, setCopied] = useState("");
  const copy = (name: string) => { void navigator.clipboard?.writeText(`{{${name}}}`); setCopied(name); window.setTimeout(() => setCopied(""), 1200); };
  return (
    <details className="placeholder-legend">
      <summary><Braces size={12} /> Placeholders you can use <ChevronDown size={12} /></summary>
      <div className="placeholder-grid">
        {PLACEHOLDERS.filter((item) => !item.stage || item.stage === stage).map((item) => (
          <button type="button" key={item.name} onClick={() => copy(item.name)} title="Copy">
            <code>{`{{${item.name}}}`}</code><span>{item.description}</span>{copied === item.name ? <Check size={11} /> : <Copy size={11} />}
          </button>
        ))}
      </div>
      <p>Values are escaped for where they appear (URL, JSON, header). Write <code>{"{{raw:name}}"}</code> to insert a value untouched. Empty form fields and headers are skipped.</p>
    </details>
  );
}

/** Compares requests by content, independent of key order after a round-trip through the backend. */
const templateSignature = (template?: RequestTemplate) => template
  ? JSON.stringify([template.method, template.url, template.headers.map(({ key, value }) => [key, value]), template.bodyType, template.fields.map(({ key, value }) => [key, value]), template.body, template.responsePath])
  : "";

interface TemplateEditorProps {
  provider: ProviderSettings;
  stage: PipelineStage;
  onChange: (provider: ProviderSettings) => void;
  onDetectedKey: (key: string) => void;
}

export function TemplateEditor({ provider, stage, onChange, onDetectedKey }: TemplateEditorProps) {
  const template = provider.template;
  const [curlOpen, setCurlOpen] = useState(false);
  const [curl, setCurl] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [importError, setImportError] = useState("");
  const [chosenPresetId, setChosenPresetId] = useState("");
  const setTemplate = (patch: Partial<RequestTemplate>) => onChange({ ...provider, template: { ...template, ...patch } });
  // The request itself tells which template it came from, so the name survives switching modes or restarting.
  const presets = TEMPLATE_PRESETS[stage];
  const templateKey = templateSignature(template);
  const matchedPreset = presets.find((preset) => preset.id === chosenPresetId && templateSignature(preset.settings.template) === templateKey)
    ?? presets.find((preset) => templateSignature(preset.settings.template) === templateKey);
  const editedPreset = matchedPreset ? undefined : presets.find((preset) => preset.id === chosenPresetId);
  const presetValue = matchedPreset?.id ?? (editedPreset ? "__edited" : "");

  const runImport = () => {
    try {
      const result = importCurl(curl, stage);
      // A different API gets its own keychain entry instead of overwriting this provider's key.
      const sameApi = hostOf(result.endpoint) && hostOf(result.endpoint) === hostOf(provider.endpoint);
      onChange({
        ...provider,
        provider: sameApi ? provider.provider : "custom",
        modelsEndpoint: sameApi ? provider.modelsEndpoint : "",
        format: "template",
        endpoint: result.endpoint,
        model: result.model ?? provider.model,
        forceWav: stage === "transcription" ? result.forceWav : provider.forceWav,
        template: result.template,
      });
      if (result.detectedKey) onDetectedKey(result.detectedKey);
      setChosenPresetId("");
      setNotes(result.notes); setImportError(""); setCurl(""); setCurlOpen(false);
    } catch (cause) { setImportError(errorText(cause)); }
  };

  const applyPreset = (id: string) => {
    const preset = TEMPLATE_PRESETS[stage].find((item) => item.id === id);
    if (!preset) return;
    onChange(applyTemplatePreset(provider, preset));
    setChosenPresetId(preset.id);
    setNotes([preset.description]);
  };

  const bodyTypes: Array<{ id: BodyType; label: string }> = [
    { id: "multipart", label: "Multipart form" },
    { id: "json", label: "JSON" },
    { id: "binary", label: "Raw audio (binary)" },
    { id: "form", label: "URL-encoded form" },
    { id: "text", label: "Plain text" },
    { id: "none", label: "No body" },
  ];

  return (
    <div className="template-editor">
      <div className="template-toolbar">
        <div className="select-wrap preset-select"><select value={presetValue} onChange={(event) => applyPreset(event.target.value)} title={matchedPreset?.description}>
          {presetValue === "" && <option value="" disabled>Start from a template…</option>}
          {editedPreset && <option value="__edited" disabled>{editedPreset.label} · edited</option>}
          {presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}
        </select><ChevronDown size={14} /></div>
        <button type="button" className={`curl-button ${curlOpen ? "active" : ""}`} onClick={() => setCurlOpen(!curlOpen)}><ClipboardPaste size={13} /> Import from cURL</button>
      </div>
      {curlOpen && (
        <div className="curl-import">
          <span>Paste the cURL example from the API's documentation. Your key is detected, stored securely, and replaced with <code>{"{{api_key}}"}</code>; the audio file becomes <code>{"{{audio}}"}</code>.</span>
          <textarea className="code" rows={7} spellCheck={false} value={curl} onChange={(event) => setCurl(event.target.value)} placeholder={"curl --location 'https://…' \\\n  --header 'Authorization: Bearer $API_KEY' \\\n  --form 'file=@\"audio.wav\"' \\\n  --form 'model=…'"} />
          {importError && <div className="models-message error">{importError}</div>}
          <div className="curl-actions"><button type="button" onClick={() => setCurlOpen(false)}>Cancel</button><button type="button" className="primary" onClick={runImport} disabled={!curl.trim()}>Convert to request</button></div>
        </div>
      )}
      {notes.length > 0 && <ul className="template-notes">{notes.map((note) => <li key={note}>{note}</li>)}<button type="button" onClick={() => setNotes([])} title="Dismiss"><X size={12} /></button></ul>}

      <div className="form-grid">
        <label><span>Method</span><div className="select-wrap"><select value={template.method} onChange={(event) => setTemplate({ method: event.target.value })}>{["POST", "PUT", "PATCH", "GET"].map((method) => <option key={method}>{method}</option>)}</select><ChevronDown size={15} /></div></label>
        <label><span>Body</span><div className="select-wrap"><select value={template.bodyType} onChange={(event) => setTemplate({ bodyType: event.target.value as BodyType })}>{bodyTypes.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><ChevronDown size={15} /></div></label>
        <label className="span-two"><span>Request URL <small>{"{{endpoint}}"} is the API endpoint above</small></span><input className="code" spellCheck={false} value={template.url} onChange={(event) => setTemplate({ url: event.target.value })} /></label>
      </div>

      <div className="template-section"><span>Headers</span><KeyValueEditor items={template.headers} onChange={(headers) => setTemplate({ headers })} keyPlaceholder="Header" valuePlaceholder="Value, e.g. Bearer {{api_key}}" addLabel="Add header" /></div>

      {(template.bodyType === "multipart" || template.bodyType === "form") && (
        <div className="template-section"><span>Form fields {template.bodyType === "multipart" && stage === "transcription" && <small>Set a value to {"{{audio}}"} to attach the recording</small>}</span><KeyValueEditor items={template.fields} onChange={(fields) => setTemplate({ fields })} keyPlaceholder="Field" valuePlaceholder="Value or {{placeholder}}" addLabel="Add field" /></div>
      )}
      {(template.bodyType === "json" || template.bodyType === "text") && (
        <label className="template-section"><span>{template.bodyType === "json" ? "JSON body" : "Body"}</span><textarea className="code" rows={Math.min(18, template.body.split("\n").length + 2)} spellCheck={false} value={template.body} onChange={(event) => setTemplate({ body: event.target.value })} placeholder={stage === "cleanup" ? '{ "model": "{{model}}", "input": "{{text}}" }' : '{ "audio": "{{audio_base64}}" }'} /></label>
      )}
      {template.bodyType === "binary" && <p className="template-hint">The recording is sent as the raw request body. Add a <code>Content-Type</code> header (for example <code>{"{{mime_type}}"}</code>) if the API needs one.</p>}

      <div className="form-grid">
        <label className="span-two"><span>Response path <small>Where the text is in the response · empty = auto-detect</small></span><input className="code" spellCheck={false} value={template.responsePath} onChange={(event) => setTemplate({ responsePath: event.target.value })} placeholder="e.g. combinedPhrases.0.text or choices.0.message.content" /></label>
      </div>
      <PlaceholderLegend stage={stage} />
    </div>
  );
}

export function ExtraParamsEditor({ provider, stage, onChange }: { provider: ProviderSettings; stage: PipelineStage; onChange: (provider: ProviderSettings) => void }) {
  const count = provider.extraParams.filter((item) => item.key.trim()).length;
  return (
    <details className="extra-params" open={count > 0}>
      <summary>Extra request parameters {count > 0 && <em>{count}</em>}<ChevronDown size={12} /></summary>
      <p>{stage === "transcription"
        ? "Added as form fields — e.g. temperature = 0 or timestamp_granularities[] = word. Set a value to null to drop a default field (language, prompt, response_format)."
        : "Merged into the JSON body — e.g. reasoning_effort = low, max_tokens = 800; dots nest (reasoning.effort). Numbers, booleans, and JSON are parsed. Set temperature = null to drop it."}</p>
      <KeyValueEditor items={provider.extraParams} onChange={(extraParams) => onChange({ ...provider, extraParams })} keyPlaceholder="Parameter" valuePlaceholder="Value" addLabel="Add parameter" />
    </details>
  );
}

const prettyJson = (text: string) => {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

export function TestPanel({ profileId, stage, provider, systemPrompt }: { profileId: string; stage: PipelineStage; provider: ProviderSettings; systemPrompt: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const run = async () => {
    setState("running"); setError("");
    try {
      const outcome = await testProvider(profileId, stage, provider, systemPrompt);
      setResult(outcome); setShowRaw(!outcome.ok); setState("done");
    } catch (cause) { setError(errorText(cause)); setState("error"); }
  };
  return (
    <div className="test-panel">
      <div className="test-panel-heading">
        <div><strong>Test this stage</strong><small>{stage === "transcription" ? "Re-sends your most recent recording using the settings above." : "Sends a short sample transcript with this mode's instruction."}</small></div>
        <button type="button" onClick={() => void run()} disabled={state === "running"}>{state === "running" ? <span className="spinner small" /> : <FlaskConical size={13} />} Run test</button>
      </div>
      {state === "error" && <div className="models-message error">{error}</div>}
      {state === "done" && result && (
        <div className={`test-result ${result.ok ? "ok" : "failed"}`}>
          <div className="test-result-meta"><span className="status-chip">HTTP {result.status}</span><span>{result.input}</span></div>
          {result.text ? <p className="test-text">{result.text}</p> : <p className="test-text muted">No text was extracted. Compare the response path with the raw response below.</p>}
          <button type="button" className="raw-toggle" onClick={() => setShowRaw(!showRaw)}>{showRaw ? "Hide" : "Show"} raw response</button>
          {showRaw && <pre className="raw-response">{prettyJson(result.raw)}</pre>}
        </div>
      )}
    </div>
  );
}
