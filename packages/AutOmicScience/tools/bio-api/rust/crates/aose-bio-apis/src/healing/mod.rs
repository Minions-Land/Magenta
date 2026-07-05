//! Self-healing API client infrastructure.
//!
//! This module provides agent-based diagnosis and repair for API failures.
//! When API calls fail after exhausting retries, a diagnostic agent spawns to
//! classify the failure, attempt automated repairs, and update circuit breaker state.

pub mod agent;
pub mod circuit;
pub mod classifier;
pub mod client;
pub mod repair;

pub use agent::{
    build_diagnostic_prompt, get_diagnostic_tool_specs, parse_diagnosis_from_output,
    AgentTraceEntry, DiagnosticAgent, DiagnosticAgentSpawner, ToolSpec,
};
pub use circuit::{
    CircuitBreakerConfig, CircuitBreakerRegistry, CircuitDecision, CircuitState, CircuitStateKind,
};
pub use classifier::{FailureClassifier, FailureContext, FailureDiagnosis, FailureKind};
pub use client::{AgentMessage, HealingResult, RepairAttempt, SelfHealingClient};
pub use repair::{RepairExecutor, RepairOutcome, RepairStrategy};
