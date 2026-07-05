//! Diagnostic agent spawn and execution for API failure analysis.
//!
//! This module defines traits for spawning diagnostic agents without directly
//! depending on aos-core. Implementations are provided in aos-core that wire
//! up the actual Agent infrastructure.

use super::classifier::{FailureContext, FailureDiagnosis, FailureKind};
use super::repair::RepairStrategy;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;

/// Diagnostic agent spawner trait.
///
/// Implementations spawn specialized agents to diagnose API failures
/// and propose repair strategies. The actual implementation lives in
/// aos-core and uses the Agent infrastructure.
#[async_trait]
pub trait DiagnosticAgentSpawner: Send + Sync {
    /// Spawn a diagnostic agent for the given failure.
    async fn spawn_diagnostic_agent(
        &self,
        failure: FailureKind,
        context: FailureContext,
    ) -> Result<Arc<dyn DiagnosticAgent>>;
}

/// Diagnostic agent interface.
///
/// Agents analyze failure contexts, search for migration notices,
/// test endpoints, and propose concrete repair strategies.
#[async_trait]
pub trait DiagnosticAgent: Send + Sync {
    /// Run diagnostic analysis and return a diagnosis with repair strategy.
    async fn diagnose(&self, context: &FailureContext) -> Result<FailureDiagnosis>;

    /// Get the agent's conversation trace (for provenance).
    fn get_trace(&self) -> Vec<AgentTraceEntry>;
}

/// Entry in the agent conversation trace for provenance.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentTraceEntry {
    /// Event type: "text", "tool_call", "tool_result", etc.
    pub event_type: String,
    /// Event payload (JSON)
    pub payload: serde_json::Value,
    /// Timestamp
    pub timestamp: String,
}

/// Utility functions for building diagnostic prompts and parsing agent output.
impl AgentTraceEntry {
    /// Create a new trace entry.
    pub fn new(event_type: impl Into<String>, payload: serde_json::Value) -> Self {
        Self {
            event_type: event_type.into(),
            payload,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Build diagnostic-specific system prompt.
///
/// This prompt template is used by agent implementations to guide
/// the diagnostic process.
pub fn build_diagnostic_prompt(failure: &FailureKind, context: &FailureContext) -> String {
    format!(
        "You are a diagnostic agent analyzing an API failure.\n\n\
         Failure Kind: {:?}\n\
         Endpoint: {}\n\
         Status Code: {:?}\n\
         Client ID: {}\n\n\
         Your task:\n\
         1. Analyze the failure context and classify the root cause\n\
         2. Search for API migration notices or documentation changes if needed\n\
         3. Propose a specific repair strategy with concrete parameters\n\
         4. Return structured JSON with strategy, confidence, evidence, and parameters\n\n\
         Use tools to gather evidence. Be precise and actionable. \
         Focus on automated repair strategies when possible.\n\n\
         Expected JSON format:\n\
         {{\n\
           \"strategy\": \"<SwitchEndpoint|RefreshAuth|BackoffAndRetry|ReduceRequestSize|Fallback|MarkUnavailable|EscalateToHuman>\",\n\
           \"confidence\": <0.0-1.0>,\n\
           \"evidence\": [\"evidence1\", \"evidence2\"],\n\
           \"parameters\": {{ /* strategy-specific params */ }}\n\
         }}",
        failure,
        context.endpoint,
        context.status_code,
        context.client_id
    )
}

/// Tool definitions for diagnostic agents.
///
/// These describe the tools that should be available to diagnostic agents.
/// Actual tool implementations are provided by the agent framework (aos-core).
pub fn get_diagnostic_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "fetch_api_docs".to_string(),
            description: "Fetch current API documentation for analysis".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "base_url": {
                        "type": "string",
                        "description": "Base URL of the API"
                    }
                },
                "required": ["base_url"]
            }),
        },
        ToolSpec {
            name: "test_endpoint".to_string(),
            description: "Test endpoint availability with HTTP HEAD request".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Full URL to test"
                    }
                },
                "required": ["url"]
            }),
        },
        ToolSpec {
            name: "parse_error_details".to_string(),
            description: "Extract structured information from error response".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "response_body": {
                        "type": "string",
                        "description": "Error response body"
                    }
                },
                "required": ["response_body"]
            }),
        },
        ToolSpec {
            name: "search_migration_notice".to_string(),
            description: "Search for API migration or deprecation announcements".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "api_name": {
                        "type": "string",
                        "description": "API name to search for"
                    },
                    "version": {
                        "type": "string",
                        "description": "API version if known"
                    }
                },
                "required": ["api_name"]
            }),
        },
    ]
}

/// Tool specification for diagnostic agents.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Parse diagnosis from agent output.
pub fn parse_diagnosis_from_output(
    output: &str,
    context: &FailureContext,
) -> Result<FailureDiagnosis> {
    // Try to extract JSON from output (may be wrapped in markdown code blocks)
    let json_start = output.find('{');
    let json_end = output.rfind('}');

    if let (Some(start), Some(end)) = (json_start, json_end) {
        let json_str = &output[start..=end];
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
            return parse_diagnosis_from_json(&parsed, context);
        }
    }

    // Fallback: construct diagnosis from text analysis
    construct_fallback_diagnosis(output, context)
}

fn parse_diagnosis_from_json(
    json: &serde_json::Value,
    context: &FailureContext,
) -> Result<FailureDiagnosis> {
    let strategy_type = json
        .get("strategy")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("Missing strategy field"))?;

    let confidence = json
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.7) as f32;

    let evidence: Vec<String> = json
        .get("evidence")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let params = json.get("parameters").cloned().unwrap_or(json!({}));

    // Map strategy type to RepairStrategy
    let strategy = match strategy_type {
        "SwitchEndpoint" => {
            let new_url = params
                .get("new_base_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            RepairStrategy::SwitchEndpoint {
                new_base_url: new_url,
            }
        }
        "RefreshAuth" => RepairStrategy::RefreshAuth,
        "BackoffAndRetry" => {
            let delay = params
                .get("delay_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(30);
            RepairStrategy::BackoffAndRetry { delay_secs: delay }
        }
        "ReduceRequestSize" => {
            let limit = params
                .get("new_limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(100) as u32;
            RepairStrategy::ReduceRequestSize { new_limit: limit }
        }
        "Fallback" => {
            let alt_id = params
                .get("alternative_client_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            RepairStrategy::Fallback {
                alternative_client_id: alt_id,
            }
        }
        "MarkUnavailable" => RepairStrategy::MarkUnavailable,
        "EscalateToHuman" => {
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Manual intervention required")
                .to_string();
            RepairStrategy::EscalateToHuman { reason }
        }
        _ => {
            return Err(anyhow!("Unknown strategy type: {}", strategy_type));
        }
    };

    // Determine failure kind from strategy and evidence
    let kind = infer_failure_kind(&strategy, &evidence, context);

    Ok(FailureDiagnosis {
        kind,
        confidence,
        evidence,
        suggested_strategy: strategy,
    })
}

fn construct_fallback_diagnosis(
    output: &str,
    context: &FailureContext,
) -> Result<FailureDiagnosis> {
    // If agent output doesn't contain structured JSON, construct a basic diagnosis
    let evidence = vec![
        "Agent analysis (unstructured)".to_string(),
        output.chars().take(200).collect(),
    ];

    let strategy = RepairStrategy::EscalateToHuman {
        reason: "Could not parse agent diagnosis, manual review needed".to_string(),
    };

    let kind = if let Some(status) = context.status_code {
        match status {
            401 | 403 => FailureKind::AuthExpired,
            404 => FailureKind::ServiceDeprecated,
            429 => FailureKind::RateLimitExhausted,
            _ => FailureKind::UnknownFailure,
        }
    } else {
        FailureKind::UnknownFailure
    };

    Ok(FailureDiagnosis {
        kind,
        confidence: 0.5,
        evidence,
        suggested_strategy: strategy,
    })
}

fn infer_failure_kind(
    strategy: &RepairStrategy,
    evidence: &[String],
    context: &FailureContext,
) -> FailureKind {
    // Infer failure kind from repair strategy and evidence
    match strategy {
        RepairStrategy::SwitchEndpoint { .. } => FailureKind::EndpointMigrated,
        RepairStrategy::RefreshAuth => FailureKind::AuthExpired,
        RepairStrategy::BackoffAndRetry { .. } => {
            if context.status_code == Some(429) {
                FailureKind::RateLimitExhausted
            } else {
                FailureKind::NetworkPartition
            }
        }
        RepairStrategy::ReduceRequestSize { .. } => FailureKind::MalformedRequest,
        RepairStrategy::Fallback { .. } | RepairStrategy::MarkUnavailable => {
            FailureKind::ServiceDeprecated
        }
        RepairStrategy::EscalateToHuman { .. } => {
            // Try to infer from evidence
            let evidence_text = evidence.join(" ").to_lowercase();
            if evidence_text.contains("schema") || evidence_text.contains("format") {
                FailureKind::DataFormatChanged
            } else if evidence_text.contains("network") || evidence_text.contains("timeout") {
                FailureKind::NetworkPartition
            } else {
                FailureKind::UnknownFailure
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_diagnostic_prompt() {
        let context = FailureContext {
            endpoint: "https://api.example.com/v1/data".to_string(),
            request_params: json!({}),
            response_headers: Default::default(),
            status_code: Some(404),
            response_body_sample: "Not found".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            attempt_count: 3,
            client_id: "test-client".to_string(),
        };

        let prompt = build_diagnostic_prompt(&FailureKind::ServiceDeprecated, &context);

        assert!(prompt.contains("test-client"));
        assert!(prompt.contains("404"));
        assert!(prompt.contains("api.example.com"));
    }

    #[test]
    fn test_parse_diagnosis_from_json() {
        let json = json!({
            "strategy": "RefreshAuth",
            "confidence": 0.9,
            "evidence": ["HTTP 401 error", "Token expired"],
            "parameters": {}
        });

        let context = FailureContext {
            endpoint: "https://api.example.com".to_string(),
            request_params: json!({}),
            response_headers: Default::default(),
            status_code: Some(401),
            response_body_sample: String::new(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            attempt_count: 1,
            client_id: "test".to_string(),
        };

        let diagnosis = parse_diagnosis_from_json(&json, &context).unwrap();

        assert_eq!(diagnosis.kind, FailureKind::AuthExpired);
        assert!((diagnosis.confidence - 0.9).abs() < 0.01);
        assert!(matches!(
            diagnosis.suggested_strategy,
            RepairStrategy::RefreshAuth
        ));
    }

    #[test]
    fn test_infer_failure_kind_from_strategy() {
        let context = FailureContext {
            endpoint: "https://api.example.com".to_string(),
            request_params: json!({}),
            response_headers: Default::default(),
            status_code: Some(429),
            response_body_sample: String::new(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            attempt_count: 1,
            client_id: "test".to_string(),
        };

        let strategy = RepairStrategy::BackoffAndRetry { delay_secs: 60 };
        let kind = infer_failure_kind(&strategy, &[], &context);

        assert_eq!(kind, FailureKind::RateLimitExhausted);
    }

    #[test]
    fn test_parse_diagnosis_from_output_with_json() {
        let output = r#"
        Based on the analysis, here's the diagnosis:

        ```json
        {
            "strategy": "BackoffAndRetry",
            "confidence": 0.85,
            "evidence": ["Rate limit exceeded", "Retry-After header present"],
            "parameters": {
                "delay_secs": 60
            }
        }
        ```
        "#;

        let context = FailureContext {
            endpoint: "https://api.example.com".to_string(),
            request_params: json!({}),
            response_headers: Default::default(),
            status_code: Some(429),
            response_body_sample: String::new(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            attempt_count: 1,
            client_id: "test".to_string(),
        };

        let diagnosis = parse_diagnosis_from_output(output, &context).unwrap();

        assert_eq!(diagnosis.kind, FailureKind::RateLimitExhausted);
        assert!((diagnosis.confidence - 0.85).abs() < 0.01);
    }

    #[test]
    fn test_construct_fallback_diagnosis() {
        let output = "The API appears to be experiencing issues...";

        let context = FailureContext {
            endpoint: "https://api.example.com".to_string(),
            request_params: json!({}),
            response_headers: Default::default(),
            status_code: None,
            response_body_sample: String::new(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            attempt_count: 1,
            client_id: "test".to_string(),
        };

        let diagnosis = construct_fallback_diagnosis(output, &context).unwrap();

        assert_eq!(diagnosis.kind, FailureKind::UnknownFailure);
        assert_eq!(diagnosis.confidence, 0.5);
        assert!(matches!(
            diagnosis.suggested_strategy,
            RepairStrategy::EscalateToHuman { .. }
        ));
    }

    #[test]
    fn test_get_diagnostic_tool_specs() {
        let specs = get_diagnostic_tool_specs();

        assert_eq!(specs.len(), 4);
        assert!(specs.iter().any(|s| s.name == "fetch_api_docs"));
        assert!(specs.iter().any(|s| s.name == "test_endpoint"));
        assert!(specs.iter().any(|s| s.name == "parse_error_details"));
        assert!(specs.iter().any(|s| s.name == "search_migration_notice"));
    }

    #[test]
    fn test_agent_trace_entry_creation() {
        let entry = AgentTraceEntry::new(
            "tool_call",
            json!({
                "name": "test_tool",
                "args": {}
            }),
        );

        assert_eq!(entry.event_type, "tool_call");
        assert!(!entry.timestamp.is_empty());
    }
}
