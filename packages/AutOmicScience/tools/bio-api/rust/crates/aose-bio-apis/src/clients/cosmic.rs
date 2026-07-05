//! COSMIC (Catalogue Of Somatic Mutations In Cancer) API client.
//!
//! Documentation: https://cancer.sanger.ac.uk/cosmic/help/api
//!
//! COSMIC download is a two-stage process:
//! 1. POST to scripted endpoint with Basic Auth returns JSON with download URL
//! 2. GET the actual URL to download tar archive containing TSV files
//!
//! Authentication uses Basic Auth with format: `base64(email:password\n)` (note trailing newline)

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tar::Archive;

const SCRIPTED_ENDPOINT: &str =
    "https://cancer.sanger.ac.uk/api/mono/products/v1/downloads/scripted";
const RELEASE_NOTES_URL: &str = "https://cancer.sanger.ac.uk/cosmic/release_notes";
const REQUESTS_PER_SECOND: u32 = 5;

/// COSMIC project types
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CosmicProject {
    /// Cancer Mutation Census (CMC) - GRCh37 only
    Cancer,
    /// Cell Line Project
    CellLine,
    /// Cancer Gene Census
    Census,
    /// Drug Resistance Mutations
    Resistance,
    /// Genome Screens
    GenomeScreen,
    /// Targeted Screens
    TargetedScreen,
    /// Cancer Example (no auth required)
    CancerExample,
}

impl CosmicProject {
    fn as_str(&self) -> &'static str {
        match self {
            CosmicProject::Cancer => "cmc",
            CosmicProject::CellLine => "cell_line",
            CosmicProject::Census => "census",
            CosmicProject::Resistance => "resistance",
            CosmicProject::GenomeScreen => "genome_screen",
            CosmicProject::TargetedScreen => "targeted_screen",
            CosmicProject::CancerExample => "cancer_example",
        }
    }

    /// Check if this project requires authentication
    pub fn requires_auth(&self) -> bool {
        !matches!(self, CosmicProject::CancerExample)
    }
}

/// COSMIC download request
#[derive(Debug, Clone)]
pub struct CosmicDownloadRequest {
    /// COSMIC project type
    pub project: CosmicProject,
    /// Genome reference version (37 or 38)
    pub grch_version: u8,
    /// COSMIC database version (e.g., 100)
    pub cosmic_version: u32,
    /// Output directory for extracted files
    pub output_dir: String,
}

/// COSMIC download response from scripted endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CosmicScriptedResponse {
    url: String,
}

/// COSMIC mutation record (simplified schema)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CosmicMutation {
    pub gene_name: Option<String>,
    pub accession_number: Option<String>,
    pub genomic_mutation_id: Option<String>,
    pub mutation_cds: Option<String>,
    pub mutation_aa: Option<String>,
    pub mutation_description: Option<String>,
    pub mutation_somatic_status: Option<String>,
    pub primary_site: Option<String>,
    pub site_subtype: Option<String>,
    pub primary_histology: Option<String>,
    pub histology_subtype: Option<String>,
    pub pubmed_pmid: Option<String>,
}

/// COSMIC API client
pub struct CosmicClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
    /// COSMIC account email (required for authenticated access)
    email: Option<String>,
    /// COSMIC account password (required for authenticated access)
    password: Option<String>,
}

impl CosmicClient {
    /// Create a new COSMIC client with credentials from environment variables
    ///
    /// Looks for `COSMIC_EMAIL` and `COSMIC_PASSWORD` environment variables.
    pub fn new() -> Self {
        let email = std::env::var("COSMIC_EMAIL").ok();
        let password = std::env::var("COSMIC_PASSWORD").ok();

        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
            email,
            password,
        }
    }

    /// Create a new COSMIC client with explicit credentials
    pub fn with_credentials(email: String, password: String) -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
            email: Some(email),
            password: Some(password),
        }
    }

    /// Generate Basic Auth header value
    ///
    /// Format: `base64(email:password\n)` - note the critical trailing newline
    fn generate_auth_header(&self) -> BioApiResult<String> {
        let email = self
            .email
            .as_ref()
            .ok_or_else(|| BioApiError::InvalidInput("COSMIC_EMAIL not set".to_string()))?;
        let password = self
            .password
            .as_ref()
            .ok_or_else(|| BioApiError::InvalidInput("COSMIC_PASSWORD not set".to_string()))?;

        // Critical: trailing newline is required by COSMIC API
        let credentials = format!("{}:{}\n", email, password);
        let encoded = BASE64.encode(credentials.as_bytes());
        Ok(format!("Basic {}", encoded))
    }

    /// Construct download path for COSMIC data
    fn construct_path(
        &self,
        project: CosmicProject,
        grch_version: u8,
        cosmic_version: u32,
    ) -> String {
        // Special cases for v99-100: use "GRCh37" not "grch37"
        let grch_prefix = if (99..=100).contains(&cosmic_version) && grch_version == 37 {
            "GRCh37"
        } else {
            &format!("grch{}", grch_version)
        };

        // Special case for v100: append "_v2" to filename
        let version_suffix = if cosmic_version == 100 { "_v2" } else { "" };

        // Construct filename based on project
        let filename = match project {
            CosmicProject::Cancer => format!(
                "CancerMutationCensus_AllData_Tsv_v{}_GRCh{}{}",
                cosmic_version, grch_version, version_suffix
            ),
            CosmicProject::CellLine => format!(
                "CosmicCellLineProject_v{}{}",
                cosmic_version, version_suffix
            ),
            CosmicProject::Census => format!(
                "CosmicCancerGeneCensus_v{}{}",
                cosmic_version, version_suffix
            ),
            CosmicProject::Resistance => format!(
                "CosmicResistanceMutations_v{}{}",
                cosmic_version, version_suffix
            ),
            CosmicProject::GenomeScreen => {
                format!("CosmicGenomeScreens_v{}{}", cosmic_version, version_suffix)
            }
            CosmicProject::TargetedScreen => format!(
                "CosmicTargetedScreens_v{}{}",
                cosmic_version, version_suffix
            ),
            CosmicProject::CancerExample => {
                format!("CosmicExample_v{}{}", cosmic_version, version_suffix)
            }
        };

        format!(
            "{}/{}/v{}/{}.tar",
            grch_prefix,
            project.as_str(),
            cosmic_version,
            filename
        )
    }

    /// Stage 1: Get download URL from scripted endpoint
    async fn get_download_url(&self, request: &CosmicDownloadRequest) -> BioApiResult<String> {
        let path = self.construct_path(
            request.project,
            request.grch_version,
            request.cosmic_version,
        );

        let url = format!(
            "{}?path={}&bucket=downloads",
            SCRIPTED_ENDPOINT,
            urlencoding::encode(&path)
        );

        let json: CosmicScriptedResponse = self
            .retry_policy
            .execute("cosmic_get_download_url", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let mut req_builder = self.client.post(&url);

                    // Add auth header if required
                    if request.project.requires_auth() {
                        let auth_header = self.generate_auth_header()?;
                        req_builder = req_builder.header("Authorization", auth_header);
                    }

                    let response = req_builder.send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 401 {
                            return Err(BioApiError::ApiError {
                                status: 401,
                                message: "Authentication failed. Check COSMIC credentials."
                                    .to_string(),
                            });
                        }
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "COSMIC data not found for project={:?} version={}",
                                request.project, request.cosmic_version
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("COSMIC API error: {}", status),
                        });
                    }

                    response
                        .json::<CosmicScriptedResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(json.url)
    }

    /// Stage 2: Download and extract tar archive
    async fn download_and_extract(
        &self,
        url: &str,
        output_dir: &Path,
    ) -> BioApiResult<Vec<String>> {
        let bytes = self
            .retry_policy
            .execute("cosmic_download_tar", || {
                let url = url.to_string();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::NotFound("Download failed".to_string()));
                    }

                    response.bytes().await.map_err(Into::into)
                }
            })
            .await?;

        // Create output directory
        tokio::fs::create_dir_all(output_dir)
            .await
            .map_err(BioApiError::IoError)?;

        // Extract tar archive
        let cursor = std::io::Cursor::new(bytes.as_ref());
        let mut archive = Archive::new(cursor);
        let mut extracted_files = Vec::new();

        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?;
            let file_name = path
                .file_name()
                .ok_or_else(|| BioApiError::Other("Invalid file path in archive".to_string()))?;

            let output_path = output_dir.join(file_name);

            // Extract file
            let mut output_file = std::fs::File::create(&output_path)?;
            std::io::copy(&mut entry, &mut output_file)?;

            extracted_files.push(output_path.to_string_lossy().to_string());
        }

        Ok(extracted_files)
    }

    /// Download COSMIC data
    ///
    /// Returns paths to extracted TSV files
    pub async fn download(&self, request: CosmicDownloadRequest) -> BioApiResult<Vec<String>> {
        // Validate input
        if request.grch_version != 37 && request.grch_version != 38 {
            return Err(BioApiError::InvalidInput(
                "grch_version must be 37 or 38".to_string(),
            ));
        }

        // CMC project only supports GRCh37
        if matches!(request.project, CosmicProject::Cancer) && request.grch_version != 37 {
            return Err(BioApiError::InvalidInput(
                "Cancer Mutation Census (CMC) only supports GRCh37".to_string(),
            ));
        }

        // Stage 1: Get download URL
        let download_url = self.get_download_url(&request).await?;

        // Stage 2: Download and extract
        let output_path = Path::new(&request.output_dir);
        let extracted_files = self
            .download_and_extract(&download_url, output_path)
            .await?;

        Ok(extracted_files)
    }

    /// Query local COSMIC TSV files
    ///
    /// Performs case-insensitive exact match on specified columns.
    /// Common query columns: GENE_NAME, ACCESSION_NUMBER, GENOMIC_MUTATION_ID
    pub async fn query_local_tsv(
        &self,
        tsv_path: &Path,
        column: &str,
        value: &str,
    ) -> BioApiResult<Vec<serde_json::Value>> {
        let content = tokio::fs::read_to_string(tsv_path).await?;

        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(b'\t')
            .from_reader(content.as_bytes());

        let headers = rdr.headers()?.clone();

        // Find column index (case-insensitive)
        let col_idx = headers
            .iter()
            .position(|h| h.eq_ignore_ascii_case(column))
            .ok_or_else(|| {
                BioApiError::InvalidInput(format!("Column '{}' not found in TSV", column))
            })?;

        let mut results = Vec::new();
        let value_lower = value.to_lowercase();

        for result in rdr.records() {
            let record = result?;
            if let Some(cell) = record.get(col_idx) {
                if cell.to_lowercase() == value_lower {
                    // Convert record to JSON object
                    let mut obj = serde_json::Map::new();
                    for (i, header) in headers.iter().enumerate() {
                        if let Some(val) = record.get(i) {
                            obj.insert(header.to_string(), Value::String(val.to_string()));
                        }
                    }
                    results.push(Value::Object(obj));
                }
            }
        }

        Ok(results)
    }

    /// Fetch latest COSMIC version by scraping release notes
    ///
    /// Parses div.news elements with id="v{number}" from release notes page
    pub async fn get_latest_version(&self) -> BioApiResult<u32> {
        let response = self
            .retry_policy
            .execute("cosmic_get_latest_version", || async {
                self.rate_limiter.acquire().await;
                self.client
                    .get(RELEASE_NOTES_URL)
                    .send()
                    .await
                    .map_err(Into::into)
            })
            .await?;

        let html = response.text().await?;

        // Parse HTML to find div.news with id="v{number}"
        // Simple regex-based extraction (for production, consider using scraper crate)
        let re = regex::Regex::new(r#"<div[^>]*class="news"[^>]*id="v(\d+)"#)
            .map_err(|e| BioApiError::Other(format!("Regex error: {}", e)))?;

        let versions: Vec<u32> = re
            .captures_iter(&html)
            .filter_map(|cap| cap.get(1)?.as_str().parse().ok())
            .collect();

        versions
            .into_iter()
            .max()
            .ok_or_else(|| BioApiError::Other("Could not determine latest version".to_string()))
    }
}

impl Default for CosmicClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = CosmicClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_auth_header_generation() {
        let client = CosmicClient::with_credentials(
            "test@example.com".to_string(),
            "password123".to_string(),
        );
        let auth_header = client.generate_auth_header().unwrap();
        assert!(auth_header.starts_with("Basic "));

        // Decode and verify format includes trailing newline
        let encoded = auth_header.strip_prefix("Basic ").unwrap();
        let decoded = BASE64.decode(encoded).unwrap();
        let decoded_str = String::from_utf8(decoded).unwrap();
        assert_eq!(decoded_str, "test@example.com:password123\n");
    }

    #[test]
    fn test_path_construction() {
        let client = CosmicClient::new();

        // Test normal case
        let path = client.construct_path(CosmicProject::Census, 38, 98);
        assert_eq!(path, "grch38/census/v98/CosmicCancerGeneCensus_v98.tar");

        // Test v100 special case (GRCh37 and _v2 suffix)
        let path = client.construct_path(CosmicProject::Cancer, 37, 100);
        assert_eq!(
            path,
            "GRCh37/cmc/v100/CancerMutationCensus_AllData_Tsv_v100_GRCh37_v2.tar"
        );

        // Test v99 special case (GRCh37 prefix)
        let path = client.construct_path(CosmicProject::CellLine, 37, 99);
        assert_eq!(path, "GRCh37/cell_line/v99/CosmicCellLineProject_v99.tar");
    }

    #[test]
    fn test_project_requires_auth() {
        assert!(CosmicProject::Cancer.requires_auth());
        assert!(CosmicProject::CellLine.requires_auth());
        assert!(CosmicProject::Census.requires_auth());
        assert!(!CosmicProject::CancerExample.requires_auth());
    }

    #[tokio::test]
    async fn test_download_request_validation() {
        let client = CosmicClient::new();

        // Invalid GRCh version
        let request = CosmicDownloadRequest {
            project: CosmicProject::Census,
            grch_version: 99,
            cosmic_version: 100,
            output_dir: "/tmp".to_string(),
        };
        let result = client.download(request).await;
        assert!(result.is_err());

        // CMC with GRCh38 (should fail)
        let request = CosmicDownloadRequest {
            project: CosmicProject::Cancer,
            grch_version: 38,
            cosmic_version: 100,
            output_dir: "/tmp".to_string(),
        };
        let result = client.download(request).await;
        assert!(result.is_err());
    }
}
