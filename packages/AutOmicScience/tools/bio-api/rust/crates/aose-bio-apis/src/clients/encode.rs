//! ENCODE (Encyclopedia of DNA Elements) REST API client.
//!
//! Documentation: https://www.encodeproject.org/help/rest-api/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tracing::debug;

const BASE_URL: &str = "https://www.encodeproject.org";
const REQUESTS_PER_SECOND: u32 = 10;

/// ENCODE REST API client
pub struct EncodeClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl EncodeClient {
    /// Create a new ENCODE client with default configuration
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

    /// Search for experiments
    ///
    /// # Arguments
    /// * `params` - Search parameters including assay type, biosample, target, etc.
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::encode::{EncodeClient, ExperimentSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = EncodeClient::new();
    /// let params = ExperimentSearchParams {
    ///     assay_title: Some("ChIP-seq".to_string()),
    ///     biosample_ontology_term_name: Some("K562".to_string()),
    ///     target_label: Some("CTCF".to_string()),
    ///     status: Some("released".to_string()),
    ///     limit: Some(10),
    ///     ..Default::default()
    /// };
    /// let experiments = client.search_experiments(&params).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_experiments(
        &self,
        params: &ExperimentSearchParams,
    ) -> BioApiResult<Vec<Experiment>> {
        let mut query_params = vec![
            ("type", "Experiment".to_string()),
            ("frame", "object".to_string()),
        ];

        if let Some(ref assay) = params.assay_title {
            query_params.push(("assay_title", assay.clone()));
        }
        if let Some(ref biosample) = params.biosample_ontology_term_name {
            query_params.push(("biosample_ontology.term_name", biosample.clone()));
        }
        if let Some(ref target) = params.target_label {
            query_params.push(("target.label", target.clone()));
        }
        if let Some(ref status) = params.status {
            query_params.push(("status", status.clone()));
        }
        if let Some(ref assembly) = params.assembly {
            query_params.push(("assembly", assembly.clone()));
        }
        if let Some(ref _replicates) = params.replicates_min {
            query_params.push((
                "replicates.library.biosample.donor.organism.scientific_name",
                "Homo sapiens".to_string(),
            ));
        }
        if let Some(limit) = params.limit {
            query_params.push(("limit", limit.to_string()));
        } else {
            query_params.push(("limit", "25".to_string()));
        }

        let url = format!("{}/search/", BASE_URL);
        let operation = "search_experiments";

        self.retry_policy
            .execute(operation, || {
                let url = url.clone();
                let query_params = query_params.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {} with params: {:?}", url, query_params);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .query(&query_params)
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound("No experiments found".to_string()));
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

                    let json: SearchResponse = response.json().await?;

                    let experiments: Vec<Experiment> = json
                        .graph
                        .into_iter()
                        .filter_map(|item| serde_json::from_value(item).ok())
                        .collect();

                    Ok(experiments)
                }
            })
            .await
    }

    /// Get file metadata for a specific experiment
    ///
    /// # Arguments
    /// * `accession` - ENCODE experiment accession (e.g., "ENCSR000AED")
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::encode::EncodeClient;
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = EncodeClient::new();
    /// let files = client.get_file_metadata("ENCSR000AED").await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_file_metadata(&self, accession: &str) -> BioApiResult<Vec<FileMetadata>> {
        let url = format!("{}/experiments/{}/", BASE_URL, accession);
        let operation = format!("get_file_metadata: {}", accession);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .query(&[("frame", "object"), ("format", "json")])
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Experiment '{}' not found",
                                accession
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

                    let files = json["files"]
                        .as_array()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse("No files array in response".to_string())
                        })?
                        .iter()
                        .filter_map(|item| self.parse_file_metadata(item))
                        .collect();

                    Ok(files)
                }
            })
            .await
    }

    /// Search for genomic annotations
    ///
    /// # Arguments
    /// * `params` - Search parameters for annotations
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::encode::{EncodeClient, AnnotationSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = EncodeClient::new();
    /// let params = AnnotationSearchParams {
    ///     annotation_type: Some("candidate regulatory elements".to_string()),
    ///     organism: Some("Homo sapiens".to_string()),
    ///     assembly: Some("GRCh38".to_string()),
    ///     limit: Some(10),
    ///     ..Default::default()
    /// };
    /// let annotations = client.search_annotations(&params).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_annotations(
        &self,
        params: &AnnotationSearchParams,
    ) -> BioApiResult<Vec<Annotation>> {
        let mut query_params = vec![
            ("type", "Annotation".to_string()),
            ("frame", "object".to_string()),
        ];

        if let Some(ref annotation_type) = params.annotation_type {
            query_params.push(("annotation_type", annotation_type.clone()));
        }
        if let Some(ref organism) = params.organism {
            query_params.push(("organism.scientific_name", organism.clone()));
        }
        if let Some(ref assembly) = params.assembly {
            query_params.push(("assembly", assembly.clone()));
        }
        if let Some(ref target) = params.target_label {
            query_params.push(("target.label", target.clone()));
        }
        if let Some(ref biosample) = params.biosample_ontology_term_name {
            query_params.push(("biosample_ontology.term_name", biosample.clone()));
        }
        if let Some(limit) = params.limit {
            query_params.push(("limit", limit.to_string()));
        } else {
            query_params.push(("limit", "25".to_string()));
        }

        let url = format!("{}/search/", BASE_URL);
        let operation = "search_annotations";

        self.retry_policy
            .execute(operation, || {
                let url = url.clone();
                let query_params = query_params.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {} with params: {:?}", url, query_params);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .query(&query_params)
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound("No annotations found".to_string()));
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

                    let json: SearchResponse = response.json().await?;

                    let annotations: Vec<Annotation> = json
                        .graph
                        .into_iter()
                        .filter_map(|item| serde_json::from_value(item).ok())
                        .collect();

                    Ok(annotations)
                }
            })
            .await
    }

    /// Get detailed information about a biosample
    pub async fn get_biosample(&self, accession: &str) -> BioApiResult<Biosample> {
        let url = format!("{}/biosamples/{}/", BASE_URL, accession);
        let operation = format!("get_biosample: {}", accession);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .query(&[("frame", "object"), ("format", "json")])
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Biosample '{}' not found",
                                accession
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

                    let biosample: Biosample = response.json().await?;
                    Ok(biosample)
                }
            })
            .await
    }

    /// Parse file metadata from JSON
    fn parse_file_metadata(&self, json: &Value) -> Option<FileMetadata> {
        Some(FileMetadata {
            accession: json["accession"].as_str()?.to_string(),
            file_format: json["file_format"].as_str()?.to_string(),
            file_type: json["file_type"].as_str().map(|s| s.to_string()),
            output_type: json["output_type"].as_str().map(|s| s.to_string()),
            assembly: json["assembly"].as_str().map(|s| s.to_string()),
            href: json["href"].as_str().map(|s| s.to_string()),
            file_size: json["file_size"].as_u64(),
            md5sum: json["md5sum"].as_str().map(|s| s.to_string()),
            status: json["status"].as_str().unwrap_or("unknown").to_string(),
            biological_replicates: json["biological_replicates"].as_array().map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u32))
                    .collect()
            }),
        })
    }
}

impl Default for EncodeClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Search parameters for experiments
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExperimentSearchParams {
    pub assay_title: Option<String>,
    pub biosample_ontology_term_name: Option<String>,
    pub target_label: Option<String>,
    pub status: Option<String>,
    pub assembly: Option<String>,
    pub replicates_min: Option<u32>,
    pub limit: Option<u32>,
}

/// Search parameters for annotations
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnnotationSearchParams {
    pub annotation_type: Option<String>,
    pub organism: Option<String>,
    pub assembly: Option<String>,
    pub target_label: Option<String>,
    pub biosample_ontology_term_name: Option<String>,
    pub limit: Option<u32>,
}

/// ENCODE search response wrapper
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    #[serde(rename = "@graph")]
    pub graph: Vec<Value>,
    #[serde(rename = "total")]
    pub total: Option<u32>,
    #[serde(rename = "notification")]
    pub notification: Option<String>,
}

/// ENCODE experiment metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experiment {
    pub accession: String,
    #[serde(rename = "assay_title")]
    pub assay_title: Option<String>,
    #[serde(rename = "biosample_summary")]
    pub biosample_summary: Option<String>,
    #[serde(rename = "biosample_ontology")]
    pub biosample_ontology: Option<BiosampleOntology>,
    pub target: Option<Target>,
    pub status: String,
    pub description: Option<String>,
    pub lab: Option<Lab>,
    pub award: Option<Award>,
    #[serde(rename = "date_released")]
    pub date_released: Option<String>,
    pub files: Option<Vec<String>>,
    pub replicates: Option<Vec<String>>,
}

/// Biosample ontology information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiosampleOntology {
    pub term_name: Option<String>,
    pub classification: Option<String>,
    pub organ_slims: Option<Vec<String>>,
    pub cell_slims: Option<Vec<String>>,
    pub developmental_slims: Option<Vec<String>>,
    pub system_slims: Option<Vec<String>>,
}

/// Target information (e.g., ChIP-seq target)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    pub label: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub organism: Option<String>,
    pub gene_name: Option<String>,
}

/// Lab information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lab {
    pub title: Option<String>,
    pub name: Option<String>,
}

/// Award/grant information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Award {
    pub project: Option<String>,
    pub rfa: Option<String>,
}

/// File metadata from ENCODE
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub accession: String,
    pub file_format: String,
    pub file_type: Option<String>,
    pub output_type: Option<String>,
    pub assembly: Option<String>,
    pub href: Option<String>,
    pub file_size: Option<u64>,
    pub md5sum: Option<String>,
    pub status: String,
    pub biological_replicates: Option<Vec<u32>>,
}

/// Genomic annotation metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub accession: String,
    pub annotation_type: Option<String>,
    pub organism: Option<Organism>,
    pub biosample_ontology: Option<BiosampleOntology>,
    pub target: Option<Target>,
    pub status: String,
    pub assembly: Option<Vec<String>>,
    pub files: Option<Vec<String>>,
    pub encyclopedia_version: Option<String>,
    pub software_used: Option<Vec<Software>>,
}

/// Organism information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organism {
    pub scientific_name: Option<String>,
    pub taxon_id: Option<String>,
}

/// Software version information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Software {
    pub software: Option<String>,
    pub version: Option<String>,
    pub title: Option<String>,
}

/// Biosample detailed information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Biosample {
    pub accession: String,
    pub biosample_ontology: Option<BiosampleOntology>,
    pub organism: Option<Organism>,
    pub description: Option<String>,
    pub biosample_type: Option<String>,
    pub status: String,
    pub treatments: Option<Vec<Treatment>>,
    pub age: Option<String>,
    pub age_units: Option<String>,
    pub sex: Option<String>,
    pub donor: Option<String>,
    pub passage_number: Option<u32>,
}

/// Treatment information for biosamples
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Treatment {
    pub treatment_term_name: Option<String>,
    pub treatment_type: Option<String>,
    pub amount: Option<f64>,
    pub amount_units: Option<String>,
    pub duration: Option<f64>,
    pub duration_units: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = EncodeClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_custom_retry_policy() {
        let policy = RetryPolicy::new(5, std::time::Duration::from_millis(50));
        let client = EncodeClient::with_retry_policy(policy);
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_experiment_search_params() {
        let params = ExperimentSearchParams {
            assay_title: Some("ChIP-seq".to_string()),
            biosample_ontology_term_name: Some("K562".to_string()),
            target_label: Some("CTCF".to_string()),
            status: Some("released".to_string()),
            limit: Some(10),
            ..Default::default()
        };

        assert_eq!(params.assay_title, Some("ChIP-seq".to_string()));
        assert_eq!(params.limit, Some(10));
    }

    #[tokio::test]
    async fn test_annotation_search_params() {
        let params = AnnotationSearchParams {
            annotation_type: Some("candidate regulatory elements".to_string()),
            organism: Some("Homo sapiens".to_string()),
            assembly: Some("GRCh38".to_string()),
            limit: Some(10),
            ..Default::default()
        };

        assert_eq!(
            params.annotation_type,
            Some("candidate regulatory elements".to_string())
        );
        assert_eq!(params.organism, Some("Homo sapiens".to_string()));
    }

    #[tokio::test]
    async fn test_parse_file_metadata() {
        let client = EncodeClient::new();
        let json = serde_json::json!({
            "accession": "ENCFF000ABC",
            "file_format": "bam",
            "file_type": "alignments",
            "output_type": "alignments",
            "assembly": "GRCh38",
            "href": "/files/ENCFF000ABC/@@download/ENCFF000ABC.bam",
            "file_size": 123456789,
            "md5sum": "abc123def456",
            "status": "released",
            "biological_replicates": [1, 2]
        });

        let metadata = client.parse_file_metadata(&json).unwrap();
        assert_eq!(metadata.accession, "ENCFF000ABC");
        assert_eq!(metadata.file_format, "bam");
        assert_eq!(metadata.assembly, Some("GRCh38".to_string()));
        assert_eq!(metadata.file_size, Some(123456789));
        assert_eq!(metadata.status, "released");
        assert_eq!(metadata.biological_replicates, Some(vec![1, 2]));
    }

    #[test]
    fn test_experiment_serialization() {
        let exp = Experiment {
            accession: "ENCSR000AED".to_string(),
            assay_title: Some("ChIP-seq".to_string()),
            biosample_summary: Some("K562".to_string()),
            biosample_ontology: None,
            target: None,
            status: "released".to_string(),
            description: None,
            lab: None,
            award: None,
            date_released: Some("2011-01-01".to_string()),
            files: None,
            replicates: None,
        };

        let json = serde_json::to_string(&exp).unwrap();
        assert!(json.contains("ENCSR000AED"));
        assert!(json.contains("ChIP-seq"));
    }

    #[test]
    fn test_biosample_ontology() {
        let ontology = BiosampleOntology {
            term_name: Some("K562".to_string()),
            classification: Some("cell line".to_string()),
            organ_slims: Some(vec!["blood".to_string()]),
            cell_slims: Some(vec!["immortalized cell line".to_string()]),
            developmental_slims: None,
            system_slims: Some(vec!["immune".to_string()]),
        };

        assert_eq!(ontology.term_name, Some("K562".to_string()));
        assert_eq!(ontology.classification, Some("cell line".to_string()));
    }
}
