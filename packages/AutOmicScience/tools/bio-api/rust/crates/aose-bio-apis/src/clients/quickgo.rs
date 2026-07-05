//! QuickGO Gene Ontology annotation client.
//!
//! Documentation: https://www.ebi.ac.uk/QuickGO/api/index.html

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://www.ebi.ac.uk/QuickGO/services";
const REQUESTS_PER_SECOND: u32 = 10;

/// QuickGO REST API client for Gene Ontology annotations
pub struct QuickGoClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl QuickGoClient {
    /// Create a new QuickGO client
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

    /// Search GO annotations for a gene product
    ///
    /// # Arguments
    /// * `params` - Search parameters (gene product ID, GO terms, etc.)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::quickgo::{QuickGoClient, AnnotationSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = QuickGoClient::new();
    /// let params = AnnotationSearchParams {
    ///     gene_product_id: Some("P12345".to_string()),
    ///     limit: Some(100),
    ///     ..Default::default()
    /// };
    /// let response = client.search_annotations(params).await?;
    /// println!("Found {} annotations", response.number_of_hits);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_annotations(
        &self,
        params: AnnotationSearchParams,
    ) -> BioApiResult<AnnotationSearchResponse> {
        let mut url = format!("{}/annotation/search", BASE_URL);
        let query_params = params.to_query_params();

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        self.retry_policy
            .execute("search_annotations", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("QuickGO API error: {}", status),
                        });
                    }

                    response
                        .json::<AnnotationSearchResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }

    /// Get detailed information about a GO term
    ///
    /// # Arguments
    /// * `go_id` - GO term identifier (e.g., "GO:0008150")
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::quickgo::QuickGoClient;
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = QuickGoClient::new();
    /// let term = client.get_go_term("GO:0008150").await?;
    /// println!("GO term: {} - {}", term.id, term.name);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_go_term(&self, go_id: &str) -> BioApiResult<GoTerm> {
        let url = format!("{}/ontology/go/terms/{}", BASE_URL, go_id);

        self.retry_policy
            .execute("get_go_term", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "GO term '{}' not found",
                                go_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("QuickGO API error: {}", status),
                        });
                    }

                    let wrapper: GoTermWrapper = response.json().await?;
                    wrapper.results.into_iter().next().ok_or_else(|| {
                        BioApiError::NotFound(format!("GO term '{}' not found", go_id))
                    })
                }
            })
            .await
    }

    /// Search GO terms by name, definition, or other criteria
    ///
    /// # Arguments
    /// * `params` - Search parameters
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::quickgo::{QuickGoClient, GoTermSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = QuickGoClient::new();
    /// let params = GoTermSearchParams {
    ///     query: "apoptosis".to_string(),
    ///     limit: Some(20),
    ///     ..Default::default()
    /// };
    /// let response = client.search_go_terms(params).await?;
    /// println!("Found {} GO terms", response.number_of_hits);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_go_terms(
        &self,
        params: GoTermSearchParams,
    ) -> BioApiResult<GoTermSearchResponse> {
        let mut url = format!("{}/ontology/go/search", BASE_URL);
        let query_params = params.to_query_params();

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        self.retry_policy
            .execute("search_go_terms", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("QuickGO API error: {}", status),
                        });
                    }

                    response
                        .json::<GoTermSearchResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }
}

impl Default for QuickGoClient {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Request parameter types
// ============================================================================

/// Parameters for searching GO annotations
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSearchParams {
    /// Gene product ID (e.g., UniProt accession "P12345")
    pub gene_product_id: Option<String>,
    /// GO term ID (e.g., "GO:0008150")
    pub go_id: Option<String>,
    /// Taxonomic identifier (e.g., "9606" for human)
    pub taxon_id: Option<String>,
    /// Aspect: biological_process, molecular_function, cellular_component
    pub aspect: Option<String>,
    /// GO evidence code (e.g., "IEA", "IDA")
    pub evidence_code: Option<String>,
    /// Assigned by (e.g., "UniProt")
    pub assigned_by: Option<String>,
    /// Maximum number of results
    pub limit: Option<u32>,
    /// Page number (for pagination)
    pub page: Option<u32>,
}

impl AnnotationSearchParams {
    fn to_query_params(&self) -> Vec<String> {
        let mut params = Vec::new();

        if let Some(ref id) = self.gene_product_id {
            params.push(format!("geneProductId={}", urlencoding::encode(id)));
        }
        if let Some(ref id) = self.go_id {
            params.push(format!("goId={}", urlencoding::encode(id)));
        }
        if let Some(ref id) = self.taxon_id {
            params.push(format!("taxonId={}", id));
        }
        if let Some(ref aspect) = self.aspect {
            params.push(format!("aspect={}", urlencoding::encode(aspect)));
        }
        if let Some(ref code) = self.evidence_code {
            params.push(format!("evidenceCode={}", code));
        }
        if let Some(ref assigned_by) = self.assigned_by {
            params.push(format!("assignedBy={}", urlencoding::encode(assigned_by)));
        }
        if let Some(limit) = self.limit {
            params.push(format!("limit={}", limit));
        }
        if let Some(page) = self.page {
            params.push(format!("page={}", page));
        }

        params
    }
}

/// Parameters for searching GO terms
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoTermSearchParams {
    /// Search query (term name or definition keywords)
    pub query: String,
    /// Limit results
    pub limit: Option<u32>,
    /// Page number
    pub page: Option<u32>,
}

impl Default for GoTermSearchParams {
    fn default() -> Self {
        Self {
            query: String::new(),
            limit: Some(25),
            page: Some(1),
        }
    }
}

impl GoTermSearchParams {
    fn to_query_params(&self) -> Vec<String> {
        let mut params = vec![format!("query={}", urlencoding::encode(&self.query))];

        if let Some(limit) = self.limit {
            params.push(format!("limit={}", limit));
        }
        if let Some(page) = self.page {
            params.push(format!("page={}", page));
        }

        params
    }
}

// ============================================================================
// Response types
// ============================================================================

/// Response from annotation search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSearchResponse {
    pub number_of_hits: u32,
    pub page_info: PageInfo,
    pub results: Vec<Annotation>,
}

/// Response wrapper for GO term details
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoTermWrapper {
    pub results: Vec<GoTerm>,
}

/// Response from GO term search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoTermSearchResponse {
    pub number_of_hits: u32,
    pub page_info: PageInfo,
    pub results: Vec<GoTerm>,
}

/// Pagination information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub total: u32,
    pub current: u32,
    pub results_per_page: u32,
}

/// GO annotation record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// Gene product ID (e.g., UniProt accession)
    pub gene_product_id: String,
    /// Gene product symbol
    #[serde(default)]
    pub symbol: Option<String>,
    /// Qualifier (e.g., "enables", "involved_in")
    #[serde(default)]
    pub qualifier: Option<String>,
    /// GO term ID
    pub go_id: String,
    /// GO term name
    #[serde(default)]
    pub go_name: Option<String>,
    /// GO aspect (biological_process, molecular_function, cellular_component)
    pub go_aspect: String,
    /// Evidence code (e.g., "IEA", "IDA")
    pub evidence_code: String,
    /// GO evidence source
    #[serde(default)]
    pub go_evidence: Option<String>,
    /// Reference (publication or database)
    #[serde(default)]
    pub reference: Option<String>,
    /// With/From field
    #[serde(default)]
    pub with_from: Vec<WithFrom>,
    /// Taxonomic identifier
    pub taxon_id: u32,
    /// Taxon name
    #[serde(default)]
    pub taxon_name: Option<String>,
    /// Assigned by (e.g., "UniProt")
    pub assigned_by: String,
    /// Annotation date (YYYYMMDD format)
    #[serde(default)]
    pub date: Option<String>,
    /// Annotation extensions
    #[serde(default)]
    pub extensions: Option<Vec<Extension>>,
}

/// GO term details
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoTerm {
    /// GO term identifier (e.g., "GO:0008150")
    pub id: String,
    /// Term name
    pub name: String,
    /// Term definition
    #[serde(default)]
    pub definition: Option<GoDefinition>,
    /// GO aspect (biological_process, molecular_function, cellular_component)
    pub aspect: String,
    /// Whether the term is obsolete
    #[serde(default)]
    pub is_obsolete: bool,
    /// Replacement term if obsolete
    #[serde(default)]
    pub replaced_by: Option<String>,
    /// Synonyms
    #[serde(default)]
    pub synonyms: Vec<Synonym>,
    /// Cross-references
    #[serde(default)]
    pub cross_references: Vec<CrossReference>,
    /// Child terms
    #[serde(default)]
    pub children: Vec<GoTermRelation>,
    /// Parent terms
    #[serde(default)]
    pub ancestors: Vec<GoTermRelation>,
}

/// GO term definition with references
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoDefinition {
    pub text: String,
    #[serde(default)]
    pub xrefs: Vec<String>,
}

/// GO term synonym
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Synonym {
    pub name: String,
    #[serde(rename = "type")]
    pub synonym_type: String,
}

/// Cross-reference to external database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossReference {
    pub db_name: String,
    pub db_id: String,
}

/// Relationship between GO terms
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoTermRelation {
    pub id: String,
    pub relation: String,
}

/// Annotation extension
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extension {
    #[serde(rename = "connectedXrefs")]
    pub connected_xrefs: Vec<ConnectedXref>,
}

/// Connected cross-reference in annotation extension
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedXref {
    pub db: String,
    pub id: String,
    pub relation: String,
}

/// Cross-reference in With/From field (no relation field)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithFromXref {
    pub db: String,
    pub id: String,
}

/// With/From field in annotations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithFrom {
    pub connected_xrefs: Vec<WithFromXref>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = QuickGoClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_annotation_params_building() {
        let params = AnnotationSearchParams {
            gene_product_id: Some("P12345".to_string()),
            go_id: Some("GO:0008150".to_string()),
            taxon_id: Some("9606".to_string()),
            limit: Some(100),
            ..Default::default()
        };

        let query = params.to_query_params();
        assert!(query.iter().any(|p| p.contains("geneProductId=P12345")));
        assert!(query.iter().any(|p| p.contains("goId=GO%3A0008150")));
        assert!(query.iter().any(|p| p.contains("taxonId=9606")));
        assert!(query.iter().any(|p| p.contains("limit=100")));
    }

    #[test]
    fn test_go_term_search_params() {
        let params = GoTermSearchParams {
            query: "apoptosis".to_string(),
            limit: Some(20),
            page: Some(1),
        };

        let query = params.to_query_params();
        assert!(query.iter().any(|p| p.contains("query=apoptosis")));
        assert!(query.iter().any(|p| p.contains("limit=20")));
        assert!(query.iter().any(|p| p.contains("page=1")));
    }

    #[test]
    fn test_annotation_params_default() {
        let params = AnnotationSearchParams::default();
        let query = params.to_query_params();
        assert!(query.is_empty());
    }
}
