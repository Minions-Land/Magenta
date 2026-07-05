//! Monarch Initiative API client.
//!
//! The Monarch Initiative is a collaborative effort to integrate genotype-phenotype data
//! from many species and sources, providing a comprehensive view of disease-phenotype-gene
//! relationships across the tree of life.
//!
//! Documentation: https://api.monarchinitiative.org/api/docs

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://api.monarchinitiative.org/api";
const REQUESTS_PER_SECOND: u32 = 10;

/// Monarch Initiative API client
///
/// Provides access to disease-phenotype-gene associations, disease models,
/// and cross-species phenotype comparisons.
pub struct MonarchClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl MonarchClient {
    /// Create a new Monarch Initiative client
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// let client = MonarchClient::new();
    /// ```
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

    /// Search for diseases by name or ID
    ///
    /// # Arguments
    /// * `query` - Search query (disease name or ID)
    /// * `limit` - Maximum number of results (default: 10, max: 100)
    /// * `offset` - Starting offset for pagination
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = MonarchClient::new();
    /// let results = client.search_diseases("Alzheimer", Some(10), None).await?;
    /// for disease in results.items {
    ///     println!("{}: {}", disease.id, disease.label);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_diseases(
        &self,
        query: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> BioApiResult<SearchResponse> {
        if query.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Query cannot be empty".to_string(),
            ));
        }

        self.rate_limiter.acquire().await;

        let url = format!("{}/search/entity/disease", BASE_URL);
        let mut params = vec![("q", query.to_string())];

        let limit_str;
        if let Some(l) = limit {
            let validated_limit = l.min(100);
            limit_str = validated_limit.to_string();
            params.push(("limit", limit_str));
        }

        let offset_str;
        if let Some(o) = offset {
            offset_str = o.to_string();
            params.push(("offset", offset_str));
        }

        let response = self
            .retry_policy
            .execute("monarch_search_diseases", || async {
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
                message: format!("Disease search failed: {}", response.status()),
            });
        }

        let search_response: SearchResponse = response.json().await?;
        Ok(search_response)
    }

    /// Get disease-gene associations for a specific disease
    ///
    /// # Arguments
    /// * `disease_id` - Disease ID (e.g., "MONDO:0004975" for Alzheimer's)
    /// * `limit` - Maximum number of results
    /// * `offset` - Starting offset for pagination
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = MonarchClient::new();
    /// let associations = client.get_disease_associations("MONDO:0004975", Some(20), None).await?;
    /// for assoc in associations.associations {
    ///     println!("Gene: {}", assoc.object.label);
    ///     if let Some(pubs) = assoc.publications {
    ///         println!("  Publications: {}", pubs.len());
    ///     }
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_disease_associations(
        &self,
        disease_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> BioApiResult<AssociationResponse> {
        if disease_id.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Disease ID cannot be empty".to_string(),
            ));
        }

        self.rate_limiter.acquire().await;

        let url = format!("{}/association/find", BASE_URL);
        let mut params = vec![
            ("subject", disease_id.to_string()),
            ("category", "biolink:Disease".to_string()),
            ("object_category", "biolink:Gene".to_string()),
        ];

        let limit_str;
        if let Some(l) = limit {
            limit_str = l.to_string();
            params.push(("limit", limit_str));
        }

        let offset_str;
        if let Some(o) = offset {
            offset_str = o.to_string();
            params.push(("offset", offset_str));
        }

        let response = self
            .retry_policy
            .execute("monarch_disease_associations", || async {
                self.client
                    .get(&url)
                    .query(&params)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "No associations found for disease {}",
                disease_id
            )));
        }

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to fetch associations for {}: {}",
                    disease_id,
                    response.status()
                ),
            });
        }

        let association_response: AssociationResponse = response.json().await?;
        Ok(association_response)
    }

    /// Get phenotype associations for a disease or gene
    ///
    /// # Arguments
    /// * `entity_id` - Entity ID (disease or gene, e.g., "MONDO:0004975", "HGNC:613")
    /// * `limit` - Maximum number of results
    /// * `offset` - Starting offset for pagination
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = MonarchClient::new();
    /// let phenotypes = client.get_phenotype_associations("MONDO:0004975", Some(20), None).await?;
    /// for assoc in phenotypes.associations {
    ///     println!("Phenotype: {}", assoc.object.label);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_phenotype_associations(
        &self,
        entity_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> BioApiResult<AssociationResponse> {
        if entity_id.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Entity ID cannot be empty".to_string(),
            ));
        }

        self.rate_limiter.acquire().await;

        let url = format!("{}/association/find", BASE_URL);
        let mut params = vec![
            ("subject", entity_id.to_string()),
            ("object_category", "biolink:PhenotypicFeature".to_string()),
        ];

        let limit_str;
        if let Some(l) = limit {
            limit_str = l.to_string();
            params.push(("limit", limit_str));
        }

        let offset_str;
        if let Some(o) = offset {
            offset_str = o.to_string();
            params.push(("offset", offset_str));
        }

        let response = self
            .retry_policy
            .execute("monarch_phenotype_associations", || async {
                self.client
                    .get(&url)
                    .query(&params)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "No phenotype associations found for {}",
                entity_id
            )));
        }

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to fetch phenotype associations for {}: {}",
                    entity_id,
                    response.status()
                ),
            });
        }

        let association_response: AssociationResponse = response.json().await?;
        Ok(association_response)
    }

    /// Search for disease models (e.g., mouse models, zebrafish models)
    ///
    /// # Arguments
    /// * `disease_id` - Disease ID (e.g., "MONDO:0004975")
    /// * `taxon` - Optional taxon filter (e.g., "NCBITaxon:10090" for mouse)
    /// * `limit` - Maximum number of results
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = MonarchClient::new();
    /// // Search for mouse models of Alzheimer's disease
    /// let models = client.search_models("MONDO:0004975", Some("NCBITaxon:10090"), Some(10)).await?;
    /// for model in models.associations {
    ///     println!("Model: {}", model.object.label);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_models(
        &self,
        disease_id: &str,
        taxon: Option<&str>,
        limit: Option<u32>,
    ) -> BioApiResult<AssociationResponse> {
        if disease_id.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Disease ID cannot be empty".to_string(),
            ));
        }

        self.rate_limiter.acquire().await;

        let url = format!("{}/association/find", BASE_URL);
        let mut params = vec![
            ("subject", disease_id.to_string()),
            ("category", "biolink:Disease".to_string()),
            (
                "object_category",
                "biolink:DiseaseOrPhenotypicFeature".to_string(),
            ),
        ];

        if let Some(t) = taxon {
            params.push(("taxon", t.to_string()));
        }

        let limit_str;
        if let Some(l) = limit {
            limit_str = l.to_string();
            params.push(("limit", limit_str));
        }

        let response = self
            .retry_policy
            .execute("monarch_search_models", || async {
                self.client
                    .get(&url)
                    .query(&params)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "No models found for disease {}",
                disease_id
            )));
        }

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to search models for {}: {}",
                    disease_id,
                    response.status()
                ),
            });
        }

        let association_response: AssociationResponse = response.json().await?;
        Ok(association_response)
    }

    /// Get detailed information about a specific entity (disease, gene, phenotype)
    ///
    /// # Arguments
    /// * `entity_id` - Entity ID (e.g., "MONDO:0004975", "HGNC:613", "HP:0000726")
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = MonarchClient::new();
    /// let entity = client.get_entity("MONDO:0004975").await?;
    /// println!("Entity: {}", entity.label);
    /// if let Some(def) = entity.definition {
    ///     println!("Definition: {}", def);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_entity(&self, entity_id: &str) -> BioApiResult<Entity> {
        if entity_id.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Entity ID cannot be empty".to_string(),
            ));
        }

        self.rate_limiter.acquire().await;

        let url = format!("{}/entity/{}", BASE_URL, entity_id);

        let response = self
            .retry_policy
            .execute("monarch_get_entity", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "Entity {} not found",
                entity_id
            )));
        }

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: format!(
                    "Failed to fetch entity {}: {}",
                    entity_id,
                    response.status()
                ),
            });
        }

        let entity: Entity = response.json().await?;
        Ok(entity)
    }

    /// Get gene-phenotype associations for a specific gene
    ///
    /// # Arguments
    /// * `gene_id` - Gene ID (e.g., "HGNC:613" for APP gene)
    /// * `limit` - Maximum number of results
    /// * `offset` - Starting offset for pagination
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::monarch::MonarchClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = MonarchClient::new();
    /// let phenotypes = client.get_gene_phenotypes("HGNC:613", Some(20), None).await?;
    /// for assoc in phenotypes.associations {
    ///     println!("Phenotype: {}", assoc.object.label);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_gene_phenotypes(
        &self,
        gene_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> BioApiResult<AssociationResponse> {
        self.get_phenotype_associations(gene_id, limit, offset)
            .await
    }
}

impl Default for MonarchClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Search response containing matching entities
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    /// List of matching entities
    #[serde(default)]
    pub items: Vec<Entity>,
    /// Total number of results
    pub total: Option<u32>,
    /// Current offset
    pub offset: Option<u32>,
    /// Results per page
    pub limit: Option<u32>,
}

/// Entity (disease, gene, phenotype, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    /// Entity ID (e.g., MONDO:0004975, HGNC:613, HP:0000726)
    pub id: String,
    /// Entity label/name
    pub label: String,
    /// Category (e.g., biolink:Disease, biolink:Gene, biolink:PhenotypicFeature)
    pub category: Option<Vec<String>>,
    /// Definition/description
    pub definition: Option<String>,
    /// Synonyms
    #[serde(default)]
    pub synonyms: Vec<String>,
    /// Cross-references to other databases
    #[serde(default)]
    pub xrefs: Vec<String>,
    /// Taxon (for genes and models)
    pub taxon: Option<Taxon>,
}

/// Taxon information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Taxon {
    /// Taxon ID (e.g., NCBITaxon:9606 for human)
    pub id: String,
    /// Taxon label (e.g., "Homo sapiens")
    pub label: Option<String>,
}

/// Association response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssociationResponse {
    /// List of associations
    #[serde(default)]
    pub associations: Vec<Association>,
    /// Total number of associations
    pub total: Option<u32>,
    /// Current offset
    pub offset: Option<u32>,
    /// Results per page
    pub limit: Option<u32>,
}

/// Association between two entities (e.g., disease-gene, disease-phenotype)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Association {
    /// Association ID
    pub id: Option<String>,
    /// Subject entity (e.g., disease)
    pub subject: AssociationEntity,
    /// Predicate (relationship type)
    pub predicate: Option<String>,
    /// Object entity (e.g., gene, phenotype)
    pub object: AssociationEntity,
    /// Association score or strength
    pub score: Option<f64>,
    /// Publications supporting this association
    pub publications: Option<Vec<Publication>>,
    /// Evidence codes
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// Association type
    pub association_type: Option<String>,
}

/// Entity reference in an association
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssociationEntity {
    /// Entity ID
    pub id: String,
    /// Entity label
    pub label: String,
    /// Entity category
    pub category: Option<Vec<String>>,
    /// Taxon (for genes)
    pub taxon: Option<Taxon>,
}

/// Publication reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Publication {
    /// Publication ID (e.g., PMID:12345678)
    pub id: String,
    /// Publication title
    pub title: Option<String>,
    /// Publication year
    pub year: Option<i32>,
}

/// Evidence supporting an association
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    /// Evidence code (e.g., ECO:0000033)
    pub evidence_code: Option<String>,
    /// Evidence label
    pub label: Option<String>,
    /// Source of evidence
    pub source: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = MonarchClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_empty_query_validation() {
        let client = MonarchClient::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let result = rt.block_on(client.search_diseases("", None, None));
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_empty_disease_id_validation() {
        let client = MonarchClient::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let result = rt.block_on(client.get_disease_associations("", None, None));
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[test]
    fn test_entity_deserialization() {
        let json = r#"{
            "id": "MONDO:0004975",
            "label": "Alzheimer disease",
            "category": ["biolink:Disease"],
            "definition": "A degenerative disease of the brain characterized by progressive dementia.",
            "synonyms": ["Alzheimer's disease", "AD"],
            "xrefs": ["DOID:10652", "OMIM:104300", "MESH:D000544"],
            "taxon": {
                "id": "NCBITaxon:9606",
                "label": "Homo sapiens"
            }
        }"#;

        let entity: Entity = serde_json::from_str(json).unwrap();
        assert_eq!(entity.id, "MONDO:0004975");
        assert_eq!(entity.label, "Alzheimer disease");
        assert_eq!(entity.category, Some(vec!["biolink:Disease".to_string()]));
        assert!(entity.definition.is_some());
        assert_eq!(entity.synonyms.len(), 2);
        assert_eq!(entity.xrefs.len(), 3);
        assert!(entity.taxon.is_some());
        assert_eq!(entity.taxon.unwrap().id, "NCBITaxon:9606");
    }

    #[test]
    fn test_association_deserialization() {
        let json = r#"{
            "id": "uuid:12345",
            "subject": {
                "id": "MONDO:0004975",
                "label": "Alzheimer disease",
                "category": ["biolink:Disease"],
                "taxon": null
            },
            "predicate": "biolink:gene_associated_with_condition",
            "object": {
                "id": "HGNC:613",
                "label": "APP",
                "category": ["biolink:Gene"],
                "taxon": {
                    "id": "NCBITaxon:9606",
                    "label": "Homo sapiens"
                }
            },
            "score": 0.95,
            "publications": [
                {
                    "id": "PMID:12345678",
                    "title": "APP and Alzheimer's disease",
                    "year": 2020
                }
            ],
            "evidence": [
                {
                    "evidence_code": "ECO:0000033",
                    "label": "author statement supported by traceable reference",
                    "source": "OMIM"
                }
            ],
            "association_type": "gene_to_disease"
        }"#;

        let association: Association = serde_json::from_str(json).unwrap();
        assert!(association.id.is_some());
        assert_eq!(association.subject.id, "MONDO:0004975");
        assert_eq!(association.subject.label, "Alzheimer disease");
        assert_eq!(association.object.id, "HGNC:613");
        assert_eq!(association.object.label, "APP");
        assert_eq!(association.score, Some(0.95));
        assert_eq!(association.publications.as_ref().unwrap().len(), 1);
        assert_eq!(association.evidence.len(), 1);
        assert_eq!(
            association.publications.as_ref().unwrap()[0].id,
            "PMID:12345678"
        );
    }

    #[test]
    fn test_search_response_deserialization() {
        let json = r#"{
            "items": [
                {
                    "id": "MONDO:0004975",
                    "label": "Alzheimer disease",
                    "category": ["biolink:Disease"],
                    "definition": "A degenerative disease",
                    "synonyms": ["AD"],
                    "xrefs": ["DOID:10652"],
                    "taxon": null
                },
                {
                    "id": "MONDO:0011561",
                    "label": "familial Alzheimer disease",
                    "category": ["biolink:Disease"],
                    "definition": null,
                    "synonyms": [],
                    "xrefs": [],
                    "taxon": null
                }
            ],
            "total": 2,
            "offset": 0,
            "limit": 10
        }"#;

        let response: SearchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.items.len(), 2);
        assert_eq!(response.items[0].id, "MONDO:0004975");
        assert_eq!(response.items[0].label, "Alzheimer disease");
        assert_eq!(response.items[1].id, "MONDO:0011561");
        assert_eq!(response.total, Some(2));
        assert_eq!(response.offset, Some(0));
        assert_eq!(response.limit, Some(10));
    }

    #[test]
    fn test_association_response_deserialization() {
        let json = r#"{
            "associations": [
                {
                    "id": "uuid:1",
                    "subject": {
                        "id": "MONDO:0004975",
                        "label": "Alzheimer disease",
                        "category": ["biolink:Disease"],
                        "taxon": null
                    },
                    "predicate": "biolink:gene_associated_with_condition",
                    "object": {
                        "id": "HGNC:613",
                        "label": "APP",
                        "category": ["biolink:Gene"],
                        "taxon": null
                    },
                    "score": null,
                    "publications": null,
                    "evidence": [],
                    "association_type": null
                }
            ],
            "total": 1,
            "offset": 0,
            "limit": 10
        }"#;

        let response: AssociationResponse = serde_json::from_str(json).unwrap();
        assert_eq!(response.associations.len(), 1);
        assert_eq!(response.associations[0].subject.id, "MONDO:0004975");
        assert_eq!(response.associations[0].object.id, "HGNC:613");
        assert_eq!(response.total, Some(1));
    }
}
