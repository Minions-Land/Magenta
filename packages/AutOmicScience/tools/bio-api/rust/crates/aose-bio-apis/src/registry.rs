//! Client registry for dynamic bio-API client management
//!
//! This module provides a centralized registry for all bio-API clients,
//! enabling dynamic lookup, health checking, and automated testing.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[cfg(feature = "healing")]
use crate::healing::{CircuitBreakerRegistry, CircuitStateKind};

/// Metadata about a bio-API client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientMetadata {
    /// Unique identifier for the client
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Description of what this client provides
    pub description: String,
    /// API base URL
    pub base_url: String,
    /// Whether authentication is required
    pub requires_auth: bool,
    /// Rate limit (requests per second)
    pub rate_limit: u32,
    /// Data categories this client provides
    pub categories: Vec<String>,
    /// Whether this client is currently available
    pub available: bool,
    /// Circuit breaker state (if healing feature enabled)
    #[cfg(feature = "healing")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_state: Option<CircuitStateKind>,
}

/// Health check result for a client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheckResult {
    pub client_id: String,
    pub healthy: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
    pub timestamp: String,
}

/// Trait that all bio-API clients should implement for registration
#[async_trait]
pub trait BioApiClient: Send + Sync {
    /// Get client metadata
    fn metadata(&self) -> Box<ClientMetadata>;

    /// Perform a health check (lightweight query to verify API is reachable)
    async fn health_check(&self) -> HealthCheckResult;

    /// Get human-readable status
    fn status(&self) -> String {
        let meta = self.metadata();
        if meta.available {
            format!("{} ({}): Available", meta.name, meta.id)
        } else {
            format!("{} ({}): Unavailable", meta.name, meta.id)
        }
    }
}

/// Registry of all bio-API clients
pub struct ClientRegistry {
    clients: HashMap<String, Arc<dyn BioApiClient>>,
    #[cfg(feature = "healing")]
    circuit_breaker: Arc<CircuitBreakerRegistry>,
}

impl ClientRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
            #[cfg(feature = "healing")]
            circuit_breaker: Arc::new(CircuitBreakerRegistry::default()),
        }
    }

    /// Register a client
    pub fn register(&mut self, client: Arc<dyn BioApiClient>) {
        let id = client.metadata().id.clone();
        self.clients.insert(id, client);
    }

    /// Get a client by ID
    pub fn get(&self, id: &str) -> Option<Arc<dyn BioApiClient>> {
        self.clients.get(id).cloned()
    }

    /// List all registered clients
    pub fn list(&self) -> Vec<ClientMetadata> {
        self.clients
            .values()
            .map(|c| {
                let meta = *c.metadata();
                #[cfg(feature = "healing")]
                {
                    // Attach circuit breaker state to metadata
                    if let Some(state) = self.circuit_breaker.get_state(&meta.id) {
                        meta.circuit_state = Some(state.state);
                    }
                }
                meta
            })
            .collect()
    }

    /// Get clients by category
    pub fn by_category(&self, category: &str) -> Vec<Arc<dyn BioApiClient>> {
        self.clients
            .values()
            .filter(|c| c.metadata().categories.contains(&category.to_string()))
            .cloned()
            .collect()
    }

    /// Check health of all clients
    pub async fn health_check_all(&self) -> Vec<HealthCheckResult> {
        let mut results = Vec::new();
        for client in self.clients.values() {
            #[cfg(feature = "healing")]
            {
                // Skip health check if circuit is open
                use crate::healing::CircuitDecision;
                let decision = self.circuit_breaker.check(&client.metadata().id);
                if let CircuitDecision::Reject { retry_after } = decision {
                    results.push(HealthCheckResult {
                        client_id: client.metadata().id.clone(),
                        healthy: false,
                        latency_ms: 0,
                        error: Some(format!("Circuit open, retry after {:?}", retry_after)),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    });
                    continue;
                }
            }

            results.push(client.health_check().await);
        }
        results
    }

    /// Get available clients (healthy ones)
    pub async fn available_clients(&self) -> Vec<String> {
        let results = self.health_check_all().await;
        results
            .into_iter()
            .filter(|r| r.healthy)
            .map(|r| r.client_id)
            .collect()
    }

    /// Get the circuit breaker registry (healing feature only)
    #[cfg(feature = "healing")]
    pub fn circuit_breaker(&self) -> Arc<CircuitBreakerRegistry> {
        Arc::clone(&self.circuit_breaker)
    }

    /// Record a successful API call (healing feature only)
    #[cfg(feature = "healing")]
    pub fn record_call_success(&self, client_id: &str) {
        self.circuit_breaker.record_success(client_id);
    }

    /// Record a failed API call (healing feature only)
    #[cfg(feature = "healing")]
    pub fn record_call_failure(&self, client_id: &str) {
        self.circuit_breaker.record_failure(client_id);
    }

    /// Check circuit breaker state for a client (healing feature only)
    #[cfg(feature = "healing")]
    pub fn check_circuit(&self, client_id: &str) -> crate::healing::CircuitDecision {
        self.circuit_breaker.check(client_id)
    }
}

impl Default for ClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder for creating a pre-populated registry
pub struct RegistryBuilder {
    registry: ClientRegistry,
}

impl RegistryBuilder {
    pub fn new() -> Self {
        Self {
            registry: ClientRegistry::new(),
        }
    }

    /// Add a client to the registry
    pub fn with_client(mut self, client: Arc<dyn BioApiClient>) -> Self {
        self.registry.register(client);
        self
    }

    /// Build the final registry
    pub fn build(self) -> ClientRegistry {
        self.registry
    }
}

impl Default for RegistryBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockClient {
        id: String,
        healthy: bool,
    }

    #[async_trait]
    impl BioApiClient for MockClient {
        fn metadata(&self) -> Box<ClientMetadata> {
            Box::new(ClientMetadata {
                id: self.id.clone(),
                name: format!("Mock {}", self.id),
                description: "Test client".to_string(),
                base_url: "https://example.com".to_string(),
                requires_auth: false,
                rate_limit: 10,
                categories: vec!["test".to_string()],
                available: true,
                #[cfg(feature = "healing")]
                circuit_state: None,
            })
        }

        async fn health_check(&self) -> HealthCheckResult {
            HealthCheckResult {
                client_id: self.id.clone(),
                healthy: self.healthy,
                latency_ms: 10,
                error: if self.healthy {
                    None
                } else {
                    Some("Mock failure".to_string())
                },
                timestamp: chrono::Utc::now().to_rfc3339(),
            }
        }
    }

    #[test]
    fn test_registry_registration() {
        let mut registry = ClientRegistry::new();
        let client = Arc::new(MockClient {
            id: "test1".to_string(),
            healthy: true,
        });

        registry.register(client);
        assert!(registry.get("test1").is_some());
        assert_eq!(registry.list().len(), 1);
    }

    #[tokio::test]
    async fn test_health_check() {
        let mut registry = ClientRegistry::new();

        registry.register(Arc::new(MockClient {
            id: "healthy".to_string(),
            healthy: true,
        }));

        registry.register(Arc::new(MockClient {
            id: "unhealthy".to_string(),
            healthy: false,
        }));

        let results = registry.health_check_all().await;
        assert_eq!(results.len(), 2);

        let available = registry.available_clients().await;
        assert_eq!(available.len(), 1);
        assert_eq!(available[0], "healthy");
    }

    #[test]
    fn test_builder_pattern() {
        let registry = RegistryBuilder::new()
            .with_client(Arc::new(MockClient {
                id: "client1".to_string(),
                healthy: true,
            }))
            .with_client(Arc::new(MockClient {
                id: "client2".to_string(),
                healthy: true,
            }))
            .build();

        assert_eq!(registry.list().len(), 2);
    }
}
