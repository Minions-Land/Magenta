//! Self-healing client trait and result types.

use crate::error::{BioApiError, BioApiResult};
use crate::healing::{
    CircuitDecision, FailureClassifier, FailureContext, FailureDiagnosis, RepairOutcome,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::future::Future;

/// Result type that includes healing metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HealingResult<T> {
    /// Operation succeeded without healing
    Success(T),

    /// Operation failed after retry exhaustion
    FailedAfterRetry(String),

    /// Operation succeeded after healing
    Healed {
        result: T,
        repair_log: RepairAttempt,
    },

    /// Circuit breaker prevented the request
    CircuitOpen {
        client_id: String,
        retry_after_secs: u64,
    },
}

impl<T> HealingResult<T> {
    /// Check if the result is successful (either Success or Healed).
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Success(_) | Self::Healed { .. })
    }

    /// Check if the result is an error.
    pub fn is_err(&self) -> bool {
        !self.is_ok()
    }

    /// Extract the successful value, if any.
    pub fn ok(self) -> Option<T> {
        match self {
            Self::Success(val) | Self::Healed { result: val, .. } => Some(val),
            _ => None,
        }
    }

    /// Map the successful value to another type.
    pub fn map<U, F>(self, f: F) -> HealingResult<U>
    where
        F: FnOnce(T) -> U,
    {
        match self {
            Self::Success(val) => HealingResult::Success(f(val)),
            Self::Healed { result, repair_log } => HealingResult::Healed {
                result: f(result),
                repair_log,
            },
            Self::FailedAfterRetry(err) => HealingResult::FailedAfterRetry(err),
            Self::CircuitOpen {
                client_id,
                retry_after_secs,
            } => HealingResult::CircuitOpen {
                client_id,
                retry_after_secs,
            },
        }
    }

    /// Get the repair log if this was a healed result.
    pub fn repair_log(&self) -> Option<&RepairAttempt> {
        match self {
            Self::Healed { repair_log, .. } => Some(repair_log),
            _ => None,
        }
    }
}

/// Full repair attempt record for provenance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairAttempt {
    /// When the repair was attempted (ISO 8601)
    pub timestamp: String,

    /// The classified failure kind
    pub failure_kind: String,

    /// Human-readable diagnosis summary
    pub diagnosis: String,

    /// The repair strategy that was applied
    pub strategy: String,

    /// Outcome of the repair (success/failure)
    pub outcome: String,

    /// Full agent conversation trace (if agent was used)
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub agent_trace: Vec<AgentMessage>,
}

impl RepairAttempt {
    /// Create a new repair attempt record.
    pub fn new(failure_kind: String, diagnosis: String, strategy: String, outcome: String) -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            failure_kind,
            diagnosis,
            strategy,
            outcome,
            agent_trace: Vec::new(),
        }
    }

    /// Add agent trace messages.
    pub fn with_agent_trace(mut self, trace: Vec<AgentMessage>) -> Self {
        self.agent_trace = trace;
        self
    }
}

/// Simplified agent message for provenance tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    /// Message role (user, assistant, system)
    pub role: String,

    /// Message content
    pub content: String,

    /// Tool calls, if any
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<String>>,
}

/// Self-healing wrapper for API clients.
///
/// This trait provides automatic diagnosis and repair for API failures.
/// When operations fail after exhausting retries, the client can spawn
/// a diagnostic agent to classify the failure and attempt automated repairs.
#[async_trait]
pub trait SelfHealingClient: Send + Sync {
    /// Execute operation with automatic healing on failure.
    ///
    /// This method wraps an API operation with:
    /// 1. Circuit breaker check (reject if circuit is open)
    /// 2. Execute operation with retry logic
    /// 3. On failure: classify, diagnose, and attempt repair
    /// 4. Update circuit breaker state based on outcome
    ///
    /// # Arguments
    ///
    /// * `operation` - Human-readable operation name for logging
    /// * `f` - The operation to execute (must be idempotent for retries)
    ///
    /// # Returns
    ///
    /// `HealingResult<T>` which includes repair metadata if healing occurred.
    async fn execute_with_healing<F, Fut, T>(&self, operation: &str, f: F) -> HealingResult<T>
    where
        F: FnMut() -> Fut + Send,
        Fut: Future<Output = BioApiResult<T>> + Send,
        T: Send;

    /// Classify failure without attempting repair.
    ///
    /// This is useful for:
    /// - Pre-flight checks to determine if repair is possible
    /// - Testing classifier accuracy
    /// - Building failure dashboards
    fn diagnose_failure(&self, error: BioApiError, context: FailureContext) -> FailureDiagnosis {
        FailureClassifier::classify(&error, &context)
    }

    /// Execute a repair strategy.
    ///
    /// This method applies the repair actions and returns the outcome.
    /// Implementations should update client configuration based on the strategy.
    ///
    /// # Arguments
    ///
    /// * `diagnosis` - The failure diagnosis including suggested strategy
    ///
    /// # Returns
    ///
    /// `RepairOutcome` describing what actions were taken and whether they succeeded.
    async fn attempt_repair(&self, diagnosis: FailureDiagnosis) -> RepairOutcome;

    /// Get client identifier for circuit breaker tracking.
    fn client_id(&self) -> &str;

    /// Check circuit breaker state before executing request.
    ///
    /// Returns `CircuitDecision::Allow` if request should proceed,
    /// or `CircuitDecision::Reject` if circuit is open.
    fn check_circuit(&self) -> CircuitDecision {
        // Default implementation allows all requests
        // Override to integrate with CircuitBreakerRegistry
        CircuitDecision::Allow
    }

    /// Record a successful call in the circuit breaker.
    fn record_success(&self) {
        // Default implementation does nothing
        // Override to integrate with CircuitBreakerRegistry
    }

    /// Record a failed call in the circuit breaker.
    fn record_failure(&self) {
        // Default implementation does nothing
        // Override to integrate with CircuitBreakerRegistry
    }
}

/// Helper to create a failure context from request information.
pub fn create_failure_context(
    client_id: impl Into<String>,
    endpoint: impl Into<String>,
    attempt_count: u32,
) -> FailureContext {
    FailureContext::new(client_id, endpoint, attempt_count)
}

/// Helper to convert BioApiError to HealingResult for non-healing clients.
pub fn error_to_healing_result<T>(error: BioApiError) -> HealingResult<T> {
    HealingResult::FailedAfterRetry(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_healing_result_is_ok() {
        let success: HealingResult<i32> = HealingResult::Success(42);
        assert!(success.is_ok());
        assert!(!success.is_err());

        let healed: HealingResult<i32> = HealingResult::Healed {
            result: 42,
            repair_log: RepairAttempt::new(
                "test".into(),
                "test".into(),
                "test".into(),
                "success".into(),
            ),
        };
        assert!(healed.is_ok());

        let failed: HealingResult<i32> = HealingResult::FailedAfterRetry("error".into());
        assert!(failed.is_err());

        let circuit_open: HealingResult<i32> = HealingResult::CircuitOpen {
            client_id: "test".into(),
            retry_after_secs: 60,
        };
        assert!(circuit_open.is_err());
    }

    #[test]
    fn test_healing_result_ok() {
        let success: HealingResult<i32> = HealingResult::Success(42);
        assert_eq!(success.ok(), Some(42));

        let healed: HealingResult<i32> = HealingResult::Healed {
            result: 99,
            repair_log: RepairAttempt::new(
                "test".into(),
                "test".into(),
                "test".into(),
                "success".into(),
            ),
        };
        assert_eq!(healed.ok(), Some(99));

        let failed: HealingResult<i32> = HealingResult::FailedAfterRetry("error".into());
        assert_eq!(failed.ok(), None);
    }

    #[test]
    fn test_healing_result_map() {
        let success: HealingResult<i32> = HealingResult::Success(42);
        let mapped = success.map(|x| x * 2);
        assert_eq!(mapped.ok(), Some(84));

        let healed: HealingResult<i32> = HealingResult::Healed {
            result: 10,
            repair_log: RepairAttempt::new(
                "test".into(),
                "test".into(),
                "test".into(),
                "success".into(),
            ),
        };
        let mapped = healed.map(|x| x + 5);
        // Check repair log before consuming with ok()
        assert!(mapped.repair_log().is_some());
        assert_eq!(mapped.ok(), Some(15));
    }

    #[test]
    fn test_healing_result_repair_log() {
        let success: HealingResult<i32> = HealingResult::Success(42);
        assert!(success.repair_log().is_none());

        let repair_log = RepairAttempt::new(
            "RateLimitExhausted".into(),
            "Rate limit hit".into(),
            "BackoffAndRetry".into(),
            "success".into(),
        );
        let healed: HealingResult<i32> = HealingResult::Healed {
            result: 42,
            repair_log: repair_log.clone(),
        };
        assert!(healed.repair_log().is_some());
        assert_eq!(
            healed.repair_log().unwrap().failure_kind,
            "RateLimitExhausted"
        );
    }

    #[test]
    fn test_repair_attempt_creation() {
        let attempt = RepairAttempt::new(
            "AuthExpired".into(),
            "Token expired".into(),
            "RefreshAuth".into(),
            "success".into(),
        );

        assert_eq!(attempt.failure_kind, "AuthExpired");
        assert_eq!(attempt.diagnosis, "Token expired");
        assert_eq!(attempt.strategy, "RefreshAuth");
        assert_eq!(attempt.outcome, "success");
        assert!(attempt.agent_trace.is_empty());
    }

    #[test]
    fn test_repair_attempt_with_agent_trace() {
        let trace = vec![
            AgentMessage {
                role: "user".into(),
                content: "Diagnose this failure".into(),
                tool_calls: None,
            },
            AgentMessage {
                role: "assistant".into(),
                content: "The API endpoint has migrated".into(),
                tool_calls: Some(vec!["fetch_api_docs".into()]),
            },
        ];

        let attempt = RepairAttempt::new(
            "EndpointMigrated".into(),
            "API moved to new URL".into(),
            "SwitchEndpoint".into(),
            "success".into(),
        )
        .with_agent_trace(trace);

        assert_eq!(attempt.agent_trace.len(), 2);
        assert_eq!(attempt.agent_trace[0].role, "user");
    }

    #[test]
    fn test_create_failure_context_helper() {
        let context = create_failure_context("test_client", "https://api.example.com", 3);

        assert_eq!(context.client_id, "test_client");
        assert_eq!(context.endpoint, "https://api.example.com");
        assert_eq!(context.attempt_count, 3);
    }

    #[test]
    fn test_error_to_healing_result_helper() {
        let error = BioApiError::NotFound("resource".into());
        let result: HealingResult<i32> = error_to_healing_result(error);

        assert!(result.is_err());
        assert!(matches!(result, HealingResult::FailedAfterRetry(_)));
    }
}
