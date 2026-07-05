//! GTEx Portal API client.
//!
//! Documentation: https://gtexportal.org/api/v2/redoc

use crate::error::{BioApiError, BioApiResult};
use crate::models::{Eqtl, GtexTissue, TissueExpression};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tracing::debug;

const BASE_URL: &str = "https://gtexportal.org/api/v2";
const REQUESTS_PER_SECOND: u32 = 10; // Conservative rate limit

/// GTEx Portal API client for eQTL and expression data
pub struct GtexClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl GtexClient {
    /// Create a new GTEx client with default configuration
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
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy,
        }
    }

    /// Get expression Quantitative Trait Loci (eQTLs) for a gene in a tissue
    ///
    /// # Arguments
    /// * `gene_symbol` - Gene symbol (e.g., "PKD1", "BRCA2")
    /// * `tissue` - Tissue name (e.g., "Kidney_Cortex", "Whole_Blood")
    ///
    /// # Returns
    /// Vector of eQTL records with variant associations
    pub async fn get_eqtls(&self, gene_symbol: &str, tissue: &str) -> BioApiResult<Vec<Eqtl>> {
        let url = format!(
            "{}/association/singleTissueEqtl?gencodeId={}&tissueSiteDetailId={}",
            BASE_URL, gene_symbol, tissue
        );

        let operation = format!("get_eqtls: {} in {}", gene_symbol, tissue);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                let gene_symbol = gene_symbol.to_string();
                let tissue = tissue.to_string();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "eQTLs not found for gene '{}' in tissue '{}'",
                                gene_symbol, tissue
                            )));
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let error_text = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message: error_text,
                            });
                        }
                    }

                    let data: GtexEqtlResponse = response.json().await?;
                    Ok(self.parse_eqtl_response(data, &gene_symbol, &tissue))
                }
            })
            .await
    }

    /// Get median gene expression across all tissues for a gene
    ///
    /// # Arguments
    /// * `gene_symbol` - Gene symbol (e.g., "PKD1", "BRCA2")
    ///
    /// # Returns
    /// Vector of tissue expression records with median TPM values
    pub async fn get_gene_expression(
        &self,
        gene_symbol: &str,
    ) -> BioApiResult<Vec<TissueExpression>> {
        // The GTEx v2 expression endpoint requires a versioned gencodeId, so
        // first resolve the gene symbol to its gencodeId via the reference API.
        let gencode_id = self.resolve_gencode_id(gene_symbol).await?;

        let url = format!(
            "{}/expression/medianGeneExpression?gencodeId={}&datasetId=gtex_v8",
            BASE_URL, gencode_id
        );

        let operation = format!("get_gene_expression: {}", gene_symbol);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                let gene_symbol = gene_symbol.to_string();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Expression data not found for gene '{}'",
                                gene_symbol
                            )));
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let error_text = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message: error_text,
                            });
                        }
                    }

                    let data: GtexExpressionResponse = response.json().await?;
                    Ok(self.parse_expression_response(data, &gene_symbol))
                }
            })
            .await
    }

    /// Resolve a gene symbol to its versioned GTEx gencodeId (e.g. "ENSG...19")
    async fn resolve_gencode_id(&self, gene_symbol: &str) -> BioApiResult<String> {
        let url = format!("{}/reference/gene?geneId={}", BASE_URL, gene_symbol);
        let operation = format!("resolve_gencode_id: {}", gene_symbol);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                let gene_symbol = gene_symbol.to_string();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        let error_text = response.text().await.unwrap_or_default();
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: error_text,
                        });
                    }

                    let data: GtexGeneResponse = response.json().await?;
                    data.data
                        .unwrap_or_default()
                        .into_iter()
                        .find_map(|g| g.gencode_id)
                        .ok_or_else(|| {
                            BioApiError::NotFound(format!(
                                "No gencodeId found for gene '{}'",
                                gene_symbol
                            ))
                        })
                }
            })
            .await
    }

    /// Get list of available tissues in GTEx
    ///
    /// # Returns
    /// Vector of tissue metadata with IDs and names
    pub async fn get_tissues(&self) -> BioApiResult<Vec<GtexTissue>> {
        let url = format!("{}/dataset/tissueSiteDetail", BASE_URL);
        let operation = "get_tissues".to_string();

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
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let error_text = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message: error_text,
                            });
                        }
                    }

                    let data: GtexTissueResponse = response.json().await?;
                    Ok(self.parse_tissue_response(data))
                }
            })
            .await
    }

    // Private helper methods

    fn parse_eqtl_response(
        &self,
        response: GtexEqtlResponse,
        gene_symbol: &str,
        tissue: &str,
    ) -> Vec<Eqtl> {
        response
            .data
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some(Eqtl {
                    gene_symbol: gene_symbol.to_string(),
                    variant_id: item.variant_id?,
                    tissue: tissue.to_string(),
                    p_value: item.pvalue?,
                    nes: item.nes.unwrap_or(0.0),
                })
            })
            .collect()
    }

    fn parse_expression_response(
        &self,
        response: GtexExpressionResponse,
        gene_symbol: &str,
    ) -> Vec<TissueExpression> {
        response
            .data
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some(TissueExpression {
                    gene_symbol: gene_symbol.to_string(),
                    tissue: item.tissue_site_detail_id?,
                    median_tpm: item.median?,
                    mean_tpm: item.mean,
                    sample_count: item.num_samples,
                })
            })
            .collect()
    }

    fn parse_tissue_response(&self, response: GtexTissueResponse) -> Vec<GtexTissue> {
        response
            .data
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some(GtexTissue {
                    tissue_id: item.tissue_site_detail_id?,
                    tissue_name: item.tissue_site_detail?,
                    tissue_site_detail: item.tissue_site,
                })
            })
            .collect()
    }
}

impl Default for GtexClient {
    fn default() -> Self {
        Self::new()
    }
}

// Response types for GTEx API

#[derive(Debug, Deserialize)]
struct GtexEqtlResponse {
    data: Option<Vec<EqtlData>>,
}

#[derive(Debug, Deserialize)]
struct EqtlData {
    #[serde(rename = "variantId")]
    variant_id: Option<String>,
    #[serde(rename = "pValue")]
    pvalue: Option<f64>,
    nes: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct GtexExpressionResponse {
    data: Option<Vec<ExpressionData>>,
}

#[derive(Debug, Deserialize)]
struct ExpressionData {
    #[serde(rename = "tissueSiteDetailId")]
    tissue_site_detail_id: Option<String>,
    median: Option<f64>,
    mean: Option<f64>,
    #[serde(rename = "numSamples")]
    num_samples: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct GtexGeneResponse {
    data: Option<Vec<GeneData>>,
}

#[derive(Debug, Deserialize)]
struct GeneData {
    #[serde(rename = "gencodeId")]
    gencode_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GtexTissueResponse {
    data: Option<Vec<TissueData>>,
}

#[derive(Debug, Deserialize)]
struct TissueData {
    #[serde(rename = "tissueSiteDetailId")]
    tissue_site_detail_id: Option<String>,
    #[serde(rename = "tissueSiteDetail")]
    tissue_site_detail: Option<String>,
    #[serde(rename = "tissueSite")]
    tissue_site: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_get_tissues() {
        let client = GtexClient::new();
        let tissues = client.get_tissues().await.unwrap();

        assert!(!tissues.is_empty());
        assert!(tissues.iter().any(|t| t.tissue_id.contains("Kidney")));
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_get_gene_expression() {
        let client = GtexClient::new();
        let expression = client.get_gene_expression("PKD1").await.unwrap();

        assert!(!expression.is_empty());
        assert!(expression.iter().any(|e| e.median_tpm > 0.0));
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_get_eqtls() {
        let client = GtexClient::new();
        let eqtls = client.get_eqtls("PKD1", "Kidney_Cortex").await.unwrap();

        // May or may not have eQTLs depending on the gene/tissue
        assert!(eqtls.is_empty() || eqtls.iter().any(|e| e.p_value < 1.0));
    }

    #[tokio::test]
    async fn test_client_creation() {
        let client = GtexClient::new();
        assert_eq!(client.rate_limiter.rate(), REQUESTS_PER_SECOND);

        let client_default = GtexClient::default();
        assert_eq!(client_default.rate_limiter.rate(), REQUESTS_PER_SECOND);
    }
}
