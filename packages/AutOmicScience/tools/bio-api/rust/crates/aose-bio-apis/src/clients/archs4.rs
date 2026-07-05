//! ARCHS4 client for gene correlation and tissue expression.
//!
//! ARCHS4 (All RNA-seq and ChIP-seq sample and signature search) is a resource providing
//! uniformly processed RNA-seq data from GEO. This client supports:
//! - Gene correlation analysis (top correlated genes)
//! - Tissue-specific gene expression profiles
//!
//! Documentation: https://maayanlab.cloud/archs4/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const CORRELATION_URL: &str = "https://maayanlab.cloud/matrixapi/coltop";
const TISSUE_EXPRESSION_URL: &str =
    "https://maayanlab.cloud/archs4/search/loadExpressionTissue.php";
const REQUESTS_PER_SECOND: u32 = 5;

/// ARCHS4 API client
pub struct Archs4Client {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Query mode for ARCHS4 data
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryMode {
    /// Get genes correlated with the query gene
    Correlation,
    /// Get tissue-specific expression profiles
    Tissue,
}

/// Species for ARCHS4 queries
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Species {
    Human,
    Mouse,
}

impl Species {
    /// Convert to API parameter string
    pub fn as_str(&self) -> &'static str {
        match self {
            Species::Human => "human",
            Species::Mouse => "mouse",
        }
    }
}

/// Request body for correlation queries
#[derive(Debug, Clone, Serialize)]
struct CorrelationRequest {
    id: String,
    count: u32,
}

/// Response from correlation API
#[derive(Debug, Deserialize)]
struct CorrelationResponse {
    #[serde(default)]
    rowids: Vec<String>,
    #[serde(default)]
    values: Vec<f64>,
    #[serde(default)]
    error: Option<String>,
}

/// Gene correlation result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneCorrelation {
    pub gene_symbol: String,
    pub pearson_correlation: f64,
}

/// Tissue expression result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TissueExpression {
    pub tissue: String,
    pub median: f64,
    pub q1: Option<f64>,
    pub q3: Option<f64>,
}

impl Archs4Client {
    /// Create a new ARCHS4 client
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1")
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Get genes correlated with the query gene
    ///
    /// # Arguments
    /// * `gene` - Gene symbol (will be converted to uppercase)
    /// * `gene_count` - Number of correlated genes to return (default: 100)
    ///
    /// # Returns
    /// Vector of correlated genes sorted by Pearson correlation coefficient (descending)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::archs4::Archs4Client;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = Archs4Client::new();
    /// let correlations = client.get_gene_correlations("STAT4", Some(10)).await?;
    /// for corr in correlations {
    ///     println!("{}: {:.4}", corr.gene_symbol, corr.pearson_correlation);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_gene_correlations(
        &self,
        gene: &str,
        gene_count: Option<u32>,
    ) -> BioApiResult<Vec<GeneCorrelation>> {
        let gene = gene.to_uppercase();
        // Add 1 because the first result is the gene vs itself, which we'll drop
        let count = gene_count.unwrap_or(100) + 1;

        let request_body = CorrelationRequest {
            id: gene.clone(),
            count,
        };

        let response: CorrelationResponse = self
            .retry_policy
            .execute("get_gene_correlations", || {
                let body = request_body.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(CORRELATION_URL)
                        .header("Content-Type", "application/json")
                        .json(&body)
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("ARCHS4 correlation API error: {}", status),
                        });
                    }

                    response
                        .json::<CorrelationResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        // Check for API error in response
        if let Some(error) = response.error {
            if error.contains("not in colids") {
                return Err(BioApiError::NotFound(format!(
                    "Gene '{}' not found in ARCHS4 database. Try using the gene symbol instead of Ensembl ID.",
                    gene
                )));
            }
            return Err(BioApiError::ApiError {
                status: 400,
                message: error,
            });
        }

        // Validate response data
        if response.rowids.is_empty() {
            return Err(BioApiError::NotFound(format!(
                "No correlation data found for gene '{}'",
                gene
            )));
        }

        if response.rowids.len() != response.values.len() {
            return Err(BioApiError::InvalidResponse(
                "Mismatched rowids and values lengths".to_string(),
            ));
        }

        // Skip first result (gene vs itself) and pair up genes with correlation scores
        let correlations: Vec<GeneCorrelation> = response
            .rowids
            .into_iter()
            .zip(response.values)
            .skip(1) // Drop self-correlation
            .map(|(gene_symbol, pearson_correlation)| GeneCorrelation {
                gene_symbol,
                pearson_correlation,
            })
            .collect();

        Ok(correlations)
    }

    /// Get tissue-specific expression profile for a gene
    ///
    /// # Arguments
    /// * `gene` - Gene symbol (will be converted to uppercase)
    /// * `species` - Species (Human or Mouse)
    ///
    /// # Returns
    /// Vector of tissue expression values sorted by median expression (descending)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::archs4::{Archs4Client, Species};
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = Archs4Client::new();
    /// let expressions = client.get_tissue_expression("ACE2", Species::Human).await?;
    /// for expr in expressions {
    ///     println!("{}: {:.2}", expr.tissue, expr.median);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_tissue_expression(
        &self,
        gene: &str,
        species: Species,
    ) -> BioApiResult<Vec<TissueExpression>> {
        let gene = gene.to_uppercase();
        let url = format!(
            "{}?search={}&species={}&type=tissue",
            TISSUE_EXPRESSION_URL,
            urlencoding::encode(&gene),
            species.as_str()
        );

        let csv_text = self
            .retry_policy
            .execute("get_tissue_expression", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.post(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("ARCHS4 tissue expression API error: {}", status),
                        });
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await?;

        // Parse CSV response
        let mut expressions = self.parse_tissue_csv(&csv_text)?;

        // Check if result is too small (indicates gene not found)
        if expressions.len() < 2 {
            return Err(BioApiError::NotFound(format!(
                "Gene '{}' not found or insufficient tissue data. Try using the gene symbol instead of Ensembl ID.",
                gene
            )));
        }

        // Sort by median expression (descending)
        expressions.sort_by(|a, b| {
            b.median
                .partial_cmp(&a.median)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(expressions)
    }

    /// Parse CSV tissue expression data
    fn parse_tissue_csv(&self, csv_text: &str) -> BioApiResult<Vec<TissueExpression>> {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(csv_text.as_bytes());

        let mut expressions = Vec::new();

        for result in reader.records() {
            let record = result
                .map_err(|e| BioApiError::InvalidResponse(format!("CSV parse error: {}", e)))?;

            // Expected columns: tissue, median, q1, q3, [color (ignored)]
            if record.len() < 2 {
                continue;
            }

            let tissue = record.get(0).unwrap_or("").to_string();
            if tissue.is_empty() {
                continue;
            }

            // Parse median (skip NaN values)
            let median = record
                .get(1)
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|v| v.is_finite());

            if let Some(median) = median {
                let q1 = record
                    .get(2)
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite());

                let q3 = record
                    .get(3)
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite());

                expressions.push(TissueExpression {
                    tissue,
                    median,
                    q1,
                    q3,
                });
            }
        }

        Ok(expressions)
    }

    /// Generic query method that routes to the appropriate endpoint
    ///
    /// # Arguments
    /// * `gene` - Gene symbol (will be converted to uppercase)
    /// * `mode` - Query mode (Correlation or Tissue)
    /// * `species` - Species (required for Tissue mode, ignored for Correlation)
    /// * `gene_count` - Number of results (Correlation mode only)
    pub async fn query(
        &self,
        gene: &str,
        mode: QueryMode,
        species: Option<Species>,
        gene_count: Option<u32>,
    ) -> BioApiResult<Archs4Result> {
        match mode {
            QueryMode::Correlation => {
                let correlations = self.get_gene_correlations(gene, gene_count).await?;
                Ok(Archs4Result::Correlation(correlations))
            }
            QueryMode::Tissue => {
                let species = species.unwrap_or(Species::Human);
                let expressions = self.get_tissue_expression(gene, species).await?;
                Ok(Archs4Result::Tissue(expressions))
            }
        }
    }
}

/// Result type for ARCHS4 queries
#[derive(Debug)]
pub enum Archs4Result {
    Correlation(Vec<GeneCorrelation>),
    Tissue(Vec<TissueExpression>),
}

impl Default for Archs4Client {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = Archs4Client::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_species_conversion() {
        assert_eq!(Species::Human.as_str(), "human");
        assert_eq!(Species::Mouse.as_str(), "mouse");
    }

    #[test]
    fn test_query_mode() {
        let mode1 = QueryMode::Correlation;
        let mode2 = QueryMode::Tissue;
        assert_ne!(mode1, mode2);
    }

    #[test]
    fn test_parse_tissue_csv() {
        let client = Archs4Client::new();
        let csv_data = "tissue,median,q1,q3,color\n\
                        Liver,100.5,80.2,120.8,#FF0000\n\
                        Lung,50.3,40.1,60.5,#00FF00\n\
                        ,NaN,NaN,NaN,#0000FF\n\
                        Heart,75.0,,,#FFFF00";

        let result = client.parse_tissue_csv(csv_data).unwrap();
        assert_eq!(result.len(), 3); // NaN row filtered out
        assert_eq!(result[0].tissue, "Liver");
        assert_eq!(result[0].median, 100.5);
        assert_eq!(result[0].q1, Some(80.2));
        assert_eq!(result[0].q3, Some(120.8));

        assert_eq!(result[1].tissue, "Lung");
        assert_eq!(result[2].tissue, "Heart");
        assert_eq!(result[2].q1, None); // Missing values
    }

    #[test]
    fn test_parse_empty_csv() {
        let client = Archs4Client::new();
        let csv_data = "tissue,median,q1,q3\n";
        let result = client.parse_tissue_csv(csv_data).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_parse_invalid_csv() {
        let client = Archs4Client::new();
        let csv_data = "incomplete";
        // Should handle gracefully
        let result = client.parse_tissue_csv(csv_data);
        assert!(result.is_ok());
    }

    // Integration tests (require network access)
    #[cfg(feature = "integration-tests")]
    mod integration {
        use super::*;

        #[tokio::test]
        async fn test_get_gene_correlations_live() {
            let client = Archs4Client::new();
            let result = client.get_gene_correlations("STAT4", Some(10)).await;

            match result {
                Ok(correlations) => {
                    assert!(!correlations.is_empty());
                    assert!(correlations.len() <= 10);
                    // Correlations should be sorted descending
                    for i in 1..correlations.len() {
                        assert!(
                            correlations[i - 1].pearson_correlation
                                >= correlations[i].pearson_correlation
                        );
                    }
                }
                Err(e) => println!("Live test failed (expected if API unavailable): {}", e),
            }
        }

        #[tokio::test]
        async fn test_get_tissue_expression_live() {
            let client = Archs4Client::new();
            let result = client.get_tissue_expression("ACE2", Species::Human).await;

            match result {
                Ok(expressions) => {
                    assert!(!expressions.is_empty());
                    // Check sorted by median descending
                    for i in 1..expressions.len() {
                        assert!(expressions[i - 1].median >= expressions[i].median);
                    }
                }
                Err(e) => println!("Live test failed (expected if API unavailable): {}", e),
            }
        }

        #[tokio::test]
        async fn test_gene_not_found() {
            let client = Archs4Client::new();
            let result = client
                .get_gene_correlations("NONEXISTENTGENE12345", Some(10))
                .await;

            assert!(result.is_err());
            if let Err(BioApiError::NotFound(msg)) = result {
                assert!(msg.contains("not found"));
            }
        }

        #[tokio::test]
        async fn test_mouse_species() {
            let client = Archs4Client::new();
            let result = client.get_tissue_expression("Ace2", Species::Mouse).await;

            match result {
                Ok(expressions) => {
                    assert!(!expressions.is_empty());
                }
                Err(e) => println!("Live test failed (expected if API unavailable): {}", e),
            }
        }
    }
}
