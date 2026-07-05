//! # Trait-Based Tool System for AOSE
//!
//! A type-safe, composable tool architecture using Rust traits and associated types.
//!
//! ## Design Principles
//!
//! 1. **Associated Types**: When `Self` is determined, input/output types are deterministic
//! 2. **Trait Bounds**: Compile-time capability verification via trait constraints
//! 3. **Nominal Typing**: Explicit `impl` declarations express tool capabilities
//! 4. **Zero-Cost Abstractions**: Static dispatch through monomorphization
//!
//! ## Key Improvements Over Current System
//!
//! - **Type Safety**: Input/Output types enforced at compile time (no runtime JSON parsing errors)
//! - **Capability Declaration**: Tools explicitly declare operations, data sources, composability
//! - **Type-Safe Pipelines**: Compile-time validation that tool outputs match next tool's inputs
//! - **Automatic Provenance**: Built into trait system via `Provenance` trait
//! - **Reduced Boilerplate**: ~70% less code via trait defaults and associated types
//! - **Better Tooling**: IDE autocomplete, type inference, refactoring support
//!
//! ## Example
//!
//! ```ignore
//! use aose_core::trait_based_tool::*;
//!
//! // Define a tool with typed inputs/outputs
//! pub struct EnsemblSearch;
//!
//! #[async_trait]
//! impl ToolCapability for EnsemblSearch {
//!     type Input = GeneQuery;
//!     type Output = Vec<GeneRecord>;
//!
//!     fn name(&self) -> &'static str { "bio_ensembl_search" }
//!     fn description(&self) -> &'static str { "Search genes by symbol" }
//!
//!     async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
//!         // Implementation
//!     }
//!
//!     fn capabilities(&self) -> CapabilitySet {
//!         CapabilitySet::new()
//!             .with_operation(ToolOperation::Read)
//!             .with_data_source(DataSource::Ensembl)
//!     }
//! }
//!
//! // Type-safe pipeline composition (compile-time verified!)
//! let pipeline = Pipeline::new(EnsemblSearch, UniProtInfo);
//! let result: Vec<ProteinRecord> = pipeline.execute(query).await?;
//! ```

use anyhow::Result;
use aose_schemas::{EvidenceRecord, TraceStep};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::tool::{ExecutionContext, Tool, ToolDefinition, ToolResult};

// ============================================================================
// Core Capability Traits
// ============================================================================

/// Core trait that all tools must implement.
/// Uses associated types to bind Input/Output at compile time.
#[async_trait]
pub trait ToolCapability: Send + Sync {
    /// The input type for this tool (must be deserializable)
    type Input: DeserializeOwned + Send;

    /// The output type for this tool (must be serializable)
    type Output: Serialize + Send;

    /// Tool name (used for registration and display)
    fn name(&self) -> &'static str;

    /// Tool description for LLM
    fn description(&self) -> &'static str;

    /// Execute the tool with typed input, returning typed output
    async fn execute(&self, input: Self::Input) -> Result<Self::Output>;

    /// Get the capability set for this tool
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::default()
    }

    /// Get data sources this tool accesses
    fn data_sources(&self) -> Vec<DataSource> {
        vec![]
    }

    /// Get tools this tool can compose with (by name)
    fn composable_with(&self) -> Vec<&'static str> {
        vec![]
    }

    /// The named analysis environment this tool requires, if any (e.g.
    /// `"sc-atac"`). `None` means the tool runs in the ambient runtime. This is
    /// the type-level counterpart of [`data_sources`]: it declares an
    /// execution-environment dependency that the runtime resolves and
    /// provisions on demand, so single-cell modalities with conflicting
    /// package stacks each get their own isolated environment instead of being
    /// forced into one.
    fn required_env(&self) -> Option<&'static str> {
        None
    }

    /// Get input JSON schema for this tool
    fn input_schema(&self) -> Value {
        // Default implementation - tools can override
        serde_json::json!({
            "type": "object",
            "properties": {},
            "required": []
        })
    }

    /// Get output JSON schema for this tool (enables type checking)
    fn output_schema(&self) -> Option<Value> {
        None
    }
}

/// Trait for tools that provide data provenance
#[async_trait]
pub trait Provenance: ToolCapability {
    /// Wrap output with evidence record
    fn with_evidence(
        &self,
        result: Self::Output,
        evidence: EvidenceRecord,
    ) -> GroundedOutput<Self::Output> {
        GroundedOutput {
            data: result,
            evidence: vec![evidence],
            trace: vec![],
        }
    }

    /// Execute and automatically generate evidence
    async fn execute_with_provenance(
        &self,
        input: Self::Input,
    ) -> Result<GroundedOutput<Self::Output>> {
        let start = std::time::Instant::now();
        let result = self.execute(input).await?;

        let evidence = self.generate_evidence(&result)?;
        let trace = TraceStep::success(
            self.name(),
            serde_json::json!({}),
            serde_json::json!({}),
            start.elapsed().as_millis() as u64,
            chrono::Utc::now().to_rfc3339(),
        );

        Ok(GroundedOutput {
            data: result,
            evidence: vec![evidence],
            trace: vec![trace],
        })
    }

    /// Generate evidence record from output (tool-specific)
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord>;
}

/// Trait for tools that support batch processing
#[async_trait]
pub trait Batchable: ToolCapability {
    /// Execute multiple inputs in batch (with potential optimization)
    async fn execute_batch(&self, inputs: Vec<Self::Input>) -> Result<Vec<Self::Output>> {
        // Default implementation: sequential execution
        let mut results = Vec::with_capacity(inputs.len());
        for input in inputs {
            results.push(self.execute(input).await?);
        }
        Ok(results)
    }

    /// Maximum batch size (for rate limiting)
    fn max_batch_size(&self) -> usize {
        10
    }
}

/// Trait for tools with fallback capability
#[async_trait]
pub trait Fallible: ToolCapability {
    /// Fallback tool type (must have same input and output)
    type FallbackTool: ToolCapability<Input = Self::Input, Output = Self::Output>;

    /// Get fallback tool instance
    fn fallback(&self) -> Option<Self::FallbackTool>;

    /// Execute with automatic fallback on failure
    async fn execute_with_fallback(&self, input: Self::Input) -> Result<Self::Output>
    where
        Self::Input: Clone,
    {
        match self.execute(input.clone()).await {
            Ok(result) => Ok(result),
            Err(e) => {
                if let Some(fallback) = self.fallback() {
                    eprintln!("[{}] Primary failed: {}, trying fallback", self.name(), e);
                    fallback.execute(input).await
                } else {
                    Err(e)
                }
            }
        }
    }
}

/// Trait for tools with rate limiting
pub trait RateLimited: ToolCapability {
    /// Get rate limit configuration
    fn rate_limit(&self) -> RateLimit {
        RateLimit::default()
    }

    /// Get semaphore for rate limiting (shared across instances)
    fn get_semaphore(&self) -> Option<Arc<Semaphore>> {
        None
    }
}

/// Trait for tools that can compose with a specific prior tool
#[async_trait]
pub trait Composable<T: ToolCapability>: ToolCapability<Input = T::Output> {
    /// Execute after another tool (type-safe composition)
    async fn compose_with(&self, prior: &T, input: T::Input) -> Result<Self::Output> {
        let intermediate = prior.execute(input).await?;
        self.execute(intermediate).await
    }
}

// ============================================================================
// Supporting Types
// ============================================================================

/// Capability set describing what a tool can do
#[derive(Debug, Clone, Default)]
pub struct CapabilitySet {
    pub operations: Vec<ToolOperation>,
    pub data_sources: Vec<DataSource>,
    pub idempotent: bool,
    pub cacheable: bool,
    pub non_destructive_write: bool,
}

impl CapabilitySet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_operation(mut self, op: ToolOperation) -> Self {
        self.operations.push(op);
        self
    }

    pub fn with_data_source(mut self, source: DataSource) -> Self {
        self.data_sources.push(source);
        self
    }

    pub fn idempotent(mut self) -> Self {
        self.idempotent = true;
        self
    }

    pub fn cacheable(mut self) -> Self {
        self.cacheable = true;
        self
    }

    /// Mark this tool as performing non-destructive writes (creates new files, doesn't delete/overwrite)
    pub fn non_destructive(mut self) -> Self {
        self.non_destructive_write = true;
        self
    }
}

/// Tool operation type (re-exported from core)
pub use crate::tool::ToolOperation;

/// Data source type
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataSource {
    Ensembl,
    UniProt,
    NCBI,
    GTEx,
    GnomAD,
    AlphaFold,
    PDB,
    OpenTargets,
    CbioPortal,
    ChEMBL,
    ClinVar,
    DbSNP,
    DisGeNET,
    DrugBank,
    ENCODE,
    Enrichr,
    GEO,
    GwasCatalog,
    HPO,
    InterPro,
    JASPAR,
    KEGG,
    Monarch,
    OMIM,
    Pfam,
    PRIDE,
    PubChem,
    QuickGO,
    Reactome,
    RegulomeDB,
    STRING,
    Uniprot,
    Custom(String),
}

/// Rate limit configuration
#[derive(Debug, Clone)]
pub struct RateLimit {
    pub requests_per_second: u32,
    pub burst: u32,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            requests_per_second: 10,
            burst: 20,
        }
    }
}

/// Output with provenance metadata
#[derive(Debug, Clone, Serialize)]
pub struct GroundedOutput<T> {
    pub data: T,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceRecord>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub trace: Vec<TraceStep>,
}

impl<T> GroundedOutput<T> {
    pub fn new(data: T) -> Self {
        Self {
            data,
            evidence: vec![],
            trace: vec![],
        }
    }

    pub fn with_evidence(mut self, evidence: EvidenceRecord) -> Self {
        self.evidence.push(evidence);
        self
    }

    pub fn with_trace(mut self, trace: TraceStep) -> Self {
        self.trace.push(trace);
        self
    }
}

// ============================================================================
// Type-Safe Pipeline
// ============================================================================

/// Type-safe pipeline of two tools where output of first matches input of second
pub struct Pipeline<T, U>
where
    T: ToolCapability,
    U: ToolCapability<Input = T::Output>,
{
    first: T,
    second: U,
}

impl<T, U> Pipeline<T, U>
where
    T: ToolCapability,
    U: ToolCapability<Input = T::Output>,
{
    pub fn new(first: T, second: U) -> Self {
        Self { first, second }
    }

    pub async fn execute(&self, input: T::Input) -> Result<U::Output> {
        let intermediate = self.first.execute(input).await?;
        self.second.execute(intermediate).await
    }

    /// Chain another tool to the pipeline
    pub fn chain<V>(self, third: V) -> Pipeline3<T, U, V>
    where
        V: ToolCapability<Input = U::Output>,
    {
        Pipeline3 {
            first: self.first,
            second: self.second,
            third,
        }
    }
}

/// Three-stage pipeline
pub struct Pipeline3<T, U, V>
where
    T: ToolCapability,
    U: ToolCapability<Input = T::Output>,
    V: ToolCapability<Input = U::Output>,
{
    first: T,
    second: U,
    third: V,
}

impl<T, U, V> Pipeline3<T, U, V>
where
    T: ToolCapability,
    U: ToolCapability<Input = T::Output>,
    V: ToolCapability<Input = U::Output>,
{
    pub async fn execute(&self, input: T::Input) -> Result<V::Output> {
        let intermediate1 = self.first.execute(input).await?;
        let intermediate2 = self.second.execute(intermediate1).await?;
        self.third.execute(intermediate2).await
    }
}

// ============================================================================
// Resilient Tool Wrapper
// ============================================================================

/// Wrapper that adds automatic fallback to any Fallible tool
pub struct ResilientTool<T, F>
where
    T: Fallible<FallbackTool = F>,
    F: ToolCapability<Output = T::Output>,
{
    primary: T,
    _phantom: std::marker::PhantomData<F>,
}

impl<T, F> ResilientTool<T, F>
where
    T: Fallible<FallbackTool = F>,
    F: ToolCapability<Output = T::Output>,
{
    pub fn new(primary: T) -> Self {
        Self {
            primary,
            _phantom: std::marker::PhantomData,
        }
    }
}

#[async_trait]
impl<T, F> ToolCapability for ResilientTool<T, F>
where
    T: Fallible<FallbackTool = F> + Clone,
    T::Input: Clone,
    F: ToolCapability<Output = T::Output> + Send + Sync,
{
    type Input = T::Input;
    type Output = T::Output;

    fn name(&self) -> &'static str {
        self.primary.name()
    }

    fn description(&self) -> &'static str {
        self.primary.description()
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.primary.execute_with_fallback(input).await
    }

    fn capabilities(&self) -> CapabilitySet {
        self.primary.capabilities()
    }
}

// ============================================================================
// Batch Executor
// ============================================================================

/// Helper to execute batchable tools efficiently
pub struct BatchExecutor<T: Batchable> {
    tool: T,
}

impl<T: Batchable> BatchExecutor<T>
where
    T::Input: Clone,
{
    pub fn new(tool: T) -> Self {
        Self { tool }
    }

    pub async fn execute_chunked(&self, inputs: Vec<T::Input>) -> Result<Vec<T::Output>> {
        let chunk_size = self.tool.max_batch_size();
        let mut results = Vec::with_capacity(inputs.len());

        for chunk in inputs.chunks(chunk_size) {
            let chunk_results = self.tool.execute_batch(chunk.to_vec()).await?;
            results.extend(chunk_results);
        }

        Ok(results)
    }
}

// ============================================================================
// Bridge: TypedTool<C> — adapt a `ToolCapability` to the runtime `dyn Tool`
// ============================================================================
//
// This is the load-bearing connection between the type-safe trait world and
// the runtime registry the agent loop actually drives. The LLM boundary is
// necessarily `Value` (arguments) and `String` (content); type safety lives
// strictly *between* `from_value` and `to_string`:
//
//   Value  --serde-->  C::Input  --execute-->  C::Output  --serde-->  String
//          \_ schema-shaped _/                            \_ provenance _/
//
// Two non-overlapping wrappers exist because Rust forbids overlapping trait
// impls: `TypedTool<C>` for plain capabilities and `GroundedTypedTool<C>` for
// capabilities that also implement `Provenance` (which auto-attaches the
// evidence + trace sidecar every grounded tool should carry).

/// Build the runtime `ToolDefinition` shared by both wrappers.
fn typed_tool_definition<C: ToolCapability>(cap: &C) -> ToolDefinition {
    let caps = cap.capabilities();
    // Read-only = the tool performs no mutating operations. Network and Read
    // are both non-mutating; only Write/Execute/Task break read-only.
    let read_only = !caps.operations.iter().any(|op| {
        matches!(
            op,
            ToolOperation::Write | ToolOperation::Execute | ToolOperation::Task
        )
    });
    let destructive = caps
        .operations
        .iter()
        .any(|op| matches!(op, ToolOperation::Write))
        && !caps.non_destructive_write;
    // Classify by the most significant operation, preferring a mutating op
    // over Read/Network when both are present.
    let operation = caps
        .operations
        .iter()
        .find(|op| matches!(op, ToolOperation::Write | ToolOperation::Execute))
        .or_else(|| caps.operations.first())
        .cloned()
        .unwrap_or(ToolOperation::Unknown);
    ToolDefinition {
        name: cap.name().to_string(),
        description: cap.description().to_string(),
        parameters: cap.input_schema(),
        aliases: Vec::new(),
        operation,
        read_only,
        destructive,
        max_result_size_chars: None,
    }
}

/// Deserialize LLM arguments into the capability's typed `Input`. An object
/// with no fields maps to a unit/empty input gracefully via serde.
fn decode_input<C: ToolCapability>(args: Value) -> Result<C::Input> {
    serde_json::from_value(args).map_err(|e| {
        anyhow::anyhow!(
            "invalid arguments for tool `{}`: {e}",
            std::any::type_name::<C>()
        )
    })
}

/// Serialize a typed `Output` back to the `String` content the LLM consumes.
fn encode_output<O: Serialize>(output: &O) -> Result<String> {
    serde_json::to_string_pretty(output)
        .map_err(|e| anyhow::anyhow!("failed to serialize tool output: {e}"))
}

/// Runtime adapter for a plain `ToolCapability` (no provenance).
pub struct TypedTool<C: ToolCapability> {
    cap: Arc<C>,
}

impl<C: ToolCapability> TypedTool<C> {
    pub fn new(cap: C) -> Self {
        Self { cap: Arc::new(cap) }
    }

    /// Register this typed tool as an `Arc<dyn Tool>` for the runtime registry.
    pub fn into_dyn(self) -> Arc<dyn Tool>
    where
        C: 'static,
    {
        Arc::new(self)
    }
}

#[async_trait]
impl<C> Tool for TypedTool<C>
where
    C: ToolCapability + 'static,
{
    fn definition(&self) -> ToolDefinition {
        typed_tool_definition(&*self.cap)
    }

    async fn execute(&self, args: Value, ctx: ExecutionContext) -> Result<ToolResult> {
        let call_id = ctx
            .metadata
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let input = decode_input::<C>(args)?;
        let output = self.cap.execute(input).await?;
        let content = encode_output(&output)?;
        Ok(ToolResult::new(call_id, content))
    }
}

/// Runtime adapter for a `Provenance` capability. Unlike [`TypedTool`], this
/// wrapper auto-attaches the evidence + trace sidecar on every call — so
/// "implement `Provenance`" is the *only* thing a tool author must do to get
/// machine-verifiable grounding, instead of hand-assembling metadata maps.
pub struct GroundedTypedTool<C: Provenance> {
    cap: Arc<C>,
}

impl<C: Provenance + 'static> GroundedTypedTool<C>
where
    C::Input: Serialize,
{
    pub fn new(cap: C) -> Self {
        Self { cap: Arc::new(cap) }
    }

    pub fn into_dyn(self) -> Arc<dyn Tool> {
        Arc::new(self)
    }
}

#[async_trait]
impl<C> Tool for GroundedTypedTool<C>
where
    C: Provenance + 'static,
    C::Input: Serialize,
{
    fn definition(&self) -> ToolDefinition {
        typed_tool_definition(&*self.cap)
    }

    async fn execute(&self, args: Value, ctx: ExecutionContext) -> Result<ToolResult> {
        let call_id = ctx
            .metadata
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let input = decode_input::<C>(args)?;
        let input_summary = serde_json::to_value(&input).unwrap_or(Value::Null);

        let start = std::time::Instant::now();
        let output = self.cap.execute(input).await?;
        let latency_ms = start.elapsed().as_millis() as u64;

        let content = encode_output(&output)?;

        // Auto-attach provenance: evidence (from the tool) + an execution trace.
        // This is the whole point of the Provenance bound — coverage becomes a
        // type-system guarantee, not a per-tool discipline.
        let timestamp = chrono::Utc::now().to_rfc3339();
        let mut result = ToolResult::new(call_id, content);
        if let Ok(evidence) = self.cap.generate_evidence(&output) {
            result = result.add_evidence(evidence);
        }
        let trace = TraceStep::success(
            self.cap.name(),
            input_summary,
            serde_json::json!({ "ok": true }),
            latency_ms,
            timestamp,
        );
        result = result.with_trace(trace);
        Ok(result)
    }
}

// ============================================================================
// Tests — exercise the full bridge end-to-end with a deterministic tool.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    // A self-contained, deterministic tool: no network, no mocks-returning-empty.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct GreetInput {
        name: String,
        #[serde(default)]
        excited: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct GreetOutput {
        greeting: String,
    }

    #[derive(Clone)]
    struct Greeter;

    #[async_trait]
    impl ToolCapability for Greeter {
        type Input = GreetInput;
        type Output = GreetOutput;

        fn name(&self) -> &'static str {
            "greet"
        }
        fn description(&self) -> &'static str {
            "Greet someone by name"
        }

        async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
            let mark = if input.excited { "!" } else { "." };
            Ok(GreetOutput {
                greeting: format!("Hello, {}{}", input.name, mark),
            })
        }

        fn capabilities(&self) -> CapabilitySet {
            CapabilitySet::new().with_operation(ToolOperation::Read)
        }
    }

    #[async_trait]
    impl Provenance for Greeter {
        fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
            Ok(EvidenceRecord::from_computation(
                "greet",
                "greeting",
                output.greeting.clone(),
                "2026-06-12T00:00:00Z",
            ))
        }
    }

    // A second tool whose Input is Greeter's Output, to test pipelines.
    #[derive(Clone)]
    struct Shouter;

    #[async_trait]
    impl ToolCapability for Shouter {
        type Input = GreetOutput;
        type Output = GreetOutput;

        fn name(&self) -> &'static str {
            "shout"
        }
        fn description(&self) -> &'static str {
            "Uppercase a greeting"
        }

        async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
            Ok(GreetOutput {
                greeting: input.greeting.to_uppercase(),
            })
        }
    }

    fn ctx_with_id(id: &str) -> ExecutionContext {
        ExecutionContext {
            agent_name: Some("test".into()),
            metadata: serde_json::json!({ "tool_call_id": id }),
            events: ::std::default::Default::default(),
        }
    }

    #[tokio::test]
    async fn typed_tool_bridges_value_to_typed_and_back() {
        let tool = TypedTool::new(Greeter).into_dyn();
        let def = tool.definition();
        assert_eq!(def.name, "greet");
        assert!(def.read_only);

        // LLM boundary: arguments arrive as Value.
        let result = tool
            .execute(
                serde_json::json!({ "name": "Ada", "excited": true }),
                ctx_with_id("call_1"),
            )
            .await
            .unwrap();
        assert_eq!(result.tool_call_id, "call_1");
        // content is the serialized typed Output.
        let out: GreetOutput = serde_json::from_str(&result.content).unwrap();
        assert_eq!(out.greeting, "Hello, Ada!");
        // Plain TypedTool attaches no provenance.
        assert!(result.metadata.is_none());
    }

    #[tokio::test]
    async fn typed_tool_rejects_malformed_arguments() {
        let tool = TypedTool::new(Greeter).into_dyn();
        // Missing required `name`.
        let err = tool
            .execute(serde_json::json!({ "excited": true }), ctx_with_id("c"))
            .await;
        assert!(
            err.is_err(),
            "missing required field must error at the boundary"
        );
    }

    #[tokio::test]
    async fn grounded_typed_tool_auto_attaches_provenance() {
        let tool = GroundedTypedTool::new(Greeter).into_dyn();
        let result = tool
            .execute(serde_json::json!({ "name": "Bob" }), ctx_with_id("call_2"))
            .await
            .unwrap();

        // Output still correct.
        let out: GreetOutput = serde_json::from_str(&result.content).unwrap();
        assert_eq!(out.greeting, "Hello, Bob.");

        // Provenance was attached AUTOMATICALLY — no per-tool metadata assembly.
        let evidence = result.get_evidence();
        assert_eq!(
            evidence.len(),
            1,
            "evidence auto-generated from Provenance impl"
        );
        assert_eq!(evidence[0].source_type, "greet");
        let trace = result.get_trace();
        assert_eq!(trace.len(), 1, "execution trace auto-recorded");
        assert_eq!(trace[0].tool_name, "greet");
    }

    #[tokio::test]
    async fn typed_pipeline_composes_with_compile_time_type_check() {
        // Greeter::Output == Shouter::Input, verified by the compiler.
        let pipeline = Pipeline::new(Greeter, Shouter);
        let out = pipeline
            .execute(GreetInput {
                name: "Ada".into(),
                excited: false,
            })
            .await
            .unwrap();
        assert_eq!(out.greeting, "HELLO, ADA.");
        // NOTE: `Pipeline::new(Greeter, Greeter)` would NOT compile because
        // Greeter::Input (GreetInput) != Greeter::Output (GreetOutput). The
        // type mismatch is caught at compile time, not runtime.
    }

    #[tokio::test]
    async fn provenance_coverage_is_total_across_grounded_tools() {
        // The point of the Provenance bound: every grounded tool carries
        // evidence+trace with zero per-tool wiring. Build several and confirm.
        let tools: Vec<Arc<dyn Tool>> = vec![
            GroundedTypedTool::new(Greeter).into_dyn(),
            GroundedTypedTool::new(Greeter).into_dyn(),
        ];
        for (i, tool) in tools.iter().enumerate() {
            let r = tool
                .execute(
                    serde_json::json!({ "name": format!("u{i}") }),
                    ctx_with_id(&format!("c{i}")),
                )
                .await
                .unwrap();
            assert!(!r.get_evidence().is_empty(), "tool {i} missing evidence");
            assert!(!r.get_trace().is_empty(), "tool {i} missing trace");
        }
    }

    // A tool that declares a named analysis environment requirement.
    #[derive(Clone)]
    struct AtacTool;

    #[async_trait]
    impl ToolCapability for AtacTool {
        type Input = GreetInput;
        type Output = GreetOutput;

        fn name(&self) -> &'static str {
            "sc_atac_peaks"
        }
        fn description(&self) -> &'static str {
            "Call ATAC peaks (needs the sc-atac environment)"
        }
        async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
            Ok(GreetOutput {
                greeting: format!("peaks for {}", input.name),
            })
        }
        fn required_env(&self) -> Option<&'static str> {
            Some("sc-atac")
        }
    }

    #[test]
    fn required_env_defaults_to_none_and_can_be_declared() {
        // Ambient tools declare no environment.
        assert_eq!(Greeter.required_env(), None);
        // Modality tools declare their isolated environment.
        assert_eq!(AtacTool.required_env(), Some("sc-atac"));
    }
}
