//! DIAMOND sequence aligner client.
//!
//! DIAMOND is a high-speed sequence aligner for protein and translated DNA searches.
//! It provides BLAST-like functionality with 100-10,000x faster performance.
//! Documentation: https://github.com/bbuchfink/diamond

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "https://www.ebi.ac.uk/Tools/services/rest/diamond";
const REQUESTS_PER_SECOND: u32 = 2;
const MAX_SEQUENCE_LENGTH: usize = 500000; // 500KB

/// DIAMOND search mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiamondMode {
    /// Align amino acid query sequences against protein database
    Blastp,
    /// Align DNA query sequences against protein database (6-frame translation)
    Blastx,
}

impl DiamondMode {
    fn to_api_param(self) -> &'static str {
        match self {
            DiamondMode::Blastp => "blastp",
            DiamondMode::Blastx => "blastx",
        }
    }
}

/// Output format for DIAMOND results
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutputFormat {
    /// Standard BLAST tabular format
    BlastTab,
    /// XML format
    Xml,
    /// JSON format
    Json,
}

impl OutputFormat {
    // Retained for completeness and unit-tested below; the DIAMOND web API
    // selects the response shape server-side, so this is not sent as a param.
    #[allow(dead_code)]
    fn to_api_param(self) -> &'static str {
        match self {
            OutputFormat::BlastTab => "0",
            OutputFormat::Xml => "5",
            OutputFormat::Json => "100",
        }
    }
}

/// Sensitivity mode for DIAMOND alignment
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SensitivityMode {
    /// Fast mode (default)
    Fast,
    /// Sensitive mode (slower but more sensitive)
    Sensitive,
    /// More sensitive mode
    MoreSensitive,
    /// Very sensitive mode (slowest)
    VerySensitive,
    /// Ultra sensitive mode (extremely slow)
    UltraSensitive,
}

impl SensitivityMode {
    fn to_api_param(self) -> &'static str {
        match self {
            SensitivityMode::Fast => "fast",
            SensitivityMode::Sensitive => "sensitive",
            SensitivityMode::MoreSensitive => "more-sensitive",
            SensitivityMode::VerySensitive => "very-sensitive",
            SensitivityMode::UltraSensitive => "ultra-sensitive",
        }
    }
}

/// DIAMOND alignment result (tabular format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiamondAlignment {
    /// Query sequence ID
    pub query_id: String,
    /// Subject (target) sequence ID
    pub subject_id: String,
    /// Percentage of identical matches
    pub percent_identity: f64,
    /// Alignment length
    pub alignment_length: u32,
    /// Number of mismatches
    pub mismatches: u32,
    /// Number of gap openings
    pub gap_opens: u32,
    /// Start position in query
    pub query_start: u32,
    /// End position in query
    pub query_end: u32,
    /// Start position in subject
    pub subject_start: u32,
    /// End position in subject
    pub subject_end: u32,
    /// Expect value (E-value)
    pub evalue: f64,
    /// Bit score
    pub bit_score: f64,
}

impl DiamondAlignment {
    /// Parse from BLAST tabular format line
    fn from_tabular_line(line: &str) -> BioApiResult<Self> {
        let fields: Vec<&str> = line.split('\t').collect();

        if fields.len() < 12 {
            return Err(BioApiError::InvalidResponse(format!(
                "Invalid tabular format: expected 12 fields, got {}",
                fields.len()
            )));
        }

        Ok(DiamondAlignment {
            query_id: fields[0].to_string(),
            subject_id: fields[1].to_string(),
            percent_identity: fields[2].parse().map_err(|_| {
                BioApiError::InvalidResponse("Invalid percent_identity".to_string())
            })?,
            alignment_length: fields[3].parse().map_err(|_| {
                BioApiError::InvalidResponse("Invalid alignment_length".to_string())
            })?,
            mismatches: fields[4]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid mismatches".to_string()))?,
            gap_opens: fields[5]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid gap_opens".to_string()))?,
            query_start: fields[6]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid query_start".to_string()))?,
            query_end: fields[7]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid query_end".to_string()))?,
            subject_start: fields[8]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid subject_start".to_string()))?,
            subject_end: fields[9]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid subject_end".to_string()))?,
            evalue: fields[10]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid evalue".to_string()))?,
            bit_score: fields[11]
                .parse()
                .map_err(|_| BioApiError::InvalidResponse("Invalid bit_score".to_string()))?,
        })
    }
}

/// DIAMOND search parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiamondSearchParams {
    /// Search mode (blastp or blastx)
    pub mode: DiamondMode,
    /// Reference database
    pub database: String,
    /// Maximum number of target sequences to report
    pub max_target_seqs: Option<u32>,
    /// E-value threshold
    pub evalue: Option<f64>,
    /// Sensitivity mode
    pub sensitivity: Option<SensitivityMode>,
    /// Output format
    pub output_format: Option<OutputFormat>,
    /// Query genetic code (for blastx)
    pub query_gencode: Option<u32>,
}

impl Default for DiamondSearchParams {
    fn default() -> Self {
        Self {
            mode: DiamondMode::Blastp,
            database: "nr".to_string(),
            max_target_seqs: Some(500),
            evalue: Some(0.001),
            sensitivity: Some(SensitivityMode::Sensitive),
            output_format: Some(OutputFormat::BlastTab),
            query_gencode: None,
        }
    }
}

/// DIAMOND search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiamondResult {
    /// Search parameters used
    pub params: DiamondSearchParams,
    /// Alignment results
    pub alignments: Vec<DiamondAlignment>,
    /// Raw output (for non-tabular formats)
    pub raw_output: Option<String>,
}

/// Job status for asynchronous DIAMOND search
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum JobStatus {
    /// Job is queued
    Queued,
    /// Job is running
    Running,
    /// Job finished successfully
    Finished,
    /// Job failed
    Failed,
    /// Job was not found
    NotFound,
}

/// DIAMOND API client
pub struct DiamondClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
    base_url: String,
}

impl DiamondClient {
    /// Create a new DIAMOND client
    pub fn new() -> Self {
        Self::with_base_url(BASE_URL)
    }

    /// Create a new DIAMOND client with custom base URL
    pub fn with_base_url(base_url: &str) -> Self {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1 (DIAMOND)")
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());

        let retry_policy = RetryPolicy {
            max_retries: 3,
            initial_backoff: Duration::from_millis(1000),
            max_backoff: Duration::from_secs(30),
            backoff_multiplier: 2.0,
            jitter: true,
        };

        Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy,
            base_url: base_url.to_string(),
        }
    }

    /// Auto-detect sequence type from content
    pub fn detect_mode(sequence: &str) -> DiamondMode {
        let upper = sequence.to_uppercase();
        let chars: Vec<char> = upper.chars().filter(|c| c.is_alphabetic()).collect();

        if chars.is_empty() {
            return DiamondMode::Blastp;
        }

        // DNA: only contains A, T, G, C, N
        let dna_chars: std::collections::HashSet<char> =
            ['A', 'T', 'G', 'C', 'N'].iter().cloned().collect();
        let is_dna = chars.iter().all(|c| dna_chars.contains(c));

        if is_dna {
            DiamondMode::Blastx // Translate DNA to protein
        } else {
            DiamondMode::Blastp // Direct protein search
        }
    }

    /// Submit a DIAMOND search job (asynchronous)
    ///
    /// # Arguments
    /// * `sequence` - Query sequence (protein or DNA)
    /// * `params` - Search parameters
    ///
    /// # Returns
    /// Job ID for tracking the search
    pub async fn submit_job(
        &self,
        sequence: &str,
        params: &DiamondSearchParams,
    ) -> BioApiResult<String> {
        // Validate sequence
        let clean_seq: String = sequence.chars().filter(|c| !c.is_whitespace()).collect();

        if clean_seq.is_empty() {
            return Err(BioApiError::InvalidInput("Empty sequence".to_string()));
        }

        if clean_seq.len() > MAX_SEQUENCE_LENGTH {
            return Err(BioApiError::InvalidInput(format!(
                "Sequence too long: {} characters (max {})",
                clean_seq.len(),
                MAX_SEQUENCE_LENGTH
            )));
        }

        // Build request parameters
        let mut form_params = vec![
            ("sequence", clean_seq.to_uppercase()),
            ("program", params.mode.to_api_param().to_string()),
            ("database", params.database.clone()),
        ];

        if let Some(max_seqs) = params.max_target_seqs {
            form_params.push(("alignments", max_seqs.to_string()));
        }

        if let Some(evalue) = params.evalue {
            form_params.push(("exp_threshold", evalue.to_string()));
        }

        if let Some(sensitivity) = params.sensitivity {
            form_params.push(("sensitivity", sensitivity.to_api_param().to_string()));
        }

        if let Some(gencode) = params.query_gencode {
            form_params.push(("query_gencode", gencode.to_string()));
        }

        let job_id: String = self
            .retry_policy
            .execute("diamond_submit", || {
                let url = format!("{}/run", self.base_url);
                let params = form_params.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.post(&url).form(&params).send().await?;

                    let status = response.status();

                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("DIAMOND API error: {}", status),
                        });
                    }

                    let job_id = response.text().await?;
                    Ok(job_id.trim().to_string())
                }
            })
            .await?;

        Ok(job_id)
    }

    /// Check the status of a DIAMOND search job
    ///
    /// # Arguments
    /// * `job_id` - Job ID returned from submit_job
    ///
    /// # Returns
    /// Current job status
    pub async fn check_status(&self, job_id: &str) -> BioApiResult<JobStatus> {
        let status_text: String = self
            .retry_policy
            .execute("diamond_status", || {
                let url = format!("{}/status/{}", self.base_url, job_id);
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.get(&url).send().await?;

                    let status = response.status();

                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("DIAMOND status check error: {}", status),
                        });
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await?;

        match status_text.trim().to_uppercase().as_str() {
            "QUEUED" => Ok(JobStatus::Queued),
            "RUNNING" => Ok(JobStatus::Running),
            "FINISHED" => Ok(JobStatus::Finished),
            "FAILED" => Ok(JobStatus::Failed),
            "NOT_FOUND" => Ok(JobStatus::NotFound),
            _ => Err(BioApiError::InvalidResponse(format!(
                "Unknown job status: {}",
                status_text
            ))),
        }
    }

    /// Retrieve results from a finished DIAMOND search job
    ///
    /// # Arguments
    /// * `job_id` - Job ID returned from submit_job
    /// * `params` - Original search parameters (for context)
    ///
    /// # Returns
    /// DIAMOND search results
    pub async fn get_results(
        &self,
        job_id: &str,
        params: &DiamondSearchParams,
    ) -> BioApiResult<DiamondResult> {
        let output_format = params.output_format.unwrap_or(OutputFormat::BlastTab);

        let result_text: String = self
            .retry_policy
            .execute("diamond_results", || {
                let url = format!("{}/result/{}/out", self.base_url, job_id);
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.get(&url).send().await?;

                    let status = response.status();

                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("DIAMOND results retrieval error: {}", status),
                        });
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await?;

        // Parse results based on format
        let alignments = if output_format == OutputFormat::BlastTab {
            self.parse_tabular_results(&result_text)?
        } else {
            Vec::new()
        };

        let raw_output = if output_format != OutputFormat::BlastTab {
            Some(result_text)
        } else {
            None
        };

        Ok(DiamondResult {
            params: params.clone(),
            alignments,
            raw_output,
        })
    }

    /// Run a complete DIAMOND search (submit + wait + retrieve)
    ///
    /// # Arguments
    /// * `sequence` - Query sequence (protein or DNA)
    /// * `params` - Search parameters
    /// * `max_wait_seconds` - Maximum time to wait for results (default: 300)
    ///
    /// # Returns
    /// DIAMOND search results
    pub async fn search(
        &self,
        sequence: &str,
        params: &DiamondSearchParams,
        max_wait_seconds: Option<u64>,
    ) -> BioApiResult<DiamondResult> {
        // Submit job
        let job_id = self.submit_job(sequence, params).await?;

        // Wait for completion
        let max_wait = max_wait_seconds.unwrap_or(300);
        let poll_interval = Duration::from_secs(2);
        let max_polls = max_wait / poll_interval.as_secs();

        for _ in 0..max_polls {
            let status = self.check_status(&job_id).await?;

            match status {
                JobStatus::Finished => {
                    return self.get_results(&job_id, params).await;
                }
                JobStatus::Failed => {
                    return Err(BioApiError::ApiError {
                        status: 500,
                        message: "DIAMOND job failed".to_string(),
                    });
                }
                JobStatus::NotFound => {
                    return Err(BioApiError::ApiError {
                        status: 404,
                        message: "DIAMOND job not found".to_string(),
                    });
                }
                JobStatus::Queued | JobStatus::Running => {
                    tokio::time::sleep(poll_interval).await;
                }
            }
        }

        Err(BioApiError::Timeout {
            operation: format!("DIAMOND search ({}s)", max_wait),
        })
    }

    /// Parse tabular BLAST output format
    fn parse_tabular_results(&self, text: &str) -> BioApiResult<Vec<DiamondAlignment>> {
        let mut alignments = Vec::new();

        for line in text.lines() {
            let trimmed = line.trim();

            // Skip empty lines and comments
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            match DiamondAlignment::from_tabular_line(trimmed) {
                Ok(alignment) => alignments.push(alignment),
                Err(_) => {
                    // Skip malformed lines but continue parsing
                    continue;
                }
            }
        }

        Ok(alignments)
    }
}

impl Default for DiamondClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mode_detection() {
        assert_eq!(
            DiamondClient::detect_mode("ATGCGATCGATCG"),
            DiamondMode::Blastx
        );
        assert_eq!(
            DiamondClient::detect_mode("MKTAYIAKQRQISFVKSHFS"),
            DiamondMode::Blastp
        );
        assert_eq!(DiamondClient::detect_mode("atgcgatcg"), DiamondMode::Blastx);
    }

    #[test]
    fn test_diamond_mode_api_param() {
        assert_eq!(DiamondMode::Blastp.to_api_param(), "blastp");
        assert_eq!(DiamondMode::Blastx.to_api_param(), "blastx");
    }

    #[test]
    fn test_output_format_api_param() {
        assert_eq!(OutputFormat::BlastTab.to_api_param(), "0");
        assert_eq!(OutputFormat::Xml.to_api_param(), "5");
        assert_eq!(OutputFormat::Json.to_api_param(), "100");
    }

    #[test]
    fn test_sensitivity_mode_api_param() {
        assert_eq!(SensitivityMode::Fast.to_api_param(), "fast");
        assert_eq!(SensitivityMode::Sensitive.to_api_param(), "sensitive");
        assert_eq!(
            SensitivityMode::MoreSensitive.to_api_param(),
            "more-sensitive"
        );
        assert_eq!(
            SensitivityMode::VerySensitive.to_api_param(),
            "very-sensitive"
        );
        assert_eq!(
            SensitivityMode::UltraSensitive.to_api_param(),
            "ultra-sensitive"
        );
    }

    #[test]
    fn test_default_params() {
        let params = DiamondSearchParams::default();
        assert_eq!(params.mode, DiamondMode::Blastp);
        assert_eq!(params.database, "nr");
        assert_eq!(params.max_target_seqs, Some(500));
        assert_eq!(params.evalue, Some(0.001));
        assert_eq!(params.sensitivity, Some(SensitivityMode::Sensitive));
    }

    #[test]
    fn test_parse_tabular_line() {
        let line = "query1\tsubject1\t95.5\t100\t4\t1\t1\t100\t50\t149\t1e-50\t200.0";
        let alignment = DiamondAlignment::from_tabular_line(line).unwrap();

        assert_eq!(alignment.query_id, "query1");
        assert_eq!(alignment.subject_id, "subject1");
        assert_eq!(alignment.percent_identity, 95.5);
        assert_eq!(alignment.alignment_length, 100);
        assert_eq!(alignment.mismatches, 4);
        assert_eq!(alignment.gap_opens, 1);
        assert_eq!(alignment.query_start, 1);
        assert_eq!(alignment.query_end, 100);
        assert_eq!(alignment.subject_start, 50);
        assert_eq!(alignment.subject_end, 149);
        assert_eq!(alignment.evalue, 1e-50);
        assert_eq!(alignment.bit_score, 200.0);
    }

    #[test]
    fn test_parse_tabular_results() {
        let client = DiamondClient::new();
        let text = "# DIAMOND tabular output\nquery1\tsubject1\t95.5\t100\t4\t1\t1\t100\t50\t149\t1e-50\t200.0\nquery1\tsubject2\t90.0\t100\t10\t0\t1\t100\t200\t299\t1e-40\t180.0\n";

        let alignments = client.parse_tabular_results(text).unwrap();
        assert_eq!(alignments.len(), 2);
        assert_eq!(alignments[0].subject_id, "subject1");
        assert_eq!(alignments[1].subject_id, "subject2");
    }

    #[tokio::test]
    async fn test_client_creation() {
        let client = DiamondClient::new();
        assert!(std::ptr::addr_of!(client).is_null() == false);
    }

    #[tokio::test]
    async fn test_sequence_validation() {
        let client = DiamondClient::new();
        let params = DiamondSearchParams::default();

        // Empty sequence
        let result = client.submit_job("", &params).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));

        // Too long sequence
        let long_seq = "A".repeat(MAX_SEQUENCE_LENGTH + 1);
        let result = client.submit_job(&long_seq, &params).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_custom_base_url() {
        let client = DiamondClient::with_base_url("https://custom.api.com/diamond");
        assert_eq!(client.base_url, "https://custom.api.com/diamond");
    }

    #[test]
    fn test_parse_invalid_tabular_line() {
        let line = "query1\tsubject1\tinvalid";
        let result = DiamondAlignment::from_tabular_line(line);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_tabular_with_comments() {
        let client = DiamondClient::new();
        let text = "# Comment line\n\nquery1\tsubject1\t95.5\t100\t4\t1\t1\t100\t50\t149\t1e-50\t200.0\n# Another comment\n";

        let alignments = client.parse_tabular_results(text).unwrap();
        assert_eq!(alignments.len(), 1);
    }
}
