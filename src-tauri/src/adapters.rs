//! Declarative request templates for providers that are not OpenAI-compatible.
//!
//! A template describes one HTTP call: method, URL, headers, body, and where the
//! text lives in the response. Values may contain `{{placeholders}}` which are
//! filled per dictation and escaped for the context they appear in (URL, JSON,
//! plain text). `{{raw:name}}` inserts a value without escaping.

use base64::Engine;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub type Vars = HashMap<String, String>;

/// Placeholders whose values are already JSON and must never be escaped.
const RAW_JSON_VARS: &[&str] = &["locales", "locales_regional"];

/// Tried in order when a template leaves the response path empty.
const AUTO_RESPONSE_PATHS: &[&str] = &[
    "text",
    "DisplayText",
    "combinedPhrases.0.text",
    "results.channels.0.alternatives.0.transcript",
    "choices.0.message.content",
    "content.0.text",
    "candidates.0.content.parts.0.text",
    "output_text",
    "output.*.content.*.text",
    "transcript",
    "transcription",
    "result.text",
    "results.0.transcript",
    "data.text",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestTemplate {
    pub method: String,
    pub url: String,
    pub headers: Vec<KeyValue>,
    /// `multipart`, `json`, `binary`, `text`, `form`, or `none`.
    pub body_type: String,
    /// Multipart or URL-encoded form fields. A value of `{{audio}}` attaches the recording.
    pub fields: Vec<KeyValue>,
    pub body: String,
    /// Dotted path (`combinedPhrases.0.text`), bracket path, or JSON pointer. `*` joins all items.
    pub response_path: String,
}

impl Default for RequestTemplate {
    fn default() -> Self {
        Self {
            method: "POST".into(),
            url: "{{endpoint}}".into(),
            headers: Vec::new(),
            body_type: "json".into(),
            fields: Vec::new(),
            body: String::new(),
            response_path: String::new(),
        }
    }
}

impl RequestTemplate {
    pub fn references(&self, name: &str) -> bool {
        let needle = |text: &str| mentions(text, name);
        needle(&self.url)
            || needle(&self.body)
            || self
                .headers
                .iter()
                .any(|header| needle(&header.key) || needle(&header.value))
            || self.fields.iter().any(|field| needle(&field.value))
    }
}

pub fn mentions(text: &str, name: &str) -> bool {
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return false;
        };
        let token = after[..end].trim();
        if token.strip_prefix("raw:").unwrap_or(token).trim() == name {
            return true;
        }
        rest = &after[end + 2..];
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escape {
    Plain,
    Json,
    Url,
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn escape_value(value: &str, escape: Escape) -> String {
    match escape {
        Escape::Plain => value.to_string(),
        Escape::Url => percent_encode(value),
        Escape::Json => {
            let quoted = serde_json::to_string(value).unwrap_or_default();
            quoted[1..quoted.len().saturating_sub(1)].to_string()
        }
    }
}

/// Fills `{{placeholders}}`. Unknown placeholders are left untouched so typos stay visible.
pub fn render(text: &str, vars: &Vars, escape: Escape) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = after[..end].trim();
        let (raw, name) = match token.strip_prefix("raw:") {
            Some(name) => (true, name.trim()),
            None => (false, token),
        };
        match vars.get(name) {
            Some(value) if raw || RAW_JSON_VARS.contains(&name) => out.push_str(value),
            Some(value) => out.push_str(&escape_value(value, escape)),
            None => out.push_str(&rest[start..start + end + 4]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn looks_like_json(text: &str) -> bool {
    matches!(text.trim_start().chars().next(), Some('{') | Some('['))
}

pub struct Audio<'a> {
    pub bytes: &'a [u8],
    pub mime_type: &'a str,
    pub file_name: String,
}

pub struct HttpOutcome {
    pub status: u16,
    pub body: String,
}

impl HttpOutcome {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

fn is_audio_field(value: &str) -> bool {
    value.trim() == "{{audio}}"
}

/// Builds and sends the templated request. `vars` must already contain `endpoint`.
pub async fn send(
    client: &reqwest::Client,
    template: &RequestTemplate,
    vars: &Vars,
    audio: Option<Audio<'_>>,
) -> Result<HttpOutcome, String> {
    let mut vars = vars.clone();
    if let Some(audio) = audio.as_ref() {
        if template.references("audio_base64") {
            vars.insert(
                "audio_base64".into(),
                base64::engine::general_purpose::STANDARD.encode(audio.bytes),
            );
        }
    }
    let endpoint = vars.get("endpoint").cloned().unwrap_or_default();
    // The endpoint is user-typed and may itself hold placeholders such as `?key={{api_key}}`.
    let url_template = template
        .url
        .replace("{{endpoint}}", &endpoint)
        .replace("{{ endpoint }}", &endpoint);
    let url = render(&url_template, &vars, Escape::Url);
    if url.trim().is_empty() {
        return Err("The request URL is empty. Add an API endpoint.".into());
    }
    let method_name = if template.method.trim().is_empty() {
        "POST".to_string()
    } else {
        template.method.trim().to_ascii_uppercase()
    };
    let method = reqwest::Method::from_bytes(method_name.as_bytes())
        .map_err(|_| format!("‘{method_name}’ is not a valid HTTP method."))?;
    let mut request = client.request(method, url.trim());

    let body_type = template.body_type.trim().to_ascii_lowercase();
    for header in &template.headers {
        let name = header.key.trim();
        let value = render(&header.value, &vars, Escape::Plain);
        if name.is_empty() || value.trim().is_empty() {
            continue;
        }
        // reqwest must set the multipart boundary itself.
        if body_type == "multipart" && name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        request = request.header(name, value.trim());
    }

    let has_content_type = template
        .headers
        .iter()
        .any(|header| header.key.trim().eq_ignore_ascii_case("content-type"));
    request = match body_type.as_str() {
        "multipart" => {
            let mut form = Form::new();
            for field in &template.fields {
                let name = field.key.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                if is_audio_field(&field.value) {
                    let audio = audio
                        .as_ref()
                        .ok_or("This stage has no audio to attach to {{audio}}.")?;
                    let part = Part::bytes(audio.bytes.to_vec())
                        .file_name(audio.file_name.clone())
                        .mime_str(audio.mime_type.split(';').next().unwrap_or("audio/wav"))
                        .map_err(|error| format!("Unsupported recording format: {error}"))?;
                    form = form.part(name, part);
                    continue;
                }
                let escape = if looks_like_json(&field.value) {
                    Escape::Json
                } else {
                    Escape::Plain
                };
                let value = render(&field.value, &vars, escape);
                if value.trim().is_empty() {
                    continue;
                }
                if escape == Escape::Json {
                    serde_json::from_str::<Value>(&value).map_err(|error| {
                        format!("The ‘{name}’ field isn't valid JSON after filling placeholders: {error}")
                    })?;
                }
                form = form.text(name, value);
            }
            request.multipart(form)
        }
        "form" => {
            let pairs: Vec<(String, String)> = template
                .fields
                .iter()
                .filter(|field| !field.key.trim().is_empty())
                .map(|field| (field.key.trim().to_string(), render(&field.value, &vars, Escape::Plain)))
                .filter(|(_, value)| !value.trim().is_empty())
                .collect();
            request.form(&pairs)
        }
        "binary" => {
            let audio = audio
                .as_ref()
                .ok_or("A binary body sends the recording, but this stage has no audio.")?;
            if !has_content_type {
                request = request.header("Content-Type", audio.mime_type);
            }
            request.body(audio.bytes.to_vec())
        }
        "json" => {
            let body = render(&template.body, &vars, Escape::Json);
            serde_json::from_str::<Value>(&body).map_err(|error| {
                format!("The request body isn't valid JSON after filling placeholders: {error}")
            })?;
            if !has_content_type {
                request = request.header("Content-Type", "application/json");
            }
            request.body(body)
        }
        "text" => request.body(render(&template.body, &vars, Escape::Plain)),
        _ => request,
    };

    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach {}: {error}", url.trim()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("The provider returned an unreadable response: {error}"))?;
    Ok(HttpOutcome { status, body })
}

fn path_segments(path: &str) -> Vec<String> {
    let path = path.trim();
    if let Some(pointer) = path.strip_prefix('/') {
        return pointer
            .split('/')
            .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
            .collect();
    }
    let path = path.strip_prefix('$').unwrap_or(path);
    path.replace('[', ".")
        .replace(']', "")
        .split('.')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn walk<'a>(value: &'a Value, segments: &[String], out: &mut Vec<&'a Value>) {
    let Some((head, tail)) = segments.split_first() else {
        out.push(value);
        return;
    };
    match (head.as_str(), value) {
        ("*", Value::Array(items)) => items.iter().for_each(|item| walk(item, tail, out)),
        ("*", Value::Object(map)) => map.values().for_each(|item| walk(item, tail, out)),
        (key, Value::Array(items)) => {
            if let Some(item) = key.parse::<usize>().ok().and_then(|index| items.get(index)) {
                walk(item, tail, out);
            }
        }
        (key, Value::Object(map)) => {
            if let Some(item) = map.get(key) {
                walk(item, tail, out);
            }
        }
        _ => {}
    }
}

/// Returns the text at `path`, joining wildcard matches with spaces.
pub fn select(value: &Value, path: &str) -> Option<String> {
    let mut found = Vec::new();
    walk(value, &path_segments(path), &mut found);
    let parts: Vec<String> = found
        .into_iter()
        .filter_map(|item| match item {
            Value::String(text) => Some(text.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Pulls the transcript or model output out of a response body.
pub fn extract_text(body: &str, path: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::String(text)) => Some(text.trim().to_string()).filter(|text| !text.is_empty()),
        Ok(value) if path.trim().is_empty() => AUTO_RESPONSE_PATHS
            .iter()
            .find_map(|candidate| select(&value, candidate)),
        Ok(value) => select(&value, path),
        // Plain-text response formats (`response_format=text`, some self-hosted servers).
        Err(_) if path.trim().is_empty() || path.trim() == "$" => Some(trimmed.to_string()),
        Err(_) => None,
    }
}

pub fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    format!("{}…", text.chars().take(limit).collect::<String>())
}

/// Best-effort human-readable error from a failed response.
pub fn error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body.trim()) {
        for path in [
            "error.message",
            "error",
            "message",
            "Message",
            "detail.message",
            "detail",
            "error.details.0.message",
            "err_msg",
            "title",
        ] {
            if let Some(message) = select(&value, path) {
                return truncate(&message, 400);
            }
        }
    }
    if body.trim().is_empty() {
        return "The provider returned an empty error response.".into();
    }
    truncate(body, 400)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vars() -> Vars {
        Vars::from([
            ("model".to_string(), "MAI-Transcribe-2".to_string()),
            ("text".to_string(), "He said \"hi\"\nthen left".to_string()),
            ("locales".to_string(), "[\"en\"]".to_string()),
            ("api_key".to_string(), "a b&c".to_string()),
        ])
    }

    #[test]
    fn render_escapes_by_context() {
        let vars = vars();
        assert_eq!(
            render("{\"content\": \"{{text}}\"}", &vars, Escape::Json),
            "{\"content\": \"He said \\\"hi\\\"\\nthen left\"}"
        );
        assert_eq!(render("?key={{api_key}}", &vars, Escape::Url), "?key=a%20b%26c");
        assert_eq!(render("{{raw:api_key}}", &vars, Escape::Url), "a b&c");
        assert_eq!(render("\"locales\": {{locales}}", &vars, Escape::Json), "\"locales\": [\"en\"]");
        assert_eq!(render("{{ model }} {{missing}}", &vars, Escape::Plain), "MAI-Transcribe-2 {{missing}}");
    }

    #[test]
    fn detects_references() {
        let mut template = RequestTemplate::default();
        template.headers.push(KeyValue {
            key: "Ocp-Apim-Subscription-Key".into(),
            value: "{{ api_key }}".into(),
        });
        assert!(template.references("api_key"));
        assert!(!template.references("audio_base64"));
    }

    #[test]
    fn selects_paths() {
        let body = json!({
            "combinedPhrases": [{ "channel": 0, "text": "Hello world." }],
            "results": { "channels": [{ "alternatives": [{ "transcript": "deepgram" }] }] },
            "output": [{ "content": [{ "text": "a" }, { "text": "b" }] }]
        });
        assert_eq!(select(&body, "combinedPhrases.0.text").as_deref(), Some("Hello world."));
        assert_eq!(select(&body, "combinedPhrases[0].text").as_deref(), Some("Hello world."));
        assert_eq!(select(&body, "/combinedPhrases/0/text").as_deref(), Some("Hello world."));
        assert_eq!(select(&body, "output.*.content.*.text").as_deref(), Some("a b"));
        assert_eq!(
            select(&body, "results.channels.0.alternatives.0.transcript").as_deref(),
            Some("deepgram")
        );
    }

    #[test]
    fn extracts_with_auto_detection() {
        assert_eq!(
            extract_text(r#"{"combinedPhrases":[{"text":"Auto"}]}"#, "").as_deref(),
            Some("Auto")
        );
        assert_eq!(
            extract_text(r#"{"RecognitionStatus":"Success","DisplayText":"Hi."}"#, "").as_deref(),
            Some("Hi.")
        );
        assert_eq!(extract_text("plain text body\n", "").as_deref(), Some("plain text body"));
        assert_eq!(extract_text(r#"{"text": {"format": {}}}"#, "").as_deref(), None);
    }

    /// Serves one canned response and returns the raw request it received.
    fn mock_server(response_body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let length = text[..head_end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= head_end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        (address, handle)
    }

    #[test]
    fn sends_microsoft_mai_multipart_request() {
        let (address, server) = mock_server(r#"{"durationMilliseconds":900,"combinedPhrases":[{"text":"Hello from MAI."}]}"#);
        let template = RequestTemplate {
            headers: vec![KeyValue {
                key: "Ocp-Apim-Subscription-Key".into(),
                value: "{{api_key}}".into(),
            }],
            body_type: "multipart".into(),
            fields: vec![
                KeyValue { key: "audio".into(), value: "{{audio}}".into() },
                KeyValue {
                    key: "definition".into(),
                    value: "{\n  \"locales\": {{locales}},\n  \"enhancedMode\": { \"enabled\": true, \"model\": \"{{model}}\", \"modelOptions\": { \"transcribeStyle\": \"clean\" } }\n}".into(),
                },
                KeyValue { key: "skipped".into(), value: "{{language}}".into() },
            ],
            response_path: "combinedPhrases.0.text".into(),
            ..RequestTemplate::default()
        };
        let vars = Vars::from([
            ("endpoint".to_string(), format!("{address}/speechtotext/transcriptions:transcribe?api-version=2025-10-15")),
            ("api_key".to_string(), "secret-key".to_string()),
            ("model".to_string(), "MAI-Transcribe-2".to_string()),
            ("locales".to_string(), "[]".to_string()),
            ("language".to_string(), String::new()),
        ]);
        let audio = Audio { bytes: b"RIFF-fake-wav", mime_type: "audio/wav", file_name: "dictation.wav".into() };
        let client = reqwest::Client::new();
        let outcome = tauri::async_runtime::block_on(send(&client, &template, &vars, Some(audio))).unwrap();
        let request = server.join().unwrap();
        let lower = request.to_ascii_lowercase();

        assert!(request.starts_with("POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15 HTTP/1.1"), "{request}");
        assert!(lower.contains("ocp-apim-subscription-key: secret-key"), "{request}");
        assert!(lower.contains("content-type: multipart/form-data; boundary="), "{request}");
        assert!(request.contains("name=\"audio\"; filename=\"dictation.wav\""), "{request}");
        assert!(request.contains("RIFF-fake-wav"), "{request}");
        assert!(request.contains("\"locales\": []"), "{request}");
        assert!(request.contains("\"model\": \"MAI-Transcribe-2\""), "{request}");
        assert!(!request.contains("name=\"skipped\""), "empty fields are omitted: {request}");
        assert!(outcome.is_success());
        assert_eq!(extract_text(&outcome.body, &template.response_path).as_deref(), Some("Hello from MAI."));
    }

    #[test]
    fn sends_json_template_with_escaped_text() {
        let (address, server) = mock_server(r#"{"content":[{"type":"text","text":"He said hi, then left."}]}"#);
        let template = RequestTemplate {
            headers: vec![
                KeyValue { key: "x-api-key".into(), value: "{{api_key}}".into() },
                KeyValue { key: "anthropic-version".into(), value: "2023-06-01".into() },
            ],
            body_type: "json".into(),
            body: "{\"model\": \"{{model}}\", \"system\": \"{{system_prompt}}\", \"messages\": [{\"role\": \"user\", \"content\": \"{{text}}\"}]}".into(),
            ..RequestTemplate::default()
        };
        let mut vars = vars();
        vars.insert("endpoint".into(), format!("{address}/v1/messages"));
        vars.insert("system_prompt".into(), "Fix \"quotes\" and\nnewlines".into());
        let client = reqwest::Client::new();
        let outcome = tauri::async_runtime::block_on(send(&client, &template, &vars, None)).unwrap();
        let request = server.join().unwrap();
        let body = &request[request.find("\r\n\r\n").unwrap() + 4..];
        let parsed: Value = serde_json::from_str(body).expect("request body is valid JSON");

        assert!(request.to_ascii_lowercase().contains("x-api-key: a b&c"), "{request}");
        assert!(request.to_ascii_lowercase().contains("content-type: application/json"), "{request}");
        assert_eq!(parsed["messages"][0]["content"], "He said \"hi\"\nthen left");
        assert_eq!(parsed["system"], "Fix \"quotes\" and\nnewlines");
        assert_eq!(extract_text(&outcome.body, "").as_deref(), Some("He said hi, then left."));
    }

    #[test]
    fn reads_error_messages() {
        assert_eq!(error_message(r#"{"error":{"code":"x","message":"Bad key"}}"#), "Bad key");
        assert_eq!(error_message(r#"{"error":"Nope"}"#), "Nope");
        assert_eq!(error_message("Service unavailable"), "Service unavailable");
    }
}
