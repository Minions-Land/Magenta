//! RCSB Protein Data Bank (PDB) API client.
//!
//! Documentation: https://data.rcsb.org/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

const BASE_URL: &str = "https://data.rcsb.org/rest/v1/core";
const FILES_URL: &str = "https://files.rcsb.org/download";
const REQUESTS_PER_SECOND: u32 = 10;

/// RCSB PDB API client
pub struct PdbClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdbEntry {
    pub pdb_id: String,
    pub title: Option<String>,
    pub experimental_method: Vec<String>,
    pub resolution: Option<f64>,
    pub release_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdbPolymer {
    pub entity_id: String,
    pub chain_ids: Vec<String>,
    pub sequence: Option<String>,
    pub molecular_weight: Option<f64>,
}

impl PdbClient {
    /// Create a new PDB client
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

    /// Get PDB entry information
    pub async fn get_entry(&self, pdb_id: &str) -> BioApiResult<PdbEntry> {
        let url = format!("{}/entry/{}", BASE_URL, pdb_id.to_uppercase());

        let json: Value = self
            .retry_policy
            .execute("pdb_get_entry", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "PDB entry {} not found",
                                pdb_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("PDB API error: {}", status),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        // Parse entry metadata
        let title = json["struct"]["title"].as_str().map(String::from);

        let experimental_method = json["exptl"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e["method"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let resolution = json["rcsb_entry_info"]["resolution_combined"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_f64());

        let release_date = json["rcsb_accession_info"]["initial_release_date"]
            .as_str()
            .map(String::from);

        Ok(PdbEntry {
            pdb_id: pdb_id.to_uppercase(),
            title,
            experimental_method,
            resolution,
            release_date,
        })
    }

    /// Get polymer (protein/nucleic acid) entities in a PDB entry
    pub async fn get_polymers(&self, pdb_id: &str) -> BioApiResult<Vec<PdbPolymer>> {
        let url = format!("{}/entry/{}", BASE_URL, pdb_id.to_uppercase());

        let json: Value = self
            .retry_policy
            .execute("pdb_get_polymers", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound(format!(
                            "PDB entry {} not found",
                            pdb_id
                        )));
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        let mut polymers = Vec::new();

        if let Some(entities) =
            json["rcsb_entry_container_identifiers"]["polymer_entity_ids"].as_array()
        {
            for entity_id in entities {
                let entity_id_str = entity_id.as_str().unwrap_or("").to_string();

                // Fetch entity details
                let entity_url = format!(
                    "{}/polymer_entity/{}/{}",
                    BASE_URL,
                    pdb_id.to_uppercase(),
                    entity_id_str
                );
                let entity_json: Value = self
                    .retry_policy
                    .execute("pdb_get_entity", || {
                        let url = entity_url.clone();
                        async move {
                            self.rate_limiter.acquire().await;
                            let response = self.client.get(&url).send().await?;
                            response.json::<Value>().await.map_err(Into::into)
                        }
                    })
                    .await
                    .unwrap_or_default();

                let chain_ids = entity_json["entity_poly"]["pdbx_strand_id"]
                    .as_str()
                    .map(|s| s.split(',').map(|c| c.trim().to_string()).collect())
                    .unwrap_or_default();

                let sequence = entity_json["entity_poly"]["pdbx_seq_one_letter_code_can"]
                    .as_str()
                    .map(|s| s.replace('\n', ""));

                let molecular_weight =
                    entity_json["rcsb_polymer_entity"]["formula_weight"].as_f64();

                polymers.push(PdbPolymer {
                    entity_id: entity_id_str,
                    chain_ids,
                    sequence,
                    molecular_weight,
                });
            }
        }

        Ok(polymers)
    }

    /// Download PDB structure file
    pub async fn download_structure(
        &self,
        pdb_id: &str,
        format: PdbFormat,
        output_path: &Path,
    ) -> BioApiResult<()> {
        let extension = match format {
            PdbFormat::Pdb => "pdb",
            PdbFormat::Cif => "cif",
            PdbFormat::Xml => "xml",
        };

        let url = format!("{}/{}.{}", FILES_URL, pdb_id.to_uppercase(), extension);

        let bytes = self
            .retry_policy
            .execute("pdb_download", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound(format!(
                            "PDB file {} not found",
                            pdb_id
                        )));
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

    /// Search PDB by text query (simple keyword search using UniProt mapping)
    pub async fn search_by_uniprot(&self, uniprot_id: &str) -> BioApiResult<Vec<String>> {
        let url = format!(
            "https://www.ebi.ac.uk/pdbe/api/mappings/uniprot/{}",
            uniprot_id
        );

        let json: Value = self
            .retry_policy
            .execute("pdb_search_uniprot", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound(format!(
                            "No PDB entries for UniProt {}",
                            uniprot_id
                        )));
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        let mut pdb_ids = Vec::new();
        if let Some(obj) = json[uniprot_id]["PDB"].as_object() {
            for key in obj.keys() {
                pdb_ids.push(key.to_uppercase());
            }
        }

        Ok(pdb_ids)
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PdbFormat {
    Pdb,
    Cif,
    Xml,
}

impl Default for PdbClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = PdbClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }
}
