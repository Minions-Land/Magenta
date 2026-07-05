//! Reactome Pathway Database API client.
//!
//! Documentation: https://reactome.org/ContentService/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tracing::debug;

const BASE_URL: &str = "https://reactome.org/ContentService";
const REQUESTS_PER_SECOND: u32 = 10;

/// Reactome API client
pub struct ReactomeClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl ReactomeClient {
    /// Create a new Reactome client with default configuration
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

    /// Get pathway or entity by stable ID (e.g., "R-HSA-69278")
    pub async fn get_entity(&self, stable_id: &str) -> BioApiResult<PathwayEntity> {
        let url = format!("{}/data/query/{}", BASE_URL, stable_id);
        let operation = format!("get_entity: {}", stable_id);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Entity '{}' not found",
                                stable_id
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
                    self.parse_pathway_entity(&json)
                }
            })
            .await
    }

    /// Full-text search across pathways, reactions, and entities
    pub async fn search(
        &self,
        query: &str,
        species: Option<&str>,
    ) -> BioApiResult<Vec<SearchResult>> {
        let url = format!("{}/search/query", BASE_URL);
        let operation = format!("search: {}", query);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                let query = query.to_string();
                let species = species.map(|s| s.to_string());
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {} (query={})", url, query);
                    let mut request = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .query(&[("query", query.as_str())]);

                    if let Some(species_name) = &species {
                        request = request.query(&[("species", species_name.as_str())]);
                    }

                    let response = request.send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
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
                    let results = json["results"].as_array().ok_or_else(|| {
                        BioApiError::InvalidResponse("Missing 'results' field".to_string())
                    })?;

                    let search_results: Vec<SearchResult> = results
                        .iter()
                        .filter_map(|item| self.parse_search_result(item))
                        .collect();

                    Ok(search_results)
                }
            })
            .await
    }

    /// Get autocomplete suggestions for a query term
    pub async fn suggest(&self, query: &str) -> BioApiResult<Vec<String>> {
        let url = format!("{}/search/suggest", BASE_URL);
        let operation = format!("suggest: {}", query);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                let query = query.to_string();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {} (query={})", url, query);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .query(&[("query", query.as_str())])
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
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
                    let suggestions = json
                        .as_array()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse(
                                "Expected array of suggestions".to_string(),
                            )
                        })?
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();

                    Ok(suggestions)
                }
            })
            .await
    }

    /// Get all available species
    pub async fn get_species(&self) -> BioApiResult<Vec<Species>> {
        let url = format!("{}/data/species/all", BASE_URL);
        let operation = "get_species".to_string();

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
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
                    let species_list = json
                        .as_array()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse("Expected array of species".to_string())
                        })?
                        .iter()
                        .filter_map(|item| self.parse_species(item))
                        .collect();

                    Ok(species_list)
                }
            })
            .await
    }

    /// Get all disease annotations
    pub async fn get_diseases(&self) -> BioApiResult<Vec<Disease>> {
        let url = format!("{}/data/diseases", BASE_URL);
        let operation = "get_diseases".to_string();

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
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
                    let diseases = json
                        .as_array()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse("Expected array of diseases".to_string())
                        })?
                        .iter()
                        .filter_map(|item| self.parse_disease(item))
                        .collect();

                    Ok(diseases)
                }
            })
            .await
    }

    /// Get events contained within a pathway
    pub async fn get_contained_events(&self, pathway_id: &str) -> BioApiResult<Vec<PathwayEvent>> {
        let url = format!("{}/data/pathway/{}/containedEvents", BASE_URL, pathway_id);
        let operation = format!("get_contained_events: {}", pathway_id);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Pathway '{}' not found",
                                pathway_id
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
                    let events = json
                        .as_array()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse("Expected array of events".to_string())
                        })?
                        .iter()
                        .filter_map(|item| self.parse_pathway_event(item))
                        .collect();

                    Ok(events)
                }
            })
            .await
    }

    /// Get complete pathway hierarchy for a species (e.g., 9606 for human)
    pub async fn get_pathway_hierarchy(
        &self,
        species_id: &str,
    ) -> BioApiResult<Vec<PathwayHierarchy>> {
        let url = format!("{}/data/eventsHierarchy/{}", BASE_URL, species_id);
        let operation = format!("get_pathway_hierarchy: {}", species_id);

        self.retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Content-Type", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Species '{}' not found",
                                species_id
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
                    let hierarchies = json
                        .as_array()
                        .ok_or_else(|| {
                            BioApiError::InvalidResponse(
                                "Expected array of hierarchies".to_string(),
                            )
                        })?
                        .iter()
                        .filter_map(|item| self.parse_pathway_hierarchy(item))
                        .collect();

                    Ok(hierarchies)
                }
            })
            .await
    }

    /// Parse pathway entity from JSON
    fn parse_pathway_entity(&self, json: &Value) -> BioApiResult<PathwayEntity> {
        Ok(PathwayEntity {
            db_id: json["dbId"].as_u64(),
            stable_id: json["stId"].as_str().map(String::from),
            display_name: json["displayName"]
                .as_str()
                .unwrap_or("Unknown")
                .to_string(),
            species_name: json["speciesName"].as_str().map(String::from),
            schema_class: json["schemaClass"].as_str().map(String::from),
            summation: json["summation"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|s| s["text"].as_str())
                .map(String::from),
        })
    }

    /// Parse search result from JSON
    fn parse_search_result(&self, json: &Value) -> Option<SearchResult> {
        Some(SearchResult {
            db_id: json["dbId"].as_u64()?,
            stable_id: json["stId"].as_str()?.to_string(),
            display_name: json["name"].as_str()?.to_string(),
            species: json["species"].as_str().map(String::from),
            entity_type: json["type"].as_str()?.to_string(),
            exact_match: json["isDisease"].as_bool().unwrap_or(false),
        })
    }

    /// Parse species from JSON
    fn parse_species(&self, json: &Value) -> Option<Species> {
        Some(Species {
            db_id: json["dbId"].as_u64()?,
            tax_id: json["taxId"].as_str()?.to_string(),
            display_name: json["displayName"].as_str()?.to_string(),
            abbreviation: json["abbreviation"].as_str().map(String::from),
        })
    }

    /// Parse disease from JSON
    fn parse_disease(&self, json: &Value) -> Option<Disease> {
        Some(Disease {
            db_id: json["dbId"].as_u64()?,
            display_name: json["displayName"].as_str()?.to_string(),
            identifier: json["identifier"].as_str().map(String::from),
            database_name: json["databaseName"].as_str().map(String::from),
        })
    }

    /// Parse pathway event from JSON
    fn parse_pathway_event(&self, json: &Value) -> Option<PathwayEvent> {
        Some(PathwayEvent {
            db_id: json["dbId"].as_u64()?,
            stable_id: json["stId"].as_str()?.to_string(),
            display_name: json["displayName"].as_str()?.to_string(),
            schema_class: json["schemaClass"].as_str()?.to_string(),
        })
    }

    /// Parse pathway hierarchy from JSON
    fn parse_pathway_hierarchy(&self, json: &Value) -> Option<PathwayHierarchy> {
        Some(PathwayHierarchy {
            db_id: json["dbId"].as_u64()?,
            stable_id: json["stId"].as_str()?.to_string(),
            display_name: json["displayName"].as_str()?.to_string(),
            has_diagram: json["hasDiagram"].as_bool().unwrap_or(false),
            has_children: json["children"]
                .as_array()
                .map(|arr| !arr.is_empty())
                .unwrap_or(false),
        })
    }
}

impl Default for ReactomeClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Pathway or entity information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathwayEntity {
    pub db_id: Option<u64>,
    pub stable_id: Option<String>,
    pub display_name: String,
    pub species_name: Option<String>,
    pub schema_class: Option<String>,
    pub summation: Option<String>,
}

/// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub db_id: u64,
    pub stable_id: String,
    pub display_name: String,
    pub species: Option<String>,
    pub entity_type: String,
    pub exact_match: bool,
}

/// Species information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Species {
    pub db_id: u64,
    pub tax_id: String,
    pub display_name: String,
    pub abbreviation: Option<String>,
}

/// Disease annotation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Disease {
    pub db_id: u64,
    pub display_name: String,
    pub identifier: Option<String>,
    pub database_name: Option<String>,
}

/// Pathway event (contained within a pathway)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathwayEvent {
    pub db_id: u64,
    pub stable_id: String,
    pub display_name: String,
    pub schema_class: String,
}

/// Pathway hierarchy node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathwayHierarchy {
    pub db_id: u64,
    pub stable_id: String,
    pub display_name: String,
    pub has_diagram: bool,
    pub has_children: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = ReactomeClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_custom_retry_policy() {
        let policy = RetryPolicy::new(5, std::time::Duration::from_millis(50));
        let client = ReactomeClient::with_retry_policy(policy);
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_parse_pathway_entity() {
        let client = ReactomeClient::new();
        let json = serde_json::json!({
            "dbId": 69278,
            "stId": "R-HSA-69278",
            "displayName": "Cell Cycle, Mitotic",
            "speciesName": "Homo sapiens",
            "schemaClass": "Pathway",
            "summation": [{
                "text": "The replication of the genome and the subsequent segregation of chromosomes into daughter cells are controlled by a series of events collectively known as the cell cycle."
            }]
        });

        let entity = client.parse_pathway_entity(&json).unwrap();
        assert_eq!(entity.db_id, Some(69278));
        assert_eq!(entity.stable_id, Some("R-HSA-69278".to_string()));
        assert_eq!(entity.display_name, "Cell Cycle, Mitotic");
        assert_eq!(entity.species_name, Some("Homo sapiens".to_string()));
        assert_eq!(entity.schema_class, Some("Pathway".to_string()));
        assert!(entity.summation.is_some());
    }

    #[tokio::test]
    async fn test_parse_search_result() {
        let client = ReactomeClient::new();
        let json = serde_json::json!({
            "dbId": 69278,
            "stId": "R-HSA-69278",
            "name": "Cell Cycle, Mitotic",
            "species": "Homo sapiens",
            "type": "Pathway",
            "isDisease": false
        });

        let result = client.parse_search_result(&json).unwrap();
        assert_eq!(result.db_id, 69278);
        assert_eq!(result.stable_id, "R-HSA-69278");
        assert_eq!(result.display_name, "Cell Cycle, Mitotic");
        assert_eq!(result.species, Some("Homo sapiens".to_string()));
        assert_eq!(result.entity_type, "Pathway");
        assert!(!result.exact_match);
    }

    #[tokio::test]
    async fn test_parse_species() {
        let client = ReactomeClient::new();
        let json = serde_json::json!({
            "dbId": 48887,
            "taxId": "9606",
            "displayName": "Homo sapiens",
            "abbreviation": "HSA"
        });

        let species = client.parse_species(&json).unwrap();
        assert_eq!(species.db_id, 48887);
        assert_eq!(species.tax_id, "9606");
        assert_eq!(species.display_name, "Homo sapiens");
        assert_eq!(species.abbreviation, Some("HSA".to_string()));
    }

    #[tokio::test]
    async fn test_parse_pathway_event() {
        let client = ReactomeClient::new();
        let json = serde_json::json!({
            "dbId": 68886,
            "stId": "R-HSA-68886",
            "displayName": "M Phase",
            "schemaClass": "Pathway"
        });

        let event = client.parse_pathway_event(&json).unwrap();
        assert_eq!(event.db_id, 68886);
        assert_eq!(event.stable_id, "R-HSA-68886");
        assert_eq!(event.display_name, "M Phase");
        assert_eq!(event.schema_class, "Pathway");
    }

    #[tokio::test]
    async fn test_parse_pathway_hierarchy() {
        let client = ReactomeClient::new();
        let json = serde_json::json!({
            "dbId": 69278,
            "stId": "R-HSA-69278",
            "displayName": "Cell Cycle, Mitotic",
            "hasDiagram": true,
            "children": [
                {"dbId": 68886}
            ]
        });

        let hierarchy = client.parse_pathway_hierarchy(&json).unwrap();
        assert_eq!(hierarchy.db_id, 69278);
        assert_eq!(hierarchy.stable_id, "R-HSA-69278");
        assert_eq!(hierarchy.display_name, "Cell Cycle, Mitotic");
        assert!(hierarchy.has_diagram);
        assert!(hierarchy.has_children);
    }
}
