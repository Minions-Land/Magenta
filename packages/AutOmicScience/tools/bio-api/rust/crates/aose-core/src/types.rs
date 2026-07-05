use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        source: String,
        #[serde(rename = "mediaType", skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    pub fn as_text_lossy(&self) -> String {
        match self {
            MessageContent::Text(text) => text.clone(),
            MessageContent::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    ContentPart::Image { .. } => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

impl From<String> for MessageContent {
    fn from(value: String) -> Self {
        MessageContent::Text(value)
    }
}

impl From<&str> for MessageContent {
    fn from(value: &str) -> Self {
        MessageContent::Text(value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Message {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub role: Role,
    pub content: MessageContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Provenance / grounding sidecar carried alongside the message but NOT sent
    /// to the LLM context. For tool messages this holds the originating
    /// `ToolResult.metadata` (evidence records + execution trace: API endpoint,
    /// params, raw response excerpt, latency, timestamp). It is the
    /// machine-verifiable link from any number in a report back to the exact
    /// tool call that produced it, and is persisted to `.aose/history.json` so a
    /// provenance document and self-audit can be reconstructed after the fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl Message {
    pub fn system(content: impl Into<MessageContent>) -> Self {
        Self {
            id: None,
            role: Role::System,
            content: content.into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            metadata: None,
        }
    }

    pub fn user(content: impl Into<MessageContent>) -> Self {
        Self {
            id: None,
            role: Role::User,
            content: content.into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            metadata: None,
        }
    }

    pub fn assistant(content: impl Into<MessageContent>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            id: None,
            role: Role::Assistant,
            content: content.into(),
            name: None,
            tool_call_id: None,
            tool_calls: (!tool_calls.is_empty()).then_some(tool_calls),
            metadata: None,
        }
    }

    pub fn tool(
        call_id: impl Into<String>,
        name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            id: None,
            role: Role::Tool,
            content: MessageContent::Text(content.into()),
            name: Some(name.into()),
            tool_call_id: Some(call_id.into()),
            tool_calls: None,
            metadata: None,
        }
    }

    /// Tool message that also carries the originating `ToolResult.metadata`
    /// (evidence + trace) as an out-of-context provenance sidecar. The metadata
    /// is persisted but never serialized into the LLM-facing context.
    pub fn tool_with_metadata(
        call_id: impl Into<String>,
        name: impl Into<String>,
        content: impl Into<String>,
        metadata: Option<Value>,
    ) -> Self {
        Self {
            id: None,
            role: Role::Tool,
            content: MessageContent::Text(content.into()),
            name: Some(name.into()),
            tool_call_id: Some(call_id.into()),
            tool_calls: None,
            metadata,
        }
    }

    /// Attach a provenance / grounding metadata sidecar to this message.
    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpenAiFunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OpenAiToolDef {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: OpenAiFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ChatOptions {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<OpenAiToolDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(rename = "maxTokens", skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(rename = "extendedThinking", skip_serializing_if = "Option::is_none")]
    pub extended_thinking: Option<bool>,
    #[serde(rename = "responseFormat", skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
}

impl AgentEvent {
    pub fn new(kind: impl Into<String>, data: impl Serialize) -> Self {
        Self {
            kind: kind.into(),
            data: serde_json::to_value(data).unwrap_or(Value::Null),
        }
    }

    pub fn text(text: impl Into<String>) -> Self {
        Self::new("text", text.into())
    }

    pub fn done(text: impl Into<String>) -> Self {
        Self::new("done", text.into())
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::new("error", serde_json::json!({ "message": message.into() }))
    }
}

/// Real-time budget tracking for agent execution.
/// Tracks multiple dimensions: iterations, tool calls, tokens, thinking rounds.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Budget {
    /// Current iteration number (0-indexed)
    pub current_iteration: usize,
    /// Maximum iterations allowed
    pub max_iterations: usize,
    /// Number of tool calls executed this turn
    pub tool_calls_count: usize,
    /// Maximum parallel tool calls (None = unlimited)
    pub max_parallel_tool_calls: Option<usize>,
    /// Estimated tokens used (input + output)
    pub tokens_used: u32,
    /// Maximum tokens allowed (None = unlimited)
    pub max_tokens: Option<u32>,
    /// Number of thinking rounds completed
    pub thinking_rounds: usize,
}

impl Budget {
    pub fn new(
        max_iterations: usize,
        max_parallel_tool_calls: Option<usize>,
        max_tokens: Option<u32>,
    ) -> Self {
        Self {
            current_iteration: 0,
            max_iterations,
            tool_calls_count: 0,
            max_parallel_tool_calls,
            tokens_used: 0,
            max_tokens,
            thinking_rounds: 0,
        }
    }

    /// Check if any budget limit is exhausted
    pub fn is_exhausted(&self) -> bool {
        self.current_iteration >= self.max_iterations
            || self.max_tokens.map_or(false, |max| self.tokens_used >= max)
    }

    /// Get a summary of which budgets are near exhaustion (>80%)
    pub fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();

        // An uncapped run (max == usize::MAX) has no iteration ceiling to warn about.
        if self.max_iterations != usize::MAX {
            let iter_pct = (self.current_iteration as f64 / self.max_iterations as f64) * 100.0;
            if iter_pct > 80.0 {
                warnings.push(format!("Iterations: {:.0}%", iter_pct));
            }
        }

        if let Some(max) = self.max_tokens {
            let token_pct = (self.tokens_used as f64 / max as f64) * 100.0;
            if token_pct > 80.0 {
                warnings.push(format!("Tokens: {:.0}%", token_pct));
            }
        }

        warnings
    }
}
