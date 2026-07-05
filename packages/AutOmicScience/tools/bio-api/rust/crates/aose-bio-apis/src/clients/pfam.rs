//! Pfam protein family database API client via InterPro.
//!
//! Pfam is now served through the InterPro REST API at EBI.
//! Documentation: https://www.ebi.ac.uk/interpro/api/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://www.ebi.ac.uk/interpro/api";
const REQUESTS_PER_SECOND: u32 = 5;

/// Pfam API client
pub struct PfamClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Pfam entry metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PfamEntry {
    pub accession: String,
    pub name: Option<String>,
    pub entry_type: Option<String>,
    pub description: Option<String>,
    pub go_terms: Vec<String>,
    pub member_databases: Vec<String>,
    pub source_database: String,
}

/// Protein domain annotation (Pfam match on a protein)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProteinDomain {
    pub accession: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub protein_id: String,
    pub start: Option<u32>,
    pub end: Option<u32>,
    pub e_value: Option<f64>,
}

/// Search parameters for Pfam entries
#[derive(Debug, Clone, Default)]
pub struct PfamSearchParams {
    pub query: Option<String>,
    pub page_size: Option<u32>,
    pub cursor: Option<String>,
}

/// Paginated response structure
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PaginatedResponse {
    count: u32,
    next: Option<String>,
    previous: Option<String>,
    results: Vec<serde_json::Value>,
}

impl PfamClient {
    /// Create a new Pfam client
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

    /// Get a specific Pfam entry by accession (e.g., PF00001)
    pub async fn get_entry(&self, accession: &str) -> BioApiResult<PfamEntry> {
        let url = format!("{}/entry/pfam/{}", BASE_URL, accession);

        let json: serde_json::Value = self
            .retry_policy
            .execute("pfam_get_entry", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Pfam entry '{}' not found",
                                accession
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("Pfam API error: {}", status),
                        });
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        self.parse_entry(json)
    }

    /// Search Pfam entries by name or description
    pub async fn search_entries(&self, params: PfamSearchParams) -> BioApiResult<Vec<PfamEntry>> {
        let mut url = format!("{}/entry/pfam/", BASE_URL);
        let mut query_params = Vec::new();

        if let Some(query) = &params.query {
            query_params.push(format!("search={}", urlencoding::encode(query)));
        }

        if let Some(page_size) = params.page_size {
            query_params.push(format!("page_size={}", page_size));
        }

        if let Some(cursor) = &params.cursor {
            query_params.push(format!("cursor={}", cursor));
        }

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        let response: PaginatedResponse = self
            .retry_policy
            .execute("pfam_search_entries", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("Pfam search failed: {}", status),
                        });
                    }

                    response
                        .json::<PaginatedResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        let mut entries = Vec::new();
        for result in response.results {
            if let Ok(entry) = self.parse_entry(result) {
                entries.push(entry);
            }
        }

        Ok(entries)
    }

    /// List all Pfam entries (with pagination support)
    pub async fn list_entries(&self, page_size: Option<u32>) -> BioApiResult<Vec<PfamEntry>> {
        self.search_entries(PfamSearchParams {
            query: None,
            page_size,
            cursor: None,
        })
        .await
    }

    /// Get Pfam domains for a specific UniProt protein
    pub async fn get_protein_domains(&self, uniprot_id: &str) -> BioApiResult<Vec<ProteinDomain>> {
        let url = format!("{}/protein/uniprot/{}?entry=pfam", BASE_URL, uniprot_id);

        let json: serde_json::Value = self
            .retry_policy
            .execute("pfam_get_protein_domains", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Protein '{}' not found or has no Pfam domains",
                                uniprot_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("Pfam API error: {}", status),
                        });
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        self.parse_protein_domains(json, uniprot_id)
    }

    /// Parse a single Pfam entry from JSON
    fn parse_entry(&self, json: serde_json::Value) -> BioApiResult<PfamEntry> {
        let metadata = &json["metadata"];

        let accession = metadata["accession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing accession in entry".to_string()))?
            .to_string();

        let name = metadata["name"].as_str().map(String::from);

        let entry_type = metadata["type"].as_str().map(String::from);

        // Description can be in multiple fields
        let description = metadata["description"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|v| v["text"].as_str())
            .or_else(|| metadata["name"]["name"].as_str())
            .map(String::from);

        // Extract GO terms if available
        let go_terms = metadata["go_terms"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v["identifier"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // Extract member databases
        let member_databases = metadata["member_databases"]
            .as_object()
            .map(|obj| obj.keys().cloned().collect())
            .unwrap_or_default();

        Ok(PfamEntry {
            accession,
            name,
            entry_type,
            description,
            go_terms,
            member_databases,
            source_database: "pfam".to_string(),
        })
    }

    /// Parse protein domains from InterPro protein endpoint response
    fn parse_protein_domains(
        &self,
        json: serde_json::Value,
        protein_id: &str,
    ) -> BioApiResult<Vec<ProteinDomain>> {
        let mut domains = Vec::new();

        // Navigate to the entry matches in the response
        if let Some(entries) = json["results"].as_array() {
            for entry in entries {
                if let Some(metadata) = entry["metadata"].as_object() {
                    let accession = metadata
                        .get("accession")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let name = metadata
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(String::from);

                    let description = metadata
                        .get("description")
                        .and_then(|v| {
                            if v.is_array() {
                                v.as_array()?.first()?.get("text")?.as_str()
                            } else {
                                v.as_str()
                            }
                        })
                        .map(String::from);

                    // Extract domain locations
                    if let Some(proteins) = entry["proteins"].as_array() {
                        for protein in proteins {
                            if let Some(matches) = protein["entry_protein_locations"].as_array() {
                                for match_loc in matches {
                                    if let Some(fragments) = match_loc["fragments"].as_array() {
                                        for fragment in fragments {
                                            let start =
                                                fragment["start"].as_u64().map(|v| v as u32);
                                            let end = fragment["end"].as_u64().map(|v| v as u32);

                                            domains.push(ProteinDomain {
                                                accession: accession.clone(),
                                                name: name.clone(),
                                                description: description.clone(),
                                                protein_id: protein_id.to_string(),
                                                start,
                                                end,
                                                e_value: None, // InterPro API doesn't expose e-values
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(domains)
    }
}

impl Default for PfamClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = PfamClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_parse_entry() {
        let client = PfamClient::new();
        let json = serde_json::json!({
            "metadata": {
                "accession": "PF00001",
                "name": "7tm_1",
                "type": "family",
                "description": [{"text": "7 transmembrane receptor"}],
                "go_terms": [{"identifier": "GO:0004930"}],
                "member_databases": {"pfam": {}}
            }
        });

        let entry = client.parse_entry(json).unwrap();
        assert_eq!(entry.accession, "PF00001");
        assert_eq!(entry.name, Some("7tm_1".to_string()));
        assert_eq!(entry.entry_type, Some("family".to_string()));
        assert!(entry.description.is_some());
        assert_eq!(entry.go_terms.len(), 1);
    }

    #[tokio::test]
    async fn test_search_params_default() {
        let params = PfamSearchParams::default();
        assert!(params.query.is_none());
        assert!(params.page_size.is_none());
        assert!(params.cursor.is_none());
    }
}
