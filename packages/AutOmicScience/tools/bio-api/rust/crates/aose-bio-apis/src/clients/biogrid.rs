//! BioGRID protein-protein and genetic interaction database API client.
//!
//! Documentation: https://wiki.thebiogrid.org/doku.php/biogridrest
//! Access key registration: https://webservice.thebiogrid.org

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://webservice.thebiogrid.org";
const REQUESTS_PER_SECOND: u32 = 5;
const MAX_RESULTS_PER_REQUEST: u32 = 10000;

/// BioGRID API client
///
/// Requires an access key obtainable from https://webservice.thebiogrid.org
/// The key should be provided via the `BIOGRID_ACCESS_KEY` environment variable
/// or passed directly to the constructor.
pub struct BiogridClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
    access_key: String,
}

impl BiogridClient {
    /// Create a new BioGRID client with the provided access key
    ///
    /// # Arguments
    /// * `access_key` - 32-character alphanumeric access key from BioGRID
    pub fn new(access_key: String) -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
            access_key,
        }
    }

    /// Search for protein-protein and genetic interactions
    ///
    /// # Arguments
    /// * `params` - Search parameters including genes, organisms, and filters
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::biogrid::{BiogridClient, InteractionSearchParams};
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = BiogridClient::new("your_access_key".to_string());
    /// let params = InteractionSearchParams {
    ///     gene_list: vec!["BRCA1".to_string(), "TP53".to_string()],
    ///     taxid: Some(9606), // Human
    ///     ..Default::default()
    /// };
    /// let interactions = client.search_interactions(params).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_interactions(
        &self,
        params: InteractionSearchParams,
    ) -> BioApiResult<Vec<BiogridInteraction>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/interactions/", BASE_URL);

        // Build query parameters
        let mut query_params = vec![
            ("accessKey", self.access_key.as_str()),
            ("format", params.format.as_str()),
        ];

        // Convert gene_list to pipe-separated string
        let gene_list_str;
        if !params.gene_list.is_empty() {
            gene_list_str = params.gene_list.join("|");
            query_params.push(("geneList", &gene_list_str));
        }

        // Add optional parameters
        let taxid_str;
        if let Some(taxid) = params.taxid {
            taxid_str = taxid.to_string();
            query_params.push(("taxId", &taxid_str));
        }

        let search_names_str = if params.search_names { "true" } else { "false" };
        query_params.push(("searchNames", search_names_str));

        let search_ids_str = if params.search_ids { "true" } else { "false" };
        query_params.push(("searchIds", search_ids_str));

        let search_synonyms_str = if params.search_synonyms {
            "true"
        } else {
            "false"
        };
        query_params.push(("searchSynonyms", search_synonyms_str));

        let start_str;
        if let Some(start) = params.start {
            start_str = start.to_string();
            query_params.push(("start", &start_str));
        }

        let max_str = params.max.to_string();
        query_params.push(("max", &max_str));

        let interaction_type_str;
        if let Some(ref int_type) = params.interaction_type {
            interaction_type_str = int_type.to_string();
            query_params.push(("interactionType", &interaction_type_str));
        }

        let evidence_str;
        if let Some(ref evidence) = params.evidence_code {
            evidence_str = evidence.clone();
            query_params.push(("evidenceList", &evidence_str));
        }

        let include_interactors_str = if params.include_interactors {
            "true"
        } else {
            "false"
        };
        query_params.push(("includeInteractors", include_interactors_str));

        let response = self
            .retry_policy
            .execute("search_interactions", || async {
                self.client
                    .get(&url)
                    .query(&query_params)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("(could not read error response body: {e})"));

            // Try to parse as JSON error response
            if let Ok(error_json) = serde_json::from_str::<serde_json::Value>(&error_text) {
                let message = error_json["MESSAGES"]
                    .as_str()
                    .unwrap_or("Unknown error")
                    .to_string();
                return Err(BioApiError::ApiError {
                    status: status.as_u16(),
                    message,
                });
            }

            return Err(BioApiError::ApiError {
                status: status.as_u16(),
                message: error_text,
            });
        }

        // Parse JSON response
        let json_response: serde_json::Value = response.json().await?;

        // BioGRID returns interactions as an object with interaction IDs as keys
        let interactions_obj = json_response
            .as_object()
            .ok_or_else(|| BioApiError::InvalidResponse("Expected object response".to_string()))?;

        let mut interactions = Vec::new();
        for (id, value) in interactions_obj {
            let mut interaction: BiogridInteraction = serde_json::from_value(value.clone())?;
            // Set the BioGRID interaction ID from the key.
            // A non-parseable ID from the API is a real data problem: surface it
            // instead of silently dropping it to None.
            interaction.biogrid_interaction_id = match id.parse() {
                Ok(parsed) => Some(parsed),
                Err(e) => {
                    tracing::warn!(
                        biogrid_interaction_id = %id,
                        error = %e,
                        "BioGRID returned a non-numeric interaction ID key; leaving field empty"
                    );
                    None
                }
            };
            interactions.push(interaction);
        }

        Ok(interactions)
    }

    /// Get a single interaction by BioGRID interaction ID
    pub async fn get_interaction(&self, interaction_id: u64) -> BioApiResult<BiogridInteraction> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/interactions/{}", BASE_URL, interaction_id);

        let response = self
            .retry_policy
            .execute("get_interaction", || async {
                self.client
                    .get(&url)
                    .query(&[("accessKey", &self.access_key)])
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        let status = response.status();
        if status == 404 {
            return Err(BioApiError::NotFound(format!(
                "BiogridInteraction {} not found",
                interaction_id
            )));
        }

        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("(could not read error response body: {e})"));
            return Err(BioApiError::ApiError {
                status: status.as_u16(),
                message: error_text,
            });
        }

        let mut interaction: BiogridInteraction = response.json().await?;
        interaction.biogrid_interaction_id = Some(interaction_id);
        Ok(interaction)
    }

    /// List supported organisms
    pub async fn list_organisms(&self) -> BioApiResult<Vec<Organism>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/organisms/", BASE_URL);

        let response = self
            .retry_policy
            .execute("list_organisms", || async {
                self.client
                    .get(&url)
                    .query(&[("accessKey", &self.access_key)])
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("(could not read error response body: {e})"));
            return Err(BioApiError::ApiError {
                status: status.as_u16(),
                message: error_text,
            });
        }

        let json_response: serde_json::Value = response.json().await?;
        let organisms_obj = json_response
            .as_object()
            .ok_or_else(|| BioApiError::InvalidResponse("Expected object response".to_string()))?;

        let mut organisms = Vec::new();
        for (taxid, value) in organisms_obj {
            let mut organism: Organism = serde_json::from_value(value.clone())?;
            organism.taxid = match taxid.parse() {
                Ok(parsed) => Some(parsed),
                Err(e) => {
                    tracing::warn!(
                        taxid = %taxid,
                        error = %e,
                        "BioGRID returned a non-numeric taxid key; leaving field empty"
                    );
                    None
                }
            };
            organisms.push(organism);
        }

        Ok(organisms)
    }

    /// Get the current BioGRID database version
    pub async fn get_version(&self) -> BioApiResult<String> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/version", BASE_URL);

        let response = self
            .retry_policy
            .execute("get_version", || async {
                self.client
                    .get(&url)
                    .query(&[("accessKey", &self.access_key)])
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("(could not read error response body: {e})"));
            return Err(BioApiError::ApiError {
                status: status.as_u16(),
                message: error_text,
            });
        }

        let text = response.text().await?;
        Ok(text.trim().to_string())
    }
}

impl Default for BiogridClient {
    fn default() -> Self {
        let access_key = std::env::var("BIOGRID_ACCESS_KEY")
            .expect("BIOGRID_ACCESS_KEY environment variable not set");
        Self::new(access_key)
    }
}

/// Parameters for searching interactions
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InteractionSearchParams {
    /// List of gene identifiers (official symbols, systematic names, or IDs)
    pub gene_list: Vec<String>,

    /// NCBI Taxonomy ID to restrict search (e.g., 9606 for human)
    pub taxid: Option<u32>,

    /// Search against official gene names
    pub search_names: bool,

    /// Search against systematic/ordered locus names
    pub search_ids: bool,

    /// Search against gene synonyms
    pub search_synonyms: bool,

    /// Starting index for pagination (0-based)
    pub start: Option<u32>,

    /// Maximum number of results (max 10,000)
    pub max: u32,

    /// Filter by interaction type (physical, genetic, or all)
    pub interaction_type: Option<InteractionType>,

    /// Filter by evidence code (pipe-separated list)
    pub evidence_code: Option<String>,

    /// Include interactors for searched genes
    pub include_interactors: bool,

    /// Response format (json, tab2, etc.)
    pub format: ResponseFormat,
}

impl InteractionSearchParams {
    /// Create a simple search for a list of genes
    pub fn genes(gene_list: Vec<String>) -> Self {
        Self {
            gene_list,
            search_names: true,
            search_ids: true,
            search_synonyms: true,
            max: 1000,
            format: ResponseFormat::Json,
            ..Default::default()
        }
    }

    /// Set the organism by NCBI taxonomy ID
    pub fn with_taxid(mut self, taxid: u32) -> Self {
        self.taxid = Some(taxid);
        self
    }

    /// Set the maximum number of results
    pub fn with_max(mut self, max: u32) -> Self {
        self.max = max.min(MAX_RESULTS_PER_REQUEST);
        self
    }

    /// Filter by interaction type
    pub fn with_interaction_type(mut self, interaction_type: InteractionType) -> Self {
        self.interaction_type = Some(interaction_type);
        self
    }
}

/// Response format options
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum ResponseFormat {
    #[default]
    Json,
    Tab2,
    ExtendedTab2,
}

impl ResponseFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResponseFormat::Json => "json",
            ResponseFormat::Tab2 => "tab2",
            ResponseFormat::ExtendedTab2 => "extendedTab2",
        }
    }
}

/// BiogridInteraction type filter
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum InteractionType {
    Physical,
    Genetic,
    #[default]
    All,
}

impl InteractionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            InteractionType::Physical => "physical",
            InteractionType::Genetic => "genetic",
            InteractionType::All => "all",
        }
    }
}

impl std::fmt::Display for InteractionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// A protein-protein or genetic interaction from BioGRID
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiogridInteraction {
    /// BioGRID interaction ID
    #[serde(rename = "BIOGRID_ID_INTERACTOR_A")]
    pub biogrid_id_a: Option<u64>,

    #[serde(rename = "BIOGRID_ID_INTERACTOR_B")]
    pub biogrid_id_b: Option<u64>,

    /// Official gene symbol for interactor A
    #[serde(rename = "OFFICIAL_SYMBOL_A")]
    pub official_symbol_a: String,

    /// Official gene symbol for interactor B
    #[serde(rename = "OFFICIAL_SYMBOL_B")]
    pub official_symbol_b: String,

    /// Systematic name for interactor A
    #[serde(rename = "SYSTEMATIC_NAME_A")]
    pub systematic_name_a: Option<String>,

    /// Systematic name for interactor B
    #[serde(rename = "SYSTEMATIC_NAME_B")]
    pub systematic_name_b: Option<String>,

    /// Organism name for interactor A
    #[serde(rename = "ORGANISM_A")]
    pub organism_a: Option<String>,

    /// Organism name for interactor B
    #[serde(rename = "ORGANISM_B")]
    pub organism_b: Option<String>,

    /// NCBI Taxonomy ID for interactor A
    #[serde(rename = "ORGANISM_A_ID")]
    pub organism_a_id: Option<u32>,

    /// NCBI Taxonomy ID for interactor B
    #[serde(rename = "ORGANISM_B_ID")]
    pub organism_b_id: Option<u32>,

    /// Experimental system used to detect interaction
    #[serde(rename = "EXPERIMENTAL_SYSTEM")]
    pub experimental_system: Option<String>,

    /// Experimental system type (physical, genetic, etc.)
    #[serde(rename = "EXPERIMENTAL_SYSTEM_TYPE")]
    pub experimental_system_type: Option<String>,

    /// PubMed ID of the publication
    #[serde(rename = "PUBMED_ID")]
    pub pubmed_id: Option<u64>,

    /// Author list of the publication
    #[serde(rename = "PUBMED_AUTHOR")]
    pub pubmed_author: Option<String>,

    /// Throughput category (High Throughput, Low Throughput)
    #[serde(rename = "THROUGHPUT")]
    pub throughput: Option<String>,

    /// Score or confidence value
    #[serde(rename = "SCORE")]
    pub score: Option<String>,

    /// Modification details
    #[serde(rename = "MODIFICATION")]
    pub modification: Option<String>,

    /// Qualifications for the interaction
    #[serde(rename = "QUALIFICATIONS")]
    pub qualifications: Option<String>,

    /// Tags associated with the interaction
    #[serde(rename = "TAGS")]
    pub tags: Option<String>,

    /// Source database
    #[serde(rename = "SOURCE_DATABASE")]
    pub source_database: Option<String>,

    /// BioGRID interaction ID (extracted from response key)
    #[serde(skip)]
    pub biogrid_interaction_id: Option<u64>,
}

/// Organism information from BioGRID
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organism {
    /// NCBI Taxonomy ID
    #[serde(skip)]
    pub taxid: Option<u32>,

    /// Official organism name
    #[serde(rename = "ORGANISM_OFFICIAL_NAME")]
    pub official_name: String,

    /// Common/Abbreviated name
    #[serde(rename = "ORGANISM_ABBREVIATION")]
    pub abbreviation: Option<String>,

    /// Strain information
    #[serde(rename = "ORGANISM_STRAIN")]
    pub strain: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interaction_search_params_builder() {
        let params = InteractionSearchParams::genes(vec!["BRCA1".to_string()])
            .with_taxid(9606)
            .with_max(500)
            .with_interaction_type(InteractionType::Physical);

        assert_eq!(params.gene_list, vec!["BRCA1".to_string()]);
        assert_eq!(params.taxid, Some(9606));
        assert_eq!(params.max, 500);
        assert_eq!(params.interaction_type, Some(InteractionType::Physical));
    }

    #[test]
    fn test_interaction_type_display() {
        assert_eq!(InteractionType::Physical.to_string(), "physical");
        assert_eq!(InteractionType::Genetic.to_string(), "genetic");
        assert_eq!(InteractionType::All.to_string(), "all");
    }

    #[test]
    fn test_response_format() {
        assert_eq!(ResponseFormat::Json.as_str(), "json");
        assert_eq!(ResponseFormat::Tab2.as_str(), "tab2");
        assert_eq!(ResponseFormat::ExtendedTab2.as_str(), "extendedTab2");
    }

    #[test]
    fn test_max_results_limit() {
        let params = InteractionSearchParams::genes(vec!["TP53".to_string()]).with_max(50000); // Exceeds limit

        assert_eq!(params.max, MAX_RESULTS_PER_REQUEST);
    }

    #[tokio::test]
    async fn test_client_creation() {
        let client = BiogridClient::new("test_key_32_characters_long_abc".to_string());
        assert_eq!(client.access_key, "test_key_32_characters_long_abc");
    }

    #[tokio::test]
    #[ignore] // Requires valid access key
    async fn test_get_version() {
        let Ok(key) = std::env::var("BIOGRID_ACCESS_KEY") else {
            eprintln!("Test skipped: BIOGRID_ACCESS_KEY not set");
            return;
        };
        let client = BiogridClient::new(key);
        let version = client.get_version().await;
        assert!(version.is_ok());
        println!("BioGRID version: {}", version.unwrap());
    }

    #[tokio::test]
    #[ignore] // Requires valid access key and network
    async fn test_search_interactions() {
        let Ok(key) = std::env::var("BIOGRID_ACCESS_KEY") else {
            eprintln!("Test skipped: BIOGRID_ACCESS_KEY not set");
            return;
        };
        let client = BiogridClient::new(key);
        let params = InteractionSearchParams::genes(vec!["BRCA1".to_string()])
            .with_taxid(9606)
            .with_max(10);

        let interactions = client.search_interactions(params).await;
        assert!(interactions.is_ok());
        let interactions = interactions.unwrap();
        assert!(!interactions.is_empty());
        println!("Found {} interactions", interactions.len());
    }

    #[tokio::test]
    #[ignore] // Requires valid access key and network
    async fn test_list_organisms() {
        let Ok(key) = std::env::var("BIOGRID_ACCESS_KEY") else {
            eprintln!("Test skipped: BIOGRID_ACCESS_KEY not set");
            return;
        };
        let client = BiogridClient::new(key);
        let organisms = client.list_organisms().await;
        assert!(organisms.is_ok());
        let organisms = organisms.unwrap();
        assert!(!organisms.is_empty());
        println!("Found {} organisms", organisms.len());
    }
}
