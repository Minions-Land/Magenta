//! aose-core (trimmed tool subsystem)
//!
//! Vendored from the AutOmicScience (BioAgent) Rust workspace, reduced to just
//! the tool subsystem needed to build the bio-API MCP server. The original
//! crate carried agent/protocol/provider/runtime/memory modules; none are
//! referenced by the tool subsystem, so they are dropped here to keep the
//! dependency closure minimal (no reqwest/postgres/etc.).
//!
//! Origin: github.com/Minions-Land/AutOmicScience, crate `aose-core`.

pub mod error;
pub mod tool;
pub mod trait_based_tool;
pub mod types;

pub use tool::{
    define_grounded_tool, define_tool, define_tool_with_metadata,
    define_tool_with_metadata_aliases_and_limit, define_tool_with_metadata_and_limit,
    format_tools_for_provider, pair_tools_to_agent, rank_tools_by_relevance, ExecutionContext,
    PermissionApprovalDecision, PermissionApprovalDecisionKind, PermissionApprovalHandler,
    PermissionApprovalRequest, PermissionBehavior, PermissionCheckDecision, PermissionCheckRequest,
    PermissionChecker, Tool, ToolDefinition, ToolOperation, ToolOutput, ToolResult, ToolSet,
};
pub use trait_based_tool::{
    Batchable, CapabilitySet, Composable, DataSource, Fallible, GroundedOutput, GroundedTypedTool,
    Pipeline, Pipeline3, Provenance, RateLimit, RateLimited, ResilientTool, ToolCapability,
    TypedTool,
};
pub use types::{
    AgentEvent, ChatOptions, ContentPart, Message, MessageContent, OpenAiToolDef, Role, ToolCall,
};
