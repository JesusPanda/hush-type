import { emptyTemplate, type KeyValue, type PipelineStage, type RequestTemplate } from "../types";

export interface CurlImport {
  template: RequestTemplate;
  endpoint: string;
  model?: string;
  /** A literal key found in the snippet. It is removed from the template and should go to the keychain. */
  detectedKey?: string;
  forceWav: boolean;
  notes: string[];
}

const VALUE_FLAGS = new Set([
  "-o", "--output", "-m", "--max-time", "--connect-timeout", "-A", "--user-agent", "-w", "--write-out",
  "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "--retry", "-x", "--proxy", "--cacert",
  "--cert", "--key", "-u", "--user", "--limit-rate", "-K", "--config",
]);

/** Splits a shell command into arguments, handling quotes and line continuations from bash, cmd, and PowerShell. */
export function tokenize(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").replace(/`\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (inToken) { tokens.push(current); current = ""; inToken = false; }
      continue;
    }
    inToken = true;
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      current += text.slice(index + 1, end < 0 ? undefined : end);
      index = end < 0 ? text.length : end;
    } else if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) index += 1;
        current += text[index];
        index += 1;
      }
    } else if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      index += 1;
    } else {
      current += char;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

const isPlaceholderSecret = (value: string) =>
  !value.trim() || /^\$\{?\w+\}?$|^\$env:\w+$|^%\w+%$|[<>{}]|your|xxx|\.\.\.|replace|api[_-]?key|token_here|^\*+$/i.test(value.trim());

const AUTH_HEADER = /^(x-api-key|api-key|apikey|x-goog-api-key|xi-api-key|ocp-apim-subscription-key|x-auth-token|x-api-token|access-token|authorization-token)$/i;

const guessResponsePath = (url: string) => {
  if (/transcriptions:transcribe/i.test(url)) return "combinedPhrases.0.text";
  if (/stt\.speech\.microsoft\.com/i.test(url)) return "DisplayText";
  if (/deepgram\.com/i.test(url)) return "results.channels.0.alternatives.0.transcript";
  if (/anthropic\.com/i.test(url)) return "content.0.text";
  if (/:generateContent/i.test(url)) return "candidates.0.content.parts.0.text";
  if (/\/chat\/completions/i.test(url)) return "choices.0.message.content";
  if (/\/audio\/(transcriptions|translations)/i.test(url)) return "text";
  if (/\/responses(\?|$)/i.test(url)) return "output.*.content.*.text";
  return "";
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (value: Json | undefined): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

const LOCALES_MARKER = "__HUSHTYPE_LOCALES__";

/** Swaps sample values in a JSON body for placeholders. Returns the rewritten JSON text. */
function templateJson(value: JsonObject, stage: PipelineStage, url: string, result: { model?: string; notes: string[] }) {
  const body: JsonObject = structuredClone(value);
  if (typeof body.model === "string") { result.model = body.model; body.model = "{{model}}"; }
  const enhanced = body.enhancedMode;
  if (isObject(enhanced) && typeof enhanced.model === "string") { result.model = enhanced.model; enhanced.model = "{{model}}"; }
  let localesVar = "";
  if (Array.isArray(body.locales)) {
    localesVar = body.locales.some((item) => typeof item === "string" && item.includes("-")) ? "{{locales_regional}}" : "{{locales}}";
    body.locales = LOCALES_MARKER;
  }
  if (body.stream === true) { delete body.stream; result.notes.push("Removed \"stream\": true — HushType needs the whole response at once."); }

  if (stage === "cleanup") {
    const messages = body.messages;
    if (Array.isArray(messages)) {
      const users = messages.filter((message): message is JsonObject => isObject(message) && message.role === "user");
      const lastUser = users[users.length - 1];
      if (lastUser) {
        if (typeof lastUser.content === "string") lastUser.content = "{{text}}";
        else if (Array.isArray(lastUser.content)) {
          const block = lastUser.content.find((item): item is JsonObject => isObject(item) && typeof item.text === "string");
          if (block) block.text = "{{text}}";
        }
      }
      const system = messages.find((message): message is JsonObject => isObject(message) && (message.role === "system" || message.role === "developer"));
      if (system) system.content = "{{system_prompt}}";
      else if ("system" in body || /anthropic\.com/i.test(url)) body.system = "{{system_prompt}}";
      else body.messages = [{ role: "system", content: "{{system_prompt}}" }, ...messages];
    } else if (Array.isArray(body.contents)) {
      const parts = body.contents.flatMap((content) => (isObject(content) && Array.isArray(content.parts) ? content.parts : []));
      const lastText = parts.filter((part): part is JsonObject => isObject(part) && typeof part.text === "string").pop();
      if (lastText) lastText.text = "{{text}}";
      body.systemInstruction = { parts: [{ text: "{{system_prompt}}" }] };
    } else if (typeof body.input === "string") {
      body.input = "{{text}}";
      body.instructions = "{{system_prompt}}";
    } else if (typeof body.prompt === "string") {
      body.prompt = "{{system_prompt}}\n\n{{text}}";
    }
  }
  let text = JSON.stringify(body, null, 2);
  if (localesVar) text = text.replace(`"${LOCALES_MARKER}"`, localesVar);
  return text;
}

const AUDIO_EXTENSIONS_WITHOUT_WAV = /\.(webm|ogg|opus|m4a)["']?$/i;

/** Converts a cURL example from API docs into a request template. */
export function importCurl(snippet: string, stage: PipelineStage): CurlImport {
  const tokens = tokenize(snippet.trim());
  if (!tokens.length) throw new Error("Paste a cURL command first.");
  const notes: string[] = [];
  let method = "";
  let url = "";
  const headers: KeyValue[] = [];
  const form: Array<[string, string]> = [];
  const data: string[] = [];
  let binaryUpload = false;
  let forceWav = true;

  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index];
    let inline: string | undefined;
    if (index === 0 && /^curl(\.exe)?$/i.test(token)) continue;
    if (token.startsWith("--") && token.includes("=")) { inline = token.slice(token.indexOf("=") + 1); token = token.slice(0, token.indexOf("=")); }
    const next = () => inline ?? tokens[++index] ?? "";
    if (/^-X.+/.test(token)) { method = token.slice(2); continue; }
    switch (token) {
      case "-X": case "--request": method = next(); break;
      case "-H": case "--header": {
        const header = next();
        const colon = header.indexOf(":");
        if (colon > 0) headers.push({ key: header.slice(0, colon).trim(), value: header.slice(colon + 1).trim() });
        break;
      }
      case "-F": case "--form": case "--form-string": {
        const field = next();
        const equals = field.indexOf("=");
        if (equals > 0) form.push([field.slice(0, equals), field.slice(equals + 1)]);
        break;
      }
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": case "--data-urlencode":
        data.push(next()); break;
      case "--json":
        data.push(next());
        headers.push({ key: "Content-Type", value: "application/json" });
        break;
      case "-T": case "--upload-file":
        next(); binaryUpload = true; method ||= "PUT"; break;
      case "--url": url = next(); break;
      case "-u": case "--user":
        next(); notes.push("Basic auth (-u) isn't imported. Add an Authorization header by hand if the API needs it."); break;
      default:
        if (VALUE_FLAGS.has(token)) { next(); break; }
        if (token.startsWith("-")) break;
        if (!url) url = token;
    }
  }
  if (!url) throw new Error("No URL was found in that command.");

  let detectedKey: string | undefined;
  const captureKey = (value: string) => {
    if (!isPlaceholderSecret(value)) detectedKey ??= value.trim();
  };
  url = url.replace(/([?&](?:key|api_key|apikey|api-key|access_token|token|subscription-key)=)([^&#]*)/gi, (_, prefix: string, value: string) => {
    captureKey(decodeURIComponent(value));
    return `${prefix}{{api_key}}`;
  });

  const templateHeaders: KeyValue[] = [];
  for (const header of headers) {
    const name = header.key;
    const bearer = header.value.match(/^(Bearer|Token|Key)\s+(.+)$/i);
    if (/^authorization$/i.test(name) && bearer) {
      captureKey(bearer[2]);
      templateHeaders.push({ key: name, value: `${bearer[1]} {{api_key}}` });
    } else if (AUTH_HEADER.test(name)) {
      captureKey(header.value);
      templateHeaders.push({ key: name, value: "{{api_key}}" });
    } else if (/^content-type$/i.test(name)) {
      if (/multipart\/form-data/i.test(header.value) || form.length) continue;
      if (/^audio\//i.test(header.value) && !/codecs|samplerate/i.test(header.value)) {
        templateHeaders.push({ key: name, value: "{{mime_type}}" });
      } else {
        templateHeaders.push(header);
      }
    } else {
      templateHeaders.push(header);
    }
  }

  const result: { model?: string; notes: string[] } = { notes };
  const template: RequestTemplate = { ...emptyTemplate(), headers: templateHeaders, url: "{{endpoint}}" };

  if (form.length) {
    template.bodyType = "multipart";
    template.fields = form.map(([name, rawValue]) => {
      if (rawValue.startsWith("@")) {
        if (AUDIO_EXTENSIONS_WITHOUT_WAV.test(rawValue.split(";")[0])) forceWav = false;
        if (stage === "transcription") return { key: name, value: "{{audio}}" };
      }
      if (name === "model") { result.model = rawValue; return { key: name, value: "{{model}}" }; }
      if (name === "language") return { key: name, value: "{{language}}" };
      if (name === "prompt" && stage === "transcription") return { key: name, value: "{{prompt}}" };
      const trimmed = rawValue.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as Json;
          if (isObject(parsed)) return { key: name, value: templateJson(parsed, stage, url, result) };
        } catch { notes.push(`The ‘${name}’ field looks like JSON but didn't parse — check it for typos.`); }
      }
      return { key: name, value: rawValue };
    });
  } else if (binaryUpload || (data.length === 1 && data[0].startsWith("@"))) {
    template.bodyType = "binary";
    if (data[0] && AUDIO_EXTENSIONS_WITHOUT_WAV.test(data[0])) forceWav = false;
  } else if (data.length) {
    const joined = data.join("&");
    let parsed: Json | undefined;
    try { parsed = JSON.parse(joined) as Json; } catch { parsed = undefined; }
    if (isObject(parsed)) {
      template.bodyType = "json";
      template.body = templateJson(parsed, stage, url, result);
    } else if (/^[\w.[\]-]+=[^&]*(&[\w.[\]-]+=[^&]*)*$/.test(joined)) {
      template.bodyType = "form";
      template.fields = joined.split("&").map((pair) => {
        const [key, ...rest] = pair.split("=");
        return { key: decodeURIComponent(key), value: decodeURIComponent(rest.join("=")) };
      });
    } else {
      template.bodyType = "text";
      template.body = joined;
    }
  } else {
    template.bodyType = "none";
  }

  template.method = (method || (template.bodyType === "none" ? "GET" : "POST")).toUpperCase();
  template.responsePath = guessResponsePath(url);

  const serialized = JSON.stringify(template);
  if (stage === "transcription" && template.bodyType !== "binary" && !/\{\{(raw:)?(audio|audio_base64)\}\}/.test(serialized)) {
    notes.push("No audio was found in the request. Put {{audio}} in a file field, or {{audio_base64}} in the JSON body.");
  }
  if (stage === "cleanup" && !serialized.includes("{{text}}")) {
    notes.push("Add {{text}} where the transcript should go, and {{system_prompt}} for your instruction.");
  }
  if (/your|<[^>]+>|\{[A-Za-z_-]+\}/i.test(url.replace(/\{\{[^}]+\}\}/g, ""))) {
    notes.push("The endpoint still contains a placeholder from the docs (like YourResourceName) — replace it with your own value.");
  }
  if (detectedKey) notes.push("A key was found in the command. It was moved to secure storage and replaced with {{api_key}}.");
  if (!template.responsePath) notes.push("Response path left on auto-detect. Use Test to see the raw response if no text comes back.");

  return { template, endpoint: url, model: result.model, detectedKey, forceWav, notes };
}
