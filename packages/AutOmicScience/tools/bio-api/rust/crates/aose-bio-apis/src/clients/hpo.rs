//! Human Phenotype Ontology (HPO) API client.
//!
//! Documentation: https://ontology.jax.org/api/hp/docs
//! HPO is a standardized vocabulary of phenotypic abnormalities encountered in human disease.
//! Each term describes a phenotypic abnormality and is linked to genes and diseases.

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://ontology.jax.org/api/hp";
const REQUESTS_PER_SECOND: u32 = 10;

/// Human Phenotype Ontology API client
pub struct HpoClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl HpoClient {
    /// Create a new HPO client
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

    /// Search HPO terms by text query
    ///
    /// # Arguments
    /// * `query` - Search query (minimum 3 characters, maximum 250 characters)
    /// * `page` - Page number (0-indexed)
    /// * `limit` - Number of results per page (default: 10)
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::hpo::HpoClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = HpoClient::new();
    /// let results = client.search("seizure", Some(0), Some(10)).await?;
    /// for term in results.terms {
    ///     println!("{}: {}", term.id, term.name);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search(
        &self,
        query: &str,
        page: Option<u32>,
        limit: Option<u32>,
    ) -> BioApiResult<SearchResponse> {
        if query.len() < 3 {
            return Err(BioApiError::InvalidInput(
                "Query must be at least 3 characters".to_string(),
            ));
        }
        if query.len() > 250 {
            return Err(BioApiError::InvalidInput(
                "Query must be at most 250 characters".to_string(),
            ));
        }

        self.rate_limiter.acquire().await;

        let url = format!("{}/search", BASE_URL);
        let mut params = vec![("q", query.to_string())];

        let page_str;
        if let Some(p) = page {
            page_str = p.to_string();
            params.push(("page", page_str));
        }

        let limit_str;
        if let Some(l) = limit {
            limit_str = l.to_string();
            params.push(("limit", limit_str));
        }

        let response = self
            .retry_policy
            .execute("hpo_search", || async {
                self.client
                    .get(&url)
                    .query(&params)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!("HPO search failed: {}", response.status()),
            });
        }

        let search_response: SearchResponse = response.json().await?;
        Ok(search_response)
    }

    /// Get detailed information about a specific HPO term by ID
    ///
    /// # Arguments
    /// * `id` - HPO term ID (format: HP:0000001 or HP:NNNNNNN)
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::hpo::HpoClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = HpoClient::new();
    /// let term = client.get_term("HP:0001250").await?;
    /// println!("Term: {}", term.name);
    /// println!("Definition: {}", term.definition.as_deref().unwrap_or("N/A"));
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_term(&self, id: &str) -> BioApiResult<HpoTerm> {
        self.validate_hpo_id(id)?;
        self.rate_limiter.acquire().await;

        let url = format!("{}/terms/{}", BASE_URL, id);

        let response = self
            .retry_policy
            .execute("hpo_get_term", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!("HPO term {} not found", id)));
        }

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!("Failed to fetch term {}: {}", id, response.status()),
            });
        }

        let term: HpoTerm = response.json().await?;
        Ok(term)
    }

    /// Get all HPO terms (paginated)
    ///
    /// # Arguments
    /// * `page` - Page number (0-indexed)
    /// * `limit` - Number of results per page (default: 10)
    pub async fn get_all_terms(
        &self,
        page: Option<u32>,
        limit: Option<u32>,
    ) -> BioApiResult<TermListResponse> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/terms", BASE_URL);
        let mut params = vec![];

        let page_str;
        if let Some(p) = page {
            page_str = p.to_string();
            params.push(("page", page_str.as_str()));
        }

        let limit_str;
        if let Some(l) = limit {
            limit_str = l.to_string();
            params.push(("limit", limit_str.as_str()));
        }

        let response = self
            .retry_policy
            .execute("hpo_get_all_terms", || async {
                self.client
                    .get(&url)
                    .query(&params)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!("Failed to fetch terms: {}", response.status()),
            });
        }

        let term_list: TermListResponse = response.json().await?;
        Ok(term_list)
    }

    /// Get parent terms of a specific HPO term
    ///
    /// # Arguments
    /// * `id` - HPO term ID
    pub async fn get_parents(&self, id: &str) -> BioApiResult<Vec<HpoTermSummary>> {
        self.validate_hpo_id(id)?;
        self.rate_limiter.acquire().await;

        let url = format!("{}/terms/{}/parents", BASE_URL, id);

        let response = self
            .retry_policy
            .execute("hpo_get_parents", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!("Failed to fetch parents for {}: {}", id, response.status()),
            });
        }

        let parents: Vec<HpoTermSummary> = response.json().await?;
        Ok(parents)
    }

    /// Get child terms of a specific HPO term
    ///
    /// # Arguments
    /// * `id` - HPO term ID
    pub async fn get_children(&self, id: &str) -> BioApiResult<Vec<HpoTermSummary>> {
        self.validate_hpo_id(id)?;
        self.rate_limiter.acquire().await;

        let url = format!("{}/terms/{}/children", BASE_URL, id);

        let response = self
            .retry_policy
            .execute("hpo_get_children", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!("Failed to fetch children for {}: {}", id, response.status()),
            });
        }

        let children: Vec<HpoTermSummary> = response.json().await?;
        Ok(children)
    }

    /// Get all ancestor terms of a specific HPO term
    ///
    /// # Arguments
    /// * `id` - HPO term ID
    pub async fn get_ancestors(&self, id: &str) -> BioApiResult<Vec<HpoTermSummary>> {
        self.validate_hpo_id(id)?;
        self.rate_limiter.acquire().await;

        let url = format!("{}/terms/{}/ancestors", BASE_URL, id);

        let response = self
            .retry_policy
            .execute("hpo_get_ancestors", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to fetch ancestors for {}: {}",
                    id,
                    response.status()
                ),
            });
        }

        let ancestors: Vec<HpoTermSummary> = response.json().await?;
        Ok(ancestors)
    }

    /// Get all descendant terms of a specific HPO term
    ///
    /// # Arguments
    /// * `id` - HPO term ID
    pub async fn get_descendants(&self, id: &str) -> BioApiResult<Vec<HpoTermSummary>> {
        self.validate_hpo_id(id)?;
        self.rate_limiter.acquire().await;

        let url = format!("{}/terms/{}/descendants", BASE_URL, id);

        let response = self
            .retry_policy
            .execute("hpo_get_descendants", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to fetch descendants for {}: {}",
                    id,
                    response.status()
                ),
            });
        }

        let descendants: Vec<HpoTermSummary> = response.json().await?;
        Ok(descendants)
    }

    /// Get network annotation (diseases and genes) associated with a phenotype
    ///
    /// # Arguments
    /// * `id` - HPO term ID
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::hpo::HpoClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = HpoClient::new();
    /// let annotation = client.get_annotation("HP:0001250").await?;
    /// println!("Associated with {} diseases", annotation.diseases.len());
    /// println!("Associated with {} genes", annotation.genes.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_annotation(&self, id: &str) -> BioApiResult<NetworkAnnotation> {
        self.validate_hpo_id(id)?;
        self.rate_limiter.acquire().await;

        let url = format!("{}/network/annotation/{}", BASE_URL, id);

        let response = self
            .retry_policy
            .execute("hpo_get_annotation", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "No annotation found for HPO term {}",
                id
            )));
        }

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to fetch annotation for {}: {}",
                    id,
                    response.status()
                ),
            });
        }

        let annotation: NetworkAnnotation = response.json().await?;
        Ok(annotation)
    }

    /// Validate HPO ID format (HP:\d{7})
    fn validate_hpo_id(&self, id: &str) -> BioApiResult<()> {
        if !id.starts_with("HP:") {
            return Err(BioApiError::InvalidInput(format!(
                "HPO ID must start with 'HP:': {}",
                id
            )));
        }

        let numeric_part = &id[3..];
        if numeric_part.len() != 7 || !numeric_part.chars().all(|c| c.is_ascii_digit()) {
            return Err(BioApiError::InvalidInput(format!(
                "HPO ID must be in format HP:NNNNNNN (7 digits): {}",
                id
            )));
        }

        Ok(())
    }
}

impl Default for HpoClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Search response containing matching HPO terms
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    /// List of matching terms
    pub terms: Vec<HpoTermSummary>,
    /// Total number of results
    pub total: Option<u32>,
    /// Current page number
    pub page: Option<u32>,
    /// Results per page
    pub limit: Option<u32>,
}

/// Summary information about an HPO term (used in lists and search results)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HpoTermSummary {
    /// HPO term ID (e.g., HP:0001250)
    pub id: String,
    /// Term name
    pub name: String,
    /// Definition (may be null in search results)
    pub definition: Option<String>,
}

/// Detailed information about an HPO term
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HpoTerm {
    /// HPO term ID (e.g., HP:0001250)
    pub id: String,
    /// Term name
    pub name: String,
    /// Definition text
    pub definition: Option<String>,
    /// Comment text
    pub comment: Option<String>,
    /// Synonyms
    #[serde(default)]
    pub synonyms: Vec<String>,
    /// Cross-references to other databases (e.g., SNOMED_CT, UMLS)
    #[serde(default)]
    pub xrefs: Vec<Xref>,
    /// PubMed references
    #[serde(default)]
    pub pubmed_refs: Vec<String>,
    /// Translations in other languages
    #[serde(default)]
    pub translations: Vec<Translation>,
    /// Number of descendant terms
    #[serde(rename = "childCount")]
    pub child_count: Option<u32>,
    /// Whether this is obsolete
    #[serde(default)]
    pub is_obsolete: bool,
    /// Replacement term ID (if obsolete)
    pub replaced_by: Option<String>,
}

/// Cross-reference to another database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Xref {
    /// Database name (e.g., "SNOMED_CT", "UMLS", "MSH")
    pub database: String,
    /// ID in the external database
    pub id: String,
}

/// Translation of term name/definition to another language
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Translation {
    /// Language code (e.g., "de", "es", "fr", "ja", "zh")
    pub language: String,
    /// Translated term name
    pub name: Option<String>,
    /// Translated definition
    pub definition: Option<String>,
}

/// List response for paginated term queries
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermListResponse {
    /// List of terms
    pub terms: Vec<HpoTermSummary>,
    /// Total number of terms available
    pub total: Option<u32>,
    /// Current page
    pub page: Option<u32>,
    /// Results per page
    pub limit: Option<u32>,
}

/// Network annotation linking phenotypes to diseases and genes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkAnnotation {
    /// HPO term ID
    pub term_id: String,
    /// Associated diseases
    #[serde(default)]
    pub diseases: Vec<DiseaseAssociation>,
    /// Associated genes
    #[serde(default)]
    pub genes: Vec<GeneAssociation>,
}

/// Disease associated with a phenotype
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiseaseAssociation {
    /// Disease database (e.g., "OMIM", "ORPHANET", "MONDO")
    pub database: String,
    /// Disease ID in the database
    pub id: String,
    /// Disease name
    pub name: Option<String>,
}

/// Gene associated with a phenotype
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneAssociation {
    /// Gene symbol
    pub symbol: String,
    /// Entrez Gene ID
    pub entrez_id: Option<String>,
    /// Ensembl gene ID
    pub ensembl_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = HpoClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_hpo_id_validation() {
        let client = HpoClient::new();

        // Valid IDs
        assert!(client.validate_hpo_id("HP:0001250").is_ok());
        assert!(client.validate_hpo_id("HP:0000001").is_ok());
        assert!(client.validate_hpo_id("HP:9999999").is_ok());

        // Invalid IDs
        assert!(client.validate_hpo_id("0001250").is_err()); // Missing HP: prefix
        assert!(client.validate_hpo_id("HP:001250").is_err()); // Too few digits
        assert!(client.validate_hpo_id("HP:00012500").is_err()); // Too many digits
        assert!(client.validate_hpo_id("HP:000125A").is_err()); // Non-numeric
        assert!(client.validate_hpo_id("INVALID").is_err()); // Wrong format
    }

    #[test]
    fn test_search_query_validation() {
        let client = HpoClient::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Too short
        let result = rt.block_on(client.search("ab", None, None));
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));

        // Too long
        let long_query = "a".repeat(251);
        let result = rt.block_on(client.search(&long_query, None, None));
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_hpo_term_deserialization() {
        let json = r#"{
            "id": "HP:0001250",
            "name": "Seizure",
            "definition": "A seizure is an intermittent abnormality of nervous system physiology.",
            "comment": null,
            "synonyms": ["Epileptic seizure", "Seizures"],
            "xrefs": [
                {
                    "database": "SNOMED_CT",
                    "id": "91175000"
                },
                {
                    "database": "UMLS",
                    "id": "C0036572"
                }
            ],
            "pubmed_refs": ["PMID:12345678"],
            "translations": [
                {
                    "language": "de",
                    "name": "Krampfanfall",
                    "definition": null
                }
            ],
            "childCount": 42,
            "is_obsolete": false,
            "replaced_by": null
        }"#;

        let term: HpoTerm = serde_json::from_str(json).unwrap();
        assert_eq!(term.id, "HP:0001250");
        assert_eq!(term.name, "Seizure");
        assert!(term.definition.is_some());
        assert_eq!(term.synonyms.len(), 2);
        assert_eq!(term.xrefs.len(), 2);
        assert_eq!(term.xrefs[0].database, "SNOMED_CT");
        assert_eq!(term.xrefs[0].id, "91175000");
        assert_eq!(term.pubmed_refs.len(), 1);
        assert_eq!(term.translations.len(), 1);
        assert_eq!(term.translations[0].language, "de");
        assert_eq!(term.child_count, Some(42));
        assert!(!term.is_obsolete);
    }

    #[test]
    fn test_search_response_deserialization() {
        let json = r#"{
            "terms": [
                {
                    "id": "HP:0001250",
                    "name": "Seizure",
                    "definition": "A seizure description"
                },
                {
                    "id": "HP:0002197",
                    "name": "Generalized-onset seizure",
                    "definition": null
                }
            ],
            "total": 2,
            "page": 0,
            "limit": 10
        }"#;

        let response: SearchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.terms.len(), 2);
        assert_eq!(response.terms[0].id, "HP:0001250");
        assert_eq!(response.terms[0].name, "Seizure");
        assert_eq!(response.total, Some(2));
        assert_eq!(response.page, Some(0));
        assert_eq!(response.limit, Some(10));
    }

    #[test]
    fn test_network_annotation_deserialization() {
        let json = r#"{
            "term_id": "HP:0001250",
            "diseases": [
                {
                    "database": "OMIM",
                    "id": "607208",
                    "name": "Epilepsy, idiopathic generalized"
                },
                {
                    "database": "ORPHANET",
                    "id": "166024",
                    "name": "Rare epilepsy syndrome"
                }
            ],
            "genes": [
                {
                    "symbol": "SCN1A",
                    "entrez_id": "6323",
                    "ensembl_id": "ENSG00000144285"
                },
                {
                    "symbol": "GABRA1",
                    "entrez_id": "2554",
                    "ensembl_id": "ENSG00000022355"
                }
            ]
        }"#;

        let annotation: NetworkAnnotation = serde_json::from_str(json).unwrap();
        assert_eq!(annotation.term_id, "HP:0001250");
        assert_eq!(annotation.diseases.len(), 2);
        assert_eq!(annotation.diseases[0].database, "OMIM");
        assert_eq!(annotation.diseases[0].id, "607208");
        assert_eq!(annotation.genes.len(), 2);
        assert_eq!(annotation.genes[0].symbol, "SCN1A");
        assert_eq!(annotation.genes[0].entrez_id, Some("6323".to_string()));
    }
}
