//! Failure classification and diagnosis.

use crate::error::BioApiError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Failure taxonomy for API errors.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// API base URL changed, redirect or documentation points to new location.
    /// Indicators: HTTP 301/404 + migration notice in body/headers.
    EndpointMigrated,

    /// Authentication token or API key expired, revoked, or invalid.
    /// Indicators: HTTP 401/403.
    AuthExpired,

    /// Request quota exceeded, requires backoff.
    /// Indicators: HTTP 429 with Retry-After header.
    RateLimitExhausted,

    /// Client sent invalid parameters, schema mismatch.
    /// Indicators: HTTP 400 + detailed error in response body.
    MalformedRequest,

    /// API response schema changed, deserialization fails.
    /// Indicators: HTTP 200 but JSON structure mismatch.
    DataFormatChanged,

    /// Transient connectivity failure, DNS resolution error, connection timeout.
    /// Indicators: reqwest::Error connection types.
    NetworkPartition,

    /// API endpoint permanently removed.
    /// Indicators: HTTP 410 Gone, or 404 with deprecation notice.
    ServiceDeprecated,

    /// Does not match known patterns, requires human intervention.
    UnknownFailure,
}

impl FailureKind {
    /// Get human-readable description of this failure kind.
    pub fn description(&self) -> &'static str {
        match self {
            Self::EndpointMigrated => "API endpoint has been moved to a new location",
            Self::AuthExpired => "Authentication credentials are expired or invalid",
            Self::RateLimitExhausted => "API rate limit exceeded, backoff required",
            Self::MalformedRequest => "Request parameters are invalid or malformed",
            Self::DataFormatChanged => "API response format has changed unexpectedly",
            Self::NetworkPartition => "Network connectivity issue or timeout",
            Self::ServiceDeprecated => "API endpoint has been permanently deprecated",
            Self::UnknownFailure => "Unknown failure requiring manual investigation",
        }
    }
}

/// Rich failure context for agent diagnosis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureContext {
    /// The API endpoint that failed
    pub endpoint: String,

    /// Request parameters (sanitized, no sensitive data)
    pub request_params: Value,

    /// Response headers from the failed request
    pub response_headers: HashMap<String, String>,

    /// HTTP status code, if available
    pub status_code: Option<u16>,

    /// First 1000 chars of response body
    pub response_body_sample: String,

    /// When the failure occurred (ISO 8601)
    pub timestamp: String,

    /// Number of retry attempts made
    pub attempt_count: u32,

    /// Client identifier (e.g., "ensembl", "ncbi")
    pub client_id: String,
}

impl FailureContext {
    /// Create a new failure context.
    pub fn new(
        client_id: impl Into<String>,
        endpoint: impl Into<String>,
        attempt_count: u32,
    ) -> Self {
        Self {
            client_id: client_id.into(),
            endpoint: endpoint.into(),
            request_params: Value::Null,
            response_headers: HashMap::new(),
            status_code: None,
            response_body_sample: String::new(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            attempt_count,
        }
    }

    /// Add request parameters (will be sanitized).
    pub fn with_params(mut self, params: Value) -> Self {
        self.request_params = Self::sanitize_params(params);
        self
    }

    /// Add response headers.
    pub fn with_headers(mut self, headers: HashMap<String, String>) -> Self {
        self.response_headers = headers;
        self
    }

    /// Add status code.
    pub fn with_status(mut self, status: u16) -> Self {
        self.status_code = Some(status);
        self
    }

    /// Add response body sample.
    pub fn with_body_sample(mut self, body: impl Into<String>) -> Self {
        let body = body.into();
        self.response_body_sample = body.chars().take(1000).collect();
        self
    }

    /// Sanitize parameters to remove sensitive data.
    fn sanitize_params(params: Value) -> Value {
        match params {
            Value::Object(mut map) => {
                // Remove common sensitive keys
                for key in &["api_key", "token", "password", "secret", "auth"] {
                    if map.contains_key(*key) {
                        map.insert(key.to_string(), Value::String("[REDACTED]".to_string()));
                    }
                }
                Value::Object(map)
            }
            other => other,
        }
    }
}

/// Diagnosis produced by classifier or agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureDiagnosis {
    /// Classified failure kind
    pub kind: FailureKind,

    /// Confidence level (0.0 = no confidence, 1.0 = certain)
    pub confidence: f32,

    /// Evidence supporting this classification
    pub evidence: Vec<String>,

    /// Suggested repair strategy
    pub suggested_strategy: crate::healing::repair::RepairStrategy,
}

impl FailureDiagnosis {
    /// Create a new diagnosis.
    pub fn new(
        kind: FailureKind,
        confidence: f32,
        suggested_strategy: crate::healing::repair::RepairStrategy,
    ) -> Self {
        Self {
            kind,
            confidence: confidence.clamp(0.0, 1.0),
            evidence: Vec::new(),
            suggested_strategy,
        }
    }

    /// Add evidence to the diagnosis.
    pub fn with_evidence(mut self, evidence: impl Into<String>) -> Self {
        self.evidence.push(evidence.into());
        self
    }

    /// Add multiple evidence items.
    pub fn with_evidence_items(mut self, items: Vec<String>) -> Self {
        self.evidence.extend(items);
        self
    }
}

/// Classifier for mapping API errors to failure kinds.
pub struct FailureClassifier;

impl FailureClassifier {
    /// Classify a failure based on error and context.
    pub fn classify(error: &BioApiError, context: &FailureContext) -> FailureDiagnosis {
        // High-confidence classification based on error type
        match error {
            BioApiError::RateLimitExceeded { retry_after_secs } => FailureDiagnosis::new(
                FailureKind::RateLimitExhausted,
                1.0,
                crate::healing::repair::RepairStrategy::BackoffAndRetry {
                    delay_secs: *retry_after_secs,
                },
            )
            .with_evidence(format!(
                "Rate limit exceeded, retry after {} seconds",
                retry_after_secs
            )),

            BioApiError::ApiError { status, message } => {
                Self::classify_api_error(*status, message, context)
            }

            BioApiError::RequestFailed(reqwest_err) => {
                Self::classify_request_failure(reqwest_err, context)
            }

            BioApiError::DeserializationError(_) => Self::classify_deserialization_error(context),

            BioApiError::Timeout { operation } => FailureDiagnosis::new(
                FailureKind::NetworkPartition,
                0.9,
                crate::healing::repair::RepairStrategy::BackoffAndRetry { delay_secs: 5 },
            )
            .with_evidence(format!("Timeout waiting for operation: {}", operation)),

            BioApiError::NotFound(resource) => Self::classify_not_found(resource, context),

            _ => FailureDiagnosis::new(
                FailureKind::UnknownFailure,
                0.5,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: format!("Unclassified error: {}", error),
                },
            ),
        }
    }

    /// Classify API error responses.
    fn classify_api_error(
        status: u16,
        message: &str,
        context: &FailureContext,
    ) -> FailureDiagnosis {
        match status {
            301 | 302 | 307 | 308 => {
                // Redirect - likely endpoint migration
                let new_url = context
                    .response_headers
                    .get("location")
                    .or_else(|| context.response_headers.get("Location"))
                    .cloned();

                if let Some(location) = new_url {
                    FailureDiagnosis::new(
                        FailureKind::EndpointMigrated,
                        0.95,
                        crate::healing::repair::RepairStrategy::SwitchEndpoint {
                            new_base_url: location.clone(),
                        },
                    )
                    .with_evidence(format!("HTTP {} redirect to {}", status, location))
                } else {
                    FailureDiagnosis::new(
                        FailureKind::EndpointMigrated,
                        0.7,
                        crate::healing::repair::RepairStrategy::EscalateToHuman {
                            reason: "Redirect without Location header".to_string(),
                        },
                    )
                    .with_evidence(format!("HTTP {} redirect without location", status))
                }
            }

            401 | 403 => {
                // Authentication/authorization failure
                FailureDiagnosis::new(
                    FailureKind::AuthExpired,
                    0.9,
                    crate::healing::repair::RepairStrategy::RefreshAuth,
                )
                .with_evidence(format!("HTTP {}: {}", status, message))
            }

            404 => {
                // Check for migration notice in body
                let body_lower = context.response_body_sample.to_lowercase();
                if body_lower.contains("moved")
                    || body_lower.contains("migrated")
                    || body_lower.contains("relocated")
                {
                    FailureDiagnosis::new(
                        FailureKind::EndpointMigrated,
                        0.8,
                        crate::healing::repair::RepairStrategy::EscalateToHuman {
                            reason: "Manual migration notice parsing required".to_string(),
                        },
                    )
                    .with_evidence("404 with migration keywords in response body".to_string())
                } else if body_lower.contains("deprecated") {
                    FailureDiagnosis::new(
                        FailureKind::ServiceDeprecated,
                        0.85,
                        crate::healing::repair::RepairStrategy::MarkUnavailable,
                    )
                    .with_evidence("404 with deprecation notice".to_string())
                } else {
                    FailureDiagnosis::new(
                        FailureKind::MalformedRequest,
                        0.6,
                        crate::healing::repair::RepairStrategy::EscalateToHuman {
                            reason: "Resource not found".to_string(),
                        },
                    )
                    .with_evidence(format!("HTTP 404: {}", message))
                }
            }

            410 => {
                // Gone - permanently deprecated
                FailureDiagnosis::new(
                    FailureKind::ServiceDeprecated,
                    1.0,
                    crate::healing::repair::RepairStrategy::MarkUnavailable,
                )
                .with_evidence(format!("HTTP 410 Gone: {}", message))
            }

            429 => {
                // Rate limiting
                let retry_after = context
                    .response_headers
                    .get("retry-after")
                    .or_else(|| context.response_headers.get("Retry-After"))
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(60);

                FailureDiagnosis::new(
                    FailureKind::RateLimitExhausted,
                    1.0,
                    crate::healing::repair::RepairStrategy::BackoffAndRetry {
                        delay_secs: retry_after,
                    },
                )
                .with_evidence(format!("HTTP 429, retry after {} seconds", retry_after))
            }

            400 => {
                // Bad request - malformed input
                FailureDiagnosis::new(
                    FailureKind::MalformedRequest,
                    0.85,
                    crate::healing::repair::RepairStrategy::EscalateToHuman {
                        reason: format!("Invalid request: {}", message),
                    },
                )
                .with_evidence(format!("HTTP 400: {}", message))
            }

            500..=599 => {
                // Server error - retry with backoff
                FailureDiagnosis::new(
                    FailureKind::NetworkPartition,
                    0.7,
                    crate::healing::repair::RepairStrategy::BackoffAndRetry { delay_secs: 10 },
                )
                .with_evidence(format!("HTTP {} server error: {}", status, message))
            }

            _ => FailureDiagnosis::new(
                FailureKind::UnknownFailure,
                0.5,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: format!("HTTP {}: {}", status, message),
                },
            ),
        }
    }

    /// Classify reqwest errors.
    fn classify_request_failure(
        reqwest_err: &reqwest::Error,
        _context: &FailureContext,
    ) -> FailureDiagnosis {
        if reqwest_err.is_timeout() {
            FailureDiagnosis::new(
                FailureKind::NetworkPartition,
                0.95,
                crate::healing::repair::RepairStrategy::BackoffAndRetry { delay_secs: 5 },
            )
            .with_evidence("Connection timeout".to_string())
        } else if reqwest_err.is_connect() {
            FailureDiagnosis::new(
                FailureKind::NetworkPartition,
                0.9,
                crate::healing::repair::RepairStrategy::BackoffAndRetry { delay_secs: 10 },
            )
            .with_evidence("Connection failed".to_string())
        } else if reqwest_err.is_redirect() {
            FailureDiagnosis::new(
                FailureKind::EndpointMigrated,
                0.8,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: "Too many redirects".to_string(),
                },
            )
            .with_evidence("Redirect loop detected".to_string())
        } else {
            FailureDiagnosis::new(
                FailureKind::UnknownFailure,
                0.6,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: format!("Request error: {}", reqwest_err),
                },
            )
            .with_evidence(format!("reqwest error: {}", reqwest_err))
        }
    }

    /// Classify deserialization errors.
    fn classify_deserialization_error(context: &FailureContext) -> FailureDiagnosis {
        // If status was 200, likely a data format change
        if context.status_code == Some(200) {
            FailureDiagnosis::new(
                FailureKind::DataFormatChanged,
                0.85,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: "API response schema changed".to_string(),
                },
            )
            .with_evidence("Successful HTTP status but deserialization failed".to_string())
            .with_evidence(format!(
                "Response body sample: {}",
                &context.response_body_sample[..context.response_body_sample.len().min(200)]
            ))
        } else {
            FailureDiagnosis::new(
                FailureKind::MalformedRequest,
                0.7,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: "Unexpected response format".to_string(),
                },
            )
            .with_evidence("Deserialization failed with non-200 status".to_string())
        }
    }

    /// Classify not found errors.
    fn classify_not_found(resource: &str, context: &FailureContext) -> FailureDiagnosis {
        let body_lower = context.response_body_sample.to_lowercase();
        if body_lower.contains("deprecated") || body_lower.contains("no longer available") {
            FailureDiagnosis::new(
                FailureKind::ServiceDeprecated,
                0.8,
                crate::healing::repair::RepairStrategy::MarkUnavailable,
            )
            .with_evidence(format!(
                "Resource not found with deprecation notice: {}",
                resource
            ))
        } else {
            FailureDiagnosis::new(
                FailureKind::MalformedRequest,
                0.7,
                crate::healing::repair::RepairStrategy::EscalateToHuman {
                    reason: format!("Resource not found: {}", resource),
                },
            )
            .with_evidence(format!("404 for resource: {}", resource))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_failure_context_sanitization() {
        let context = FailureContext::new("test_client", "https://api.example.com", 1).with_params(
            serde_json::json!({
                "query": "test",
                "api_key": "secret123",
                "token": "bearer_xyz"
            }),
        );

        assert_eq!(context.request_params["query"], "test");
        assert_eq!(context.request_params["api_key"], "[REDACTED]");
        assert_eq!(context.request_params["token"], "[REDACTED]");
    }

    #[test]
    fn test_classify_rate_limit() {
        let error = BioApiError::RateLimitExceeded {
            retry_after_secs: 60,
        };
        let context = FailureContext::new("test", "https://api.example.com", 3);
        let diagnosis = FailureClassifier::classify(&error, &context);

        assert_eq!(diagnosis.kind, FailureKind::RateLimitExhausted);
        assert_eq!(diagnosis.confidence, 1.0);
        assert!(matches!(
            diagnosis.suggested_strategy,
            crate::healing::repair::RepairStrategy::BackoffAndRetry { delay_secs: 60 }
        ));
    }

    #[test]
    fn test_classify_auth_expired() {
        let error = BioApiError::ApiError {
            status: 401,
            message: "Unauthorized".to_string(),
        };
        let context = FailureContext::new("test", "https://api.example.com", 1);
        let diagnosis = FailureClassifier::classify(&error, &context);

        assert_eq!(diagnosis.kind, FailureKind::AuthExpired);
        assert_eq!(diagnosis.confidence, 0.9);
    }

    #[test]
    fn test_classify_endpoint_migrated() {
        let error = BioApiError::ApiError {
            status: 301,
            message: "Moved Permanently".to_string(),
        };
        let mut context = FailureContext::new("test", "https://api.example.com/old", 1);
        context.response_headers.insert(
            "location".to_string(),
            "https://api.example.com/new".to_string(),
        );

        let diagnosis = FailureClassifier::classify(&error, &context);

        assert_eq!(diagnosis.kind, FailureKind::EndpointMigrated);
        assert!(diagnosis.confidence > 0.9);
        assert!(matches!(
            diagnosis.suggested_strategy,
            crate::healing::repair::RepairStrategy::SwitchEndpoint { .. }
        ));
    }

    #[test]
    fn test_classify_service_deprecated() {
        let error = BioApiError::ApiError {
            status: 410,
            message: "Gone".to_string(),
        };
        let context = FailureContext::new("test", "https://api.example.com", 1);
        let diagnosis = FailureClassifier::classify(&error, &context);

        assert_eq!(diagnosis.kind, FailureKind::ServiceDeprecated);
        assert_eq!(diagnosis.confidence, 1.0);
    }

    #[test]
    fn test_classify_data_format_changed() {
        let error = BioApiError::DeserializationError(
            serde_json::from_str::<Value>("invalid").unwrap_err(),
        );
        let context = FailureContext::new("test", "https://api.example.com", 1)
            .with_status(200)
            .with_body_sample(r#"{"unexpected": "schema"}"#);

        let diagnosis = FailureClassifier::classify(&error, &context);

        assert_eq!(diagnosis.kind, FailureKind::DataFormatChanged);
        assert!(diagnosis.confidence > 0.8);
    }
}
