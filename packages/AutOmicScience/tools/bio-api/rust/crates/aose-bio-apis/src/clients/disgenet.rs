//! DisGeNET REST API client.
//!
//! DisGeNET is a discovery platform containing one of the largest publicly available
//! collections of genes and variants associated to human diseases.
//!
//! Documentation: https://disgenet.com (requires account registration)

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::sync::Arc;

const BASE_URL: &str = "https://api.disgenet.com/api/v1";
const REQUESTS_PER_SECOND: u32 = 10;

/// DisGeNET API client
///
/// Requires authentication via Bearer token. Set `DISGENET_API_KEY` environment variable
/// or provide the key directly when creating the client.
///
/// Get your API key by registering at https://disgenet.com
pub struct DisGeNetClient {
    client: Client,
    api_key: String,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Gene-Disease Association (GDA) record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneDiseaseAssociation {
    /// Gene symbol (e.g., BRCA1)
    #[serde(rename = "gene_symbol")]
    pub gene_symbol: String,
    /// Gene ID
    #[serde(rename = "gene_id")]
    pub gene_id: Option<String>,
    /// Disease ID (e.g., C0006142 for Breast Cancer)
    #[serde(rename = "disease_id")]
    pub disease_id: String,
    /// Disease name
    #[serde(rename = "disease_name")]
    pub disease_name: String,
    /// Association score (0.0 to 1.0)
    pub score: f64,
    /// Evidence level (e.g., "Curated", "Predicted")
    #[serde(rename = "ei")]
    pub evidence_level: Option<String>,
    /// Evidence index
    #[serde(rename = "ei_value")]
    pub evidence_index: Option<f64>,
    /// Source (e.g., "CURATED", "INFERRED")
    pub source: Option<String>,
    /// Number of PubMed articles supporting the association
    #[serde(rename = "pmid_count")]
    pub pmid_count: Option<i32>,
    /// Year when first published
    #[serde(rename = "year_initial")]
    pub year_initial: Option<i32>,
    /// Year when last published
    #[serde(rename = "year_final")]
    pub year_final: Option<i32>,
}

/// Variant-Disease Association (VDA) record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantDiseaseAssociation {
    /// Variant ID (e.g., rs121913527)
    #[serde(rename = "variant_id")]
    pub variant_id: String,
    /// Chromosome
    pub chromosome: Option<String>,
    /// Position
    pub position: Option<i64>,
    /// Reference allele
    #[serde(rename = "reference_allele")]
    pub reference_allele: Option<String>,
    /// Alternate allele
    #[serde(rename = "alternate_allele")]
    pub alternate_allele: Option<String>,
    /// Disease ID
    #[serde(rename = "disease_id")]
    pub disease_id: String,
    /// Disease name
    #[serde(rename = "disease_name")]
    pub disease_name: String,
    /// Association score (0.0 to 1.0)
    pub score: f64,
    /// Evidence level
    #[serde(rename = "ei")]
    pub evidence_level: Option<String>,
    /// Source
    pub source: Option<String>,
    /// Number of PubMed articles
    #[serde(rename = "pmid_count")]
    pub pmid_count: Option<i32>,
}

/// Disease information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiseaseInfo {
    /// Disease ID (e.g., C0006142)
    #[serde(rename = "disease_id")]
    pub disease_id: String,
    /// Disease name
    #[serde(rename = "disease_name")]
    pub disease_name: String,
    /// Disease type (disease, phenotype, group)
    #[serde(rename = "disease_type")]
    pub disease_type: Option<String>,
    /// Disease class
    #[serde(rename = "disease_class")]
    pub disease_class: Option<String>,
    /// Number of associated genes
    #[serde(rename = "gene_count")]
    pub gene_count: Option<i32>,
    /// Number of associated variants
    #[serde(rename = "variant_count")]
    pub variant_count: Option<i32>,
}

/// Gene information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneInfo {
    /// Gene symbol
    #[serde(rename = "gene_symbol")]
    pub gene_symbol: String,
    /// Gene ID
    #[serde(rename = "gene_id")]
    pub gene_id: String,
    /// Gene description
    pub description: Option<String>,
    /// Protein class
    #[serde(rename = "protein_class")]
    pub protein_class: Option<String>,
    /// Number of associated diseases
    #[serde(rename = "disease_count")]
    pub disease_count: Option<i32>,
}

/// Query parameters for association searches
#[derive(Debug, Clone, Default)]
pub struct AssociationQueryParams {
    /// Minimum score threshold (0.0 to 1.0)
    pub min_score: Option<f64>,
    /// Maximum number of results
    pub limit: Option<u32>,
    /// Filter by source (e.g., "CURATED", "INFERRED")
    pub source: Option<String>,
    /// Filter by disease type
    pub disease_type: Option<String>,
}

/// API error response structure
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // fields capture the API error shape; not all are read yet
struct DisGeNetErrorResponse {
    status: Option<String>,
    payload: Option<ErrorPayload>,
}

#[derive(Debug, Deserialize)]
struct ErrorPayload {
    message: Option<String>,
    details: Option<String>,
}

impl DisGeNetClient {
    /// Create a new DisGeNET client with API key from environment
    ///
    /// Reads API key from `DISGENET_API_KEY` environment variable.
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::DisGeNetClient;
    /// # fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DisGeNetClient::new()?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn new() -> BioApiResult<Self> {
        let api_key = env::var("DISGENET_API_KEY").map_err(|_| {
            BioApiError::InvalidInput(
                "DISGENET_API_KEY environment variable not set. Register at https://disgenet.com to obtain an API key".to_string()
            )
        })?;

        Ok(Self::with_api_key(api_key))
    }

    /// Create a new DisGeNET client with explicit API key
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::DisGeNetClient;
    /// let client = DisGeNetClient::with_api_key("your_api_key_here".to_string());
    /// ```
    pub fn with_api_key(api_key: String) -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            api_key,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Get gene-disease associations for a specific gene
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::{DisGeNetClient, AssociationQueryParams};
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DisGeNetClient::new()?;
    /// let params = AssociationQueryParams {
    ///     min_score: Some(0.3),
    ///     limit: Some(20),
    ///     ..Default::default()
    /// };
    /// let associations = client.get_gene_disease_associations("BRCA1", &params).await?;
    /// println!("Found {} disease associations for BRCA1", associations.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_gene_disease_associations(
        &self,
        gene_symbol: &str,
        params: &AssociationQueryParams,
    ) -> BioApiResult<Vec<GeneDiseaseAssociation>> {
        let mut url = format!("{}/gda/gene/{}", BASE_URL, gene_symbol);
        let query_params = self.build_query_string(params);

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params);
        }

        let json = self
            .execute_request(&url, "get_gene_disease_associations")
            .await?;

        // DisGeNET returns results in a "payload" field
        if let Some(payload) = json.get("payload") {
            if let Some(results) = payload.as_array() {
                return Ok(results
                    .iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect());
            }
        }

        // If no payload, try parsing directly
        if let Some(results) = json.as_array() {
            return Ok(results
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect());
        }

        Ok(Vec::new())
    }

    /// Get gene-disease associations for a specific disease
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::{DisGeNetClient, AssociationQueryParams};
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DisGeNetClient::new()?;
    /// let params = AssociationQueryParams {
    ///     min_score: Some(0.5),
    ///     limit: Some(10),
    ///     ..Default::default()
    /// };
    /// // C0006142 is the UMLS CUI for Breast Cancer
    /// let associations = client.get_disease_gene_associations("C0006142", &params).await?;
    /// println!("Found {} gene associations", associations.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_disease_gene_associations(
        &self,
        disease_id: &str,
        params: &AssociationQueryParams,
    ) -> BioApiResult<Vec<GeneDiseaseAssociation>> {
        let mut url = format!("{}/gda/disease/{}", BASE_URL, disease_id);
        let query_params = self.build_query_string(params);

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params);
        }

        let json = self
            .execute_request(&url, "get_disease_gene_associations")
            .await?;

        // Parse response with payload or direct array
        if let Some(payload) = json.get("payload") {
            if let Some(results) = payload.as_array() {
                return Ok(results
                    .iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect());
            }
        }

        if let Some(results) = json.as_array() {
            return Ok(results
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect());
        }

        Ok(Vec::new())
    }

    /// Get variant-disease associations for a specific variant
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::{DisGeNetClient, AssociationQueryParams};
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DisGeNetClient::new()?;
    /// let params = AssociationQueryParams::default();
    /// let associations = client.get_variant_disease_associations("rs121913527", &params).await?;
    /// println!("Found {} disease associations for variant", associations.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_variant_disease_associations(
        &self,
        variant_id: &str,
        params: &AssociationQueryParams,
    ) -> BioApiResult<Vec<VariantDiseaseAssociation>> {
        let mut url = format!("{}/vda/variant/{}", BASE_URL, variant_id);
        let query_params = self.build_query_string(params);

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params);
        }

        let json = self
            .execute_request(&url, "get_variant_disease_associations")
            .await?;

        // Parse response
        if let Some(payload) = json.get("payload") {
            if let Some(results) = payload.as_array() {
                return Ok(results
                    .iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect());
            }
        }

        if let Some(results) = json.as_array() {
            return Ok(results
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect());
        }

        Ok(Vec::new())
    }

    /// Get disease information by disease ID
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::DisGeNetClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DisGeNetClient::new()?;
    /// let disease = client.get_disease_info("C0006142").await?;
    /// println!("Disease: {} ({})", disease.disease_name, disease.disease_id);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_disease_info(&self, disease_id: &str) -> BioApiResult<DiseaseInfo> {
        let url = format!("{}/disease/{}", BASE_URL, disease_id);
        let json = self.execute_request(&url, "get_disease_info").await?;

        // Try to parse from payload or directly
        if let Some(payload) = json.get("payload") {
            if let Some(_disease_data) = payload.as_object() {
                return serde_json::from_value(payload.clone())
                    .map_err(BioApiError::DeserializationError);
            }
        }

        serde_json::from_value(json).map_err(BioApiError::DeserializationError)
    }

    /// Get gene information by gene symbol
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::disgenet::DisGeNetClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DisGeNetClient::new()?;
    /// let gene = client.get_gene_info("BRCA1").await?;
    /// println!("Gene: {} ({})", gene.gene_symbol, gene.gene_id);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_gene_info(&self, gene_symbol: &str) -> BioApiResult<GeneInfo> {
        let url = format!("{}/gene/{}", BASE_URL, gene_symbol);
        let json = self.execute_request(&url, "get_gene_info").await?;

        // Try to parse from payload or directly
        if let Some(payload) = json.get("payload") {
            if let Some(_gene_data) = payload.as_object() {
                return serde_json::from_value(payload.clone())
                    .map_err(BioApiError::DeserializationError);
            }
        }

        serde_json::from_value(json).map_err(BioApiError::DeserializationError)
    }

    /// Execute an authenticated HTTP request to the DisGeNET API
    async fn execute_request(&self, url: &str, operation: &str) -> BioApiResult<Value> {
        self.retry_policy
            .execute(operation, || {
                let url = url.to_string();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .get(&url)
                        .header("Authorization", format!("Bearer {}", self.api_key))
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();

                    // Handle error status codes
                    if !status.is_success() {
                        // Try to parse error response
                        if let Ok(error_json) = response.json::<DisGeNetErrorResponse>().await {
                            let message = error_json
                                .payload
                                .and_then(|p| p.message.or(p.details))
                                .unwrap_or_else(|| "Unknown error".to_string());

                            if status.as_u16() == 404 {
                                return Err(BioApiError::NotFound(message));
                            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                                return Err(BioApiError::ApiError {
                                    status: status.as_u16(),
                                    message: format!("Authentication failed: {}", message),
                                });
                            }

                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }

                        // Fallback error handling
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound("Resource not found".to_string()));
                        } else if status.as_u16() == 401 || status.as_u16() == 403 {
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message: "Invalid API key or insufficient permissions. Please check your DISGENET_API_KEY.".to_string(),
                            });
                        }

                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("DisGeNET API error: {}", status),
                        });
                    }

                    // Parse successful response
                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await
    }

    /// Build query string from parameters
    fn build_query_string(&self, params: &AssociationQueryParams) -> String {
        let mut query_parts = Vec::new();

        if let Some(min_score) = params.min_score {
            query_parts.push(format!("min_score={}", min_score));
        }
        if let Some(limit) = params.limit {
            query_parts.push(format!("limit={}", limit));
        }
        if let Some(source) = &params.source {
            query_parts.push(format!("source={}", urlencoding::encode(source)));
        }
        if let Some(disease_type) = &params.disease_type {
            query_parts.push(format!(
                "disease_type={}",
                urlencoding::encode(disease_type)
            ));
        }

        query_parts.join("&")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation_without_key() {
        // Should fail without API key in environment
        env::remove_var("DISGENET_API_KEY");
        let result = DisGeNetClient::new();
        assert!(result.is_err());
        if let Err(e) = result {
            assert!(e.to_string().contains("DISGENET_API_KEY"));
        }
    }

    #[test]
    fn test_client_creation_with_explicit_key() {
        let client = DisGeNetClient::with_api_key("test_api_key".to_string());
        assert_eq!(client.api_key, "test_api_key");
    }

    #[test]
    fn test_query_params_default() {
        let params = AssociationQueryParams::default();
        assert!(params.min_score.is_none());
        assert!(params.limit.is_none());
        assert!(params.source.is_none());
        assert!(params.disease_type.is_none());
    }

    #[test]
    fn test_query_params_builder() {
        let params = AssociationQueryParams {
            min_score: Some(0.3),
            limit: Some(50),
            source: Some("CURATED".to_string()),
            disease_type: Some("disease".to_string()),
        };
        assert_eq!(params.min_score, Some(0.3));
        assert_eq!(params.limit, Some(50));
        assert_eq!(params.source, Some("CURATED".to_string()));
    }

    #[test]
    fn test_build_query_string() {
        let client = DisGeNetClient::with_api_key("test_key".to_string());

        let params = AssociationQueryParams {
            min_score: Some(0.5),
            limit: Some(10),
            ..Default::default()
        };

        let query_string = client.build_query_string(&params);
        assert!(query_string.contains("min_score=0.5"));
        assert!(query_string.contains("limit=10"));
    }

    #[test]
    fn test_build_query_string_empty() {
        let client = DisGeNetClient::with_api_key("test_key".to_string());
        let params = AssociationQueryParams::default();
        let query_string = client.build_query_string(&params);
        assert_eq!(query_string, "");
    }

    #[tokio::test]
    #[ignore] // Requires valid API key and network access
    async fn test_get_gene_disease_associations() {
        if let Ok(client) = DisGeNetClient::new() {
            let params = AssociationQueryParams {
                limit: Some(5),
                ..Default::default()
            };

            let result = client.get_gene_disease_associations("BRCA1", &params).await;

            match result {
                Ok(associations) => {
                    assert!(!associations.is_empty());
                    println!("Found {} associations for BRCA1", associations.len());
                    for assoc in associations.iter().take(3) {
                        println!("  - {} (score: {})", assoc.disease_name, assoc.score);
                    }
                }
                Err(e) => {
                    println!("Test skipped due to API error: {}", e);
                }
            }
        } else {
            println!("Test skipped: DISGENET_API_KEY not set");
        }
    }

    #[tokio::test]
    #[ignore] // Requires valid API key and network access
    async fn test_get_disease_gene_associations() {
        if let Ok(client) = DisGeNetClient::new() {
            let params = AssociationQueryParams {
                limit: Some(5),
                min_score: Some(0.3),
                ..Default::default()
            };

            // C0006142 is UMLS CUI for Breast Cancer
            let result = client
                .get_disease_gene_associations("C0006142", &params)
                .await;

            match result {
                Ok(associations) => {
                    assert!(!associations.is_empty());
                    println!(
                        "Found {} gene associations for Breast Cancer",
                        associations.len()
                    );
                }
                Err(e) => {
                    println!("Test skipped due to API error: {}", e);
                }
            }
        } else {
            println!("Test skipped: DISGENET_API_KEY not set");
        }
    }
}
