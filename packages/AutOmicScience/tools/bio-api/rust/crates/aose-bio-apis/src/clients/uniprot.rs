//! UniProt REST API client.
//!
//! Documentation: https://www.uniprot.org/help/api

use crate::error::{BioApiError, BioApiResult};
use crate::models::{Fasta, ProteinRecord};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde_json::Value;
use std::sync::Arc;

const BASE_URL: &str = "https://rest.uniprot.org/uniprotkb";
const REQUESTS_PER_SECOND: u32 = 10;

/// UniProt REST API client
pub struct UniProtClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl UniProtClient {
    /// Create a new UniProt client
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

    /// Get protein annotation by UniProt ID
    pub async fn get_protein_info(&self, uniprot_id: &str) -> BioApiResult<ProteinRecord> {
        let url = format!("{}/{}.json", BASE_URL, uniprot_id);

        let json: Value = self
            .retry_policy
            .execute("get_protein_info", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Protein '{}' not found",
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

        // Parse the complex UniProt JSON into our simpler ProteinRecord
        let primary_accession = json["primaryAccession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing primaryAccession".to_string()))?;

        let organism = json["organism"]["scientificName"]
            .as_str()
            .unwrap_or("Unknown")
            .to_string();

        // Extract gene names
        let gene_names = json["genes"]
            .as_array()
            .map(|genes| {
                genes
                    .iter()
                    .filter_map(|g| g["geneName"]["value"].as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // Extract protein name
        let protein_name = json["proteinDescription"]["recommendedName"]["fullName"]["value"]
            .as_str()
            .map(String::from);

        // Extract sequence
        let sequence = json["sequence"]["value"].as_str().map(String::from);
        let length = json["sequence"]["length"].as_u64().map(|l| l as usize);

        // Extract function (first comment of type "function")
        let function = json["comments"].as_array().and_then(|comments| {
            comments
                .iter()
                .find(|c| c["commentType"].as_str() == Some("FUNCTION"))
                .and_then(|c| c["texts"].as_array())
                .and_then(|texts| texts.first())
                .and_then(|t| t["value"].as_str())
                .map(String::from)
        });

        // Extract subcellular location
        let subcellular_location = json["comments"].as_array().and_then(|comments| {
            comments
                .iter()
                .find(|c| c["commentType"].as_str() == Some("SUBCELLULAR LOCATION"))
                .and_then(|c| c["subcellularLocations"].as_array())
                .map(|locs| {
                    locs.iter()
                        .filter_map(|loc| loc["location"]["value"].as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
        });

        Ok(ProteinRecord {
            uniprot_id: primary_accession.to_string(),
            protein_name,
            gene_names,
            organism,
            sequence,
            length,
            function,
            subcellular_location,
        })
    }

    /// Get protein sequence in FASTA format
    pub async fn get_protein_sequence(&self, uniprot_id: &str) -> BioApiResult<Fasta> {
        let url = format!("{}/{}.fasta", BASE_URL, uniprot_id);

        let text = self
            .retry_policy
            .execute("get_protein_sequence", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound(format!(
                            "Sequence for '{}' not found",
                            uniprot_id
                        )));
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await?;

        // Parse FASTA (header line + sequence lines)
        let mut lines = text.lines();
        let header = lines
            .next()
            .ok_or_else(|| BioApiError::InvalidResponse("Empty FASTA".to_string()))?
            .trim_start_matches('>')
            .to_string();
        let sequence = lines.collect::<String>().replace('\n', "");

        Ok(Fasta {
            id: uniprot_id.to_string(),
            description: Some(header),
            sequence,
        })
    }

    /// Search proteins by gene name or other criteria
    pub async fn search_proteins(&self, query: &str) -> BioApiResult<Vec<ProteinRecord>> {
        let url = format!(
            "{}/search?query={}&format=json&size=10",
            BASE_URL,
            urlencoding::encode(query)
        );

        let json: Value = self
            .retry_policy
            .execute("search_proteins", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Search failed".to_string(),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        let results = json["results"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing results array".to_string()))?;

        let mut records = Vec::new();
        for result in results.iter().take(10) {
            let accession = result["primaryAccession"]
                .as_str()
                .ok_or_else(|| BioApiError::InvalidResponse("Missing accession".to_string()))?;

            // For search results, we do a lightweight parse without fetching full details
            let organism = result["organism"]["scientificName"]
                .as_str()
                .unwrap_or("Unknown")
                .to_string();

            let gene_names = result["genes"]
                .as_array()
                .map(|genes| {
                    genes
                        .iter()
                        .filter_map(|g| g["geneName"]["value"].as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let protein_name = result["proteinDescription"]["recommendedName"]["fullName"]["value"]
                .as_str()
                .map(String::from);

            records.push(ProteinRecord {
                uniprot_id: accession.to_string(),
                protein_name,
                gene_names,
                organism,
                sequence: None,
                length: result["sequence"]["length"].as_u64().map(|l| l as usize),
                function: None,
                subcellular_location: None,
            });
        }

        Ok(records)
    }
}

impl Default for UniProtClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = UniProtClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }
}
