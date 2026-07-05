//! ELM (Eukaryotic Linear Motifs) client for protein motif prediction.
//!
//! ELM prediction combines UniProt API lookups with local TSV file analysis.
//! This client handles the UniProt search component and defines data structures
//! for the complete ELM workflow.
//!
//! Documentation: http://elm.eu.org/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

const UNIPROT_BASE_URL: &str = "https://rest.uniprot.org/uniprotkb/search";
const REQUESTS_PER_SECOND: u32 = 10;
const CONNECT_TIMEOUT_SECS: u64 = 10;
const READ_TIMEOUT_SECS: u64 = 60;

/// gget ELM client for motif prediction
pub struct ElmClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// UniProt sequence lookup response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniProtSequence {
    pub primary_accession: String,
    pub organism: String,
    pub sequence: String,
    pub sequence_length: usize,
    pub gene_names: Vec<String>,
    pub protein_name: Option<String>,
}

/// ELM ortholog match from validated instances
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElmOrtholog {
    pub ortholog_uniprot_acc: String,
    pub protein_name: String,
    pub class_accession: String,
    pub elm_identifier: String,
    pub functional_site_name: String,
    pub description: String,
    pub interaction_domain_id: Option<String>,
    pub interaction_domain_name: Option<String>,
    pub interaction_domain_description: Option<String>,
    pub regex: String,
    pub probability: Option<String>,
    pub methods: Option<String>,
    pub organism: String,
    pub query_seq_length: usize,
    pub subject_seq_length: usize,
    pub alignment_length: usize,
    pub identity_percentage: f64,
    pub motif_inside_subject_query_overlap: bool,
    pub query_start: usize,
    pub query_end: usize,
    pub subject_start: usize,
    pub subject_end: usize,
    pub motif_start_in_subject: Option<usize>,
    pub motif_end_in_subject: Option<usize>,
    pub references: Option<String>,
    pub instance_logic: Option<String>,
    pub pdb: Option<String>,
    pub num_instances: Option<u32>,
    pub num_instances_in_pdb: Option<u32>,
}

/// ELM regex match from pattern scanning
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElmRegexMatch {
    pub instance_accession: String,
    pub elm_identifier: String,
    pub functional_site_name: String,
    pub elm_type: Option<String>,
    pub description: String,
    pub interaction_domain_id: Option<String>,
    pub interaction_domain_name: Option<String>,
    pub interaction_domain_description: Option<String>,
    pub regex: String,
    pub matched_sequence: String,
    pub motif_start_in_query: usize,
    pub motif_end_in_query: usize,
    pub instance_logic: Option<String>,
    pub num_instances: Option<u32>,
    pub num_instances_in_pdb: Option<u32>,
    // Expanded fields (when expand=true)
    pub protein_name: Option<String>,
    pub organism: Option<String>,
    pub references: Option<String>,
}

/// Complete ELM prediction result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElmPrediction {
    /// Input sequence or UniProt ID
    pub query: String,
    /// Sequence length
    pub sequence_length: usize,
    /// Validated ortholog matches from ELM database
    pub ortholog_matches: Vec<ElmOrtholog>,
    /// Regex pattern matches against query sequence
    pub regex_matches: Vec<ElmRegexMatch>,
    /// Number of unique ELM motifs found
    pub unique_motifs: usize,
}

impl ElmClient {
    /// Create a new gget ELM client
    pub fn new() -> BioApiResult<Self> {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1 (ELM)")
            .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(std::time::Duration::from_secs(READ_TIMEOUT_SECS))
            .build()
            .map_err(|e| BioApiError::Other(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        })
    }

    /// Lookup protein sequence from UniProt by accession ID
    ///
    /// # Arguments
    /// * `uniprot_id` - UniProt accession (e.g., "P12345")
    /// * `reviewed_only` - If true, search only Swiss-Prot (reviewed) entries
    ///
    /// # Returns
    /// UniProt sequence information including amino acid sequence
    pub async fn lookup_uniprot_sequence(
        &self,
        uniprot_id: &str,
        reviewed_only: bool,
    ) -> BioApiResult<UniProtSequence> {
        let query = if reviewed_only {
            format!("{}+AND+reviewed:true", uniprot_id)
        } else {
            uniprot_id.to_string()
        };

        let url = format!("{}?query={}&format=json&size=1", UNIPROT_BASE_URL, query);

        let json: Value = self
            .retry_policy
            .execute("lookup_uniprot_sequence", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "UniProt entry '{}' not found",
                                uniprot_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("UniProt API error: {}", status),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        // Parse UniProt search response
        let results = json["results"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing results array".to_string()))?;

        if results.is_empty() {
            return Err(BioApiError::NotFound(format!(
                "No UniProt entry found for '{}'",
                uniprot_id
            )));
        }

        let entry = &results[0];

        let primary_accession = entry["primaryAccession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing primaryAccession".to_string()))?
            .to_string();

        let organism = entry["organism"]["scientificName"]
            .as_str()
            .unwrap_or("Unknown")
            .to_string();

        let sequence = entry["sequence"]["value"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing sequence value".to_string()))?
            .to_string();

        let sequence_length = entry["sequence"]["length"]
            .as_u64()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing sequence length".to_string()))?
            as usize;

        let gene_names = entry["genes"]
            .as_array()
            .map(|genes| {
                genes
                    .iter()
                    .filter_map(|g| g["geneName"]["value"].as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let protein_name = entry["proteinDescription"]["recommendedName"]["fullName"]["value"]
            .as_str()
            .map(String::from)
            .or_else(|| {
                entry["proteinDescription"]["submittedName"]
                    .as_array()
                    .and_then(|names| names.first())
                    .and_then(|name| name["fullName"]["value"].as_str())
                    .map(String::from)
            });

        Ok(UniProtSequence {
            primary_accession,
            organism,
            sequence,
            sequence_length,
            gene_names,
            protein_name,
        })
    }

    /// Lookup sequence with fallback: try reviewed first, then unreviewed
    ///
    /// This matches the gget elm behavior of trying Swiss-Prot (reviewed) first,
    /// then falling back to TrEMBL (unreviewed) entries.
    pub async fn lookup_sequence_with_fallback(
        &self,
        uniprot_id: &str,
    ) -> BioApiResult<UniProtSequence> {
        // Try reviewed first
        match self.lookup_uniprot_sequence(uniprot_id, true).await {
            Ok(seq) => Ok(seq),
            Err(BioApiError::NotFound(_)) => {
                // Fallback to unreviewed
                self.lookup_uniprot_sequence(uniprot_id, false).await
            }
            Err(e) => Err(e),
        }
    }

    /// Validate amino acid sequence
    ///
    /// Ensures the input is a valid protein sequence containing only standard
    /// amino acid characters.
    pub fn validate_sequence(sequence: &str) -> BioApiResult<()> {
        if sequence.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Sequence cannot be empty".to_string(),
            ));
        }

        let valid_aa = "ACDEFGHIKLMNPQRSTVWY";
        for (i, ch) in sequence.chars().enumerate() {
            let ch_upper = ch.to_ascii_uppercase();
            if !valid_aa.contains(ch_upper) {
                return Err(BioApiError::InvalidInput(format!(
                    "Invalid amino acid '{}' at position {}. Sequence must contain only standard amino acids.",
                    ch, i + 1
                )));
            }
        }

        Ok(())
    }

    /// Parse ELM classes TSV header
    ///
    /// ELM TSV files have 5 comment lines starting with '#' that must be skipped.
    /// This helper can be used to skip headers when parsing local ELM files.
    pub fn should_skip_elm_header(line: &str) -> bool {
        line.trim().starts_with('#') || line.trim().is_empty()
    }
}

impl Default for ElmClient {
    fn default() -> Self {
        Self::new().expect("Failed to create default ElmClient")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = ElmClient::new();
        assert!(client.is_ok());
    }

    #[test]
    fn test_validate_sequence_valid() {
        let seq = "MVHLTPEEKSAVTALWGKVNVDEVGGEALGRLLVVYPWTQRFFESFGDLSTPDAVMGNPKVKAHGKKVLGAFSDGLAHLDNLKGTFATLSELHCDKLHVDPENFRLLGNVLVCVLAHHFGKEFTPPVQAAYQKVVAGVANALAHKYH";
        assert!(ElmClient::validate_sequence(seq).is_ok());
    }

    #[test]
    fn test_validate_sequence_invalid_char() {
        let seq = "MVHLTPX"; // X is ambiguous
        assert!(ElmClient::validate_sequence(seq).is_err());
    }

    #[test]
    fn test_validate_sequence_empty() {
        assert!(ElmClient::validate_sequence("").is_err());
    }

    #[test]
    fn test_validate_sequence_with_numbers() {
        let seq = "MVHL123";
        assert!(ElmClient::validate_sequence(seq).is_err());
    }

    #[test]
    fn test_skip_elm_header() {
        assert!(ElmClient::should_skip_elm_header("# ELM Classes"));
        assert!(ElmClient::should_skip_elm_header("#Accession\tIdentifier"));
        assert!(ElmClient::should_skip_elm_header(""));
        assert!(!ElmClient::should_skip_elm_header("ELME000001\tLIG_14-3-3"));
    }

    #[test]
    fn test_sequence_validation_case_insensitive() {
        let seq_lower = "mvhltpeek";
        let seq_upper = "MVHLTPEEK";
        assert!(ElmClient::validate_sequence(seq_lower).is_ok());
        assert!(ElmClient::validate_sequence(seq_upper).is_ok());
    }
}
