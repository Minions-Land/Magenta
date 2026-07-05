//! PRIDE proteomics database client.
//!
//! Documentation: https://www.ebi.ac.uk/pride/ws/archive/v2/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://www.ebi.ac.uk/pride/ws/archive/v2";
const REQUESTS_PER_SECOND: u32 = 10;

/// PRIDE Archive REST API client for proteomics data
pub struct PrideClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl PrideClient {
    /// Create a new PRIDE client
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

    /// Search proteomics projects
    ///
    /// # Arguments
    /// * `params` - Search parameters (keyword, organism, etc.)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::pride::{PrideClient, ProjectSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = PrideClient::new();
    /// let params = ProjectSearchParams {
    ///     keyword: Some("breast cancer".to_string()),
    ///     page_size: Some(10),
    ///     ..Default::default()
    /// };
    /// let response = client.search_projects(params).await?;
    /// println!("Found {} projects", response.page.total_elements);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_projects(
        &self,
        params: ProjectSearchParams,
    ) -> BioApiResult<ProjectSearchResponse> {
        let mut url = format!("{}/projects", BASE_URL);
        let query_params = params.to_query_params();

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        self.retry_policy
            .execute("search_projects", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("PRIDE API error: {}", status),
                        });
                    }

                    response
                        .json::<ProjectSearchResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }

    /// Get detailed information about a specific project
    ///
    /// # Arguments
    /// * `accession` - Project accession (e.g., "PXD012345")
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::pride::PrideClient;
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = PrideClient::new();
    /// let project = client.get_project("PXD012345").await?;
    /// println!("Project: {}", project.title);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_project(&self, accession: &str) -> BioApiResult<Project> {
        let url = format!("{}/projects/{}", BASE_URL, accession);

        self.retry_policy
            .execute("get_project", || {
                let url = url.clone();
                let accession = accession.to_string();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Project '{}' not found",
                                accession
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("PRIDE API error: {}", status),
                        });
                    }

                    response.json::<Project>().await.map_err(Into::into)
                }
            })
            .await
    }

    /// Get list of files for a project
    ///
    /// # Arguments
    /// * `accession` - Project accession (e.g., "PXD012345")
    /// * `params` - Optional file filter parameters
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::pride::{PrideClient, FileListParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = PrideClient::new();
    /// let params = FileListParams {
    ///     page_size: Some(50),
    ///     ..Default::default()
    /// };
    /// let response = client.get_project_files("PXD012345", params).await?;
    /// println!("Found {} files", response.page.total_elements);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_project_files(
        &self,
        accession: &str,
        params: FileListParams,
    ) -> BioApiResult<FileListResponse> {
        let mut url = format!("{}/projects/{}/files", BASE_URL, accession);
        let query_params = params.to_query_params();

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        self.retry_policy
            .execute("get_project_files", || {
                let url = url.clone();
                let accession = accession.to_string();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Project '{}' not found",
                                accession
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("PRIDE API error: {}", status),
                        });
                    }

                    response
                        .json::<FileListResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }

    /// Search proteins across projects
    ///
    /// # Arguments
    /// * `params` - Protein search parameters
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::pride::{PrideClient, ProteinSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = PrideClient::new();
    /// let params = ProteinSearchParams {
    ///     accession: Some("P12345".to_string()),
    ///     project_accession: Some("PXD012345".to_string()),
    ///     page_size: Some(100),
    ///     ..Default::default()
    /// };
    /// let response = client.search_proteins(params).await?;
    /// println!("Found {} proteins", response.page.total_elements);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_proteins(
        &self,
        params: ProteinSearchParams,
    ) -> BioApiResult<ProteinSearchResponse> {
        let mut url = format!("{}/proteins", BASE_URL);
        let query_params = params.to_query_params();

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        self.retry_policy
            .execute("search_proteins", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("PRIDE API error: {}", status),
                        });
                    }

                    response
                        .json::<ProteinSearchResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }
}

impl Default for PrideClient {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Request parameter types
// ============================================================================

/// Parameters for searching projects
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchParams {
    /// Keyword search (title, description, etc.)
    pub keyword: Option<String>,
    /// Filter by organism (taxon ID or name)
    pub filter: Option<String>,
    /// NCBI taxonomy ID
    pub ptms: Option<String>,
    /// Instrument name
    pub instrument: Option<String>,
    /// Experiment type
    pub experiment_type: Option<String>,
    /// Quantification method
    pub quantification: Option<String>,
    /// Page number (0-indexed)
    pub page: Option<u32>,
    /// Number of results per page
    pub page_size: Option<u32>,
    /// Sort field
    pub sort_field: Option<String>,
    /// Sort direction (ASC or DESC)
    pub sort_direction: Option<String>,
}

impl ProjectSearchParams {
    fn to_query_params(&self) -> Vec<String> {
        let mut params = Vec::new();

        if let Some(ref keyword) = self.keyword {
            params.push(format!("keyword={}", urlencoding::encode(keyword)));
        }
        if let Some(ref filter) = self.filter {
            params.push(format!("filter={}", urlencoding::encode(filter)));
        }
        if let Some(ref ptms) = self.ptms {
            params.push(format!("ptms={}", urlencoding::encode(ptms)));
        }
        if let Some(ref instrument) = self.instrument {
            params.push(format!("instrument={}", urlencoding::encode(instrument)));
        }
        if let Some(ref exp_type) = self.experiment_type {
            params.push(format!("experimentType={}", urlencoding::encode(exp_type)));
        }
        if let Some(ref quant) = self.quantification {
            params.push(format!("quantification={}", urlencoding::encode(quant)));
        }
        if let Some(page) = self.page {
            params.push(format!("page={}", page));
        }
        if let Some(page_size) = self.page_size {
            params.push(format!("pageSize={}", page_size));
        }
        if let Some(ref sort) = self.sort_field {
            params.push(format!("sortField={}", sort));
        }
        if let Some(ref direction) = self.sort_direction {
            params.push(format!("sortDirection={}", direction));
        }

        params
    }
}

/// Parameters for listing project files
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListParams {
    /// Filter by file type
    pub file_type: Option<String>,
    /// Page number (0-indexed)
    pub page: Option<u32>,
    /// Number of results per page
    pub page_size: Option<u32>,
}

impl FileListParams {
    fn to_query_params(&self) -> Vec<String> {
        let mut params = Vec::new();

        if let Some(ref file_type) = self.file_type {
            params.push(format!("fileType={}", urlencoding::encode(file_type)));
        }
        if let Some(page) = self.page {
            params.push(format!("page={}", page));
        }
        if let Some(page_size) = self.page_size {
            params.push(format!("pageSize={}", page_size));
        }

        params
    }
}

/// Parameters for searching proteins
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProteinSearchParams {
    /// Protein accession (e.g., UniProt ID)
    pub accession: Option<String>,
    /// Project accession
    pub project_accession: Option<String>,
    /// Assay accession
    pub assay_accession: Option<String>,
    /// Reported accession
    pub reported_accession: Option<String>,
    /// Page number (0-indexed)
    pub page: Option<u32>,
    /// Number of results per page
    pub page_size: Option<u32>,
}

impl ProteinSearchParams {
    fn to_query_params(&self) -> Vec<String> {
        let mut params = Vec::new();

        if let Some(ref acc) = self.accession {
            params.push(format!("accession={}", urlencoding::encode(acc)));
        }
        if let Some(ref proj) = self.project_accession {
            params.push(format!("projectAccession={}", urlencoding::encode(proj)));
        }
        if let Some(ref assay) = self.assay_accession {
            params.push(format!("assayAccession={}", urlencoding::encode(assay)));
        }
        if let Some(ref reported) = self.reported_accession {
            params.push(format!(
                "reportedAccession={}",
                urlencoding::encode(reported)
            ));
        }
        if let Some(page) = self.page {
            params.push(format!("page={}", page));
        }
        if let Some(page_size) = self.page_size {
            params.push(format!("pageSize={}", page_size));
        }

        params
    }
}

// ============================================================================
// Response types
// ============================================================================

/// Response from project search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResponse {
    /// Embedded list of projects
    #[serde(rename = "_embedded")]
    pub embedded: Option<EmbeddedProjects>,
    /// Pagination information
    pub page: PageInfo,
}

/// Wrapper for embedded projects
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedProjects {
    pub projects: Vec<ProjectSummary>,
}

/// Response from file listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListResponse {
    /// Embedded list of files
    #[serde(rename = "_embedded")]
    pub embedded: Option<EmbeddedFiles>,
    /// Pagination information
    pub page: PageInfo,
}

/// Wrapper for embedded files
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedFiles {
    pub files: Vec<ProjectFile>,
}

/// Response from protein search
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProteinSearchResponse {
    /// Embedded list of proteins
    #[serde(rename = "_embedded")]
    pub embedded: Option<EmbeddedProteins>,
    /// Pagination information
    pub page: PageInfo,
}

/// Wrapper for embedded proteins
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedProteins {
    pub proteins: Vec<Protein>,
}

/// Pagination information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// Total number of elements
    pub total_elements: u64,
    /// Total number of pages
    pub total_pages: u32,
    /// Current page number (0-indexed)
    pub number: u32,
    /// Results per page
    pub size: u32,
}

/// Summary information about a project (used in search results)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// Project accession (e.g., PXD012345)
    pub accession: String,
    /// Project title
    pub title: String,
    /// Project description
    #[serde(default)]
    pub project_description: Option<String>,
    /// Submission date
    #[serde(default)]
    pub submission_date: Option<String>,
    /// Publication date
    #[serde(default)]
    pub publication_date: Option<String>,
    /// Organisms studied
    #[serde(default)]
    pub organisms: Vec<Organism>,
    /// Instruments used
    #[serde(default)]
    pub instruments: Vec<Instrument>,
    /// Associated PubMed IDs
    #[serde(default)]
    pub references: Vec<Reference>,
    /// Project tags/keywords
    #[serde(default)]
    pub project_tags: Vec<String>,
}

/// Detailed project information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Project accession (e.g., PXD012345)
    pub accession: String,
    /// Project title
    pub title: String,
    /// Full project description
    #[serde(default)]
    pub project_description: Option<String>,
    /// Sample processing protocol
    #[serde(default)]
    pub sample_processing_protocol: Option<String>,
    /// Data processing protocol
    #[serde(default)]
    pub data_processing_protocol: Option<String>,
    /// Submission type
    #[serde(default)]
    pub submission_type: Option<String>,
    /// Submission date
    #[serde(default)]
    pub submission_date: Option<String>,
    /// Publication date
    #[serde(default)]
    pub publication_date: Option<String>,
    /// Update date
    #[serde(default)]
    pub updated_date: Option<String>,
    /// Submitter information
    #[serde(default)]
    pub submitters: Vec<Contact>,
    /// Lab head information
    #[serde(default)]
    pub lab_heads: Vec<Contact>,
    /// Keywords/tags
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Project tags
    #[serde(default)]
    pub project_tags: Vec<String>,
    /// PTMs (post-translational modifications)
    #[serde(default)]
    pub ptm_list: Vec<Ptm>,
    /// Organisms
    #[serde(default)]
    pub organisms: Vec<Organism>,
    /// Organism parts
    #[serde(default)]
    pub organism_parts: Vec<OrganismPart>,
    /// Diseases
    #[serde(default)]
    pub diseases: Vec<Disease>,
    /// Instruments
    #[serde(default)]
    pub instruments: Vec<Instrument>,
    /// Software used
    #[serde(default)]
    pub software_list: Vec<Software>,
    /// Quantification methods
    #[serde(default)]
    pub quantification_methods: Vec<QuantificationMethod>,
    /// Associated publications
    #[serde(default)]
    pub references: Vec<Reference>,
}

/// File information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// File name
    pub file_name: String,
    /// File type/category
    pub file_category: String,
    /// File size in bytes
    pub file_size_bytes: u64,
    /// Download link
    pub download_link: String,
    /// FTP link
    #[serde(default)]
    pub ftp_link: Option<String>,
    /// Associated project accession
    pub accession: String,
    /// Associated assay accession
    #[serde(default)]
    pub assay_accession: Option<String>,
}

/// Protein identification information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Protein {
    /// Reported protein accession
    pub reported_accession: String,
    /// Protein description
    #[serde(default)]
    pub protein_description: Option<String>,
    /// Mapped protein accession (e.g., UniProt)
    #[serde(default)]
    pub accession: Option<String>,
    /// Project accession
    pub project_accession: String,
    /// Assay accession
    pub assay_accession: String,
    /// Protein sequence
    #[serde(default)]
    pub protein_sequence: Option<String>,
    /// PTMs identified
    #[serde(default)]
    pub ptms: Vec<String>,
}

/// Organism information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organism {
    /// Organism name
    pub name: String,
    /// NCBI taxonomy ID
    pub taxon: u32,
}

/// Organism part/tissue information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganismPart {
    /// Part name
    pub name: String,
    /// Ontology accession
    #[serde(default)]
    pub accession: Option<String>,
}

/// Disease information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Disease {
    /// Disease name
    pub name: String,
    /// Disease ontology accession
    #[serde(default)]
    pub accession: Option<String>,
}

/// Instrument information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    /// Instrument name
    pub name: String,
    /// Instrument ontology accession
    #[serde(default)]
    pub accession: Option<String>,
}

/// Software information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Software {
    /// Software name
    pub name: String,
    /// Software version
    #[serde(default)]
    pub version: Option<String>,
}

/// Quantification method
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantificationMethod {
    /// Method name
    pub name: String,
    /// Method ontology accession
    #[serde(default)]
    pub accession: Option<String>,
}

/// Post-translational modification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ptm {
    /// PTM name
    pub name: String,
    /// PTM ontology accession
    #[serde(default)]
    pub accession: Option<String>,
}

/// Contact information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    /// Contact name
    pub name: String,
    /// Email address
    #[serde(default)]
    pub email: Option<String>,
    /// Affiliation
    #[serde(default)]
    pub affiliation: Option<String>,
}

/// Publication reference
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// Reference line (formatted citation)
    #[serde(default)]
    pub reference_line: Option<String>,
    /// PubMed ID
    #[serde(default)]
    pub pubmed_id: Option<String>,
    /// DOI
    #[serde(default)]
    pub doi: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = PrideClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_project_search_params() {
        let params = ProjectSearchParams {
            keyword: Some("breast cancer".to_string()),
            page_size: Some(10),
            page: Some(0),
            ..Default::default()
        };

        let query = params.to_query_params();
        assert!(query.iter().any(|p| p.contains("keyword=breast")));
        assert!(query.iter().any(|p| p.contains("pageSize=10")));
        assert!(query.iter().any(|p| p.contains("page=0")));
    }

    #[test]
    fn test_protein_search_params() {
        let params = ProteinSearchParams {
            accession: Some("P12345".to_string()),
            project_accession: Some("PXD012345".to_string()),
            page_size: Some(100),
            ..Default::default()
        };

        let query = params.to_query_params();
        assert!(query.iter().any(|p| p.contains("accession=P12345")));
        assert!(query
            .iter()
            .any(|p| p.contains("projectAccession=PXD012345")));
        assert!(query.iter().any(|p| p.contains("pageSize=100")));
    }

    #[test]
    fn test_file_list_params() {
        let params = FileListParams {
            file_type: Some("RAW".to_string()),
            page_size: Some(50),
            ..Default::default()
        };

        let query = params.to_query_params();
        assert!(query.iter().any(|p| p.contains("fileType=RAW")));
        assert!(query.iter().any(|p| p.contains("pageSize=50")));
    }

    #[test]
    fn test_default_params() {
        let params = ProjectSearchParams::default();
        let query = params.to_query_params();
        assert!(query.is_empty());
    }
}
