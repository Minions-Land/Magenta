//! UCSC BLAT client for sequence alignment.
//!
//! BLAT (BLAST-Like Alignment Tool) aligns DNA/protein sequences against genome assemblies.
//! Documentation: https://genome.ucsc.edu/cgi-bin/hgBlat

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "https://genome.ucsc.edu/cgi-bin/hgBlat";
const MAX_SEQUENCE_LENGTH: usize = 8000;
const REQUESTS_PER_SECOND: u32 = 1; // Conservative rate limit for UCSC

/// Sequence type for BLAT alignment
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SequenceType {
    /// DNA sequence
    DNA,
    /// Protein sequence
    Protein,
    /// Translated RNA (searches in 3 frames)
    #[serde(rename = "translated RNA")]
    TranslatedRNA,
    /// Translated DNA (searches in 6 frames)
    #[serde(rename = "translated DNA")]
    TranslatedDNA,
}

impl SequenceType {
    /// Convert to UCSC API parameter format
    fn to_api_param(self) -> &'static str {
        match self {
            SequenceType::DNA => "DNA",
            SequenceType::Protein => "protein",
            SequenceType::TranslatedRNA => "translated%20RNA",
            SequenceType::TranslatedDNA => "translated%20DNA",
        }
    }
}

/// BLAT alignment result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlatAlignment {
    /// Number of matching bases
    pub matches: u32,
    /// Number of mismatching bases
    pub mismatches: u32,
    /// Number of bases that match but are part of repeats
    pub rep_matches: u32,
    /// Number of 'N' bases
    pub n_count: u32,
    /// Number of inserts in query
    pub q_num_insert: u32,
    /// Number of bases inserted in query
    pub q_base_insert: u32,
    /// Number of inserts in target
    pub t_num_insert: u32,
    /// Number of bases inserted in target
    pub t_base_insert: u32,
    /// Strand (+ or -)
    pub strand: String,
    /// Query sequence name
    pub q_name: String,
    /// Query sequence size
    pub q_size: u32,
    /// Alignment start position in query (0-based)
    pub q_start: u32,
    /// Alignment end position in query (0-based)
    pub q_end: u32,
    /// Target sequence name (chromosome)
    pub t_name: String,
    /// Target sequence size
    pub t_size: u64,
    /// Alignment start position in target (0-based)
    pub t_start: u64,
    /// Alignment end position in target (0-based)
    pub t_end: u64,
    /// Number of blocks in alignment
    pub block_count: u32,
    /// Comma-separated list of block sizes
    pub block_sizes: String,
    /// Comma-separated list of query block starts
    pub q_starts: String,
    /// Comma-separated list of target block starts
    pub t_starts: String,
    /// Percentage of query aligned (0-100)
    pub percent_aligned: f64,
    /// Percentage of aligned region that matches (0-100)
    pub percent_matched: f64,
}

impl BlatAlignment {
    /// Parse from BLAT API response row
    fn from_api_row(fields: &[String], values: &[serde_json::Value]) -> BioApiResult<Self> {
        let mut data = HashMap::new();
        for (i, field) in fields.iter().enumerate() {
            if let Some(value) = values.get(i) {
                data.insert(field.as_str(), value.clone());
            }
        }

        let get_u32 = |key: &str| -> BioApiResult<u32> {
            data.get(key)
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .ok_or_else(|| {
                    BioApiError::InvalidResponse(format!("Missing or invalid field: {}", key))
                })
        };

        let get_u64 = |key: &str| -> BioApiResult<u64> {
            data.get(key).and_then(|v| v.as_u64()).ok_or_else(|| {
                BioApiError::InvalidResponse(format!("Missing or invalid field: {}", key))
            })
        };

        let get_str = |key: &str| -> BioApiResult<String> {
            data.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| {
                    BioApiError::InvalidResponse(format!("Missing or invalid field: {}", key))
                })
        };

        let matches = get_u32("matches")?;
        let mismatches = get_u32("misMatches")?;
        let q_size = get_u32("qSize")?;
        let q_start = get_u32("qStart")?;
        let q_end = get_u32("qEnd")?;

        // Calculate derived metrics
        let aligned_length = q_end.saturating_sub(q_start);
        let percent_aligned = if q_size > 0 {
            (aligned_length as f64 / q_size as f64) * 100.0
        } else {
            0.0
        };
        let percent_matched = if aligned_length > 0 {
            (matches as f64 / aligned_length as f64) * 100.0
        } else {
            0.0
        };

        Ok(BlatAlignment {
            matches,
            mismatches,
            rep_matches: get_u32("repMatches").unwrap_or(0),
            n_count: get_u32("nCount").unwrap_or(0),
            q_num_insert: get_u32("qNumInsert").unwrap_or(0),
            q_base_insert: get_u32("qBaseInsert").unwrap_or(0),
            t_num_insert: get_u32("tNumInsert").unwrap_or(0),
            t_base_insert: get_u32("tBaseInsert").unwrap_or(0),
            strand: get_str("strand")?,
            q_name: get_str("qName")?,
            q_size,
            q_start,
            q_end,
            t_name: get_str("tName")?,
            t_size: get_u64("tSize")?,
            t_start: get_u64("tStart")?,
            t_end: get_u64("tEnd")?,
            block_count: get_u32("blockCount").unwrap_or(0),
            // PSL block-structure fields are core to an alignment; a missing field
            // signals a BLAT API schema change and must be surfaced, not defaulted
            // to an empty string that masquerades as a valid (empty) alignment.
            block_sizes: get_str("blockSizes")?,
            q_starts: get_str("qStarts")?,
            t_starts: get_str("tStarts")?,
            percent_aligned,
            percent_matched,
        })
    }
}

/// BLAT search results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlatResult {
    /// Genome assembly used
    pub genome: String,
    /// Alignment results
    pub alignments: Vec<BlatAlignment>,
}

/// UCSC BLAT API client
pub struct BlatClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl BlatClient {
    /// Create a new BLAT client with custom retry policy for UCSC throttling
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1 (BLAT)")
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| Client::new());

        // UCSC-specific retry policy: longer backoff, more retries
        let retry_policy = RetryPolicy {
            max_retries: 4,
            initial_backoff: Duration::from_millis(1500),
            max_backoff: Duration::from_secs(30),
            backoff_multiplier: 2.0,
            jitter: true,
        };

        Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy,
        }
    }

    /// Auto-detect sequence type from content
    pub fn detect_sequence_type(sequence: &str) -> SequenceType {
        let upper = sequence.to_uppercase();
        let chars: Vec<char> = upper.chars().filter(|c| c.is_alphabetic()).collect();

        if chars.is_empty() {
            return SequenceType::DNA;
        }

        // DNA: only contains A, T, G, C, N
        let dna_chars: std::collections::HashSet<char> =
            ['A', 'T', 'G', 'C', 'N'].iter().cloned().collect();
        let is_dna = chars.iter().all(|c| dna_chars.contains(c));

        if is_dna {
            SequenceType::DNA
        } else {
            // Contains amino acid characters -> protein
            SequenceType::Protein
        }
    }

    /// Map common assembly aliases to UCSC names
    fn normalize_assembly(assembly: &str) -> String {
        match assembly.to_lowercase().as_str() {
            "human" | "h38" | "grch38" => "hg38",
            "human37" | "h37" | "grch37" => "hg19",
            "mouse" | "m39" | "grcm39" => "mm39",
            "mouse38" | "m38" | "grcm38" => "mm10",
            "zebrafinch" => "taeGut2",
            "rat" | "r6" | "rnor6" => "rn6",
            other => other,
        }
        .to_string()
    }

    /// Search genome assembly with DNA or protein sequence
    ///
    /// # Arguments
    /// * `sequence` - DNA or protein sequence (max 8000 characters)
    /// * `sequence_type` - Sequence type (DNA, protein, translated RNA/DNA). If None, auto-detect.
    /// * `assembly` - Genome assembly (e.g., "hg38", "mm39"). Defaults to "hg38".
    ///
    /// # Returns
    /// BLAT search results with alignment hits
    pub async fn search(
        &self,
        sequence: &str,
        sequence_type: Option<SequenceType>,
        assembly: Option<&str>,
    ) -> BioApiResult<BlatResult> {
        // Validate sequence length
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

        // Auto-detect or use provided sequence type
        let seq_type = sequence_type.unwrap_or_else(|| Self::detect_sequence_type(&clean_seq));

        // Normalize assembly name
        let db = Self::normalize_assembly(assembly.unwrap_or("hg38"));

        // Build query parameters
        let uppercase_seq = clean_seq.to_uppercase();
        let params = [
            ("userSeq", uppercase_seq.as_str()),
            ("type", seq_type.to_api_param()),
            ("db", db.as_str()),
            ("output", "json"),
        ];

        let response_json: serde_json::Value = self
            .retry_policy
            .execute("blat_search", || {
                let url = BASE_URL.to_string();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.get(&url).query(&params).send().await?;

                    let status = response.status();

                    // UCSC may return 429 or 503 under load
                    if status.as_u16() == 429 || status.as_u16() == 503 {
                        return Err(BioApiError::RateLimitExceeded {
                            retry_after_secs: 2,
                        });
                    }

                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("UCSC BLAT API error: {}", status),
                        });
                    }

                    // Check if response is JSON (UCSC sometimes returns HTML error pages)
                    let content_type = response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");

                    if !content_type.contains("json") {
                        let text = response.text().await?;
                        if text.contains("<html") || text.contains("<!DOCTYPE") {
                            // HTML error page - treat as rate limit
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 3,
                            });
                        }
                        return Err(BioApiError::InvalidResponse(
                            "Expected JSON, got HTML or plain text".to_string(),
                        ));
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        // Parse response
        self.parse_blat_response(response_json)
    }

    /// Parse BLAT API JSON response
    fn parse_blat_response(&self, json: serde_json::Value) -> BioApiResult<BlatResult> {
        let genome = json["genome"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing 'genome' field".to_string()))?
            .to_string();

        let fields = json["fields"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing 'fields' array".to_string()))?
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect::<Vec<_>>();

        let blat_rows = json["blat"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing 'blat' array".to_string()))?;

        let mut alignments = Vec::new();
        for row in blat_rows {
            let values = row.as_array().ok_or_else(|| {
                BioApiError::InvalidResponse("Invalid BLAT row format".to_string())
            })?;

            let alignment = BlatAlignment::from_api_row(&fields, values)?;
            alignments.push(alignment);
        }

        Ok(BlatResult { genome, alignments })
    }
}

impl Default for BlatClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequence_type_detection() {
        assert_eq!(
            BlatClient::detect_sequence_type("ATGCGATCGATCG"),
            SequenceType::DNA
        );
        assert_eq!(
            BlatClient::detect_sequence_type("ATGCNATCN"),
            SequenceType::DNA
        );
        assert_eq!(
            BlatClient::detect_sequence_type("MKTAYIAKQRQISFVKSHFS"),
            SequenceType::Protein
        );
        assert_eq!(
            BlatClient::detect_sequence_type("atgcgatcg"),
            SequenceType::DNA
        );
    }

    #[test]
    fn test_assembly_normalization() {
        assert_eq!(BlatClient::normalize_assembly("human"), "hg38");
        assert_eq!(BlatClient::normalize_assembly("HUMAN"), "hg38");
        assert_eq!(BlatClient::normalize_assembly("grch38"), "hg38");
        assert_eq!(BlatClient::normalize_assembly("mouse"), "mm39");
        assert_eq!(BlatClient::normalize_assembly("mm39"), "mm39");
        assert_eq!(BlatClient::normalize_assembly("zebrafinch"), "taeGut2");
        assert_eq!(BlatClient::normalize_assembly("hg38"), "hg38");
    }

    #[tokio::test]
    async fn test_sequence_validation() {
        let client = BlatClient::new();

        // Empty sequence
        let result = client.search("", None, None).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));

        // Too long sequence
        let long_seq = "A".repeat(MAX_SEQUENCE_LENGTH + 1);
        let result = client.search(&long_seq, None, None).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_client_creation() {
        let client = BlatClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_sequence_type_api_param() {
        assert_eq!(SequenceType::DNA.to_api_param(), "DNA");
        assert_eq!(SequenceType::Protein.to_api_param(), "protein");
        assert_eq!(
            SequenceType::TranslatedRNA.to_api_param(),
            "translated%20RNA"
        );
        assert_eq!(
            SequenceType::TranslatedDNA.to_api_param(),
            "translated%20DNA"
        );
    }

    #[test]
    fn test_parse_blat_response_empty() {
        let client = BlatClient::new();
        let json = serde_json::json!({
            "genome": "hg38",
            "fields": ["matches", "misMatches", "qName", "qSize", "qStart", "qEnd",
                       "tName", "tStart", "tEnd", "strand", "tSize"],
            "blat": []
        });

        let result = client.parse_blat_response(json).unwrap();
        assert_eq!(result.genome, "hg38");
        assert_eq!(result.alignments.len(), 0);
    }

    #[test]
    fn test_parse_blat_response_single_hit() {
        let client = BlatClient::new();
        let json = serde_json::json!({
            "genome": "hg38",
            "fields": [
                "matches", "misMatches", "repMatches", "nCount",
                "qNumInsert", "qBaseInsert", "tNumInsert", "tBaseInsert",
                "strand", "qName", "qSize", "qStart", "qEnd",
                "tName", "tSize", "tStart", "tEnd", "blockCount",
                "blockSizes", "qStarts", "tStarts"
            ],
            "blat": [[
                100, 5, 0, 0,
                0, 0, 0, 0,
                "+", "query1", 120, 10, 110,
                "chr1", 248956422, 1000000, 1000100, 1,
                "100,", "10,", "1000000,"
            ]]
        });

        let result = client.parse_blat_response(json).unwrap();
        assert_eq!(result.genome, "hg38");
        assert_eq!(result.alignments.len(), 1);

        let alignment = &result.alignments[0];
        assert_eq!(alignment.matches, 100);
        assert_eq!(alignment.mismatches, 5);
        assert_eq!(alignment.q_name, "query1");
        assert_eq!(alignment.t_name, "chr1");
        assert_eq!(alignment.strand, "+");
        assert!(alignment.percent_aligned > 0.0);
        assert!(alignment.percent_matched > 0.0);
    }
}
