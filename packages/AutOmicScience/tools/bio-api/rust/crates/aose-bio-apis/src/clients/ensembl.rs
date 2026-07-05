//! Ensembl REST API client.
//!
//! Documentation: https://rest.ensembl.org

use crate::error::{BioApiError, BioApiResult};
use crate::models::{Fasta, GeneRecord};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tracing::debug;

const BASE_URL: &str = "https://rest.ensembl.org";
const REQUESTS_PER_SECOND: u32 = 15;

/// Ensembl REST API client
pub struct EnsemblClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl EnsemblClient {
    /// Create a new Ensembl client with default configuration
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Create a client with custom retry policy
    pub fn with_retry_policy(retry_policy: RetryPolicy) -> Self {
        Self {
            client: Client::new(),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy,
        }
    }

    /// Search for genes by symbol or ID
    pub async fn search_genes(
        &self,
        query: &str,
        species: Option<&str>,
    ) -> BioApiResult<Vec<GeneRecord>> {
        let species = species.unwrap_or("homo_sapiens");
        let url = format!("{}/lookup/symbol/{}/{}", BASE_URL, species, query);

        let operation = format!("search_genes: {} ({})", query, species);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Gene '{}' not found",
                                query
                            )));
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let message = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }
                    }

                    let json: Value = response.json().await?;

                    // Ensembl returns either a single object or array
                    let results = if json.is_array() {
                        json.as_array().unwrap().clone()
                    } else {
                        vec![json]
                    };

                    let genes: Vec<GeneRecord> = results
                        .iter()
                        .filter_map(|item| self.parse_gene_record(item))
                        .collect();

                    Ok(genes)
                }
            })
            .await
    }

    /// Get detailed gene information
    pub async fn get_gene_info(&self, ensembl_id: &str) -> BioApiResult<GeneRecord> {
        let url = format!("{}/lookup/id/{}", BASE_URL, ensembl_id);

        let operation = format!("get_gene_info: {}", ensembl_id);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .query(&[("expand", "1")])
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Gene ID '{}' not found",
                                ensembl_id
                            )));
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let message = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }
                    }

                    let json: Value = response.json().await?;

                    self.parse_gene_record(&json).ok_or_else(|| {
                        BioApiError::InvalidResponse("Failed to parse gene record".to_string())
                    })
                }
            })
            .await
    }

    /// Get gene sequence in FASTA format
    pub async fn get_sequence(
        &self,
        ensembl_id: &str,
        seq_type: SequenceType,
    ) -> BioApiResult<Fasta> {
        let endpoint = match seq_type {
            SequenceType::Genomic => "sequence/id",
            SequenceType::Cdna => "sequence/id",
            SequenceType::Cds => "sequence/id",
            SequenceType::Protein => "sequence/id",
        };

        let url = format!("{}/{}/{}", BASE_URL, endpoint, ensembl_id);

        let seq_type_param = match seq_type {
            SequenceType::Genomic => "genomic",
            SequenceType::Cdna => "cdna",
            SequenceType::Cds => "cds",
            SequenceType::Protein => "protein",
        };

        let operation = format!("get_sequence: {} ({})", ensembl_id, seq_type_param);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .query(&[("type", seq_type_param)])
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Sequence for '{}' not found",
                                ensembl_id
                            )));
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let message = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }
                    }

                    let json: Value = response.json().await?;

                    let id = json["id"].as_str().unwrap_or(ensembl_id).to_string();

                    let description = json["desc"].as_str().map(|s| s.to_string());

                    let sequence = json["seq"]
                        .as_str()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse(
                                "No sequence field in response".to_string(),
                            )
                        })?
                        .to_string();

                    Ok(Fasta {
                        id,
                        description,
                        sequence,
                    })
                }
            })
            .await
    }

    /// Get reference genome FTP links
    pub async fn get_reference(
        &self,
        species: &str,
        release: Option<u32>,
    ) -> BioApiResult<ReferenceLinks> {
        // Ensembl REST API doesn't directly provide FTP links
        // We construct them based on known FTP structure
        let release = release.unwrap_or(110); // Default to release 110

        let species_lower = species.to_lowercase().replace(' ', "_");

        let ftp_base = format!(
            "https://ftp.ensembl.org/pub/release-{}/fasta/{}/dna",
            release, species_lower
        );

        let gtf_base = format!(
            "https://ftp.ensembl.org/pub/release-{}/gtf/{}",
            release, species_lower
        );

        // Construct typical file names (user needs to verify exact filenames)
        let fasta_dna = format!("{}/{}.dna.primary_assembly.fa.gz", ftp_base, species_lower);
        let fasta_cdna = Some(format!(
            "https://ftp.ensembl.org/pub/release-{}/fasta/{}/cdna/{}.cdna.all.fa.gz",
            release, species_lower, species_lower
        ));
        let gtf = format!("{}/{}.{}.gtf.gz", gtf_base, species_lower, release);

        Ok(ReferenceLinks {
            species: species.to_string(),
            release,
            fasta_dna,
            fasta_cdna,
            gtf,
        })
    }

    /// Parse gene record from JSON
    fn parse_gene_record(&self, json: &Value) -> Option<GeneRecord> {
        Some(GeneRecord {
            gene_id: json["id"].as_str()?.to_string(),
            gene_name: json["display_name"]
                .as_str()
                .or_else(|| json["external_name"].as_str())
                .map(|s| s.to_string()),
            species: json["species"].as_str().unwrap_or("unknown").to_string(),
            chromosome: json["seq_region_name"].as_str().map(|s| s.to_string()),
            start: json["start"].as_u64(),
            end: json["end"].as_u64(),
            strand: json["strand"].as_i64().map(|s| s as i8),
            description: json["description"].as_str().map(|s| s.to_string()),
            biotype: json["biotype"].as_str().map(|s| s.to_string()),
        })
    }
}

impl Default for EnsemblClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Sequence type for retrieval
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SequenceType {
    Genomic,
    Cdna,
    Cds,
    Protein,
}

/// Reference genome FTP links
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceLinks {
    pub species: String,
    pub release: u32,
    pub fasta_dna: String,
    pub fasta_cdna: Option<String>,
    pub gtf: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = EnsemblClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_custom_retry_policy() {
        let policy = RetryPolicy::new(5, std::time::Duration::from_millis(50));
        let client = EnsemblClient::with_retry_policy(policy);
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_parse_gene_record() {
        let client = EnsemblClient::new();
        let json = serde_json::json!({
            "id": "ENSG00000139618",
            "display_name": "BRCA2",
            "species": "homo_sapiens",
            "seq_region_name": "13",
            "start": 32315474,
            "end": 32400266,
            "strand": 1,
            "description": "BRCA2 DNA repair associated",
            "biotype": "protein_coding"
        });

        let record = client.parse_gene_record(&json).unwrap();
        assert_eq!(record.gene_id, "ENSG00000139618");
        assert_eq!(record.gene_name, Some("BRCA2".to_string()));
        assert_eq!(record.species, "homo_sapiens");
        assert_eq!(record.chromosome, Some("13".to_string()));
        assert_eq!(record.start, Some(32315474));
        assert_eq!(record.end, Some(32400266));
        assert_eq!(record.strand, Some(1));
        assert_eq!(record.biotype, Some("protein_coding".to_string()));
    }

    #[tokio::test]
    async fn test_get_reference_links() {
        let client = EnsemblClient::new();
        let links = client
            .get_reference("homo_sapiens", Some(110))
            .await
            .unwrap();

        assert_eq!(links.species, "homo_sapiens");
        assert_eq!(links.release, 110);
        assert!(links.fasta_dna.contains("homo_sapiens"));
        assert!(links.fasta_dna.contains("release-110"));
        assert!(links.gtf.contains("gtf"));
    }

    #[tokio::test]
    async fn test_sequence_type_serialization() {
        let genomic = SequenceType::Genomic;
        let json = serde_json::to_string(&genomic).unwrap();
        assert_eq!(json, r#""genomic""#);

        let cdna = SequenceType::Cdna;
        let json = serde_json::to_string(&cdna).unwrap();
        assert_eq!(json, r#""cdna""#);
    }
}
