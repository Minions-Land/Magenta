//! Repair strategy definitions and execution.

use serde::{Deserialize, Serialize};

/// Executable repair action for API failures.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RepairStrategy {
    /// Switch to a new API endpoint URL.
    SwitchEndpoint { new_base_url: String },

    /// Refresh authentication credentials.
    RefreshAuth,

    /// Reduce request batch size or parameters.
    ReduceRequestSize { new_limit: u32 },

    /// Backoff and retry after a delay.
    BackoffAndRetry { delay_secs: u64 },

    /// Fallback to an alternative client.
    Fallback { alternative_client_id: String },

    /// Mark the client as unavailable in circuit breaker.
    MarkUnavailable,

    /// Escalate to human intervention.
    EscalateToHuman { reason: String },
}

impl RepairStrategy {
    /// Check if this strategy requires human intervention.
    pub fn requires_human(&self) -> bool {
        matches!(self, Self::EscalateToHuman { .. })
    }

    /// Check if this strategy can be applied automatically.
    pub fn is_automated(&self) -> bool {
        !self.requires_human()
    }

    /// Get a human-readable description of this strategy.
    pub fn description(&self) -> String {
        match self {
            Self::SwitchEndpoint { new_base_url } => {
                format!("Switch API endpoint to: {}", new_base_url)
            }
            Self::RefreshAuth => "Refresh authentication credentials".to_string(),
            Self::ReduceRequestSize { new_limit } => {
                format!("Reduce request batch size to {}", new_limit)
            }
            Self::BackoffAndRetry { delay_secs } => {
                format!("Wait {} seconds and retry", delay_secs)
            }
            Self::Fallback {
                alternative_client_id,
            } => {
                format!("Fallback to alternative client: {}", alternative_client_id)
            }
            Self::MarkUnavailable => "Mark service as unavailable".to_string(),
            Self::EscalateToHuman { reason } => {
                format!("Manual intervention required: {}", reason)
            }
        }
    }
}

/// Repair execution outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairOutcome {
    /// Whether the repair was successful
    pub success: bool,

    /// The strategy that was applied
    pub strategy_applied: RepairStrategy,

    /// Detailed actions taken during repair
    pub actions_taken: Vec<String>,

    /// Error message if repair failed
    pub error: Option<String>,
}

impl RepairOutcome {
    /// Create a successful repair outcome.
    pub fn success(strategy: RepairStrategy, actions: Vec<String>) -> Self {
        Self {
            success: true,
            strategy_applied: strategy,
            actions_taken: actions,
            error: None,
        }
    }

    /// Create a failed repair outcome.
    pub fn failure(strategy: RepairStrategy, error: impl Into<String>) -> Self {
        Self {
            success: false,
            strategy_applied: strategy,
            actions_taken: Vec::new(),
            error: Some(error.into()),
        }
    }

    /// Add an action to the outcome.
    pub fn with_action(mut self, action: impl Into<String>) -> Self {
        self.actions_taken.push(action.into());
        self
    }
}

/// Executor for repair strategies.
pub struct RepairExecutor;

impl RepairExecutor {
    /// Execute a repair strategy.
    ///
    /// This is a simplified implementation for demonstration.
    /// In production, this would interact with ClientRegistry and spawn agents.
    pub async fn execute(strategy: &RepairStrategy) -> RepairOutcome {
        match strategy {
            RepairStrategy::SwitchEndpoint { new_base_url } => RepairOutcome::success(
                strategy.clone(),
                vec![format!("Switched endpoint to: {}", new_base_url)],
            ),
            RepairStrategy::RefreshAuth => RepairOutcome::success(
                strategy.clone(),
                vec!["Refreshed authentication credentials".to_string()],
            ),
            RepairStrategy::ReduceRequestSize { new_limit } => RepairOutcome::success(
                strategy.clone(),
                vec![format!("Reduced request size to: {}", new_limit)],
            ),
            RepairStrategy::BackoffAndRetry { delay_secs } => RepairOutcome::success(
                strategy.clone(),
                vec![format!("Scheduled retry after {} seconds", delay_secs)],
            ),
            RepairStrategy::Fallback {
                alternative_client_id,
            } => {
                if alternative_client_id.is_empty() {
                    RepairOutcome::failure(strategy.clone(), "No alternative client specified")
                } else {
                    RepairOutcome::success(
                        strategy.clone(),
                        vec![format!(
                            "Switched to alternative: {}",
                            alternative_client_id
                        )],
                    )
                }
            }
            RepairStrategy::MarkUnavailable => RepairOutcome::success(
                strategy.clone(),
                vec!["Marked service as unavailable".to_string()],
            ),
            RepairStrategy::EscalateToHuman { reason } => RepairOutcome::success(
                strategy.clone(),
                vec![format!("Escalated to human: {}", reason)],
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repair_strategy_serialization() {
        let strategy = RepairStrategy::SwitchEndpoint {
            new_base_url: "https://api.example.com/v2".to_string(),
        };

        let json = serde_json::to_string(&strategy).unwrap();
        assert!(json.contains("switch_endpoint"));
        assert!(json.contains("https://api.example.com/v2"));

        let deserialized: RepairStrategy = serde_json::from_str(&json).unwrap();
        assert_eq!(strategy, deserialized);
    }

    #[test]
    fn test_repair_strategy_requires_human() {
        assert!(RepairStrategy::EscalateToHuman {
            reason: "test".to_string()
        }
        .requires_human());

        assert!(!RepairStrategy::BackoffAndRetry { delay_secs: 10 }.requires_human());
    }

    #[test]
    fn test_repair_outcome_success() {
        let outcome = RepairOutcome::success(
            RepairStrategy::RefreshAuth,
            vec!["Retrieved new token".to_string()],
        );

        assert!(outcome.success);
        assert_eq!(outcome.actions_taken.len(), 1);
        assert!(outcome.error.is_none());
    }

    #[test]
    fn test_repair_outcome_failure() {
        let outcome = RepairOutcome::failure(RepairStrategy::RefreshAuth, "Token expired");

        assert!(!outcome.success);
        assert_eq!(outcome.error, Some("Token expired".to_string()));
    }

    #[test]
    fn test_strategy_descriptions() {
        let strategies = vec![
            RepairStrategy::SwitchEndpoint {
                new_base_url: "https://new.api".to_string(),
            },
            RepairStrategy::RefreshAuth,
            RepairStrategy::BackoffAndRetry { delay_secs: 30 },
        ];

        for strategy in strategies {
            let desc = strategy.description();
            assert!(!desc.is_empty());
        }
    }
}
