//! STRING (Search Tool for the Retrieval of Interacting Genes/Proteins) API client.
//!
//! Documentation: https://string-db.org/cgi/help?subpage=api

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://string-db.org/api";
const REQUESTS_PER_SECOND: u32 = 1; // STRING recommends 1 second between calls

/// STRING database API client
pub struct StringClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl StringClient {
    /// Create a new STRING client
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

    /// Create a STRING client with custom rate limit
    pub fn with_rate_limit(requests_per_second: u32) -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(requests_per_second)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Get current STRING database version
    pub async fn version(&self) -> BioApiResult<String> {
        let url = format!("{}/json/version", BASE_URL);

        let response = self
            .retry_policy
            .execute("string_version", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to get STRING version".to_string(),
                        });
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        let version = response
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|v| v["string_version"].as_str())
            .ok_or_else(|| BioApiError::InvalidResponse("No version in response".to_string()))?;

        Ok(version.to_string())
    }

    /// Map protein identifiers to STRING IDs
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or IDs
    /// * `species` - NCBI taxonomy ID (e.g., 9606 for human)
    pub async fn get_string_ids(
        &self,
        identifiers: &[String],
        species: u32,
    ) -> BioApiResult<Vec<StringIdMapping>> {
        let url = format!("{}/json/get_string_ids", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let mappings = self
            .retry_policy
            .execute("string_get_ids", || {
                let url = url.clone();
                let identifiers_str = identifiers_str.clone();
                let species_str = species_str.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(&url)
                        .form(&[
                            ("identifiers", identifiers_str.as_str()),
                            ("species", &species_str),
                        ])
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to map STRING IDs".to_string(),
                        });
                    }

                    response
                        .json::<Vec<StringIdMapping>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(mappings)
    }

    /// Retrieve protein interaction network
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `params` - Network query parameters
    pub async fn network(
        &self,
        identifiers: &[String],
        params: NetworkParams,
    ) -> BioApiResult<Vec<Interaction>> {
        let url = format!("{}/json/network", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = params.species.to_string();

        let mut form = vec![
            ("identifiers", identifiers_str.as_str()),
            ("species", species_str.as_str()),
        ];

        let required_score_str;
        if let Some(score) = params.required_score {
            required_score_str = score.to_string();
            form.push(("required_score", &required_score_str));
        }

        let network_type_str;
        if let Some(ref network_type) = params.network_type {
            network_type_str = network_type.to_string();
            form.push(("network_type", &network_type_str));
        }

        let add_nodes_str;
        if let Some(add_nodes) = params.add_nodes {
            add_nodes_str = add_nodes.to_string();
            form.push(("add_nodes", &add_nodes_str));
        }

        let interactions = self
            .retry_policy
            .execute("string_network", || {
                let url = url.clone();
                let form = form.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.post(&url).form(&form).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to retrieve network".to_string(),
                        });
                    }

                    response
                        .json::<Vec<Interaction>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(interactions)
    }

    /// Get all interaction partners for given proteins
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `species` - NCBI taxonomy ID
    /// * `limit` - Maximum number of partners to return (optional)
    pub async fn interaction_partners(
        &self,
        identifiers: &[String],
        species: u32,
        limit: Option<u32>,
    ) -> BioApiResult<Vec<InteractionPartner>> {
        let url = format!("{}/json/interaction_partners", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let mut form = vec![
            ("identifiers", identifiers_str.as_str()),
            ("species", species_str.as_str()),
        ];

        let limit_str;
        if let Some(lim) = limit {
            limit_str = lim.to_string();
            form.push(("limit", &limit_str));
        }

        let partners = self
            .retry_policy
            .execute("string_interaction_partners", || {
                let url = url.clone();
                let form = form.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.post(&url).form(&form).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to get interaction partners".to_string(),
                        });
                    }

                    response
                        .json::<Vec<InteractionPartner>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(partners)
    }

    /// Perform functional enrichment analysis
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `species` - NCBI taxonomy ID
    pub async fn enrichment(
        &self,
        identifiers: &[String],
        species: u32,
    ) -> BioApiResult<Vec<EnrichmentTerm>> {
        let url = format!("{}/json/enrichment", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let enrichments = self
            .retry_policy
            .execute("string_enrichment", || {
                let url = url.clone();
                let identifiers_str = identifiers_str.clone();
                let species_str = species_str.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(&url)
                        .form(&[
                            ("identifiers", identifiers_str.as_str()),
                            ("species", &species_str),
                        ])
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to perform enrichment analysis".to_string(),
                        });
                    }

                    response
                        .json::<Vec<EnrichmentTerm>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(enrichments)
    }

    /// Get functional annotations (GO, PFAM, INTERPRO) for proteins
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `species` - NCBI taxonomy ID
    pub async fn functional_annotation(
        &self,
        identifiers: &[String],
        species: u32,
    ) -> BioApiResult<Vec<Annotation>> {
        let url = format!("{}/json/functional_annotation", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let annotations = self
            .retry_policy
            .execute("string_functional_annotation", || {
                let url = url.clone();
                let identifiers_str = identifiers_str.clone();
                let species_str = species_str.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(&url)
                        .form(&[
                            ("identifiers", identifiers_str.as_str()),
                            ("species", &species_str),
                        ])
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to get functional annotations".to_string(),
                        });
                    }

                    response.json::<Vec<Annotation>>().await.map_err(Into::into)
                }
            })
            .await?;

        Ok(annotations)
    }

    /// Test for protein-protein interaction enrichment
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `species` - NCBI taxonomy ID
    pub async fn ppi_enrichment(
        &self,
        identifiers: &[String],
        species: u32,
    ) -> BioApiResult<PpiEnrichment> {
        let url = format!("{}/json/ppi_enrichment", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let enrichments = self
            .retry_policy
            .execute("string_ppi_enrichment", || {
                let url = url.clone();
                let identifiers_str = identifiers_str.clone();
                let species_str = species_str.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(&url)
                        .form(&[
                            ("identifiers", identifiers_str.as_str()),
                            ("species", &species_str),
                        ])
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to test PPI enrichment".to_string(),
                        });
                    }

                    response
                        .json::<Vec<PpiEnrichment>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        // API returns an array, take the first element
        enrichments.into_iter().next().ok_or_else(|| {
            BioApiError::InvalidResponse("Empty PPI enrichment response".to_string())
        })
    }

    /// Get protein homology scores
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `species` - NCBI taxonomy ID
    pub async fn homology(
        &self,
        identifiers: &[String],
        species: u32,
    ) -> BioApiResult<Vec<HomologyScore>> {
        let url = format!("{}/json/homology", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let scores = self
            .retry_policy
            .execute("string_homology", || {
                let url = url.clone();
                let identifiers_str = identifiers_str.clone();
                let species_str = species_str.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(&url)
                        .form(&[
                            ("identifiers", identifiers_str.as_str()),
                            ("species", &species_str),
                        ])
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to get homology scores".to_string(),
                        });
                    }

                    response
                        .json::<Vec<HomologyScore>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(scores)
    }

    /// Get URL to STRING web interface for given proteins
    ///
    /// # Arguments
    /// * `identifiers` - List of protein names or STRING IDs
    /// * `species` - NCBI taxonomy ID
    pub async fn get_link(&self, identifiers: &[String], species: u32) -> BioApiResult<String> {
        let url = format!("{}/json/get_link", BASE_URL);
        let identifiers_str = identifiers.join("\n");
        let species_str = species.to_string();

        let links = self
            .retry_policy
            .execute("string_get_link", || {
                let url = url.clone();
                let identifiers_str = identifiers_str.clone();
                let species_str = species_str.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self
                        .client
                        .post(&url)
                        .form(&[
                            ("identifiers", identifiers_str.as_str()),
                            ("species", &species_str),
                        ])
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to get STRING link".to_string(),
                        });
                    }

                    response.json::<Vec<String>>().await.map_err(Into::into)
                }
            })
            .await?;

        // API returns an array of links, take the first one
        links
            .into_iter()
            .next()
            .ok_or_else(|| BioApiError::InvalidResponse("No link in response".to_string()))
    }
}

impl Default for StringClient {
    fn default() -> Self {
        Self::new()
    }
}

/// STRING ID mapping result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringIdMapping {
    #[serde(rename = "queryItem")]
    pub query_item: String,
    #[serde(rename = "stringId")]
    pub string_id: String,
    #[serde(rename = "preferredName")]
    pub preferred_name: String,
    pub annotation: Option<String>,
    #[serde(rename = "ncbiTaxonId")]
    pub ncbi_taxon_id: u32,
}

/// Protein-protein interaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interaction {
    #[serde(rename = "stringId_A")]
    pub string_id_a: String,
    #[serde(rename = "stringId_B")]
    pub string_id_b: String,
    #[serde(rename = "preferredName_A")]
    pub preferred_name_a: String,
    #[serde(rename = "preferredName_B")]
    pub preferred_name_b: String,
    #[serde(rename = "ncbiTaxonId")]
    pub ncbi_taxon_id: String,
    /// Combined confidence score (0.0-1.0)
    pub score: f64,
    /// Neighborhood evidence score (0.0-1.0)
    pub nscore: f64,
    /// Fusion evidence score (0.0-1.0)
    pub fscore: f64,
    /// Phylogenetic profile similarity score (0.0-1.0)
    pub pscore: f64,
    /// Coexpression score (0.0-1.0)
    #[serde(rename = "ascore")]
    pub coexpression_score: f64,
    /// Experimental evidence score (0.0-1.0)
    pub escore: f64,
    /// Database evidence score (0.0-1.0)
    pub dscore: f64,
    /// Text-mining score (0.0-1.0)
    pub tscore: f64,
}

/// Network query parameters
#[derive(Debug, Clone)]
pub struct NetworkParams {
    /// NCBI taxonomy ID (e.g., 9606 for human)
    pub species: u32,
    /// Minimum confidence score (0-1000), default 400
    pub required_score: Option<u32>,
    /// Network type: functional or physical
    pub network_type: Option<NetworkType>,
    /// Number of additional nodes to add (0-20), default 0
    pub add_nodes: Option<u32>,
}

impl Default for NetworkParams {
    fn default() -> Self {
        Self {
            species: 9606, // Human
            required_score: Some(400),
            network_type: None,
            add_nodes: None,
        }
    }
}

/// Network type filter
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkType {
    /// Functional associations
    Functional,
    /// Physical interactions
    Physical,
}

impl std::fmt::Display for NetworkType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetworkType::Functional => write!(f, "functional"),
            NetworkType::Physical => write!(f, "physical"),
        }
    }
}

/// Interaction partner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionPartner {
    #[serde(rename = "stringId_A")]
    pub string_id_a: String,
    #[serde(rename = "stringId_B")]
    pub string_id_b: String,
    #[serde(rename = "preferredName_A")]
    pub preferred_name_a: String,
    #[serde(rename = "preferredName_B")]
    pub preferred_name_b: String,
    #[serde(rename = "ncbiTaxonId")]
    pub ncbi_taxon_id: u32,
    pub score: u32,
}

/// Functional enrichment term
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentTerm {
    pub category: String,
    pub term: String,
    #[serde(rename = "number_of_genes")]
    pub number_of_genes: u32,
    #[serde(rename = "number_of_genes_in_background")]
    pub number_of_genes_in_background: u32,
    #[serde(rename = "ncbiTaxonId")]
    pub ncbi_taxon_id: u32,
    #[serde(rename = "inputGenes")]
    pub input_genes: Vec<String>,
    #[serde(rename = "preferredNames")]
    pub preferred_names: Vec<String>,
    /// P-value
    pub p_value: f64,
    /// False discovery rate
    pub fdr: f64,
    pub description: Option<String>,
}

/// Functional annotation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    #[serde(rename = "stringId")]
    pub string_id: String,
    #[serde(rename = "preferredName")]
    pub preferred_name: String,
    pub annotation: String,
    pub category: String,
    pub description: Option<String>,
}

/// PPI enrichment test result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PpiEnrichment {
    #[serde(rename = "number_of_nodes")]
    pub number_of_nodes: u32,
    #[serde(rename = "number_of_edges")]
    pub number_of_edges: u32,
    #[serde(rename = "average_node_degree")]
    pub average_node_degree: f64,
    #[serde(rename = "local_clustering_coefficient")]
    pub local_clustering_coefficient: f64,
    #[serde(rename = "expected_number_of_edges")]
    pub expected_number_of_edges: u32,
    #[serde(rename = "p_value")]
    pub p_value: f64,
}

/// Protein homology score
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomologyScore {
    #[serde(rename = "stringId_A")]
    pub string_id_a: String,
    #[serde(rename = "stringId_B")]
    pub string_id_b: String,
    #[serde(rename = "bitscore_A")]
    pub bitscore_a: f64,
    #[serde(rename = "bitscore_B")]
    pub bitscore_b: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = StringClient::new();
        assert_eq!(client.rate_limiter.rate(), REQUESTS_PER_SECOND);
    }

    #[tokio::test]
    async fn test_client_with_custom_rate_limit() {
        let client = StringClient::with_rate_limit(5);
        assert_eq!(client.rate_limiter.rate(), 5);
    }

    #[tokio::test]
    async fn test_network_params_default() {
        let params = NetworkParams::default();
        assert_eq!(params.species, 9606);
        assert_eq!(params.required_score, Some(400));
        assert!(params.network_type.is_none());
        assert!(params.add_nodes.is_none());
    }

    #[tokio::test]
    async fn test_network_type_display() {
        assert_eq!(NetworkType::Functional.to_string(), "functional");
        assert_eq!(NetworkType::Physical.to_string(), "physical");
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_version() {
        let client = StringClient::new();
        let version = client.version().await;
        assert!(version.is_ok());
        let version_str = version.unwrap();
        assert!(!version_str.is_empty());
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_get_string_ids() {
        let client = StringClient::new();
        let identifiers = vec!["TP53".to_string(), "BRCA1".to_string()];
        let mappings = client.get_string_ids(&identifiers, 9606).await;
        assert!(mappings.is_ok());
        let mappings = mappings.unwrap();
        assert!(!mappings.is_empty());
        assert_eq!(mappings.len(), 2);
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_network() {
        let client = StringClient::new();
        let identifiers = vec!["TP53".to_string()];
        let params = NetworkParams {
            species: 9606,
            required_score: Some(700),
            network_type: Some(NetworkType::Physical),
            add_nodes: Some(5),
        };
        let interactions = client.network(&identifiers, params).await;
        assert!(interactions.is_ok());
        let interactions = interactions.unwrap();
        assert!(!interactions.is_empty());
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_enrichment() {
        let client = StringClient::new();
        let identifiers = vec!["TP53".to_string(), "BRCA1".to_string(), "BRCA2".to_string()];
        let enrichments = client.enrichment(&identifiers, 9606).await;
        assert!(enrichments.is_ok());
        let enrichments = enrichments.unwrap();
        assert!(!enrichments.is_empty());
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_ppi_enrichment() {
        let client = StringClient::new();
        let identifiers = vec!["TP53".to_string(), "BRCA1".to_string(), "BRCA2".to_string()];
        let result = client.ppi_enrichment(&identifiers, 9606).await;
        assert!(result.is_ok());
        let enrichment = result.unwrap();
        assert!(enrichment.number_of_nodes > 0);
    }

    #[tokio::test]
    #[ignore] // Requires network access
    async fn test_get_link() {
        let client = StringClient::new();
        let identifiers = vec!["TP53".to_string()];
        let link = client.get_link(&identifiers, 9606).await;
        assert!(link.is_ok());
        let link_url = link.unwrap();
        assert!(link_url.contains("string-db.org"));
    }
}
