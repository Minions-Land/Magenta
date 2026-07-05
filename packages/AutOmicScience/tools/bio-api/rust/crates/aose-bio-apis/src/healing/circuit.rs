//! Circuit breaker implementation for API clients.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// Circuit breaker state machine.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CircuitStateKind {
    /// Healthy, requests allowed
    Closed,

    /// Failing, reject immediately
    Open { retry_after_secs: u64 },

    /// Testing recovery, limited requests
    HalfOpen,
}

impl CircuitStateKind {
    /// Check if requests should be allowed in this state.
    pub fn allows_requests(&self) -> bool {
        !matches!(self, Self::Open { .. })
    }

    /// Get display color for TUI rendering.
    pub fn display_color(&self) -> &'static str {
        match self {
            Self::Closed => "green",
            Self::Open { .. } => "red",
            Self::HalfOpen => "yellow",
        }
    }
}

impl std::fmt::Display for CircuitStateKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "Closed"),
            Self::Open { retry_after_secs } => write!(f, "Open (retry in {}s)", retry_after_secs),
            Self::HalfOpen => write!(f, "HalfOpen"),
        }
    }
}

/// Circuit breaker state with metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitState {
    /// Current state
    pub state: CircuitStateKind,

    /// Total number of failures
    pub failure_count: u32,

    /// Consecutive failures (resets on success)
    pub consecutive_failures: u32,

    /// When the last failure occurred
    #[serde(skip)]
    pub last_failure: Option<Instant>,

    /// When the last success occurred
    #[serde(skip)]
    pub last_success: Option<Instant>,

    /// Total number of calls
    pub total_calls: u64,

    /// Number of successful calls
    pub success_calls: u64,

    /// When the circuit was opened (for timeout tracking)
    #[serde(skip)]
    opened_at: Option<Instant>,
}

impl CircuitState {
    /// Create a new circuit state in Closed state.
    pub fn new() -> Self {
        Self {
            state: CircuitStateKind::Closed,
            failure_count: 0,
            consecutive_failures: 0,
            last_failure: None,
            last_success: None,
            total_calls: 0,
            success_calls: 0,
            opened_at: None,
        }
    }

    /// Calculate success rate (0.0 to 1.0).
    pub fn success_rate(&self) -> f32 {
        if self.total_calls == 0 {
            1.0
        } else {
            self.success_calls as f32 / self.total_calls as f32
        }
    }

    /// Check if the circuit should transition from Open to HalfOpen.
    fn should_attempt_reset(&self, timeout: Duration) -> bool {
        if let CircuitStateKind::Open { .. } = self.state {
            if let Some(opened_at) = self.opened_at {
                return opened_at.elapsed() >= timeout;
            }
        }
        false
    }

    /// Record a successful call.
    fn record_success(&mut self, _config: &CircuitBreakerConfig) {
        self.total_calls += 1;
        self.success_calls += 1;
        self.consecutive_failures = 0;
        self.last_success = Some(Instant::now());

        match self.state {
            CircuitStateKind::HalfOpen => {
                // Transition to Closed after success in HalfOpen
                self.state = CircuitStateKind::Closed;
                self.opened_at = None;
            }
            CircuitStateKind::Open { .. } => {
                // Should not happen, but handle gracefully
                self.state = CircuitStateKind::Closed;
                self.opened_at = None;
            }
            CircuitStateKind::Closed => {
                // Already closed, no state change
            }
        }
    }

    /// Record a failed call.
    fn record_failure(&mut self, config: &CircuitBreakerConfig) {
        self.total_calls += 1;
        self.failure_count += 1;
        self.consecutive_failures += 1;
        self.last_failure = Some(Instant::now());

        match self.state {
            CircuitStateKind::Closed => {
                if self.consecutive_failures >= config.failure_threshold {
                    self.state = CircuitStateKind::Open {
                        retry_after_secs: config.timeout_secs,
                    };
                    self.opened_at = Some(Instant::now());
                }
            }
            CircuitStateKind::HalfOpen => {
                // Failure in HalfOpen -> back to Open
                self.state = CircuitStateKind::Open {
                    retry_after_secs: config.timeout_secs,
                };
                self.opened_at = Some(Instant::now());
            }
            CircuitStateKind::Open { .. } => {
                // Already open, no state change
            }
        }
    }

    /// Check and potentially update state based on timeout.
    fn check_timeout(&mut self, config: &CircuitBreakerConfig) {
        if self.should_attempt_reset(Duration::from_secs(config.timeout_secs)) {
            self.state = CircuitStateKind::HalfOpen;
        }
    }
}

impl Default for CircuitState {
    fn default() -> Self {
        Self::new()
    }
}

/// Circuit breaker configuration.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    /// Consecutive failures before opening (default: 5)
    pub failure_threshold: u32,

    /// Time in seconds before Open→HalfOpen transition (default: 60)
    pub timeout_secs: u64,

    /// Successes in HalfOpen before Closed (default: 1)
    pub success_threshold: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            timeout_secs: 60,
            success_threshold: 1,
        }
    }
}

impl CircuitBreakerConfig {
    /// Create a new config with custom thresholds.
    pub fn new(failure_threshold: u32, timeout_secs: u64) -> Self {
        Self {
            failure_threshold,
            timeout_secs,
            success_threshold: 1,
        }
    }

    /// Set the success threshold for HalfOpen→Closed transition.
    pub fn with_success_threshold(mut self, threshold: u32) -> Self {
        self.success_threshold = threshold;
        self
    }
}

/// Circuit decision for incoming requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitDecision {
    /// Allow the request
    Allow,

    /// Reject the request
    Reject { retry_after: Duration },
}

/// Circuit breaker registry for managing multiple API clients.
#[derive(Debug, Clone)]
pub struct CircuitBreakerRegistry {
    states: Arc<RwLock<HashMap<String, CircuitState>>>,
    config: CircuitBreakerConfig,
}

impl CircuitBreakerRegistry {
    /// Create a new registry with the given configuration.
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
            config,
        }
    }

    /// Check if a request should be allowed for the given client.
    pub fn check(&self, client_id: &str) -> CircuitDecision {
        let mut states = self.states.write().unwrap();
        let state = states.entry(client_id.to_string()).or_default();

        // Check if circuit should transition from Open to HalfOpen
        state.check_timeout(&self.config);

        match state.state {
            CircuitStateKind::Closed | CircuitStateKind::HalfOpen => CircuitDecision::Allow,
            CircuitStateKind::Open { retry_after_secs } => CircuitDecision::Reject {
                retry_after: Duration::from_secs(retry_after_secs),
            },
        }
    }

    /// Record a successful call.
    pub fn record_success(&self, client_id: &str) {
        let mut states = self.states.write().unwrap();
        let state = states.entry(client_id.to_string()).or_default();
        state.record_success(&self.config);
    }

    /// Record a failed call.
    pub fn record_failure(&self, client_id: &str) {
        let mut states = self.states.write().unwrap();
        let state = states.entry(client_id.to_string()).or_default();
        state.record_failure(&self.config);
    }

    /// Get the current state for a client.
    pub fn get_state(&self, client_id: &str) -> Option<CircuitState> {
        let states = self.states.read().unwrap();
        states.get(client_id).cloned()
    }

    /// Get all client states (for monitoring/TUI).
    pub fn get_all_states(&self) -> HashMap<String, CircuitState> {
        let states = self.states.read().unwrap();
        states.clone()
    }

    /// Reset a circuit breaker to Closed state.
    pub fn reset(&self, client_id: &str) {
        let mut states = self.states.write().unwrap();
        states.insert(client_id.to_string(), CircuitState::new());
    }

    /// Get the configuration.
    pub fn config(&self) -> &CircuitBreakerConfig {
        &self.config
    }
}

impl Default for CircuitBreakerRegistry {
    fn default() -> Self {
        Self::new(CircuitBreakerConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_state_new() {
        let state = CircuitState::new();
        assert_eq!(state.state, CircuitStateKind::Closed);
        assert_eq!(state.success_rate(), 1.0);
    }

    #[test]
    fn test_circuit_state_success_rate() {
        let mut state = CircuitState::new();
        let config = CircuitBreakerConfig::default();

        state.record_success(&config);
        state.record_success(&config);
        state.record_failure(&config);

        assert_eq!(state.total_calls, 3);
        assert_eq!(state.success_calls, 2);
        assert!((state.success_rate() - 0.666).abs() < 0.01);
    }

    #[test]
    fn test_circuit_opens_after_threshold() {
        let mut state = CircuitState::new();
        let config = CircuitBreakerConfig::default();

        // Fail threshold times
        for _ in 0..config.failure_threshold {
            state.record_failure(&config);
        }

        assert!(matches!(state.state, CircuitStateKind::Open { .. }));
        assert_eq!(state.consecutive_failures, config.failure_threshold);
    }

    #[test]
    fn test_circuit_stays_closed_below_threshold() {
        let mut state = CircuitState::new();
        let config = CircuitBreakerConfig::default();

        // Fail below threshold
        for _ in 0..config.failure_threshold - 1 {
            state.record_failure(&config);
        }

        assert_eq!(state.state, CircuitStateKind::Closed);
    }

    #[test]
    fn test_circuit_resets_consecutive_failures_on_success() {
        let mut state = CircuitState::new();
        let config = CircuitBreakerConfig::default();

        state.record_failure(&config);
        state.record_failure(&config);
        assert_eq!(state.consecutive_failures, 2);

        state.record_success(&config);
        assert_eq!(state.consecutive_failures, 0);
        assert_eq!(state.state, CircuitStateKind::Closed);
    }

    #[test]
    fn test_circuit_half_open_transitions() {
        let mut state = CircuitState::new();
        let config = CircuitBreakerConfig::default();

        // Open the circuit
        for _ in 0..config.failure_threshold {
            state.record_failure(&config);
        }
        assert!(matches!(state.state, CircuitStateKind::Open { .. }));

        // Manually transition to HalfOpen (timeout simulation)
        state.state = CircuitStateKind::HalfOpen;

        // Success in HalfOpen should close the circuit
        state.record_success(&config);
        assert_eq!(state.state, CircuitStateKind::Closed);
    }

    #[test]
    fn test_circuit_half_open_failure_reopens() {
        let mut state = CircuitState::new();
        let config = CircuitBreakerConfig::default();

        state.state = CircuitStateKind::HalfOpen;
        state.record_failure(&config);

        assert!(matches!(state.state, CircuitStateKind::Open { .. }));
    }

    #[test]
    fn test_registry_check_allow_when_closed() {
        let registry = CircuitBreakerRegistry::default();
        let decision = registry.check("test_client");
        assert_eq!(decision, CircuitDecision::Allow);
    }

    #[test]
    fn test_registry_check_reject_when_open() {
        let registry = CircuitBreakerRegistry::new(CircuitBreakerConfig {
            failure_threshold: 2,
            timeout_secs: 10,
            success_threshold: 1,
        });

        // Fail enough times to open the circuit
        registry.record_failure("test_client");
        registry.record_failure("test_client");

        let decision = registry.check("test_client");
        assert!(matches!(decision, CircuitDecision::Reject { .. }));
    }

    #[test]
    fn test_registry_records_success() {
        let registry = CircuitBreakerRegistry::default();

        registry.record_success("test_client");
        registry.record_success("test_client");

        let state = registry.get_state("test_client").unwrap();
        assert_eq!(state.success_calls, 2);
        assert_eq!(state.success_rate(), 1.0);
    }

    #[test]
    fn test_registry_reset() {
        let registry = CircuitBreakerRegistry::default();

        registry.record_failure("test_client");
        registry.record_failure("test_client");

        let state_before = registry.get_state("test_client").unwrap();
        assert_eq!(state_before.failure_count, 2);

        registry.reset("test_client");

        let state_after = registry.get_state("test_client").unwrap();
        assert_eq!(state_after.failure_count, 0);
        assert_eq!(state_after.state, CircuitStateKind::Closed);
    }

    #[test]
    fn test_circuit_state_kind_display() {
        assert_eq!(CircuitStateKind::Closed.to_string(), "Closed");
        assert_eq!(CircuitStateKind::HalfOpen.to_string(), "HalfOpen");
        assert_eq!(
            CircuitStateKind::Open {
                retry_after_secs: 30
            }
            .to_string(),
            "Open (retry in 30s)"
        );
    }

    #[test]
    fn test_circuit_state_kind_allows_requests() {
        assert!(CircuitStateKind::Closed.allows_requests());
        assert!(CircuitStateKind::HalfOpen.allows_requests());
        assert!(!CircuitStateKind::Open {
            retry_after_secs: 10
        }
        .allows_requests());
    }
}
