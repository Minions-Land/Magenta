use crate::types::{AgentEvent, OpenAiFunctionDef, OpenAiToolDef};
use anyhow::Result;
use aose_schemas::{EvidenceRecord, ProcessingStep, TraceStep};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;

const DEFAULT_MAX_RESULT_SIZE_CHARS: usize = 200_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl ToolResult {
    /// Create a new ToolResult with the given tool_call_id and content.
    pub fn new(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            content: content.into(),
            metadata: None,
        }
    }

    /// Add evidence records to the result metadata.
    pub fn with_evidence(mut self, evidence: Vec<EvidenceRecord>) -> Self {
        let evidence_value = serde_json::to_value(&evidence).unwrap_or(Value::Null);
        self.metadata = Some(merge_into_metadata(
            self.metadata,
            "evidence",
            evidence_value,
        ));
        self
    }

    /// Add a single evidence record to the result metadata.
    pub fn add_evidence(mut self, evidence: EvidenceRecord) -> Self {
        let mut existing_evidence = self.get_evidence_array();
        existing_evidence.push(serde_json::to_value(&evidence).unwrap_or(Value::Null));

        self.metadata = Some(merge_into_metadata(
            self.metadata,
            "evidence",
            Value::Array(existing_evidence),
        ));
        self
    }

    /// Add a trace step to the result metadata.
    pub fn with_trace(mut self, step: TraceStep) -> Self {
        let mut existing_trace = self.get_trace_array();
        existing_trace.push(serde_json::to_value(&step).unwrap_or(Value::Null));

        self.metadata = Some(merge_into_metadata(
            self.metadata,
            "trace",
            Value::Array(existing_trace),
        ));
        self
    }

    /// Add multiple trace steps to the result metadata.
    pub fn with_traces(mut self, steps: Vec<TraceStep>) -> Self {
        let mut existing_trace = self.get_trace_array();
        for step in steps {
            existing_trace.push(serde_json::to_value(&step).unwrap_or(Value::Null));
        }

        self.metadata = Some(merge_into_metadata(
            self.metadata,
            "trace",
            Value::Array(existing_trace),
        ));
        self
    }

    /// Get evidence records from metadata.
    pub fn get_evidence(&self) -> Vec<EvidenceRecord> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("evidence"))
            .and_then(|e| serde_json::from_value(e.clone()).ok())
            .unwrap_or_default()
    }

    /// Get trace steps from metadata.
    pub fn get_trace(&self) -> Vec<TraceStep> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("trace"))
            .and_then(|t| serde_json::from_value(t.clone()).ok())
            .unwrap_or_default()
    }

    /// Add a processing-step record (a deterministic transformation applied to
    /// raw data) to the result metadata. Makes derived numbers explainable
    /// rather than silent LLM rewrites — the core of processing transparency.
    pub fn with_processing(mut self, step: ProcessingStep) -> Self {
        let mut existing = self.get_processing_array();
        existing.push(serde_json::to_value(&step).unwrap_or(Value::Null));
        self.metadata = Some(merge_into_metadata(
            self.metadata,
            "processing",
            Value::Array(existing),
        ));
        self
    }

    /// Add multiple processing-step records.
    pub fn with_processing_steps(mut self, steps: Vec<ProcessingStep>) -> Self {
        let mut existing = self.get_processing_array();
        for step in steps {
            existing.push(serde_json::to_value(&step).unwrap_or(Value::Null));
        }
        self.metadata = Some(merge_into_metadata(
            self.metadata,
            "processing",
            Value::Array(existing),
        ));
        self
    }

    /// Get processing steps from metadata.
    pub fn get_processing(&self) -> Vec<ProcessingStep> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("processing"))
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default()
    }

    fn get_processing_array(&self) -> Vec<Value> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("processing"))
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default()
    }

    /// Internal helper to get existing evidence array.
    fn get_evidence_array(&self) -> Vec<Value> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("evidence"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default()
    }

    /// Internal helper to get existing trace array.
    fn get_trace_array(&self) -> Vec<Value> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("trace"))
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default()
    }
}

/// Helper function to merge a field into metadata.
fn merge_into_metadata(existing: Option<Value>, field: &str, value: Value) -> Value {
    match existing {
        Some(Value::Object(mut map)) => {
            map.insert(field.to_string(), value);
            Value::Object(map)
        }
        _ => {
            let mut map = serde_json::Map::new();
            map.insert(field.to_string(), value);
            Value::Object(map)
        }
    }
}

/// A live event channel a tool can push `AgentEvent`s onto while it runs.
///
/// The agent main loop owns the `mpsc::UnboundedSender<AgentEvent>` that
/// streams to the front-end (and, via the stdio protocol, to the TUI). Long-
/// running tools — notably `spawn_agent` and `start_dynamic_workflow` — clone
/// that sender into their `ExecutionContext` so they can emit lifecycle events
/// (`agent_spawned`, `agent_progress`, `agent_finished`) *during* execution
/// instead of only returning a final string. This is what gives the TUI a
/// real-time view of sub-agent activity rather than a single static result at
/// the end.
///
/// Cloning is cheap (it clones the channel sender). When no front-end is
/// attached (e.g. headless/library use) the emitter is simply `None` and every
/// `emit` is a no-op, so tools never need to special-case its absence.
#[derive(Debug, Clone, Default)]
pub struct ToolEventEmitter {
    tx: Option<mpsc::UnboundedSender<AgentEvent>>,
}

impl ToolEventEmitter {
    /// An emitter wired to the agent's live event channel.
    pub fn new(tx: mpsc::UnboundedSender<AgentEvent>) -> Self {
        Self { tx: Some(tx) }
    }

    /// A no-op emitter (no front-end attached).
    pub fn disabled() -> Self {
        Self { tx: None }
    }

    /// Emit a structured event. Best-effort: a closed channel (front-end gone)
    /// silently drops the event so a tool never fails on a dead receiver.
    pub fn emit(&self, kind: impl Into<String>, data: impl Serialize) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(AgentEvent::new(kind, data));
        }
    }

    /// True when a real channel is attached (useful to skip building payloads
    /// when nobody is listening).
    pub fn is_active(&self) -> bool {
        self.tx.is_some()
    }
}

#[derive(Clone, Default)]
pub struct ExecutionContext {
    pub agent_name: Option<String>,
    pub metadata: Value,
    /// Live event channel for streaming progress while the tool runs. Skipped
    /// in (de)serialization — it is a runtime-only handle, never persisted or
    /// sent over the wire. Absent (`disabled`) for tools that don't stream.
    pub events: ToolEventEmitter,
}

impl std::fmt::Debug for ExecutionContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutionContext")
            .field("agent_name", &self.agent_name)
            .field("metadata", &self.metadata)
            .field("events_active", &self.events.is_active())
            .finish()
    }
}

impl Serialize for ExecutionContext {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ExecutionContext", 2)?;
        if self.agent_name.is_some() {
            state.serialize_field("agentName", &self.agent_name)?;
        }
        state.serialize_field("metadata", &self.metadata)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for ExecutionContext {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(rename = "agentName", default)]
            agent_name: Option<String>,
            #[serde(default)]
            metadata: Value,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(ExecutionContext {
            agent_name: wire.agent_name,
            metadata: wire.metadata,
            events: ToolEventEmitter::disabled(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolOperation {
    Read,
    Write,
    Execute,
    Network,
    Task,
    #[default]
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub aliases: Vec<String>,
    pub operation: ToolOperation,
    pub read_only: bool,
    pub destructive: bool,
    pub max_result_size_chars: Option<usize>,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    fn permission_path(&self, args: &Value) -> Option<String> {
        permission_path_arg(args)
    }
    async fn execute(&self, args: Value, ctx: ExecutionContext) -> Result<ToolResult>;
}

pub struct FunctionTool<F> {
    definition: ToolDefinition,
    f: F,
}

#[async_trait]
impl<F, Fut> Tool for FunctionTool<F>
where
    F: Send + Sync + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + std::future::Future<Output = Result<String>>,
{
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    async fn execute(&self, args: Value, ctx: ExecutionContext) -> Result<ToolResult> {
        let call_id = ctx
            .metadata
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok(ToolResult {
            tool_call_id: call_id,
            content: (self.f)(args, ctx).await?,
            metadata: None,
        })
    }
}

/// Structured return for a "grounded" tool: the LLM-facing text plus an
/// out-of-context provenance/grounding metadata sidecar (evidence records,
/// execution trace, and processing-step records). Tools that have provenance to
/// report return this instead of a bare `String` so the metadata survives into
/// the persisted `Message` rather than being dropped at `Ok(content)`.
#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub content: String,
    pub metadata: Option<Value>,
}

impl ToolOutput {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: None,
        }
    }

    pub fn with_metadata(content: impl Into<String>, metadata: Value) -> Self {
        Self {
            content: content.into(),
            metadata: Some(metadata),
        }
    }
}

impl From<String> for ToolOutput {
    fn from(content: String) -> Self {
        Self::new(content)
    }
}
// GROUNDED_TOOL_PLACEHOLDER

/// A tool whose closure returns a [`ToolOutput`] (content + provenance
/// metadata). Mirrors [`FunctionTool`] but preserves the metadata sidecar.
pub struct GroundedFunctionTool<F> {
    definition: ToolDefinition,
    f: F,
}

#[async_trait]
impl<F, Fut> Tool for GroundedFunctionTool<F>
where
    F: Send + Sync + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + std::future::Future<Output = Result<ToolOutput>>,
{
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    async fn execute(&self, args: Value, ctx: ExecutionContext) -> Result<ToolResult> {
        let call_id = ctx
            .metadata
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let output = (self.f)(args, ctx).await?;
        Ok(ToolResult {
            tool_call_id: call_id,
            content: output.content,
            metadata: output.metadata,
        })
    }
}

/// Define a grounded tool whose closure returns [`ToolOutput`] so its evidence /
/// trace / processing-step metadata is carried on the persisted message. Use
/// this for tools that fetch or transform data and must be traceable.
#[allow(clippy::too_many_arguments)]
pub fn define_grounded_tool<F, Fut>(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: Value,
    operation: ToolOperation,
    read_only: bool,
    destructive: bool,
    f: F,
) -> Arc<dyn Tool>
where
    F: Send + Sync + 'static + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + 'static + std::future::Future<Output = Result<ToolOutput>>,
{
    Arc::new(GroundedFunctionTool {
        definition: ToolDefinition {
            name: name.into(),
            description: description.into(),
            parameters,
            aliases: Vec::new(),
            operation,
            read_only,
            destructive,
            max_result_size_chars: None,
        },
        f,
    })
}

pub fn define_tool<F, Fut>(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: Value,
    f: F,
) -> Arc<dyn Tool>
where
    F: Send + Sync + 'static + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + 'static + std::future::Future<Output = Result<String>>,
{
    define_tool_with_metadata(
        name,
        description,
        parameters,
        ToolOperation::Unknown,
        false,
        false,
        f,
    )
}

pub fn define_tool_with_metadata<F, Fut>(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: Value,
    operation: ToolOperation,
    read_only: bool,
    destructive: bool,
    f: F,
) -> Arc<dyn Tool>
where
    F: Send + Sync + 'static + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + 'static + std::future::Future<Output = Result<String>>,
{
    define_tool_with_metadata_aliases_and_limit(
        name,
        description,
        parameters,
        Vec::new(),
        operation,
        read_only,
        destructive,
        None,
        f,
    )
}

#[allow(clippy::too_many_arguments)] // Tool definition requires many metadata parameters
pub fn define_tool_with_metadata_and_limit<F, Fut>(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: Value,
    operation: ToolOperation,
    read_only: bool,
    destructive: bool,
    max_result_size_chars: Option<usize>,
    f: F,
) -> Arc<dyn Tool>
where
    F: Send + Sync + 'static + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + 'static + std::future::Future<Output = Result<String>>,
{
    define_tool_with_metadata_aliases_and_limit(
        name,
        description,
        parameters,
        Vec::new(),
        operation,
        read_only,
        destructive,
        max_result_size_chars,
        f,
    )
}

#[allow(clippy::too_many_arguments)] // Tool definition requires many metadata parameters
pub fn define_tool_with_metadata_aliases_and_limit<F, Fut>(
    name: impl Into<String>,
    description: impl Into<String>,
    parameters: Value,
    aliases: Vec<String>,
    operation: ToolOperation,
    read_only: bool,
    destructive: bool,
    max_result_size_chars: Option<usize>,
    f: F,
) -> Arc<dyn Tool>
where
    F: Send + Sync + 'static + Fn(Value, ExecutionContext) -> Fut,
    Fut: Send + 'static + std::future::Future<Output = Result<String>>,
{
    Arc::new(FunctionTool {
        definition: ToolDefinition {
            name: name.into(),
            description: description.into(),
            parameters,
            aliases,
            operation,
            read_only,
            destructive,
            max_result_size_chars,
        },
        f,
    })
}

pub fn pair_tools_to_agent(
    tools: &[ToolDefinition],
    agent_capabilities: &[String],
) -> Vec<ToolDefinition> {
    if agent_capabilities.is_empty() {
        return tools.to_vec();
    }

    let capabilities = agent_capabilities
        .iter()
        .map(|capability| capability.to_ascii_lowercase())
        .collect::<Vec<_>>();

    tools
        .iter()
        .filter(|tool| {
            let name = tool.name.to_ascii_lowercase();
            let description = tool.description.to_ascii_lowercase();
            capabilities.iter().any(|capability| {
                capability == &name || name.contains(capability) || description.contains(capability)
            })
        })
        .cloned()
        .collect()
}

pub fn rank_tools_by_relevance(tools: &[ToolDefinition], query: &str) -> Vec<ToolDefinition> {
    let query_words = query
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|word| word.chars().count() > 2)
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();

    let mut scored = tools
        .iter()
        .enumerate()
        .map(|(idx, tool)| {
            let text = format!("{} {}", tool.name, tool.description).to_ascii_lowercase();
            let mut score = query_words
                .iter()
                .filter(|word| text.contains(word.as_str()))
                .count();
            if query_words.contains(&tool.name.to_ascii_lowercase()) {
                score += 3;
            }
            (idx, score, tool.clone())
        })
        .collect::<Vec<_>>();

    scored.sort_by(|(idx_a, score_a, _), (idx_b, score_b, _)| {
        score_b.cmp(score_a).then_with(|| idx_a.cmp(idx_b))
    });
    scored.into_iter().map(|(_, _, tool)| tool).collect()
}

pub fn format_tools_for_provider(tools: &[ToolDefinition], provider: &str) -> Vec<Value> {
    match provider.to_ascii_lowercase().as_str() {
        "anthropic" => tools.iter().map(format_tool_for_anthropic).collect(),
        "gemini" => vec![serde_json::json!({
            "functionDeclarations": tools.iter().map(format_tool_for_gemini).collect::<Vec<_>>()
        })],
        "openai" => tools.iter().map(format_tool_for_openai).collect(),
        _ => tools.iter().map(format_tool_for_openai).collect(),
    }
}

fn format_tool_for_openai(tool: &ToolDefinition) -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters
        }
    })
}

fn format_tool_for_anthropic(tool: &ToolDefinition) -> Value {
    serde_json::json!({
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.parameters
    })
}

fn format_tool_for_gemini(tool: &ToolDefinition) -> Value {
    serde_json::json!({
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters
    })
}

#[derive(Debug, Clone)]
pub struct PermissionCheckRequest {
    pub tool_name: String,
    pub args: Value,
    pub agent_name: Option<String>,
    pub operation: ToolOperation,
    pub read_only: bool,
    pub destructive: bool,
    pub command: Option<String>,
    pub path: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionBehavior {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionCheckDecision {
    pub behavior: PermissionBehavior,
    pub reason: Option<String>,
    pub rule: Option<Value>,
    #[serde(rename = "updatedArgs", skip_serializing_if = "Option::is_none")]
    pub updated_args: Option<Value>,
}

pub trait PermissionChecker: Send + Sync {
    fn check(&self, request: PermissionCheckRequest) -> PermissionCheckDecision;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionApprovalRequest {
    pub approval_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
    pub agent_name: Option<String>,
    pub operation: ToolOperation,
    pub read_only: bool,
    pub destructive: bool,
    pub command: Option<String>,
    pub path: Option<String>,
    pub metadata: Value,
    pub reason: Option<String>,
    pub rule: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionApprovalDecisionKind {
    AllowOnce,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionApprovalDecision {
    pub decision: PermissionApprovalDecisionKind,
    pub reason: Option<String>,
    #[serde(rename = "updatedArgs", skip_serializing_if = "Option::is_none")]
    pub updated_args: Option<Value>,
}

#[async_trait]
pub trait PermissionApprovalHandler: Send + Sync {
    async fn request_approval(
        &self,
        request: PermissionApprovalRequest,
    ) -> PermissionApprovalDecision;
}

#[derive(Clone)]
pub struct ToolSet {
    inner: Arc<RwLock<ToolSetInner>>,
}

struct ToolSetInner {
    tools: HashMap<String, Arc<dyn Tool>>,
    aliases: HashMap<String, String>,
    permission_checker: Option<Arc<dyn PermissionChecker>>,
    result_storage_dir: PathBuf,
    default_max_result_size_chars: usize,
}

impl Default for ToolSet {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(ToolSetInner {
                tools: HashMap::new(),
                aliases: HashMap::new(),
                permission_checker: None,
                result_storage_dir: std::env::temp_dir().join("aos-tool-results"),
                default_max_result_size_chars: DEFAULT_MAX_RESULT_SIZE_CHARS,
            })),
        }
    }
}

impl ToolSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> Self {
        let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
        Self {
            inner: Arc::new(RwLock::new(ToolSetInner {
                tools: inner
                    .tools
                    .iter()
                    .map(|(name, tool)| (name.clone(), tool.clone()))
                    .collect(),
                aliases: inner.aliases.clone(),
                permission_checker: inner.permission_checker.clone(),
                result_storage_dir: inner.result_storage_dir.clone(),
                default_max_result_size_chars: inner.default_max_result_size_chars,
            })),
        }
    }

    pub fn register(&self, tool: Arc<dyn Tool>) -> Result<()> {
        let definition = tool.definition();
        let name = definition.name.clone();
        let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
        if inner.tools.contains_key(&name) || inner.aliases.contains_key(&name) {
            return Err(crate::error::CoreError::ToolAlreadyRegistered { name }.into());
        }
        let mut aliases = Vec::new();
        for alias in definition.aliases {
            if alias.is_empty() || alias == name || aliases.contains(&alias) {
                continue;
            }
            if inner.tools.contains_key(&alias) || inner.aliases.contains_key(&alias) {
                return Err(crate::error::CoreError::ToolAlreadyRegistered { name: alias }.into());
            }
            aliases.push(alias);
        }
        inner.tools.insert(name.clone(), tool);
        for alias in aliases {
            inner.aliases.insert(alias, name.clone());
        }
        Ok(())
    }

    pub fn register_alias(
        &self,
        alias: impl Into<String>,
        canonical: impl Into<String>,
    ) -> Result<()> {
        let alias = alias.into();
        let canonical = canonical.into();
        let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
        if inner.tools.contains_key(&alias) || inner.aliases.contains_key(&alias) {
            return Err(crate::error::CoreError::ToolAlreadyRegistered { name: alias }.into());
        }
        if !inner.tools.contains_key(&canonical) {
            return Err(crate::error::CoreError::ToolNotFound { name: canonical }.into());
        }
        inner.aliases.insert(alias, canonical);
        Ok(())
    }

    pub fn merge(&self, other: ToolSet) {
        let (tools, aliases) = {
            let other = other.inner.read().unwrap_or_else(|err| err.into_inner());
            (
                other
                    .tools
                    .iter()
                    .map(|(name, tool)| (name.clone(), tool.clone()))
                    .collect::<Vec<_>>(),
                other.aliases.clone(),
            )
        };
        let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
        for (name, tool) in tools {
            inner.tools.remove(&name);
            inner.aliases.retain(|_, canonical| canonical != &name);
            inner.tools.insert(name, tool);
        }
        for (alias, canonical) in aliases {
            if inner.tools.contains_key(&alias) {
                inner.tools.remove(&alias);
                inner.aliases.retain(|_, target| target != &alias);
            }
            if inner.tools.contains_key(&canonical) {
                inner.aliases.insert(alias, canonical);
            }
        }
    }

    pub fn remove(&self, name: &str) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
        let mut removed = inner.tools.remove(name).is_some();
        if removed {
            inner
                .aliases
                .retain(|alias, canonical| alias != name && canonical != name);
        }
        if inner.aliases.remove(name).is_some() {
            removed = true;
        }
        removed
    }

    pub fn with_permission_checker(self, checker: Arc<dyn PermissionChecker>) -> Self {
        self.set_permission_checker(Some(checker));
        self
    }

    pub fn set_permission_checker(&self, checker: Option<Arc<dyn PermissionChecker>>) {
        self.inner
            .write()
            .unwrap_or_else(|err| err.into_inner())
            .permission_checker = checker;
    }

    pub fn with_result_storage_dir(self, dir: impl Into<PathBuf>) -> Self {
        self.set_result_storage_dir(dir);
        self
    }

    pub fn set_result_storage_dir(&self, dir: impl Into<PathBuf>) {
        self.inner
            .write()
            .unwrap_or_else(|err| err.into_inner())
            .result_storage_dir = dir.into();
    }

    pub fn with_default_max_result_size_chars(self, max: usize) -> Self {
        self.set_default_max_result_size_chars(max);
        self
    }

    pub fn set_default_max_result_size_chars(&self, max: usize) {
        self.inner
            .write()
            .unwrap_or_else(|err| err.into_inner())
            .default_max_result_size_chars = max;
    }

    /// Apply a wrapper function to all registered tools in-place.
    ///
    /// For each tool, calls `wrapper(name, tool)` and replaces the tool with
    /// the returned wrapper. Useful for adding cross-cutting concerns like
    /// circuit-breaking, rate-limiting, or logging without modifying individual
    /// tool implementations.
    pub fn wrap_all_with<F>(&self, mut wrapper: F) -> Result<()>
    where
        F: FnMut(String, Arc<dyn Tool>) -> Result<Arc<dyn Tool>>,
    {
        let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
        let snapshot: Vec<(String, Arc<dyn Tool>)> = inner
            .tools
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        for (name, tool) in snapshot {
            let wrapped = wrapper(name.clone(), tool)?;
            inner.tools.insert(name, wrapped);
        }
        Ok(())
    }

    pub fn has(&self, name: &str) -> bool {
        let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
        inner.tools.contains_key(name) || inner.aliases.contains_key(name)
    }

    pub fn list(&self) -> Vec<ToolDefinition> {
        let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
        let mut tools = inner
            .tools
            .values()
            .map(|tool| tool.definition())
            .collect::<Vec<_>>();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        tools
    }

    pub fn size(&self) -> usize {
        self.inner
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .tools
            .len()
    }

    pub fn to_openai_tools(&self) -> Vec<OpenAiToolDef> {
        Self::defs_to_openai_tools(self.list())
    }

    /// Like [`to_openai_tools`], but caps the payload at `limit` definitions.
    ///
    /// Providers bound the number of function definitions per request (OpenAI
    /// rejects more than 128). When the toolset is larger than `limit`, the
    /// discovery tools (`manual_lookup`, `tool_search`) are always retained so
    /// the model can recover any dropped tool through the two-step lookup flow,
    /// and the remaining slots go to the tools ranked most relevant to `query`
    /// (the latest user message). `limit == 0` disables capping.
    pub fn to_openai_tools_ranked(&self, limit: usize, query: &str) -> Vec<OpenAiToolDef> {
        let defs = self.list();
        if limit == 0 || defs.len() <= limit {
            return Self::defs_to_openai_tools(defs);
        }
        // Canonical names of the two-step discovery tools (`search_tools` is
        // aliased as `ToolSearch`); they must survive capping so the model can
        // always reach tools dropped from the wire payload.
        const ALWAYS_KEEP: [&str; 2] = ["manual_lookup", "search_tools"];
        let (mut kept, rest): (Vec<_>, Vec<_>) = defs
            .into_iter()
            .partition(|def| ALWAYS_KEEP.contains(&def.name.as_str()));
        let remaining = limit.saturating_sub(kept.len());
        kept.extend(
            rank_tools_by_relevance(&rest, query)
                .into_iter()
                .take(remaining),
        );
        Self::defs_to_openai_tools(kept)
    }

    fn defs_to_openai_tools(defs: Vec<ToolDefinition>) -> Vec<OpenAiToolDef> {
        defs.into_iter()
            .map(|def| OpenAiToolDef {
                kind: "function".to_string(),
                function: OpenAiFunctionDef {
                    name: def.name,
                    description: def.description,
                    parameters: def.parameters,
                },
            })
            .collect()
    }

    pub async fn execute(&self, name: &str, args: Value, ctx: ExecutionContext) -> ToolResult {
        self.execute_with_approval(name, args, ctx, None).await
    }

    pub async fn execute_with_approval(
        &self,
        name: &str,
        args: Value,
        ctx: ExecutionContext,
        approval: Option<Arc<dyn PermissionApprovalHandler>>,
    ) -> ToolResult {
        let (tool, checker) = {
            let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
            let canonical = inner.aliases.get(name).map(String::as_str).unwrap_or(name);
            let Some(tool) = inner.tools.get(canonical).cloned() else {
                return ToolResult {
                    tool_call_id: tool_call_id(&ctx),
                    content: serde_json::json!({ "error": format!("Tool '{name}' not found") })
                        .to_string(),
                    metadata: Some(serde_json::json!({ "errorCode": "tool_not_found" })),
                };
            };
            (tool, inner.permission_checker.clone())
        };
        let def = tool.definition();
        let mut effective_args = normalize_tool_input(&def.parameters, args);
        if let Err(message) = validate_tool_input(&def.parameters, &effective_args) {
            return ToolResult {
                tool_call_id: tool_call_id(&ctx),
                content: serde_json::json!({ "error": message }).to_string(),
                metadata: Some(serde_json::json!({ "errorCode": "invalid_input" })),
            };
        }

        if let Some(checker) = &checker {
            let permission_args = effective_args.clone();
            let command = permission_command_arg(&effective_args);
            let (read_only, destructive) = permission_flags_for_tool(&def, command.as_deref());
            let decision = checker.check(PermissionCheckRequest {
                tool_name: def.name.clone(),
                args: permission_args,
                agent_name: ctx.agent_name.clone(),
                operation: def.operation.clone(),
                read_only,
                destructive,
                command: command.clone(),
                path: tool.permission_path(&effective_args),
                metadata: ctx.metadata.clone(),
            });
            match decision.behavior {
                PermissionBehavior::Allow => {
                    if let Some(updated_args) = decision.updated_args {
                        effective_args = updated_args;
                    }
                }
                PermissionBehavior::Deny => {
                    return permission_denied_result(
                        &ctx,
                        &def,
                        PermissionBehavior::Deny,
                        decision.reason,
                        decision.rule,
                    );
                }
                PermissionBehavior::Ask => {
                    let Some(approval) = approval.as_ref() else {
                        return permission_denied_result(
                            &ctx,
                            &def,
                            PermissionBehavior::Ask,
                            decision
                                .reason
                                .or_else(|| Some(format!("Tool '{}' requires approval", def.name))),
                            decision.rule,
                        );
                    };
                    let approval_decision = approval
                        .request_approval(PermissionApprovalRequest {
                            approval_id: permission_approval_id(),
                            tool_call_id: tool_call_id(&ctx),
                            tool_name: def.name.clone(),
                            args: effective_args.clone(),
                            agent_name: ctx.agent_name.clone(),
                            operation: def.operation.clone(),
                            read_only,
                            destructive,
                            command,
                            path: tool.permission_path(&effective_args),
                            metadata: ctx.metadata.clone(),
                            reason: decision.reason.clone(),
                            rule: decision.rule.clone(),
                        })
                        .await;
                    match approval_decision.decision {
                        PermissionApprovalDecisionKind::AllowOnce => {
                            if let Some(updated_args) =
                                approval_decision.updated_args.or(decision.updated_args)
                            {
                                effective_args = updated_args;
                            }
                        }
                        PermissionApprovalDecisionKind::Deny => {
                            return permission_denied_result(
                                &ctx,
                                &def,
                                PermissionBehavior::Ask,
                                approval_decision.reason.or(decision.reason),
                                decision.rule,
                            );
                        }
                    }
                }
            }
        }
        match tool.execute(effective_args, ctx.clone()).await {
            Ok(result) => match self.maybe_store_large_result(&def, result).await {
                Ok(result) => result,
                Err(err) => ToolResult {
                    tool_call_id: tool_call_id(&ctx),
                    content: serde_json::json!({ "error": err.to_string() }).to_string(),
                    metadata: Some(serde_json::json!({ "errorCode": "tool_result_storage_error" })),
                },
            },
            Err(err) => ToolResult {
                tool_call_id: tool_call_id(&ctx),
                content: serde_json::json!({ "error": err.to_string() }).to_string(),
                metadata: Some(serde_json::json!({ "errorCode": "tool_error" })),
            },
        }
    }

    async fn maybe_store_large_result(
        &self,
        def: &ToolDefinition,
        mut result: ToolResult,
    ) -> Result<ToolResult> {
        let (default_max, result_storage_dir) = {
            let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
            (
                inner.default_max_result_size_chars,
                inner.result_storage_dir.clone(),
            )
        };
        let max = def.max_result_size_chars.unwrap_or(default_max);
        let original_length = result.content.chars().count();
        if original_length <= max {
            return Ok(result);
        }

        tokio::fs::create_dir_all(&result_storage_dir).await?;
        let file = result_storage_dir.join(format!(
            "{}-{}-{}.txt",
            unix_millis(),
            sanitize_result_filename(&def.name),
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::write(&file, &result.content).await?;

        let preview = compress_preview(&result.content, max);
        result.content = serde_json::json!({
            "preview": preview,
            "truncated": true,
            "fullResultPath": file,
            "originalLength": original_length
        })
        .to_string();

        let truncation_metadata = serde_json::json!({
            "fullResultPath": file,
            "originalLength": original_length,
            "truncated": true
        });
        result.metadata = Some(merge_metadata(result.metadata, truncation_metadata));
        Ok(result)
    }
}

/// Build a token-frugal preview of an over-sized tool result.
///
/// Inspired by structural context-compression layers (e.g. headroom's
/// "SmartCrusher"): instead of a blind head-slice that can land mid-row and
/// drop the schema/aggregate/tail signal, sniff the payload format and keep the
/// parts that actually carry answer-relevant information within `max` chars.
///
/// This is intentionally **deterministic and lossless-with-pointer**: the full
/// content is always written to disk first by `maybe_store_large_result`, and
/// the envelope still carries `fullResultPath`, so this preview never loses
/// recoverable data — it only changes *which* slice the model reads inline.
/// Unrecognized formats fall back to the original head-slice (zero regression).
fn compress_preview(content: &str, max: usize) -> String {
    if content.chars().count() <= max {
        return content.to_string();
    }
    let trimmed = content.trim_start();
    if let Some(preview) = compress_json_preview(trimmed, max) {
        return preview;
    }
    if let Some(preview) = compress_tabular_preview(content, max) {
        return preview;
    }
    if let Some(preview) = compress_fasta_preview(content, max) {
        return preview;
    }
    head_slice(content, max)
}

fn head_slice(content: &str, max: usize) -> String {
    content.chars().take(max).collect()
}

/// JSON array / row-set preview: keep the schema, total count, and a
/// rank-preserved head+tail sample so ordering-sensitive results (ranked BLAST
/// hits, gget tables) don't silently drop their tail.
fn compress_json_preview(content: &str, max: usize) -> Option<String> {
    let value: Value = serde_json::from_str(content).ok()?;
    let array = match &value {
        Value::Array(items) => Some(items.as_slice()),
        Value::Object(map) => map
            .get("rows")
            .or_else(|| map.get("data"))
            .or_else(|| map.get("results"))
            .and_then(Value::as_array)
            .map(Vec::as_slice),
        _ => None,
    }?;
    let total = array.len();
    if total == 0 {
        return None;
    }
    let fields = infer_fields(array);
    // Probe how many sampled rows fit, splitting the budget head/tail.
    let mut keep = total.min(64);
    loop {
        let preview = render_json_preview(&value, array, total, &fields, keep);
        if preview.chars().count() <= max {
            return Some(preview);
        }
        if keep <= 1 {
            // A single sampled item already exceeds the budget; hard-bound it.
            // Full data is on disk via fullResultPath, so this stays lossless.
            return Some(head_slice(&preview, max));
        }
        keep /= 2;
    }
}

fn infer_fields(array: &[Value]) -> Vec<String> {
    array
        .iter()
        .find_map(|item| item.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

fn render_json_preview(
    root: &Value,
    array: &[Value],
    total: usize,
    fields: &[String],
    keep: usize,
) -> String {
    let head_n = keep.div_ceil(2).min(total);
    let tail_n = keep
        .saturating_sub(head_n)
        .min(total.saturating_sub(head_n));
    let head: Vec<&Value> = array.iter().take(head_n).collect();
    let tail: Vec<&Value> = array.iter().skip(total - tail_n).collect();
    let container = match root {
        Value::Object(_) => "object{rows}",
        _ => "array",
    };
    let mut out = format!(
        "[compressed preview] {container} with {total} items; showing first {head_n} and last {tail_n}.\n"
    );
    if !fields.is_empty() {
        out.push_str(&format!("fields: {}\n", fields.join(", ")));
    }
    out.push_str("head:\n");
    for item in &head {
        out.push_str(&serde_json::to_string(item).unwrap_or_default());
        out.push('\n');
    }
    if tail_n > 0 {
        out.push_str(&format!(
            "…({} items omitted)…\ntail:\n",
            total - head_n - tail_n
        ));
        for item in &tail {
            out.push_str(&serde_json::to_string(item).unwrap_or_default());
            out.push('\n');
        }
    }
    out.push_str(&format!(
        "[full {total} items written to fullResultPath — re-read it for exhaustive analysis]"
    ));
    out
}

/// TSV/CSV preview: keep the header row + a head/tail sample of data rows.
fn compress_tabular_preview(content: &str, max: usize) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() < 8 {
        return None;
    }
    let delim = detect_delimiter(&lines)?;
    let header = lines[0];
    let header_cols = header.matches(delim).count() + 1;
    if header_cols < 2 {
        return None;
    }
    let body = &lines[1..];
    let total = body.len();
    let mut keep = total.min(64);
    loop {
        let head_n = keep.div_ceil(2).min(total);
        let tail_n = keep
            .saturating_sub(head_n)
            .min(total.saturating_sub(head_n));
        let mut out = format!(
            "[compressed preview] delimited table, {total} data rows, {header_cols} columns; first {head_n} + last {tail_n}.\nheader: {header}\n"
        );
        for line in body.iter().take(head_n) {
            out.push_str(line);
            out.push('\n');
        }
        if tail_n > 0 {
            out.push_str(&format!("…({} rows omitted)…\n", total - head_n - tail_n));
            for line in body.iter().skip(total - tail_n) {
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push_str("[full table written to fullResultPath]");
        if out.chars().count() <= max {
            return Some(out);
        }
        if keep <= 1 {
            return Some(head_slice(&out, max));
        }
        keep /= 2;
    }
}

fn detect_delimiter(lines: &[&str]) -> Option<char> {
    // Require the column count to be stable across EVERY line and ≥2. Genuine
    // tables are uniform throughout; prose almost always has at least one line
    // with a different delimiter count, so this avoids treating comma-heavy
    // prose as a table. On any doubt we fall back to a lossless head-slice.
    for delim in ['\t', ','] {
        let first = lines[0].matches(delim).count();
        if first >= 1 && lines.iter().all(|l| l.matches(delim).count() == first) {
            return Some(delim);
        }
    }
    None
}

/// FASTA preview: list record headers + length per sequence, drop the bulk
/// residues (which the model rarely needs verbatim and can re-read on disk).
fn compress_fasta_preview(content: &str, max: usize) -> Option<String> {
    if !content.trim_start().starts_with('>') {
        return None;
    }
    let mut records: Vec<(String, usize)> = Vec::new();
    let mut current: Option<(String, usize)> = None;
    for line in content.lines() {
        if let Some(header) = line.strip_prefix('>') {
            if let Some(rec) = current.take() {
                records.push(rec);
            }
            current = Some((header.trim().to_string(), 0));
        } else if let Some((_, len)) = current.as_mut() {
            *len += line.trim().chars().count();
        }
    }
    if let Some(rec) = current.take() {
        records.push(rec);
    }
    if records.len() < 2 {
        return None;
    }
    let total = records.len();
    let mut out =
        format!("[compressed preview] FASTA with {total} sequences (residues omitted):\n");
    for (header, len) in &records {
        out.push_str(&format!("> {header} (len={len})\n"));
        if out.chars().count() > max {
            out.push_str("…(more sequences omitted)…\n");
            break;
        }
    }
    out.push_str("[full sequences written to fullResultPath]");
    Some(head_slice(&out, max))
}

fn merge_metadata(existing: Option<Value>, truncation: Value) -> Value {
    match (existing, truncation) {
        (Some(Value::Object(mut existing)), Value::Object(truncation)) => {
            existing.extend(truncation);
            Value::Object(existing)
        }
        (_, truncation) => truncation,
    }
}

fn sanitize_result_filename(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "tool".to_string()
    } else {
        sanitized
    }
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn tool_call_id(ctx: &ExecutionContext) -> String {
    ctx.metadata
        .get("tool_call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn permission_approval_id() -> String {
    format!("perm_{}", uuid::Uuid::new_v4().simple())
}

fn permission_denied_result(
    ctx: &ExecutionContext,
    def: &ToolDefinition,
    behavior: PermissionBehavior,
    reason: Option<String>,
    rule: Option<Value>,
) -> ToolResult {
    ToolResult {
        tool_call_id: tool_call_id(ctx),
        content: serde_json::json!({
            "error": reason.unwrap_or_else(|| format!("Tool '{}' was not permitted", def.name))
        })
        .to_string(),
        metadata: Some(serde_json::json!({
            "permission": behavior,
            "rule": rule
        })),
    }
}

fn validate_tool_input(schema: &Value, input: &Value) -> std::result::Result<(), String> {
    validate_schema_value(schema, input, "input")
}

fn normalize_tool_input(schema: &Value, input: Value) -> Value {
    let mut input = if input.is_null() && schema_allows_object(schema) {
        serde_json::json!({})
    } else {
        input
    };
    apply_schema_defaults(schema, &mut input);
    input
}

fn apply_schema_defaults(schema: &Value, value: &mut Value) {
    match schema_type_names(schema).as_deref() {
        Some(types) if types.contains(&"object") => apply_object_schema_defaults(schema, value),
        Some(types) if types.contains(&"array") => apply_array_schema_defaults(schema, value),
        _ => {}
    }
}

fn apply_object_schema_defaults(schema: &Value, value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return;
    };

    for (field, property_schema) in properties {
        if let Some(property_value) = object.get_mut(field) {
            apply_schema_defaults(property_schema, property_value);
        } else if let Some(default_value) = property_schema.get("default") {
            object.insert(field.clone(), default_value.clone());
        }
    }
}

fn apply_array_schema_defaults(schema: &Value, value: &mut Value) {
    let Some(values) = value.as_array_mut() else {
        return;
    };
    let Some(items_schema) = schema.get("items") else {
        return;
    };

    for item in values {
        apply_schema_defaults(items_schema, item);
    }
}

fn validate_schema_value(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let expected_types = schema_type_names(schema);
    if let Some(expected_types) = &expected_types {
        if !expected_types
            .iter()
            .any(|expected_type| value_matches_schema_type(value, expected_type))
        {
            return Err(format!(
                "{path} must be {}",
                format_expected_types(expected_types)
            ));
        }
    }
    validate_enum_schema(schema, value, path)?;
    validate_number_bounds(schema, value, path)?;
    validate_string_bounds(schema, value, path)?;
    validate_array_bounds(schema, value, path)?;

    match expected_types.as_deref() {
        Some(types) if types.contains(&"object") => validate_object_schema(schema, value, path),
        Some(types) if types.contains(&"array") => validate_array_schema(schema, value, path),
        _ => Ok(()),
    }
}

fn validate_object_schema(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };

    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for field in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(field) {
                return Err(format!("{path}.{field} is required"));
            }
        }
    }

    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Ok(());
    };

    for (field, property_schema) in properties {
        if let Some(property_value) = object.get(field) {
            validate_schema_value(property_schema, property_value, &format!("{path}.{field}"))?;
        }
    }

    Ok(())
}

fn validate_array_schema(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let Some(values) = value.as_array() else {
        return Ok(());
    };
    let Some(items_schema) = schema.get("items") else {
        return Ok(());
    };

    for (index, item) in values.iter().enumerate() {
        validate_schema_value(items_schema, item, &format!("{path}[{index}]"))?;
    }

    Ok(())
}

fn validate_number_bounds(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let Some(number) = value.as_f64() else {
        return Ok(());
    };

    if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
        if number < minimum {
            return Err(format!(
                "{path} must be >= {}",
                format_schema_number(minimum)
            ));
        }
    }
    match schema.get("exclusiveMinimum") {
        Some(Value::Number(minimum)) => {
            if let Some(minimum) = minimum.as_f64() {
                if number <= minimum {
                    return Err(format!(
                        "{path} must be > {}",
                        format_schema_number(minimum)
                    ));
                }
            }
        }
        Some(Value::Bool(true)) => {
            if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
                if number <= minimum {
                    return Err(format!(
                        "{path} must be > {}",
                        format_schema_number(minimum)
                    ));
                }
            }
        }
        _ => {}
    }

    if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
        if number > maximum {
            return Err(format!(
                "{path} must be <= {}",
                format_schema_number(maximum)
            ));
        }
    }
    match schema.get("exclusiveMaximum") {
        Some(Value::Number(maximum)) => {
            if let Some(maximum) = maximum.as_f64() {
                if number >= maximum {
                    return Err(format!(
                        "{path} must be < {}",
                        format_schema_number(maximum)
                    ));
                }
            }
        }
        Some(Value::Bool(true)) => {
            if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
                if number >= maximum {
                    return Err(format!(
                        "{path} must be < {}",
                        format_schema_number(maximum)
                    ));
                }
            }
        }
        _ => {}
    }

    Ok(())
}

fn validate_string_bounds(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let Some(text) = value.as_str() else {
        return Ok(());
    };
    let len = text.chars().count() as u64;

    if let Some(min_length) = schema.get("minLength").and_then(Value::as_u64) {
        if len < min_length {
            return Err(format!("{path} must have at least {min_length} characters"));
        }
    }
    if let Some(max_length) = schema.get("maxLength").and_then(Value::as_u64) {
        if len > max_length {
            return Err(format!("{path} must have at most {max_length} characters"));
        }
    }

    Ok(())
}

fn validate_array_bounds(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let Some(values) = value.as_array() else {
        return Ok(());
    };
    let len = values.len() as u64;

    if let Some(min_items) = schema.get("minItems").and_then(Value::as_u64) {
        if len < min_items {
            return Err(format!("{path} must have at least {min_items} items"));
        }
    }
    if let Some(max_items) = schema.get("maxItems").and_then(Value::as_u64) {
        if len > max_items {
            return Err(format!("{path} must have at most {max_items} items"));
        }
    }

    Ok(())
}

fn format_schema_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn schema_type_names(schema: &Value) -> Option<Vec<&str>> {
    match schema.get("type") {
        Some(Value::String(value)) => Some(vec![value.as_str()]),
        Some(Value::Array(values)) => {
            let types = values.iter().filter_map(Value::as_str).collect::<Vec<_>>();
            (!types.is_empty()).then_some(types)
        }
        _ => None,
    }
}

fn schema_allows_object(schema: &Value) -> bool {
    schema_type_names(schema).is_some_and(|types| types.contains(&"object"))
}

fn validate_enum_schema(
    schema: &Value,
    value: &Value,
    path: &str,
) -> std::result::Result<(), String> {
    let Some(allowed) = schema.get("enum").and_then(Value::as_array) else {
        return Ok(());
    };
    if allowed.iter().any(|allowed_value| allowed_value == value) {
        return Ok(());
    }
    Err(format!(
        "{path} must be one of {}",
        format_enum_values(allowed)
    ))
}

fn value_matches_schema_type(value: &Value, expected_type: &str) -> bool {
    match expected_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value.as_f64().is_some_and(|number| number.fract() == 0.0)
        }
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn format_enum_values(values: &[Value]) -> String {
    values
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_expected_types(types: &[&str]) -> String {
    match types {
        [] => "valid".to_string(),
        [single] => format!("{} {single}", indefinite_article(single)),
        _ => {
            let mut formatted = types
                .iter()
                .map(|expected_type| {
                    format!("{} {expected_type}", indefinite_article(expected_type))
                })
                .collect::<Vec<_>>();
            let last = formatted.pop().unwrap_or_default();
            format!("{} or {last}", formatted.join(", "))
        }
    }
}

fn indefinite_article(word: &str) -> &'static str {
    match word.chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ => "a",
    }
}

fn permission_command_arg(args: &Value) -> Option<String> {
    ["cmd", "command"]
        .into_iter()
        .find_map(|key| args.get(key).and_then(Value::as_str).map(str::to_string))
}

fn permission_flags_for_tool(def: &ToolDefinition, command: Option<&str>) -> (bool, bool) {
    if matches!(def.name.as_str(), "execute_command" | "shell") {
        if let Some(command) = command {
            return (
                is_read_only_shell_command(command),
                is_destructive_shell_command(command),
            );
        }
    }
    (def.read_only, def.destructive)
}

fn is_read_only_shell_command(command: &str) -> bool {
    let first = command
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        first.as_str(),
        "cat"
            | "type"
            | "dir"
            | "ls"
            | "pwd"
            | "echo"
            | "rg"
            | "grep"
            | "find"
            | "git"
            | "npm"
            | "node"
            | "python"
            | "python3"
            | "where"
            | "which"
            | "get-childitem"
            | "get-content"
    )
}

fn is_destructive_shell_command(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    [
        "rm",
        "del",
        "erase",
        "remove-item",
        "rmdir",
        "rd",
        "git reset",
        "git clean",
        "format",
        "mkfs",
        "shutdown",
        "reboot",
    ]
    .into_iter()
    .any(|pattern| shell_command_contains_pattern(&normalized, pattern))
}

fn shell_command_contains_pattern(command: &str, pattern: &str) -> bool {
    let Some(start) = command.find(pattern) else {
        return false;
    };
    let before = command[..start].chars().last();
    let after = command[start + pattern.len()..].chars().next();
    before.is_none_or(|ch| !is_shell_word_char(ch))
        && after.is_none_or(|ch| !is_shell_word_char(ch))
}

fn is_shell_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

fn permission_path_arg(args: &Value) -> Option<String> {
    [
        "path",
        "filePath",
        "scriptPath",
        "inputPath",
        "outputPath",
        "queryPath",
        "outputDir",
        "outputRoot",
        "directory",
    ]
    .into_iter()
    .find_map(|key| args.get(key).and_then(Value::as_str).map(str::to_string))
}

pub fn object_schema(properties: Value, required: &[&str]) -> Value {
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

pub fn permissive_object_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": true
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn execution_context_serde_roundtrips_without_emitter() {
        // The events emitter is runtime-only: it must never appear in the
        // serialized form, and deserialization yields a disabled emitter.
        let ctx = ExecutionContext {
            agent_name: Some("aose".to_string()),
            metadata: serde_json::json!({ "tool_call_id": "c1" }),
            events: ToolEventEmitter::disabled(),
        };
        let json = serde_json::to_value(&ctx).unwrap();
        assert_eq!(json["agentName"], "aose");
        assert_eq!(json["metadata"]["tool_call_id"], "c1");
        assert!(json.get("events").is_none(), "emitter must not serialize");

        let back: ExecutionContext = serde_json::from_value(json).unwrap();
        assert_eq!(back.agent_name.as_deref(), Some("aose"));
        assert!(!back.events.is_active(), "deserialized emitter is disabled");
    }

    #[tokio::test]
    async fn tool_event_emitter_streams_to_channel() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let emitter = ToolEventEmitter::new(tx);
        assert!(emitter.is_active());
        emitter.emit("agent_spawned", serde_json::json!({ "name": "sub1" }));
        emitter.emit(
            "agent_finished",
            serde_json::json!({ "name": "sub1", "ok": true }),
        );
        let e1 = rx.recv().await.unwrap();
        assert_eq!(e1.kind, "agent_spawned");
        assert_eq!(e1.data["name"], "sub1");
        let e2 = rx.recv().await.unwrap();
        assert_eq!(e2.kind, "agent_finished");
        assert_eq!(e2.data["ok"], true);
    }

    #[test]
    fn disabled_emitter_is_noop() {
        // A disabled emitter must silently drop events (no panic, no channel).
        let emitter = ToolEventEmitter::disabled();
        assert!(!emitter.is_active());
        emitter.emit("agent_spawned", serde_json::json!({}));
    }

    struct RecordingChecker {
        requests: Arc<Mutex<Vec<PermissionCheckRequest>>>,
    }

    impl PermissionChecker for RecordingChecker {
        fn check(&self, request: PermissionCheckRequest) -> PermissionCheckDecision {
            self.requests.lock().unwrap().push(request);
            PermissionCheckDecision {
                behavior: PermissionBehavior::Allow,
                reason: None,
                rule: None,
                updated_args: None,
            }
        }
    }

    struct UpdatingChecker {
        updated_args: Value,
        requests: Arc<Mutex<Vec<PermissionCheckRequest>>>,
    }

    impl PermissionChecker for UpdatingChecker {
        fn check(&self, request: PermissionCheckRequest) -> PermissionCheckDecision {
            self.requests.lock().unwrap().push(request);
            PermissionCheckDecision {
                behavior: PermissionBehavior::Allow,
                reason: None,
                rule: None,
                updated_args: Some(self.updated_args.clone()),
            }
        }
    }

    struct AskChecker {
        requests: Arc<Mutex<Vec<PermissionCheckRequest>>>,
        reason: Option<String>,
        updated_args: Option<Value>,
    }

    impl PermissionChecker for AskChecker {
        fn check(&self, request: PermissionCheckRequest) -> PermissionCheckDecision {
            self.requests.lock().unwrap().push(request);
            PermissionCheckDecision {
                behavior: PermissionBehavior::Ask,
                reason: self.reason.clone(),
                rule: Some(serde_json::json!({ "id": "ask-rule" })),
                updated_args: self.updated_args.clone(),
            }
        }
    }

    struct StaticApprovalHandler {
        requests: Arc<Mutex<Vec<PermissionApprovalRequest>>>,
        decision: PermissionApprovalDecision,
    }

    #[async_trait]
    impl PermissionApprovalHandler for StaticApprovalHandler {
        async fn request_approval(
            &self,
            request: PermissionApprovalRequest,
        ) -> PermissionApprovalDecision {
            self.requests.lock().unwrap().push(request);
            self.decision.clone()
        }
    }

    fn test_ctx() -> ExecutionContext {
        ExecutionContext {
            agent_name: Some("test".to_string()),
            metadata: Value::Null,
            events: ::std::default::Default::default(),
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tool_def(name: &str, description: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: description.to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                },
                "required": ["query"]
            }),
            aliases: Vec::new(),
            operation: ToolOperation::Unknown,
            read_only: false,
            destructive: false,
            max_result_size_chars: None,
        }
    }

    #[test]
    fn pairs_tools_to_agent_like_utility() {
        let tools = vec![
            tool_def("search_web", "Search public web pages"),
            tool_def("write_file", "Create or update files"),
            tool_def("python_run", "Execute Python analysis"),
        ];

        let all = pair_tools_to_agent(&tools, &[]);
        assert_eq!(
            all.iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["search_web", "write_file", "python_run"]
        );

        let paired = pair_tools_to_agent(&tools, &["python".to_string(), "public web".to_string()]);
        assert_eq!(
            paired
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["search_web", "python_run"]
        );
    }

    #[test]
    fn ranks_tools_by_keyword_overlap_like_utility() {
        let tools = vec![
            tool_def("write_file", "Create files on disk"),
            tool_def("search_web", "Search the internet for pages"),
            tool_def("python", "Run Python code"),
            tool_def("python_plot", "Render Python plots"),
        ];

        let ranked = rank_tools_by_relevance(&tools, "python plot with python");
        assert_eq!(
            ranked
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["python", "python_plot", "write_file", "search_web"]
        );
    }

    #[test]
    fn formats_tools_for_provider_like_utility() {
        let tools = vec![tool_def("search_web", "Search public web pages")];

        let openai = format_tools_for_provider(&tools, "openai");
        assert_eq!(
            openai[0],
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": "search_web",
                    "description": "Search public web pages",
                    "parameters": tools[0].parameters
                }
            })
        );
        assert_eq!(format_tools_for_provider(&tools, "unknown"), openai);

        let anthropic = format_tools_for_provider(&tools, "anthropic");
        assert_eq!(
            anthropic[0],
            serde_json::json!({
                "name": "search_web",
                "description": "Search public web pages",
                "input_schema": tools[0].parameters
            })
        );

        let gemini = format_tools_for_provider(&tools, "gemini");
        assert_eq!(
            gemini,
            vec![serde_json::json!({
                "functionDeclarations": [{
                    "name": "search_web",
                    "description": "Search public web pages",
                    "parameters": tools[0].parameters
                }]
            })]
        );
    }

    #[tokio::test]
    async fn merge_later_tool_aliases_win_like_toolset() {
        let base = ToolSet::new();
        base.register(define_tool(
            "old_tool",
            "old",
            permissive_object_schema(),
            |_args, _ctx| async move { Ok("old".to_string()) },
        ))
        .unwrap();
        base.register_alias("shared_alias", "old_tool").unwrap();

        let incoming = ToolSet::new();
        incoming
            .register(define_tool(
                "new_tool",
                "new",
                permissive_object_schema(),
                |_args, _ctx| async move { Ok("new".to_string()) },
            ))
            .unwrap();
        incoming.register_alias("shared_alias", "new_tool").unwrap();

        base.merge(incoming);

        let result = base
            .execute("shared_alias", serde_json::json!({}), test_ctx())
            .await;
        assert_eq!(result.content, "new");
        assert!(base.has("old_tool"));
        assert!(base.has("new_tool"));
    }

    #[tokio::test]
    async fn registered_tool_definition_aliases_are_hidden_and_executable() {
        let tools = ToolSet::new();
        tools
            .register(define_tool_with_metadata_aliases_and_limit(
                "canonical_tool",
                "Canonical tool.",
                object_schema(
                    serde_json::json!({ "value": { "type": "string" } }),
                    &["value"],
                ),
                vec![
                    "canonical_alias".to_string(),
                    "canonical_shortcut".to_string(),
                ],
                ToolOperation::Read,
                true,
                false,
                None,
                |args, _ctx| async move {
                    Ok(args
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string())
                },
            ))
            .unwrap();

        assert!(tools.has("canonical_tool"));
        assert!(tools.has("canonical_alias"));
        assert!(tools.has("canonical_shortcut"));
        assert_eq!(tools.size(), 1);
        assert_eq!(
            tools
                .list()
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["canonical_tool"]
        );

        let result = tools
            .execute(
                "canonical_alias",
                serde_json::json!({ "value": "via-alias" }),
                test_ctx(),
            )
            .await;
        assert_eq!(result.content, "via-alias");
    }

    #[tokio::test]
    async fn cloned_toolsets_share_runtime_registry_but_snapshots_do_not() {
        let base = ToolSet::new();
        let runtime_view = base.clone();
        let rollback_snapshot = base.snapshot();

        base.register(define_tool(
            "dynamic_tool",
            "dynamic",
            permissive_object_schema(),
            |_args, _ctx| async move { Ok("dynamic".to_string()) },
        ))
        .unwrap();

        assert!(runtime_view.has("dynamic_tool"));
        assert!(!rollback_snapshot.has("dynamic_tool"));
        let result = runtime_view
            .execute("dynamic_tool", serde_json::json!({}), test_ctx())
            .await;
        assert_eq!(result.content, "dynamic");
    }

    #[tokio::test]
    async fn invalid_tool_input_returns_error_before_permission_and_execution() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let executed = Arc::new(Mutex::new(0usize));
        let tools = ToolSet::new();
        let executed_for_tool = executed.clone();
        tools
            .register(define_tool(
                "typed",
                "Typed input.",
                object_schema(
                    serde_json::json!({
                        "query": { "type": "string" },
                        "limit": { "type": "integer" },
                        "exact": { "type": "boolean" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "options": {
                            "type": "object",
                            "properties": {
                                "threshold": { "type": "number" }
                            }
                        }
                    }),
                    &["query"],
                ),
                move |_args, _ctx| {
                    let executed = executed_for_tool.clone();
                    async move {
                        *executed.lock().unwrap() += 1;
                        Ok("ok".to_string())
                    }
                },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(RecordingChecker {
            requests: requests.clone(),
        })));

        let result = tools
            .execute(
                "typed",
                serde_json::json!({
                    "query": "cells",
                    "limit": 5,
                    "exact": true,
                    "tags": ["rna", 42],
                    "options": { "threshold": 0.8 }
                }),
                ExecutionContext {
                    agent_name: Some("aose".to_string()),
                    metadata: serde_json::json!({ "tool_call_id": "call-invalid" }),
                    events: ::std::default::Default::default(),
                },
            )
            .await;

        assert_eq!(result.tool_call_id, "call-invalid");
        assert_eq!(result.metadata.unwrap()["errorCode"], "invalid_input");
        let body: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(body["error"], "input.tags[1] must be a string");
        assert!(requests.lock().unwrap().is_empty());
        assert_eq!(*executed.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn schema_constraints_return_error_before_permission_and_execution() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let executed = Arc::new(Mutex::new(0usize));
        let tools = ToolSet::new();
        let executed_for_tool = executed.clone();
        tools
            .register(define_tool(
                "constrained",
                "Constrained input.",
                object_schema(
                    serde_json::json!({
                        "positive": { "type": "integer", "minimum": 1 },
                        "ratio": { "type": "number", "minimum": 0, "maximum": 1 },
                        "name": { "type": "string", "minLength": 2, "maxLength": 4 },
                        "items": {
                            "type": "array",
                            "items": { "type": "string" },
                            "minItems": 1,
                            "maxItems": 2
                        }
                    }),
                    &["positive", "ratio", "name", "items"],
                ),
                move |_args, _ctx| {
                    let executed = executed_for_tool.clone();
                    async move {
                        *executed.lock().unwrap() += 1;
                        Ok("ok".to_string())
                    }
                },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(RecordingChecker {
            requests: requests.clone(),
        })));

        let cases = [
            (
                serde_json::json!({ "positive": 0, "ratio": 0.5, "name": "ok", "items": ["a"] }),
                "input.positive must be >= 1",
            ),
            (
                serde_json::json!({ "positive": 1, "ratio": 2, "name": "ok", "items": ["a"] }),
                "input.ratio must be <= 1",
            ),
            (
                serde_json::json!({ "positive": 1, "ratio": 0.5, "name": "x", "items": ["a"] }),
                "input.name must have at least 2 characters",
            ),
            (
                serde_json::json!({ "positive": 1, "ratio": 0.5, "name": "abcde", "items": ["a"] }),
                "input.name must have at most 4 characters",
            ),
            (
                serde_json::json!({ "positive": 1, "ratio": 0.5, "name": "ok", "items": [] }),
                "input.items must have at least 1 items",
            ),
            (
                serde_json::json!({ "positive": 1, "ratio": 0.5, "name": "ok", "items": ["a", "b", "c"] }),
                "input.items must have at most 2 items",
            ),
        ];

        for (args, expected_error) in cases {
            let result = tools.execute("constrained", args, test_ctx()).await;
            assert_eq!(result.metadata.unwrap()["errorCode"], "invalid_input");
            let body: Value = serde_json::from_str(&result.content).unwrap();
            assert_eq!(body["error"], expected_error);
        }

        assert!(requests.lock().unwrap().is_empty());
        assert_eq!(*executed.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn invalid_enum_input_returns_error_before_permission_and_execution() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let executed = Arc::new(Mutex::new(0usize));
        let tools = ToolSet::new();
        let executed_for_tool = executed.clone();
        tools
            .register(define_tool(
                "request",
                "Request.",
                object_schema(
                    serde_json::json!({
                        "method": {
                            "type": "string",
                            "enum": ["GET", "POST"]
                        }
                    }),
                    &["method"],
                ),
                move |_args, _ctx| {
                    let executed = executed_for_tool.clone();
                    async move {
                        *executed.lock().unwrap() += 1;
                        Ok("ok".to_string())
                    }
                },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(RecordingChecker {
            requests: requests.clone(),
        })));

        let result = tools
            .execute(
                "request",
                serde_json::json!({ "method": "PUT" }),
                test_ctx(),
            )
            .await;

        assert_eq!(result.metadata.unwrap()["errorCode"], "invalid_input");
        let body: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(
            body["error"],
            "input.method must be one of \"GET\", \"POST\""
        );
        assert!(requests.lock().unwrap().is_empty());
        assert_eq!(*executed.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn schema_defaults_are_applied_before_permission_and_execution() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let tools = ToolSet::new();
        tools
            .register(define_tool(
                "request",
                "Request.",
                object_schema(
                    serde_json::json!({
                        "method": {
                            "type": "string",
                            "enum": ["GET", "POST"],
                            "default": "GET"
                        },
                        "options": {
                            "type": "object",
                            "properties": {
                                "limit": { "type": "integer", "default": 10 }
                            }
                        }
                    }),
                    &[],
                ),
                |args, _ctx| async move { Ok(args.to_string()) },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(RecordingChecker {
            requests: requests.clone(),
        })));

        let result = tools
            .execute("request", serde_json::json!({ "options": {} }), test_ctx())
            .await;

        let permission_args = requests.lock().unwrap()[0].args.clone();
        assert_eq!(
            permission_args,
            serde_json::json!({ "method": "GET", "options": { "limit": 10 } })
        );
        let body: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(body, permission_args);
    }

    #[tokio::test]
    async fn validates_required_fields_null_empty_object_and_root_object_type() {
        let tools = ToolSet::new();
        tools
            .register(define_tool(
                "lookup",
                "Lookup.",
                object_schema(
                    serde_json::json!({ "query": { "type": "string" } }),
                    &["query"],
                ),
                |_args, _ctx| async move { Ok("ok".to_string()) },
            ))
            .unwrap();

        let missing = tools
            .execute("lookup", serde_json::json!({}), test_ctx())
            .await;
        assert_eq!(missing.metadata.unwrap()["errorCode"], "invalid_input");
        let missing_body: Value = serde_json::from_str(&missing.content).unwrap();
        assert_eq!(missing_body["error"], "input.query is required");

        let null_args = tools.execute("lookup", Value::Null, test_ctx()).await;
        assert_eq!(null_args.metadata.unwrap()["errorCode"], "invalid_input");
        let null_args_body: Value = serde_json::from_str(&null_args.content).unwrap();
        assert_eq!(null_args_body["error"], "input.query is required");

        let non_object = tools
            .execute("lookup", Value::String("query".to_string()), test_ctx())
            .await;
        assert_eq!(non_object.metadata.unwrap()["errorCode"], "invalid_input");
        let non_object_body: Value = serde_json::from_str(&non_object.content).unwrap();
        assert_eq!(non_object_body["error"], "input must be an object");
    }

    #[tokio::test]
    async fn permission_request_extracts_command_and_path_args() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let tools = ToolSet::new();
        tools
            .register(define_tool_with_metadata(
                "execute_command",
                "Execute command",
                permissive_object_schema(),
                ToolOperation::Execute,
                false,
                true,
                |_args, _ctx| async move { Ok("ok".to_string()) },
            ))
            .unwrap();
        tools
            .register(define_tool_with_metadata(
                "execute_script",
                "Execute script",
                permissive_object_schema(),
                ToolOperation::Execute,
                false,
                false,
                |_args, _ctx| async move { Ok("ok".to_string()) },
            ))
            .unwrap();
        tools
            .register(define_tool_with_metadata(
                "write_file",
                "Write file",
                permissive_object_schema(),
                ToolOperation::Write,
                false,
                true,
                |_args, _ctx| async move { Ok("ok".to_string()) },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(RecordingChecker {
            requests: requests.clone(),
        })));

        tools
            .execute(
                "execute_command",
                serde_json::json!({ "command": "printf hi" }),
                test_ctx(),
            )
            .await;
        tools
            .execute(
                "execute_command",
                serde_json::json!({ "command": "ls -la" }),
                test_ctx(),
            )
            .await;
        tools
            .execute(
                "execute_command",
                serde_json::json!({ "command": "rm out.txt" }),
                test_ctx(),
            )
            .await;
        tools
            .execute(
                "execute_script",
                serde_json::json!({ "scriptPath": "scripts/run.sh" }),
                test_ctx(),
            )
            .await;
        tools
            .execute(
                "write_file",
                serde_json::json!({ "path": "out.txt" }),
                test_ctx(),
            )
            .await;

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        assert_eq!(requests[0].tool_name, "execute_command");
        assert_eq!(requests[0].command.as_deref(), Some("printf hi"));
        assert_eq!(requests[0].path, None);
        assert_eq!(
            requests[0].args,
            serde_json::json!({ "command": "printf hi" })
        );
        assert_eq!(requests[0].agent_name.as_deref(), Some("test"));
        assert_eq!(requests[0].metadata, Value::Null);
        assert_eq!(requests[0].operation, ToolOperation::Execute);
        assert!(!requests[0].read_only);
        assert!(!requests[0].destructive);
        assert_eq!(requests[1].command.as_deref(), Some("ls -la"));
        assert!(requests[1].read_only);
        assert!(!requests[1].destructive);
        assert_eq!(requests[2].command.as_deref(), Some("rm out.txt"));
        assert!(!requests[2].read_only);
        assert!(requests[2].destructive);
        assert_eq!(requests[3].tool_name, "execute_script");
        assert_eq!(requests[3].command, None);
        assert_eq!(requests[3].path.as_deref(), Some("scripts/run.sh"));
        assert_eq!(requests[4].tool_name, "write_file");
        assert_eq!(requests[4].operation, ToolOperation::Write);
        assert_eq!(requests[4].path.as_deref(), Some("out.txt"));
        assert!(!requests[4].read_only);
        assert!(requests[4].destructive);
    }

    #[tokio::test]
    async fn permission_decision_updated_args_are_executed_like_toolset() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let tools = ToolSet::new();
        tools
            .register(define_tool(
                "echo_arg",
                "Echo argument",
                permissive_object_schema(),
                |args, _ctx| async move { Ok(args["value"].as_str().unwrap_or("").to_string()) },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(UpdatingChecker {
            updated_args: serde_json::json!({ "value": "rewritten" }),
            requests: requests.clone(),
        })));

        let result = tools
            .execute(
                "echo_arg",
                serde_json::json!({ "value": "original" }),
                ExecutionContext {
                    agent_name: Some("aose".to_string()),
                    metadata: serde_json::json!({ "tool_call_id": "call-1", "source": "test" }),
                    events: ::std::default::Default::default(),
                },
            )
            .await;

        assert_eq!(result.tool_call_id, "call-1");
        assert_eq!(result.content, "rewritten");
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].args, serde_json::json!({ "value": "original" }));
        assert_eq!(requests[0].agent_name.as_deref(), Some("aose"));
        assert_eq!(requests[0].metadata["source"], "test");
    }

    #[tokio::test]
    async fn ask_permission_without_approval_context_denies_without_execution() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let executed = Arc::new(Mutex::new(0usize));
        let tools = ToolSet::new();
        let executed_for_tool = executed.clone();
        tools
            .register(define_tool(
                "approval_echo",
                "Approval echo",
                permissive_object_schema(),
                move |args, _ctx| {
                    let executed = executed_for_tool.clone();
                    async move {
                        *executed.lock().unwrap() += 1;
                        Ok(args["value"].as_str().unwrap_or("").to_string())
                    }
                },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(AskChecker {
            requests: requests.clone(),
            reason: Some("approval required".to_string()),
            updated_args: None,
        })));

        let result = tools
            .execute(
                "approval_echo",
                serde_json::json!({ "value": "original" }),
                ExecutionContext {
                    agent_name: Some("aose".to_string()),
                    metadata: serde_json::json!({ "tool_call_id": "call-ask" }),
                    events: ::std::default::Default::default(),
                },
            )
            .await;

        assert_eq!(*executed.lock().unwrap(), 0);
        assert_eq!(requests.lock().unwrap().len(), 1);
        let body: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(body["error"], "approval required");
        let metadata = result.metadata.unwrap();
        assert_eq!(metadata["permission"], "ask");
        assert_eq!(metadata["rule"]["id"], "ask-rule");
    }

    #[tokio::test]
    async fn ask_permission_allow_once_executes_with_approval_context() {
        let permission_requests = Arc::new(Mutex::new(Vec::new()));
        let approval_requests = Arc::new(Mutex::new(Vec::new()));
        let tools = ToolSet::new();
        tools
            .register(define_tool(
                "approval_echo",
                "Approval echo",
                permissive_object_schema(),
                |args, _ctx| async move { Ok(args["value"].as_str().unwrap_or("").to_string()) },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(AskChecker {
            requests: permission_requests.clone(),
            reason: Some("approval required".to_string()),
            updated_args: Some(serde_json::json!({ "value": "checker-updated" })),
        })));
        let approval = Arc::new(StaticApprovalHandler {
            requests: approval_requests.clone(),
            decision: PermissionApprovalDecision {
                decision: PermissionApprovalDecisionKind::AllowOnce,
                reason: Some("approved".to_string()),
                updated_args: Some(serde_json::json!({ "value": "approval-updated" })),
            },
        });

        let result = tools
            .execute_with_approval(
                "approval_echo",
                serde_json::json!({ "value": "original" }),
                ExecutionContext {
                    agent_name: Some("aose".to_string()),
                    metadata: serde_json::json!({
                        "tool_call_id": "call-ask",
                        "source": "test"
                    }),
                    events: ::std::default::Default::default(),
                },
                Some(approval),
            )
            .await;

        assert_eq!(result.tool_call_id, "call-ask");
        assert_eq!(result.content, "approval-updated");
        assert_eq!(permission_requests.lock().unwrap().len(), 1);
        let approval_requests = approval_requests.lock().unwrap();
        assert_eq!(approval_requests.len(), 1);
        assert!(approval_requests[0].approval_id.starts_with("perm_"));
        assert_eq!(approval_requests[0].tool_call_id, "call-ask");
        assert_eq!(approval_requests[0].tool_name, "approval_echo");
        assert_eq!(
            approval_requests[0].args,
            serde_json::json!({ "value": "original" })
        );
        assert_eq!(approval_requests[0].agent_name.as_deref(), Some("aose"));
        assert_eq!(approval_requests[0].metadata["source"], "test");
        assert_eq!(
            approval_requests[0].reason.as_deref(),
            Some("approval required")
        );
        assert_eq!(
            approval_requests[0].rule.as_ref().unwrap()["id"],
            "ask-rule"
        );
    }

    #[tokio::test]
    async fn ask_permission_deny_does_not_execute_with_approval_context() {
        let permission_requests = Arc::new(Mutex::new(Vec::new()));
        let approval_requests = Arc::new(Mutex::new(Vec::new()));
        let executed = Arc::new(Mutex::new(0usize));
        let tools = ToolSet::new();
        let executed_for_tool = executed.clone();
        tools
            .register(define_tool(
                "approval_echo",
                "Approval echo",
                permissive_object_schema(),
                move |_args, _ctx| {
                    let executed = executed_for_tool.clone();
                    async move {
                        *executed.lock().unwrap() += 1;
                        Ok("executed".to_string())
                    }
                },
            ))
            .unwrap();
        tools.set_permission_checker(Some(Arc::new(AskChecker {
            requests: permission_requests.clone(),
            reason: Some("approval required".to_string()),
            updated_args: None,
        })));
        let approval = Arc::new(StaticApprovalHandler {
            requests: approval_requests.clone(),
            decision: PermissionApprovalDecision {
                decision: PermissionApprovalDecisionKind::Deny,
                reason: Some("user denied".to_string()),
                updated_args: None,
            },
        });

        let result = tools
            .execute_with_approval(
                "approval_echo",
                serde_json::json!({ "value": "original" }),
                test_ctx(),
                Some(approval),
            )
            .await;

        assert_eq!(*executed.lock().unwrap(), 0);
        assert_eq!(permission_requests.lock().unwrap().len(), 1);
        assert_eq!(approval_requests.lock().unwrap().len(), 1);
        let body: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(body["error"], "user denied");
        assert_eq!(result.metadata.unwrap()["permission"], "ask");
    }

    #[tokio::test]
    async fn stores_large_tool_results_like_toolset() {
        let result_dir = unique_temp_dir("aos-core-large-tool-result");
        let tools = ToolSet::new()
            .with_result_storage_dir(result_dir.clone())
            .with_default_max_result_size_chars(8);
        tools
            .register(define_tool_with_metadata(
                "huge",
                "Huge output",
                permissive_object_schema(),
                ToolOperation::Read,
                true,
                false,
                |_args, _ctx| async move { Ok("abcdefghijkl".to_string()) },
            ))
            .unwrap();

        let result = tools
            .execute("huge", serde_json::json!({}), test_ctx())
            .await;
        let body: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(body["preview"], "abcdefgh");
        assert_eq!(body["truncated"], true);
        assert_eq!(body["originalLength"], 12);
        let full_path = body["fullResultPath"].as_str().unwrap();
        assert!(full_path.contains("aos-core-large-tool-result"));
        assert_eq!(std::fs::read_to_string(full_path).unwrap(), "abcdefghijkl");

        let metadata = result.metadata.unwrap();
        assert_eq!(metadata["truncated"], true);
        assert_eq!(metadata["originalLength"], 12);
        assert_eq!(metadata["fullResultPath"], full_path);

        let _ = std::fs::remove_dir_all(result_dir);
    }

    #[test]
    fn tool_result_with_evidence_records() {
        let evidence1 = aose_schemas::EvidenceRecord::from_tool(
            "scanpy",
            "analysis_001",
            "PCA completed with 10 components",
            "2026-06-08T10:00:00Z",
        );
        let evidence2 = aose_schemas::EvidenceRecord::from_database(
            "GEO",
            "GSE12345",
            "Dataset contains 5000 cells",
            "2026-06-08T10:01:00Z",
            Some("https://ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE12345".to_string()),
        );

        let result = ToolResult::new("call-123", "Analysis complete")
            .add_evidence(evidence1.clone())
            .add_evidence(evidence2.clone());

        let retrieved = result.get_evidence();
        assert_eq!(retrieved.len(), 2);
        assert_eq!(retrieved[0].source_type, "scanpy");
        assert_eq!(retrieved[0].identifier, "analysis_001");
        assert_eq!(retrieved[1].source_type, "GEO");
        assert_eq!(retrieved[1].identifier, "GSE12345");

        let metadata = result.metadata.unwrap();
        assert!(metadata.get("evidence").is_some());
        assert!(metadata.get("evidence").unwrap().is_array());
    }

    #[test]
    fn tool_result_with_trace_steps() {
        let step1 = aose_schemas::TraceStep::success(
            "python_repl",
            serde_json::json!({"code": "import scanpy as sc"}),
            serde_json::json!({"success": true}),
            150,
            "2026-06-08T10:00:00Z",
        );
        let step2 = aose_schemas::TraceStep::success(
            "python_repl",
            serde_json::json!({"code": "adata = sc.read_h5ad('data.h5ad')"}),
            serde_json::json!({"shape": [5000, 2000]}),
            320,
            "2026-06-08T10:00:01Z",
        );

        let result = ToolResult::new("call-456", "Data loaded")
            .with_trace(step1.clone())
            .with_trace(step2.clone());

        let retrieved = result.get_trace();
        assert_eq!(retrieved.len(), 2);
        assert_eq!(retrieved[0].tool_name, "python_repl");
        assert_eq!(retrieved[0].latency_ms, 150);
        assert_eq!(retrieved[1].tool_name, "python_repl");
        assert_eq!(retrieved[1].latency_ms, 320);

        let metadata = result.metadata.unwrap();
        assert!(metadata.get("trace").is_some());
        assert!(metadata.get("trace").unwrap().is_array());
    }

    #[test]
    fn tool_result_with_evidence_and_trace() {
        let evidence = aose_schemas::EvidenceRecord::from_computation(
            "statistical_test",
            "ttest_001",
            "p-value: 0.001, significant difference detected",
            "2026-06-08T10:00:00Z",
        )
        .with_metadata("method", serde_json::json!("two-tailed t-test"))
        .with_metadata("alpha", serde_json::json!(0.05));

        let trace1 = aose_schemas::TraceStep::success(
            "python_repl",
            serde_json::json!({"code": "from scipy import stats"}),
            serde_json::json!({"success": true}),
            50,
            "2026-06-08T10:00:00Z",
        );
        let trace2 = aose_schemas::TraceStep::success(
            "python_repl",
            serde_json::json!({"code": "stats.ttest_ind(group1, group2)"}),
            serde_json::json!({"statistic": 3.45, "pvalue": 0.001}),
            120,
            "2026-06-08T10:00:01Z",
        );

        let result = ToolResult::new("call-789", "Statistical test completed")
            .add_evidence(evidence.clone())
            .with_traces(vec![trace1, trace2]);

        let retrieved_evidence = result.get_evidence();
        assert_eq!(retrieved_evidence.len(), 1);
        assert_eq!(retrieved_evidence[0].source_type, "statistical_test");
        assert_eq!(retrieved_evidence[0].metadata.len(), 2);

        let retrieved_trace = result.get_trace();
        assert_eq!(retrieved_trace.len(), 2);
        assert_eq!(
            retrieved_trace[0].status,
            aose_schemas::TraceStatus::Success
        );
        assert_eq!(
            retrieved_trace[1].status,
            aose_schemas::TraceStatus::Success
        );

        let metadata = result.metadata.unwrap();
        assert!(metadata.get("evidence").is_some());
        assert!(metadata.get("trace").is_some());
    }

    #[test]
    fn tool_result_batch_evidence() {
        let evidence_batch = vec![
            aose_schemas::EvidenceRecord::from_tool(
                "file_reader",
                "/data/experiment1.csv",
                "Read 1000 rows",
                "2026-06-08T10:00:00Z",
            ),
            aose_schemas::EvidenceRecord::from_tool(
                "file_reader",
                "/data/experiment2.csv",
                "Read 1500 rows",
                "2026-06-08T10:00:01Z",
            ),
            aose_schemas::EvidenceRecord::from_tool(
                "file_reader",
                "/data/experiment3.csv",
                "Read 800 rows",
                "2026-06-08T10:00:02Z",
            ),
        ];

        let result =
            ToolResult::new("call-batch", "Loaded 3 datasets").with_evidence(evidence_batch);

        let retrieved = result.get_evidence();
        assert_eq!(retrieved.len(), 3);
        assert_eq!(retrieved[0].identifier, "/data/experiment1.csv");
        assert_eq!(retrieved[1].identifier, "/data/experiment2.csv");
        assert_eq!(retrieved[2].identifier, "/data/experiment3.csv");
    }

    #[test]
    fn tool_result_empty_evidence_and_trace() {
        let result = ToolResult::new("call-empty", "No metadata");

        assert!(result.get_evidence().is_empty());
        assert!(result.get_trace().is_empty());
        assert!(result.metadata.is_none());
    }

    #[test]
    fn tool_result_evidence_accumulation() {
        let evidence1 = aose_schemas::EvidenceRecord::from_tool(
            "tool1",
            "id1",
            "content1",
            "2026-06-08T10:00:00Z",
        );
        let evidence2 = aose_schemas::EvidenceRecord::from_tool(
            "tool2",
            "id2",
            "content2",
            "2026-06-08T10:00:01Z",
        );
        let evidence3 = aose_schemas::EvidenceRecord::from_tool(
            "tool3",
            "id3",
            "content3",
            "2026-06-08T10:00:02Z",
        );

        let result = ToolResult::new("call-accum", "Result")
            .add_evidence(evidence1)
            .add_evidence(evidence2)
            .add_evidence(evidence3);

        let retrieved = result.get_evidence();
        assert_eq!(retrieved.len(), 3);
        assert_eq!(retrieved[0].source_type, "tool1");
        assert_eq!(retrieved[1].source_type, "tool2");
        assert_eq!(retrieved[2].source_type, "tool3");
    }

    #[test]
    fn tool_result_trace_accumulation() {
        let step1 = aose_schemas::TraceStep::success(
            "step1",
            serde_json::json!({"input": 1}),
            serde_json::json!({"output": 1}),
            100,
            "2026-06-08T10:00:00Z",
        );
        let step2 = aose_schemas::TraceStep::success(
            "step2",
            serde_json::json!({"input": 2}),
            serde_json::json!({"output": 2}),
            200,
            "2026-06-08T10:00:01Z",
        );

        let result = ToolResult::new("call-trace-accum", "Result")
            .with_trace(step1)
            .with_trace(step2);

        let retrieved = result.get_trace();
        assert_eq!(retrieved.len(), 2);
        assert_eq!(retrieved[0].tool_name, "step1");
        assert_eq!(retrieved[1].tool_name, "step2");
    }

    #[test]
    fn tool_result_evidence_error_trace() {
        let evidence = aose_schemas::EvidenceRecord::from_tool(
            "python_repl",
            "exec_failed_001",
            "Attempted to divide by zero",
            "2026-06-08T10:00:00Z",
        );

        let error_trace = aose_schemas::TraceStep::error(
            "python_repl",
            serde_json::json!({"code": "1 / 0"}),
            "ZeroDivisionError: division by zero",
            50,
            "2026-06-08T10:00:00Z",
        );

        let result = ToolResult::new("call-error", "Execution failed")
            .add_evidence(evidence)
            .with_trace(error_trace);

        let retrieved_trace = result.get_trace();
        assert_eq!(retrieved_trace.len(), 1);
        assert_eq!(retrieved_trace[0].status, aose_schemas::TraceStatus::Error);
        assert!(retrieved_trace[0].error.is_some());
        assert_eq!(
            retrieved_trace[0].error.as_ref().unwrap(),
            "ZeroDivisionError: division by zero"
        );
    }

    #[test]
    fn compress_preview_keeps_json_schema_and_tail() {
        let rows: Vec<Value> = (0..500)
            .map(|i| serde_json::json!({ "gene": format!("G{i}"), "evalue": i }))
            .collect();
        let content = serde_json::to_string(&Value::Array(rows)).unwrap();
        let preview = compress_preview(&content, 1_000);
        assert!(preview.chars().count() <= 1_000);
        assert!(preview.contains("with 500 items"));
        assert!(preview.contains("fields:"));
        assert!(preview.contains("gene"));
        // rank-preserved tail: last item must survive
        assert!(preview.contains("G499"));
        assert!(preview.contains("fullResultPath"));
    }

    #[test]
    fn compress_preview_handles_rows_envelope() {
        let rows: Vec<Value> = (0..200).map(|i| serde_json::json!({ "id": i })).collect();
        let content =
            serde_json::to_string(&serde_json::json!({ "rows": rows, "rowCount": 200 })).unwrap();
        let preview = compress_preview(&content, 800);
        assert!(preview.chars().count() <= 800);
        assert!(preview.contains("with 200 items"));
    }

    #[test]
    fn compress_preview_keeps_tsv_header() {
        let mut content = String::from("chrom\tpos\tref\talt\n");
        for i in 0..300 {
            content.push_str(&format!("chr1\t{i}\tA\tT\n"));
        }
        let preview = compress_preview(&content, 1_000);
        assert!(preview.chars().count() <= 1_000);
        assert!(preview.contains("header: chrom\tpos\tref\talt"));
        assert!(preview.contains("data rows"));
    }

    #[test]
    fn compress_preview_summarizes_fasta() {
        let mut content = String::new();
        for i in 0..50 {
            content.push_str(&format!(">seq{i} description here\n"));
            content.push_str(&"ACGT".repeat(60));
            content.push('\n');
        }
        let preview = compress_preview(&content, 2_000);
        assert!(preview.contains("FASTA with 50 sequences"));
        assert!(preview.contains("len=240"));
        assert!(!preview.contains(&"ACGT".repeat(60)));
    }

    #[test]
    fn compress_preview_falls_back_to_head_slice() {
        let content = "x".repeat(10_000);
        let preview = compress_preview(&content, 100);
        assert_eq!(preview.chars().count(), 100);
        assert!(preview.chars().all(|c| c == 'x'));
    }

    #[test]
    fn compress_preview_bounds_single_oversized_row() {
        // A single huge object must not blow the budget — full data is on disk.
        let rows = vec![
            serde_json::json!({ "blob": "z".repeat(50_000) }),
            serde_json::json!({ "blob": "y".repeat(50_000) }),
        ];
        let content = serde_json::to_string(&Value::Array(rows)).unwrap();
        let preview = compress_preview(&content, 500);
        assert!(preview.chars().count() <= 500);
    }

    #[test]
    fn compress_preview_ignores_prose_with_commas() {
        // Prose should not be mistaken for a CSV table.
        let mut content = String::new();
        for _ in 0..40 {
            content.push_str("Hello, world, this sentence, has commas, in it.\n");
        }
        content.push_str(&"and a long tail ".repeat(2_000));
        let preview = compress_preview(&content, 1_000);
        assert!(preview.chars().count() <= 1_000);
        // Falls back to head-slice, not a bogus "delimited table" header.
        assert!(!preview.contains("delimited table"));
    }

    #[test]
    fn compress_preview_passthrough_when_small() {
        let content = "small enough";
        assert_eq!(compress_preview(content, 1_000), content);
    }
}
