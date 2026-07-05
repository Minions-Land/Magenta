//! 8CubeDB client for mouse gene expression specificity analysis.
//!
//! 8CubeDB provides mouse gene expression specificity analysis across tissues and cell types.
//! The database contains ψ (psi) and ζ (zeta) specificity metrics, block-wise statistics,
//! and normalized expression values.
//!
//! API Documentation: https://eightcubedb.onrender.com/
//! Note: Hosted on Render free tier; first request may have 10-30s cold-start delay.

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "https://eightcubedb.onrender.com";
const REQUESTS_PER_SECOND: u32 = 5; // Conservative rate limit for free-tier API
const CONNECT_TIMEOUT_SECS: u64 = 10;
const READ_TIMEOUT_SECS: u64 = 60;

/// 8CubeDB client for mouse gene expression specificity analysis
pub struct EightCubeClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Gene specificity statistics (ψ and ζ metrics)
///
/// Returned by the `/specificity` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneSpecificity {
    pub gene_name: String,
    pub ensembl_id: String,
    #[serde(rename = "Analysis_level")]
    pub analysis_level: String,
    #[serde(rename = "Analysis_type")]
    pub analysis_type: String,
    #[serde(rename = "Psi_mean")]
    pub psi_mean: f64,
    #[serde(rename = "Psi_std")]
    pub psi_std: f64,
    #[serde(rename = "Zeta_mean")]
    pub zeta_mean: f64,
    #[serde(rename = "Zeta_std")]
    pub zeta_std: f64,
}

/// Block-specific ψ scores within partitions
///
/// Returned by the `/psi_block` endpoint.
/// Block labels vary by analysis_type (e.g., "Male:NZOJ", "Female:B6J").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PsiBlockRow {
    pub gene_name: String,
    pub ensembl_id: String,
    #[serde(rename = "Analysis_level")]
    pub analysis_level: String,
    #[serde(rename = "Analysis_type")]
    pub analysis_type: String,
    /// Dynamic block scores stored as a map
    /// Keys are block labels like "Male:NZOJ", values are ψ_block scores
    #[serde(flatten)]
    pub block_scores: std::collections::HashMap<String, String>,
}

/// Normalized gene expression with mean/variance per partition block
///
/// Returned by the `/gene_expression` endpoint.
/// Schema varies by analysis_type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneExpressionRow {
    pub gene_name: String,
    pub ensembl_id: String,
    #[serde(rename = "Analysis_level")]
    pub analysis_level: String,
    #[serde(rename = "Analysis_type")]
    pub analysis_type: String,
    /// Dynamic expression statistics stored as a map
    /// Keys are partition block labels with "_mean" and "_var" suffixes
    #[serde(flatten)]
    pub expression_stats: std::collections::HashMap<String, String>,
}

/// Request parameters for specificity query
#[derive(Debug, Clone)]
pub struct SpecificityRequest {
    pub gene_list: Vec<String>,
}

/// Request parameters for psi_block query
#[derive(Debug, Clone)]
pub struct PsiBlockRequest {
    pub gene_list: Vec<String>,
    pub analysis_level: String,
    pub analysis_type: String,
}

/// Request parameters for gene_expression query
#[derive(Debug, Clone)]
pub struct GeneExpressionRequest {
    pub gene_list: Vec<String>,
    pub analysis_level: String,
    pub analysis_type: String,
}

impl EightCubeClient {
    /// Create a new gget 8cube client
    pub fn new() -> BioApiResult<Self> {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1 (8CubeDB)")
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(READ_TIMEOUT_SECS))
            .build()
            .map_err(|e| BioApiError::Other(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        })
    }

    /// Get gene-level specificity statistics (ψ and ζ metrics)
    ///
    /// # Arguments
    /// * `request` - Gene list to query (accepts Entrez symbols or Ensembl IDs)
    ///
    /// # Returns
    /// Vector of specificity statistics for each gene across all analysis levels/types
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::eightcube::{EightCubeClient, SpecificityRequest};
    ///
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = EightCubeClient::new()?;
    /// let request = SpecificityRequest {
    ///     gene_list: vec!["Akr1c21".to_string(), "ENSMUSG00000021207.10".to_string()],
    /// };
    /// let results = client.get_specificity(&request).await?;
    /// for result in results {
    ///     println!("{}: ψ={:.3}, ζ={:.3}", result.gene_name, result.psi_mean, result.zeta_mean);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_specificity(
        &self,
        request: &SpecificityRequest,
    ) -> BioApiResult<Vec<GeneSpecificity>> {
        if request.gene_list.is_empty() {
            return Err(BioApiError::InvalidInput(
                "gene_list cannot be empty".to_string(),
            ));
        }

        let url = self.build_url("/specificity", &request.gene_list, None, None)?;

        let csv_text = self
            .retry_policy
            .execute("get_specificity", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        let error_text = response.text().await.unwrap_or_default();
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("8CubeDB API error: {} - {}", status, error_text),
                        });
                    }

                    let text = response.text().await?;

                    // Check if response is HTML error page (common for web APIs)
                    if text.trim().starts_with("<!DOCTYPE") || text.trim().starts_with("<html") {
                        return Err(BioApiError::InvalidResponse(
                            "Received HTML error page instead of CSV".to_string(),
                        ));
                    }

                    Ok(text)
                }
            })
            .await?;

        self.parse_csv(&csv_text)
    }

    /// Get block-specific ψ scores within partitions
    ///
    /// # Arguments
    /// * `request` - Gene list, analysis level (e.g., "Kidney"), and analysis type (e.g., "Sex:Celltype")
    ///
    /// # Returns
    /// Vector of psi block rows with dynamic block scores
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::eightcube::{EightCubeClient, PsiBlockRequest};
    ///
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = EightCubeClient::new()?;
    /// let request = PsiBlockRequest {
    ///     gene_list: vec!["Akr1c21".to_string()],
    ///     analysis_level: "Kidney".to_string(),
    ///     analysis_type: "Sex:Celltype".to_string(),
    /// };
    /// let results = client.get_psi_block(&request).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_psi_block(&self, request: &PsiBlockRequest) -> BioApiResult<Vec<PsiBlockRow>> {
        if request.gene_list.is_empty() {
            return Err(BioApiError::InvalidInput(
                "gene_list cannot be empty".to_string(),
            ));
        }

        let url = self.build_url(
            "/psi_block",
            &request.gene_list,
            Some(&request.analysis_level),
            Some(&request.analysis_type),
        )?;

        let csv_text = self
            .retry_policy
            .execute("get_psi_block", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        let error_text = response.text().await.unwrap_or_default();
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("8CubeDB API error: {} - {}", status, error_text),
                        });
                    }

                    let text = response.text().await?;

                    if text.trim().starts_with("<!DOCTYPE") || text.trim().starts_with("<html") {
                        return Err(BioApiError::InvalidResponse(
                            "Received HTML error page instead of CSV".to_string(),
                        ));
                    }

                    Ok(text)
                }
            })
            .await?;

        self.parse_csv(&csv_text)
    }

    /// Get normalized gene expression values with mean/variance per partition block
    ///
    /// # Arguments
    /// * `request` - Gene list, analysis level (e.g., "Across_tissues"), and analysis type (e.g., "Strain")
    ///
    /// # Returns
    /// Vector of expression rows with dynamic expression statistics
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::eightcube::{EightCubeClient, GeneExpressionRequest};
    ///
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = EightCubeClient::new()?;
    /// let request = GeneExpressionRequest {
    ///     gene_list: vec!["ENSMUSG00000030945.18".to_string()],
    ///     analysis_level: "Across_tissues".to_string(),
    ///     analysis_type: "Strain".to_string(),
    /// };
    /// let results = client.get_gene_expression(&request).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_gene_expression(
        &self,
        request: &GeneExpressionRequest,
    ) -> BioApiResult<Vec<GeneExpressionRow>> {
        if request.gene_list.is_empty() {
            return Err(BioApiError::InvalidInput(
                "gene_list cannot be empty".to_string(),
            ));
        }

        let url = self.build_url(
            "/gene_expression",
            &request.gene_list,
            Some(&request.analysis_level),
            Some(&request.analysis_type),
        )?;

        let csv_text = self
            .retry_policy
            .execute("get_gene_expression", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        let error_text = response.text().await.unwrap_or_default();
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("8CubeDB API error: {} - {}", status, error_text),
                        });
                    }

                    let text = response.text().await?;

                    if text.trim().starts_with("<!DOCTYPE") || text.trim().starts_with("<html") {
                        return Err(BioApiError::InvalidResponse(
                            "Received HTML error page instead of CSV".to_string(),
                        ));
                    }

                    Ok(text)
                }
            })
            .await?;

        self.parse_csv(&csv_text)
    }

    /// Build URL with query parameters
    ///
    /// Genes are pre-processed by stripping whitespace only (case and version preserved).
    fn build_url(
        &self,
        endpoint: &str,
        gene_list: &[String],
        analysis_level: Option<&str>,
        analysis_type: Option<&str>,
    ) -> BioApiResult<String> {
        let mut url = format!("{}{}", BASE_URL, endpoint);
        let mut params = Vec::new();

        // Add gene_list as repeated query params
        for gene in gene_list {
            let gene_normalized = gene.trim();
            if gene_normalized.is_empty() {
                continue;
            }
            params.push(format!(
                "gene_list={}",
                urlencoding::encode(gene_normalized)
            ));
        }

        if params.is_empty() {
            return Err(BioApiError::InvalidInput(
                "No valid genes after normalization".to_string(),
            ));
        }

        // Add optional parameters
        if let Some(level) = analysis_level {
            params.push(format!("analysis_level={}", urlencoding::encode(level)));
        }
        if let Some(atype) = analysis_type {
            params.push(format!("analysis_type={}", urlencoding::encode(atype)));
        }

        url.push('?');
        url.push_str(&params.join("&"));

        Ok(url)
    }

    /// Parse CSV response into typed structs
    fn parse_csv<T>(&self, csv_text: &str) -> BioApiResult<Vec<T>>
    where
        T: for<'de> Deserialize<'de>,
    {
        let mut reader = csv::Reader::from_reader(csv_text.as_bytes());
        let mut results = Vec::new();

        for result in reader.deserialize() {
            match result {
                Ok(record) => results.push(record),
                Err(e) => {
                    return Err(BioApiError::InvalidResponse(format!(
                        "CSV parsing error: {}",
                        e
                    )));
                }
            }
        }

        Ok(results)
    }

    /// Normalize gene identifiers
    ///
    /// Strips whitespace while preserving case and Ensembl version suffixes.
    /// Accepts both Entrez gene symbols and Ensembl IDs.
    pub fn normalize_genes(genes: &[String]) -> Vec<String> {
        genes
            .iter()
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect()
    }
}

impl Default for EightCubeClient {
    fn default() -> Self {
        Self::new().expect("Failed to create default EightCubeClient")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = EightCubeClient::new();
        assert!(client.is_ok());
    }

    #[test]
    fn test_normalize_genes() {
        let genes = vec![
            "  Akr1c21  ".to_string(),
            "ENSMUSG00000021207.10".to_string(),
            "  ".to_string(),
            "Gapdh".to_string(),
        ];

        let normalized = EightCubeClient::normalize_genes(&genes);
        assert_eq!(normalized.len(), 3);
        assert_eq!(normalized[0], "Akr1c21");
        assert_eq!(normalized[1], "ENSMUSG00000021207.10"); // Version preserved
        assert_eq!(normalized[2], "Gapdh");
    }

    #[test]
    fn test_build_url_specificity() {
        let client = EightCubeClient::new().unwrap();
        let genes = vec!["Akr1c21".to_string(), "Gapdh".to_string()];
        let url = client
            .build_url("/specificity", &genes, None, None)
            .unwrap();

        assert!(url.contains("/specificity?"));
        assert!(url.contains("gene_list=Akr1c21"));
        assert!(url.contains("gene_list=Gapdh"));
    }

    #[test]
    fn test_build_url_with_analysis_params() {
        let client = EightCubeClient::new().unwrap();
        let genes = vec!["Akr1c21".to_string()];
        let url = client
            .build_url("/psi_block", &genes, Some("Kidney"), Some("Sex:Celltype"))
            .unwrap();

        assert!(url.contains("gene_list=Akr1c21"));
        assert!(url.contains("analysis_level=Kidney"));
        assert!(url.contains("analysis_type=Sex%3ACelltype")); // : is encoded
    }

    #[test]
    fn test_build_url_empty_genes() {
        let client = EightCubeClient::new().unwrap();
        let genes: Vec<String> = vec![];
        let result = client.build_url("/specificity", &genes, None, None);

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_parse_csv_specificity() {
        let client = EightCubeClient::new().unwrap();
        let csv_data = "\
gene_name,ensembl_id,Analysis_level,Analysis_type,Psi_mean,Psi_std,Zeta_mean,Zeta_std
Akr1c21,ENSMUSG00000021207,Kidney,Sex:Celltype,0.45,0.12,0.89,0.05
Gapdh,ENSMUSG00000057666,Across_tissues,Strain,0.12,0.08,0.34,0.10
";

        let results: Vec<GeneSpecificity> = client.parse_csv(csv_data).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].gene_name, "Akr1c21");
        assert_eq!(results[0].psi_mean, 0.45);
        assert_eq!(results[1].gene_name, "Gapdh");
    }

    #[test]
    fn test_parse_csv_empty_results() {
        let client = EightCubeClient::new().unwrap();
        let csv_data = "gene_name,ensembl_id,Analysis_level,Analysis_type,Psi_mean,Psi_std,Zeta_mean,Zeta_std\n";

        let results: Vec<GeneSpecificity> = client.parse_csv(csv_data).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_parse_csv_invalid() {
        let client = EightCubeClient::new().unwrap();
        let csv_data = "invalid,csv,data\nwithout,proper,headers,or,types";

        let results: Result<Vec<GeneSpecificity>, _> = client.parse_csv(csv_data);
        assert!(results.is_err());
        assert!(matches!(
            results.unwrap_err(),
            BioApiError::InvalidResponse(_)
        ));
    }

    #[tokio::test]
    async fn test_specificity_request_empty_genes() {
        let client = EightCubeClient::new().unwrap();
        let request = SpecificityRequest { gene_list: vec![] };

        let result = client.get_specificity(&request).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_ensembl_version_preservation() {
        let genes = vec!["ENSMUSG00000021207.10".to_string()];
        let normalized = EightCubeClient::normalize_genes(&genes);
        assert_eq!(normalized[0], "ENSMUSG00000021207.10");
    }

    #[test]
    fn test_case_preservation() {
        let genes = vec![
            "Akr1c21".to_string(),
            "GAPDH".to_string(),
            "Sox2".to_string(),
        ];
        let normalized = EightCubeClient::normalize_genes(&genes);
        assert_eq!(normalized[0], "Akr1c21");
        assert_eq!(normalized[1], "GAPDH");
        assert_eq!(normalized[2], "Sox2");
    }
}
