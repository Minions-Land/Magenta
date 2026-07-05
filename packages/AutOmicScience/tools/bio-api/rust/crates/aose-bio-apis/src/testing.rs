//! Automated testing framework for bio-API clients
//!
//! Provides utilities for testing client implementations:
//! - Connectivity tests
//! - Response validation
//! - Rate limiting verification
//! - Error handling checks

use crate::registry::BioApiClient;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Test result for a single test case
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub test_name: String,
    pub client_id: String,
    pub passed: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
    pub details: String,
}

/// Test suite for a bio-API client
pub struct ClientTestSuite {
    client: Arc<dyn BioApiClient>,
    results: Vec<TestResult>,
}

impl ClientTestSuite {
    /// Create a new test suite for a client
    pub fn new(client: Arc<dyn BioApiClient>) -> Self {
        Self {
            client,
            results: Vec::new(),
        }
    }

    /// Run all standard tests
    pub async fn run_all(&mut self) -> Vec<TestResult> {
        self.test_connectivity().await;
        self.test_metadata().await;
        self.test_health_check().await;
        self.results.clone()
    }

    /// Test basic connectivity
    async fn test_connectivity(&mut self) {
        let start = Instant::now();
        let meta = self.client.metadata();

        let result = self.client.health_check().await;

        self.results.push(TestResult {
            test_name: "connectivity".to_string(),
            client_id: meta.id.clone(),
            passed: result.healthy,
            duration_ms: start.elapsed().as_millis() as u64,
            error: result.error,
            details: format!("API responded in {}ms", result.latency_ms),
        });
    }

    /// Test metadata validity
    async fn test_metadata(&mut self) {
        let start = Instant::now();
        let meta = self.client.metadata();

        let valid = !meta.id.is_empty()
            && !meta.name.is_empty()
            && !meta.base_url.is_empty()
            && meta.rate_limit > 0;

        self.results.push(TestResult {
            test_name: "metadata".to_string(),
            client_id: meta.id.clone(),
            passed: valid,
            duration_ms: start.elapsed().as_millis() as u64,
            error: if valid {
                None
            } else {
                Some("Invalid metadata".to_string())
            },
            details: format!(
                "Metadata validation: id={}, name={}, url={}",
                meta.id, meta.name, meta.base_url
            ),
        });
    }

    /// Test health check functionality
    async fn test_health_check(&mut self) {
        let start = Instant::now();
        let meta = self.client.metadata();

        match tokio::time::timeout(Duration::from_secs(10), self.client.health_check()).await {
            Ok(result) => {
                self.results.push(TestResult {
                    test_name: "health_check".to_string(),
                    client_id: meta.id.clone(),
                    passed: result.healthy,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error: result.error,
                    details: format!("Health check completed in {}ms", result.latency_ms),
                });
            }
            Err(_) => {
                self.results.push(TestResult {
                    test_name: "health_check".to_string(),
                    client_id: meta.id.clone(),
                    passed: false,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error: Some("Health check timeout".to_string()),
                    details: "Exceeded 10s timeout".to_string(),
                });
            }
        }
    }

    /// Get test results
    pub fn results(&self) -> &[TestResult] {
        &self.results
    }

    /// Get summary statistics
    pub fn summary(&self) -> TestSummary {
        let total = self.results.len();
        let passed = self.results.iter().filter(|r| r.passed).count();
        let failed = total - passed;
        let avg_duration = if total > 0 {
            self.results.iter().map(|r| r.duration_ms).sum::<u64>() / total as u64
        } else {
            0
        };

        TestSummary {
            total,
            passed,
            failed,
            avg_duration_ms: avg_duration,
        }
    }
}

/// Summary statistics for test results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestSummary {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub avg_duration_ms: u64,
}

/// Batch test runner for multiple clients
pub struct BatchTestRunner {
    clients: Vec<Arc<dyn BioApiClient>>,
}

impl BatchTestRunner {
    pub fn new() -> Self {
        Self {
            clients: Vec::new(),
        }
    }

    /// Add a client to test
    pub fn add_client(&mut self, client: Arc<dyn BioApiClient>) {
        self.clients.push(client);
    }

    /// Run tests on all clients in parallel
    pub async fn run_all_parallel(&self) -> Vec<Vec<TestResult>> {
        let mut handles = Vec::new();

        for client in &self.clients {
            let client = Arc::clone(client);
            let handle = tokio::spawn(async move {
                let mut suite = ClientTestSuite::new(client);
                suite.run_all().await
            });
            handles.push(handle);
        }

        let mut all_results = Vec::new();
        for handle in handles {
            if let Ok(results) = handle.await {
                all_results.push(results);
            }
        }

        all_results
    }

    /// Run tests on all clients sequentially
    pub async fn run_all_sequential(&self) -> Vec<Vec<TestResult>> {
        let mut all_results = Vec::new();

        for client in &self.clients {
            let mut suite = ClientTestSuite::new(Arc::clone(client));
            let results = suite.run_all().await;
            all_results.push(results);
        }

        all_results
    }

    /// Generate a summary report
    pub fn summary_report(results: &[Vec<TestResult>]) -> BatchTestSummary {
        let mut total_clients = 0;
        let mut healthy_clients = 0;
        let mut total_tests = 0;
        let mut passed_tests = 0;

        for client_results in results {
            total_clients += 1;
            let all_passed = client_results.iter().all(|r| r.passed);
            if all_passed {
                healthy_clients += 1;
            }

            for result in client_results {
                total_tests += 1;
                if result.passed {
                    passed_tests += 1;
                }
            }
        }

        BatchTestSummary {
            total_clients,
            healthy_clients,
            unhealthy_clients: total_clients - healthy_clients,
            total_tests,
            passed_tests,
            failed_tests: total_tests - passed_tests,
        }
    }
}

impl Default for BatchTestRunner {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchTestSummary {
    pub total_clients: usize,
    pub healthy_clients: usize,
    pub unhealthy_clients: usize,
    pub total_tests: usize,
    pub passed_tests: usize,
    pub failed_tests: usize,
}

impl BatchTestSummary {
    pub fn success_rate(&self) -> f64 {
        if self.total_tests == 0 {
            0.0
        } else {
            (self.passed_tests as f64 / self.total_tests as f64) * 100.0
        }
    }

    pub fn client_health_rate(&self) -> f64 {
        if self.total_clients == 0 {
            0.0
        } else {
            (self.healthy_clients as f64 / self.total_clients as f64) * 100.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{BioApiClient, ClientMetadata, HealthCheckResult};
    use async_trait::async_trait;

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

    #[tokio::test]
    async fn test_client_test_suite() {
        let client = Arc::new(MockClient {
            id: "test_client".to_string(),
            healthy: true,
        });

        let mut suite = ClientTestSuite::new(client);
        let results = suite.run_all().await;

        assert_eq!(results.len(), 3); // connectivity, metadata, health_check
        assert!(results.iter().all(|r| r.passed));

        let summary = suite.summary();
        assert_eq!(summary.total, 3);
        assert_eq!(summary.passed, 3);
        assert_eq!(summary.failed, 0);
    }

    #[tokio::test]
    async fn test_batch_runner() {
        let mut runner = BatchTestRunner::new();

        runner.add_client(Arc::new(MockClient {
            id: "client1".to_string(),
            healthy: true,
        }));

        runner.add_client(Arc::new(MockClient {
            id: "client2".to_string(),
            healthy: false,
        }));

        let results = runner.run_all_parallel().await;
        assert_eq!(results.len(), 2);

        let summary = BatchTestRunner::summary_report(&results);
        assert_eq!(summary.total_clients, 2);
        assert_eq!(summary.healthy_clients, 1);
        assert!(summary.success_rate() < 100.0);
    }
}
