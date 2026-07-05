//! AlphaFold Database API client.
//!
//! Documentation: https://alphafold.ebi.ac.uk/api-docs

use crate::error::{BioApiError, BioApiResult};
use crate::models::AlphaFoldStructure;
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

const BASE_URL: &str = "https://alphafold.ebi.ac.uk/api/prediction";
const FILES_URL: &str = "https://alphafold.ebi.ac.uk/files";
const REQUESTS_PER_SECOND: u32 = 10;

/// AlphaFold Database API client
pub struct AlphaFoldClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl AlphaFoldClient {
    /// Create a new AlphaFold client
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Get structure prediction metadata
    pub async fn get_prediction(&self, uniprot_id: &str) -> BioApiResult<AlphaFoldStructure> {
        let url = format!("{}/{}", BASE_URL, uniprot_id);

        let json: Value = self
            .retry_policy
            .execute("get_prediction", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "No AlphaFold prediction for '{}'",
                                uniprot_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("AlphaFold API error: {}", status),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        // AlphaFold API returns an array; take the first (latest) prediction
        let prediction = json.as_array().and_then(|arr| arr.first()).ok_or_else(|| {
            BioApiError::NotFound(format!("No prediction found for {}", uniprot_id))
        })?;

        let model_version = prediction["latestVersion"]
            .as_u64()
            .map(|v| format!("v{}", v))
            .unwrap_or_else(|| "v1".to_string());

        let model_date = prediction["modelCreatedDate"].as_str().map(String::from);

        let latest_version = prediction["latestVersion"].as_u64().unwrap_or(1) as u32;

        // Construct PDB/PAE URLs based on model ID and version
        let pdb_url = format!(
            "{}/AF-{}-F1-model_v{}.pdb",
            FILES_URL, uniprot_id, latest_version
        );
        let pae_url = format!(
            "{}/AF-{}-F1-predicted_aligned_error_v{}.json",
            FILES_URL, uniprot_id, latest_version
        );

        // Extract pLDDT confidence scores if available
        let confidence_scores = prediction["confidence"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect());

        Ok(AlphaFoldStructure {
            uniprot_id: uniprot_id.to_string(),
            model_version,
            model_date,
            confidence_scores,
            pdb_url: Some(pdb_url),
            pae_url: Some(pae_url),
        })
    }

    /// Download PDB file for a prediction
    pub async fn download_pdb(&self, uniprot_id: &str, output_path: &Path) -> BioApiResult<()> {
        let structure = self.get_prediction(uniprot_id).await?;
        let pdb_url = structure
            .pdb_url
            .ok_or_else(|| BioApiError::NotFound("No PDB URL available".to_string()))?;

        let bytes = self
            .retry_policy
            .execute("download_pdb", || {
                let url = pdb_url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound("PDB file not found".to_string()));
                    }

                    response.bytes().await.map_err(Into::into)
                }
            })
            .await?;

        tokio::fs::write(output_path, bytes)
            .await
            .map_err(|e| BioApiError::Other(format!("Failed to write PDB file: {}", e)))?;

        Ok(())
    }

    /// Get predicted aligned error (PAE) data
    pub async fn get_pae_data(&self, uniprot_id: &str) -> BioApiResult<Vec<Vec<f64>>> {
        let structure = self.get_prediction(uniprot_id).await?;
        let pae_url = structure
            .pae_url
            .ok_or_else(|| BioApiError::NotFound("No PAE data available".to_string()))?;

        let json: Value = self
            .retry_policy
            .execute("get_pae_data", || {
                let url = pae_url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound("PAE data not found".to_string()));
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        // PAE format: [[distance matrix]]
        let pae_matrix = json[0]["predicted_aligned_error"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing PAE matrix".to_string()))?;

        let matrix: Vec<Vec<f64>> = pae_matrix
            .iter()
            .filter_map(|row| {
                row.as_array()
                    .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
            })
            .collect();

        Ok(matrix)
    }
}

impl Default for AlphaFoldClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = AlphaFoldClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }
}
