//! NCBI Virus client for viral sequence metadata.
//!
//! Retrieves viral sequence metadata from NCBI Datasets v2 API.
//! Documentation: https://www.ncbi.nlm.nih.gov/datasets/docs/v2/api/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "https://api.ncbi.nlm.nih.gov/datasets/v2";
const EFETCH_URL: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
/// Max accessions per efetch GET. NCBI recommends EPost for >200 IDs.
const EFETCH_BATCH_SIZE: usize = 200;
const DEFAULT_REQUESTS_PER_SECOND: u32 = 3;
const WITH_API_KEY_REQUESTS_PER_SECOND: u32 = 10;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_PAGE_SIZE: u32 = 1000;
const MIN_PAGE_SIZE: u32 = 20;

/// NCBI Virus client for viral genomic data
pub struct NcbiVirusClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
    api_key: Option<String>,
}

impl NcbiVirusClient {
    /// Create a new gget virus client
    pub fn new(api_key: Option<String>) -> Self {
        let rps = if api_key.is_some() {
            WITH_API_KEY_REQUESTS_PER_SECOND
        } else {
            DEFAULT_REQUESTS_PER_SECOND
        };

        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1")
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());

        // Configure retry policy for NCBI Virus
        let retry_policy = RetryPolicy {
            max_retries: 2,
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(5),
            backoff_multiplier: 2.0,
            jitter: true,
        };

        Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(rps)),
            retry_policy,
            api_key,
        }
    }

    /// Fetch virus dataset by taxon (virus name or taxon ID)
    pub async fn fetch_by_taxon(
        &self,
        virus: &str,
        params: VirusQueryParams,
    ) -> BioApiResult<Vec<VirusRecord>> {
        let url = format!("{}/virus/taxon/{}/dataset_report", BASE_URL, virus);
        self.fetch_virus_data(&url, params).await
    }

    /// Fetch virus dataset by accession list
    pub async fn fetch_by_accessions(
        &self,
        accessions: &[String],
        params: VirusQueryParams,
    ) -> BioApiResult<Vec<VirusRecord>> {
        if accessions.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Accession list cannot be empty".to_string(),
            ));
        }

        // Join accessions with URL-encoded comma
        let accession_str = accessions.join("%2C");
        let url = format!(
            "{}/virus/accession/{}/dataset_report",
            BASE_URL, accession_str
        );

        self.fetch_virus_data(&url, params).await
    }

    /// Download nucleotide FASTA sequences for the given accessions.
    ///
    /// This is a pure-Rust replacement for the FASTA download performed by
    /// `gget virus`. It calls NCBI's E-utilities `efetch` endpoint
    /// (`db=nucleotide`, `rettype=fasta`, `retmode=text`) which returns the
    /// exact same bytes gget writes to `<virus>_sequences.fasta`.
    ///
    /// Accessions are batched (≤200 per request, comma-joined) to stay within
    /// the GET limit for direct efetch. The returned FASTA blocks are
    /// concatenated and trailing whitespace is trimmed to match gget, which
    /// strips one trailing blank line.
    pub async fn download_sequences(&self, accessions: &[String]) -> BioApiResult<String> {
        if accessions.is_empty() {
            return Err(BioApiError::InvalidInput(
                "Accession list cannot be empty".to_string(),
            ));
        }

        let mut fasta = String::new();
        for chunk in accessions.chunks(EFETCH_BATCH_SIZE) {
            let id_param = chunk.join(",");
            let block = self.efetch_fasta(&id_param).await?;
            if !block.trim().is_empty() {
                if !fasta.is_empty() && !fasta.ends_with('\n') {
                    fasta.push('\n');
                }
                fasta.push_str(&block);
            }
        }

        // gget strips one trailing blank line; trimming trailing whitespace is
        // a faithful superset for the no-trailing-newline contract.
        Ok(fasta.trim_end().to_string())
    }

    /// Fetch one batch of FASTA from efetch for a comma-joined id string.
    async fn efetch_fasta(&self, id_param: &str) -> BioApiResult<String> {
        self.rate_limiter.acquire().await;

        let mut query_params = vec![
            ("db", "nucleotide".to_string()),
            ("id", id_param.to_string()),
            ("rettype", "fasta".to_string()),
            ("retmode", "text".to_string()),
        ];
        if let Some(ref key) = self.api_key {
            query_params.push(("api_key", key.clone()));
        }

        self.retry_policy
            .execute("efetch_fasta", || {
                let params = query_params.clone();
                async move {
                    let response = self.client.get(EFETCH_URL).query(&params).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(
                                "efetch: sequences not found".to_string(),
                            ));
                        }
                        if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 60,
                            });
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("NCBI efetch error: {}", status),
                        });
                    }

                    let text = response.text().await?;
                    if text.trim_start().starts_with('>') || text.trim().is_empty() {
                        Ok(text)
                    } else {
                        // efetch returns plain-text error bodies with HTTP 200.
                        Err(BioApiError::InvalidResponse(format!(
                            "efetch returned non-FASTA body: {}",
                            text.chars().take(200).collect::<String>()
                        )))
                    }
                }
            })
            .await
    }

    /// Internal method to fetch virus data with pagination
    async fn fetch_virus_data(
        &self,
        base_url: &str,
        params: VirusQueryParams,
    ) -> BioApiResult<Vec<VirusRecord>> {
        let mut all_records = Vec::new();
        let mut page_token: Option<String> = None;
        let mut page_size = params.page_size.unwrap_or(MAX_PAGE_SIZE);

        loop {
            let response = self
                .fetch_page(base_url, &params, page_size, page_token.as_deref())
                .await;

            match response {
                Ok(page_response) => {
                    all_records.extend(page_response.reports);

                    // Check for more pages
                    page_token = page_response.next_page_token;
                    if page_token.is_none() {
                        break;
                    }
                }
                Err(e) if e.is_retryable() && page_size > MIN_PAGE_SIZE => {
                    // Fallback: reduce page size
                    page_size = (page_size - 50).max(MIN_PAGE_SIZE);
                    tracing::warn!(
                        "Fetch failed, reducing page_size to {} and retrying",
                        page_size
                    );
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        Ok(all_records)
    }

    /// Fetch a single page of virus data
    async fn fetch_page(
        &self,
        base_url: &str,
        params: &VirusQueryParams,
        page_size: u32,
        page_token: Option<&str>,
    ) -> BioApiResult<VirusPageResponse> {
        self.rate_limiter.acquire().await;

        let mut query_params = vec![("page_size", page_size.to_string())];

        if let Some(token) = page_token {
            query_params.push(("page_token", token.to_string()));
        }

        // Add filters
        if let Some(true) = params.refseq_only {
            query_params.push(("filter.refseq_only", "true".to_string()));
        }
        if let Some(true) = params.annotated_only {
            query_params.push(("filter.annotated_only", "true".to_string()));
        }
        if let Some(true) = params.complete_only {
            query_params.push(("filter.complete_only", "true".to_string()));
        }
        if let Some(ref host) = params.host {
            // Spaces become +, preserve literal + characters
            let host_encoded = host.replace(' ', "+");
            query_params.push(("filter.host", host_encoded));
        }
        if let Some(ref location) = params.geo_location {
            // Spaces become +, apostrophes become %27
            let location_encoded = location.replace(' ', "+").replace('\'', "%27");
            query_params.push(("filter.geo_location", location_encoded));
        }
        if let Some(ref date) = params.released_since {
            query_params.push(("filter.released_since", date.clone()));
        }

        if let Some(ref key) = self.api_key {
            query_params.push(("api_key", key.clone()));
        }

        let response = self
            .retry_policy
            .execute("fetch_virus_page", || {
                let url = base_url.to_string();
                let params = query_params.clone();
                async move {
                    let response = self.client.get(&url).query(&params).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound("Virus data not found".to_string()));
                        }
                        if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 60,
                            });
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("NCBI Virus API error: {}", status),
                        });
                    }

                    response
                        .json::<VirusPageResponse>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        Ok(response)
    }
}

impl Default for NcbiVirusClient {
    fn default() -> Self {
        Self::new(std::env::var("NCBI_API_KEY").ok())
    }
}

/// Query parameters for virus dataset
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VirusQueryParams {
    /// Maximum records per page (default 1000, max 1000)
    pub page_size: Option<u32>,
    /// Limit to RefSeq entries only
    pub refseq_only: Option<bool>,
    /// Limit to annotated sequences only
    pub annotated_only: Option<bool>,
    /// Limit to complete genomes only
    pub complete_only: Option<bool>,
    /// Filter by host organism (e.g., "Homo sapiens")
    pub host: Option<String>,
    /// Filter by geographic location (e.g., "USA: California")
    pub geo_location: Option<String>,
    /// Filter by release date (ISO format: YYYY-MM-DDTHH:MM:SS.sssZ)
    pub released_since: Option<String>,
}

/// Paginated response from NCBI Virus API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirusPageResponse {
    pub reports: Vec<VirusRecord>,
    #[serde(default)]
    pub total_count: Option<u64>,
    #[serde(default)]
    pub next_page_token: Option<String>,
}

/// NCBI Virus record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirusRecord {
    pub accession: String,
    #[serde(default)]
    pub length: Option<u32>,
    #[serde(rename = "geneCount", default)]
    pub gene_count: Option<u32>,
    #[serde(default)]
    pub completeness: Option<String>,
    #[serde(default)]
    pub virus: Option<VirusInfo>,
    #[serde(default)]
    pub host: Option<HostInfo>,
    #[serde(default)]
    pub isolate: Option<IsolateInfo>,
    #[serde(default)]
    pub location: Option<LocationInfo>,
    #[serde(rename = "releaseDate", default)]
    pub release_date: Option<String>,
    #[serde(rename = "isAnnotated", default)]
    pub is_annotated: Option<bool>,
    #[serde(rename = "sourceDatabase", default)]
    pub source_database: Option<String>,
    #[serde(rename = "isLabHost", default)]
    pub is_lab_host: Option<bool>,
    #[serde(rename = "proteinCount", default)]
    pub protein_count: Option<u32>,
    #[serde(rename = "maturePeptideCount", default)]
    pub mature_peptide_count: Option<u32>,
    #[serde(default)]
    pub segment: Option<String>,
    #[serde(rename = "isVaccineStrain", default)]
    pub is_vaccine_strain: Option<bool>,
    #[serde(default)]
    pub submitter: Option<SubmitterInfo>,
}

/// Virus taxonomy information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirusInfo {
    #[serde(rename = "organismName", default)]
    pub organism_name: Option<String>,
    #[serde(rename = "taxId", default)]
    pub tax_id: Option<u32>,
    #[serde(rename = "pangolinClassification", default)]
    pub pangolin_classification: Option<String>,
}

/// Host organism information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfo {
    #[serde(rename = "organismName", default)]
    pub organism_name: Option<String>,
    #[serde(rename = "taxId", default)]
    pub tax_id: Option<u32>,
}

/// Isolate metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IsolateInfo {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "collectionDate", default)]
    pub collection_date: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// Geographic location information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationInfo {
    #[serde(rename = "geographicLocation", default)]
    pub geographic_location: Option<String>,
    #[serde(rename = "geographicRegion", default)]
    pub geographic_region: Option<String>,
}

/// Submitter information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitterInfo {
    #[serde(default)]
    pub names: Option<Vec<String>>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub affiliation: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = NcbiVirusClient::new(None);
        assert!(client.api_key.is_none());
    }

    #[tokio::test]
    async fn test_client_with_api_key() {
        let client = NcbiVirusClient::new(Some("test_key".to_string()));
        assert!(client.api_key.is_some());
        assert_eq!(client.api_key.unwrap(), "test_key");
    }

    #[tokio::test]
    async fn test_default_client() {
        let client = NcbiVirusClient::default();
        // Should attempt to read NCBI_API_KEY from env
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_virus_query_params_default() {
        let params = VirusQueryParams::default();
        assert!(params.page_size.is_none());
        assert!(params.refseq_only.is_none());
        assert!(params.host.is_none());
    }

    #[test]
    fn test_virus_query_params_builder() {
        let params = VirusQueryParams {
            page_size: Some(500),
            refseq_only: Some(true),
            complete_only: Some(true),
            host: Some("Homo sapiens".to_string()),
            ..Default::default()
        };

        assert_eq!(params.page_size, Some(500));
        assert_eq!(params.refseq_only, Some(true));
        assert_eq!(params.complete_only, Some(true));
        assert_eq!(params.host, Some("Homo sapiens".to_string()));
    }

    #[test]
    fn test_virus_record_deserialization() {
        let json = r#"{
            "accession": "NC_045512.2",
            "length": 29903,
            "geneCount": 11,
            "completeness": "complete",
            "virus": {
                "organismName": "Severe acute respiratory syndrome coronavirus 2",
                "taxId": 2697049
            },
            "host": {
                "organismName": "Homo sapiens",
                "taxId": 9606
            },
            "isAnnotated": true,
            "sourceDatabase": "RefSeq"
        }"#;

        let record: Result<VirusRecord, _> = serde_json::from_str(json);
        assert!(record.is_ok());

        let record = record.unwrap();
        assert_eq!(record.accession, "NC_045512.2");
        assert_eq!(record.length, Some(29903));
        assert_eq!(record.gene_count, Some(11));
        assert_eq!(record.is_annotated, Some(true));

        let virus = record.virus.unwrap();
        assert_eq!(virus.tax_id, Some(2697049));

        let host = record.host.unwrap();
        assert_eq!(host.organism_name, Some("Homo sapiens".to_string()));
    }

    #[tokio::test]
    async fn test_empty_accessions_error() {
        let client = NcbiVirusClient::new(None);
        let params = VirusQueryParams::default();
        let result = client.fetch_by_accessions(&[], params).await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn test_empty_download_sequences_error() {
        let client = NcbiVirusClient::new(None);
        let result = client.download_sequences(&[]).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    /// LIVE: downloads the SARS-CoV-2 reference genome via efetch and checks
    /// the FASTA header and the ~29903 bp sequence length.
    /// Run with: `cargo test -p aos-bio-apis test_live_download_sars_cov2 -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn test_live_download_sars_cov2() {
        let client = NcbiVirusClient::new(std::env::var("NCBI_API_KEY").ok());
        let fasta = client
            .download_sequences(&["NC_045512.2".to_string()])
            .await
            .expect("efetch download should succeed");

        assert!(
            fasta.starts_with(">NC_045512.2 Severe acute respiratory syndrome coronavirus 2"),
            "unexpected header: {}",
            fasta.lines().next().unwrap_or("")
        );

        let bases: usize = fasta
            .lines()
            .skip(1)
            .filter(|l| !l.starts_with('>'))
            .map(|l| l.trim().len())
            .sum();
        assert!(
            (29900..=29906).contains(&bases),
            "unexpected base count: {bases}"
        );
        // gget contract: no trailing blank line.
        assert!(!fasta.ends_with('\n'));
        println!(
            "LIVE OK: header='{}' bases={}",
            fasta.lines().next().unwrap_or(""),
            bases
        );
    }
}
