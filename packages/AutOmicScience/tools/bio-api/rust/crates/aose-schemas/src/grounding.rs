//! Evidence-first grounding schemas for bio agent integration.
//!
//! This module provides types for tracking evidence, execution traces, and
//! confidence levels in agent responses, following an evidence-first model.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Source type for evidence records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    /// Evidence from tool execution (e.g., Python REPL, shell command)
    Tool,
    /// Evidence from database query (e.g., GEO, NCBI, UniProt)
    Database,
    /// Evidence from literature search (e.g., PubMed, bioRxiv)
    Literature,
    /// Evidence from computational analysis (e.g., ML model, statistical test)
    Computation,
    /// Evidence from manual annotation or user input
    Manual,
}

/// A single evidence record linking a claim to its source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRecord {
    /// Source type (tool, database, literature, etc.)
    pub source: EvidenceSource,
    /// Human-readable source name (e.g., "scanpy", "GEO", "PubMed")
    pub source_type: String,
    /// Unique identifier for this evidence (e.g., file path, accession, DOI)
    pub identifier: String,
    /// Optional URL for retrieving the evidence
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// ISO 8601 timestamp when evidence was collected
    pub timestamp: String,
    /// Evidence content (summary, excerpt, or full data)
    pub content: String,
    /// Additional structured metadata
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, serde_json::Value>,
}

impl EvidenceRecord {
    /// Validates that required fields are non-empty.
    pub fn validate(&self) -> Result<()> {
        if self.source_type.is_empty() {
            return Err(anyhow!("EvidenceRecord.source_type must not be empty"));
        }
        if self.identifier.is_empty() {
            return Err(anyhow!("EvidenceRecord.identifier must not be empty"));
        }
        Ok(())
    }

    /// Creates evidence from a tool execution.
    pub fn from_tool(
        tool_name: impl Into<String>,
        identifier: impl Into<String>,
        content: impl Into<String>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            source: EvidenceSource::Tool,
            source_type: tool_name.into(),
            identifier: identifier.into(),
            url: None,
            timestamp: timestamp.into(),
            content: content.into(),
            metadata: HashMap::new(),
        }
    }

    /// Creates evidence from a database query.
    pub fn from_database(
        db_name: impl Into<String>,
        accession: impl Into<String>,
        content: impl Into<String>,
        timestamp: impl Into<String>,
        url: Option<String>,
    ) -> Self {
        Self {
            source: EvidenceSource::Database,
            source_type: db_name.into(),
            identifier: accession.into(),
            url,
            timestamp: timestamp.into(),
            content: content.into(),
            metadata: HashMap::new(),
        }
    }

    /// Creates evidence from literature.
    pub fn from_literature(
        source: impl Into<String>,
        doi_or_id: impl Into<String>,
        content: impl Into<String>,
        timestamp: impl Into<String>,
        url: Option<String>,
    ) -> Self {
        Self {
            source: EvidenceSource::Literature,
            source_type: source.into(),
            identifier: doi_or_id.into(),
            url,
            timestamp: timestamp.into(),
            content: content.into(),
            metadata: HashMap::new(),
        }
    }

    /// Creates evidence from a computational analysis.
    pub fn from_computation(
        analysis_name: impl Into<String>,
        identifier: impl Into<String>,
        content: impl Into<String>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            source: EvidenceSource::Computation,
            source_type: analysis_name.into(),
            identifier: identifier.into(),
            url: None,
            timestamp: timestamp.into(),
            content: content.into(),
            metadata: HashMap::new(),
        }
    }

    /// Creates evidence from manual annotation.
    pub fn from_manual(
        annotator: impl Into<String>,
        identifier: impl Into<String>,
        content: impl Into<String>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            source: EvidenceSource::Manual,
            source_type: annotator.into(),
            identifier: identifier.into(),
            url: None,
            timestamp: timestamp.into(),
            content: content.into(),
            metadata: HashMap::new(),
        }
    }

    /// Adds metadata to this evidence record.
    pub fn with_metadata(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.metadata.insert(key.into(), value);
        self
    }
}

/// Execution status for a trace step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceStatus {
    /// Step completed successfully
    Success,
    /// Step failed with error
    Error,
    /// Step was skipped
    Skipped,
    /// Step is still running
    Pending,
}

/// A single step in the agent's execution trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceStep {
    /// Tool or service name (e.g., "python_repl", "web_search")
    pub tool_name: String,
    /// Input to the tool (arguments, query, code)
    pub input: serde_json::Value,
    /// Output from the tool (result, stdout, error message)
    pub output: serde_json::Value,
    /// Execution status
    pub status: TraceStatus,
    /// Execution time in milliseconds
    pub latency_ms: u64,
    /// ISO 8601 timestamp when step started
    pub timestamp: String,
    /// Optional error message if status is Error
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TraceStep {
    /// Creates a successful trace step.
    pub fn success(
        tool_name: impl Into<String>,
        input: serde_json::Value,
        output: serde_json::Value,
        latency_ms: u64,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            tool_name: tool_name.into(),
            input,
            output,
            status: TraceStatus::Success,
            latency_ms,
            timestamp: timestamp.into(),
            error: None,
        }
    }

    /// Creates a failed trace step.
    pub fn error(
        tool_name: impl Into<String>,
        input: serde_json::Value,
        error: impl Into<String>,
        latency_ms: u64,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            tool_name: tool_name.into(),
            input,
            output: serde_json::Value::Null,
            status: TraceStatus::Error,
            latency_ms,
            timestamp: timestamp.into(),
            error: Some(error.into()),
        }
    }
}

/// A record of a deterministic transformation applied to raw retrieved data.
///
/// This is the heart of "processing transparency": when a tool (or the agent
/// via a tool) derives a value from raw API data — filtering, classifying,
/// aggregating, normalizing — that transformation must be recorded so the
/// derived number in the report is explainable and reproducible, not a silent
/// LLM rewrite. Each step names the operation, its parameters, and a compact
/// description of what went in and what came out. Bioinformatics standard
/// methods (e.g. variant-consequence classification, TPM thresholds, count
/// sampling) are exactly the steps that must never be invisible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingStep {
    /// Canonical operation name, e.g. "filter", "classify", "aggregate",
    /// "sample", "normalize", "threshold", "join".
    pub operation: String,
    /// Human-readable statement of the transformation rule applied.
    pub description: String,
    /// Structured parameters of the transformation (thresholds, mappings, n).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub params: HashMap<String, serde_json::Value>,
    /// Compact description of the input the step consumed (e.g. "30 of 7233
    /// ClinVar records"). Makes sampling/coverage gaps explicit.
    pub input_summary: String,
    /// Compact description of the output the step produced.
    pub output_summary: String,
    /// True if the output is a sample/subset of the full data — flags that
    /// downstream proportions are NOT computed over the complete dataset.
    #[serde(default)]
    pub is_partial: bool,
    /// ISO 8601 timestamp.
    pub timestamp: String,
}

impl ProcessingStep {
    pub fn new(
        operation: impl Into<String>,
        description: impl Into<String>,
        input_summary: impl Into<String>,
        output_summary: impl Into<String>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            operation: operation.into(),
            description: description.into(),
            params: HashMap::new(),
            input_summary: input_summary.into(),
            output_summary: output_summary.into(),
            is_partial: false,
            timestamp: timestamp.into(),
        }
    }

    pub fn with_param(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.params.insert(key.into(), value);
        self
    }

    /// Mark this step's output as a partial sample of the full dataset.
    pub fn partial(mut self) -> Self {
        self.is_partial = true;
        self
    }

    pub fn validate(&self) -> Result<()> {
        if self.operation.is_empty() {
            return Err(anyhow!("ProcessingStep.operation must not be empty"));
        }
        Ok(())
    }
}

/// Confidence level for agent responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// High confidence: strong evidence, consistent results
    High,
    /// Medium confidence: partial evidence, some uncertainty
    Medium,
    /// Low confidence: weak evidence, conflicting signals
    Low,
    /// Uncertain: insufficient evidence or unreliable sources
    Uncertain,
}

impl Confidence {
    /// Converts confidence to a numeric score (0.0 = uncertain, 1.0 = high).
    pub fn to_score(&self) -> f64 {
        match self {
            Confidence::High => 1.0,
            Confidence::Medium => 0.66,
            Confidence::Low => 0.33,
            Confidence::Uncertain => 0.0,
        }
    }

    /// Creates confidence from a numeric score (0.0-1.0).
    pub fn from_score(score: f64) -> Self {
        if score >= 0.85 {
            Confidence::High
        } else if score >= 0.5 {
            Confidence::Medium
        } else if score >= 0.2 {
            Confidence::Low
        } else {
            Confidence::Uncertain
        }
    }
}

/// A grounded response with evidence and execution trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroundedResponse {
    /// The agent's answer or conclusion
    pub answer: String,
    /// Evidence records supporting the answer
    pub evidence: Vec<EvidenceRecord>,
    /// Execution trace showing how the answer was derived
    pub trace: Vec<TraceStep>,
    /// Confidence level in the answer
    pub confidence: Confidence,
    /// Warnings or caveats about the answer
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

impl GroundedResponse {
    /// Validates that the response has at least one piece of evidence.
    pub fn validate(&self) -> Result<()> {
        if self.answer.is_empty() {
            return Err(anyhow!("GroundedResponse.answer must not be empty"));
        }
        if self.evidence.is_empty() {
            return Err(anyhow!(
                "GroundedResponse must include at least one evidence record"
            ));
        }
        for record in &self.evidence {
            record.validate()?;
        }
        Ok(())
    }

    /// Creates a new grounded response.
    pub fn new(
        answer: impl Into<String>,
        evidence: Vec<EvidenceRecord>,
        trace: Vec<TraceStep>,
        confidence: Confidence,
    ) -> Self {
        Self {
            answer: answer.into(),
            evidence,
            trace,
            confidence,
            warnings: Vec::new(),
        }
    }

    /// Adds a warning to this response.
    pub fn with_warning(mut self, warning: impl Into<String>) -> Self {
        self.warnings.push(warning.into());
        self
    }

    /// Adds multiple warnings to this response.
    pub fn with_warnings(mut self, warnings: impl IntoIterator<Item = String>) -> Self {
        self.warnings.extend(warnings);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_record_validation() {
        let valid = EvidenceRecord::from_tool(
            "scanpy",
            "analysis_001",
            "PCA result",
            "2026-06-08T12:00:00Z",
        );
        assert!(valid.validate().is_ok());

        let invalid_source = EvidenceRecord {
            source: EvidenceSource::Tool,
            source_type: String::new(),
            identifier: "test".to_string(),
            url: None,
            timestamp: "2026-06-08T12:00:00Z".to_string(),
            content: "data".to_string(),
            metadata: HashMap::new(),
        };
        assert!(invalid_source.validate().is_err());

        let invalid_id = EvidenceRecord {
            source: EvidenceSource::Database,
            source_type: "GEO".to_string(),
            identifier: String::new(),
            url: None,
            timestamp: "2026-06-08T12:00:00Z".to_string(),
            content: "data".to_string(),
            metadata: HashMap::new(),
        };
        assert!(invalid_id.validate().is_err());
    }

    #[test]
    fn confidence_score_conversion() {
        assert_eq!(Confidence::High.to_score(), 1.0);
        assert_eq!(Confidence::Medium.to_score(), 0.66);
        assert_eq!(Confidence::Low.to_score(), 0.33);
        assert_eq!(Confidence::Uncertain.to_score(), 0.0);

        assert_eq!(Confidence::from_score(0.9), Confidence::High);
        assert_eq!(Confidence::from_score(0.6), Confidence::Medium);
        assert_eq!(Confidence::from_score(0.3), Confidence::Low);
        assert_eq!(Confidence::from_score(0.1), Confidence::Uncertain);
    }

    #[test]
    fn grounded_response_validation() {
        let evidence = vec![EvidenceRecord::from_tool(
            "python_repl",
            "exec_001",
            "Analysis complete",
            "2026-06-08T12:00:00Z",
        )];
        let trace = vec![TraceStep::success(
            "python_repl",
            serde_json::json!({"code": "import scanpy"}),
            serde_json::json!({"success": true}),
            150,
            "2026-06-08T12:00:00Z",
        )];

        let valid = GroundedResponse::new(
            "Result: 42",
            evidence.clone(),
            trace.clone(),
            Confidence::High,
        );
        assert!(valid.validate().is_ok());

        let no_evidence =
            GroundedResponse::new("Result: 42", vec![], trace.clone(), Confidence::High);
        assert!(no_evidence.validate().is_err());

        let empty_answer = GroundedResponse::new("", evidence, trace, Confidence::High);
        assert!(empty_answer.validate().is_err());
    }

    #[test]
    fn evidence_constructors() {
        let tool_evidence =
            EvidenceRecord::from_tool("scanpy", "run_001", "PCA done", "2026-06-08T12:00:00Z");
        assert_eq!(tool_evidence.source, EvidenceSource::Tool);
        assert_eq!(tool_evidence.source_type, "scanpy");

        let db_evidence = EvidenceRecord::from_database(
            "GEO",
            "GSE12345",
            "Dataset metadata",
            "2026-06-08T12:00:00Z",
            Some("https://ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE12345".to_string()),
        );
        assert_eq!(db_evidence.source, EvidenceSource::Database);
        assert!(db_evidence.url.is_some());

        let lit_evidence = EvidenceRecord::from_literature(
            "PubMed",
            "10.1038/s41586-020-2157-4",
            "Abstract text",
            "2026-06-08T12:00:00Z",
            Some("https://doi.org/10.1038/s41586-020-2157-4".to_string()),
        );
        assert_eq!(lit_evidence.source, EvidenceSource::Literature);
    }

    #[test]
    fn trace_step_constructors() {
        let success = TraceStep::success(
            "python_repl",
            serde_json::json!({"code": "1 + 1"}),
            serde_json::json!({"result": 2}),
            50,
            "2026-06-08T12:00:00Z",
        );
        assert_eq!(success.status, TraceStatus::Success);
        assert!(success.error.is_none());

        let error = TraceStep::error(
            "python_repl",
            serde_json::json!({"code": "1 / 0"}),
            "ZeroDivisionError",
            30,
            "2026-06-08T12:00:00Z",
        );
        assert_eq!(error.status, TraceStatus::Error);
        assert!(error.error.is_some());
    }

    #[test]
    fn processing_step_records_transformation() {
        let step = ProcessingStep::new(
            "sample",
            "Returned first 30 of 7233 ClinVar records",
            "7233 records",
            "30 sampled records",
            "2026-06-08T12:00:00Z",
        )
        .with_param("retmax", serde_json::json!(30))
        .partial();
        assert!(step.validate().is_ok());
        assert!(step.is_partial);
        assert_eq!(step.params.get("retmax"), Some(&serde_json::json!(30)));

        let empty_op = ProcessingStep::new("", "x", "i", "o", "t");
        assert!(empty_op.validate().is_err());
    }
}
