//! Enrichr gene enrichment analysis API client.
//!
//! Documentation: https://maayanlab.cloud/Enrichr/help#api

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

const BASE_URL: &str = "https://maayanlab.cloud/speedrichr/api";
const REQUESTS_PER_SECOND: u32 = 5;

/// Enrichr API client
pub struct EnrichrClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentResult {
    pub term: String,
    pub p_value: f64,
    pub adjusted_p_value: f64,
    pub z_score: f64,
    pub combined_score: f64,
    pub genes: Vec<String>,
    pub gene_count: usize,
}

impl EnrichrClient {
    /// Create a new Enrichr client
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

    /// Submit gene list and perform enrichment analysis
    pub async fn enrich(
        &self,
        genes: &[String],
        gene_set_library: &str,
    ) -> BioApiResult<Vec<EnrichmentResult>> {
        // Step 1: Submit gene list and get userListId
        let user_list_id = self.add_list(genes).await?;

        // Step 2: Query enrichment results for the specified library
        self.get_enrichment(&user_list_id, gene_set_library).await
    }

    /// Submit gene list to Enrichr
    async fn add_list(&self, genes: &[String]) -> BioApiResult<String> {
        let gene_list = genes.join("\n");
        let url = format!("{}/addList", BASE_URL);

        let json: Value = self
            .retry_policy
            .execute("enrichr_add_list", || {
                let url = url.clone();
                let gene_list = gene_list.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    // Use multipart/form-data as gget does
                    let form = reqwest::multipart::Form::new()
                        .text("list", gene_list.clone())
                        .text("description", "AOSE gene list");

                    let response = self.client.post(&url).multipart(form).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: format!("Failed to submit gene list: {}", response.status()),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        let user_list_id = json["userListId"]
            .as_u64()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing userListId".to_string()))?;

        Ok(user_list_id.to_string())
    }

    /// Get enrichment results for a submitted gene list
    async fn get_enrichment(
        &self,
        user_list_id: &str,
        gene_set_library: &str,
    ) -> BioApiResult<Vec<EnrichmentResult>> {
        let url = format!(
            "{}/enrich?userListId={}&backgroundType={}",
            BASE_URL, user_list_id, gene_set_library
        );

        let json: Value = self
            .retry_policy
            .execute("enrichr_get_enrichment", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to fetch enrichment results".to_string(),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        // Parse enrichment results
        let results_array = json[gene_set_library]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing results array".to_string()))?;

        let mut results = Vec::new();
        for item in results_array {
            let arr = item
                .as_array()
                .ok_or_else(|| BioApiError::InvalidResponse("Invalid result format".to_string()))?;

            if arr.len() < 9 {
                continue;
            }

            let term = arr[1].as_str().unwrap_or("").to_string();
            let p_value = arr[2].as_f64().unwrap_or(1.0);
            let z_score = arr[3].as_f64().unwrap_or(0.0);
            let combined_score = arr[4].as_f64().unwrap_or(0.0);
            let genes_str = arr[5].as_str().unwrap_or("");
            let genes: Vec<String> = genes_str.split(';').map(|s| s.to_string()).collect();
            let adjusted_p_value = arr[6].as_f64().unwrap_or(1.0);

            results.push(EnrichmentResult {
                term,
                p_value,
                adjusted_p_value,
                z_score,
                combined_score,
                gene_count: genes.len(),
                genes,
            });
        }

        Ok(results)
    }

    /// List available gene set libraries
    pub async fn list_libraries(&self) -> BioApiResult<Vec<String>> {
        let url = format!("{}/datasetStatistics", BASE_URL);

        let json: Value = self
            .retry_policy
            .execute("enrichr_list_libraries", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to fetch libraries".to_string(),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        let libraries = json["statistics"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing statistics".to_string()))?
            .iter()
            .filter_map(|item| item["libraryName"].as_str().map(String::from))
            .collect();

        Ok(libraries)
    }
}

impl Default for EnrichrClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = EnrichrClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }
}
