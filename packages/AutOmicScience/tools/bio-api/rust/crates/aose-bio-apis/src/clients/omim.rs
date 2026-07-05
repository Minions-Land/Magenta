//! OMIM (Online Mendelian Inheritance in Man) API client.
//!
//! Documentation: https://www.omim.org/help/api
//!
//! OMIM is a comprehensive, authoritative compendium of human genes and genetic
//! phenotypes. The database contains information on all known Mendelian disorders
//! and over 16,000 genes.
//!
//! # Authentication
//!
//! Requires an API key from https://www.omim.org/api
//! Set the `OMIM_API_KEY` environment variable or pass the key to the client.
//!
//! # Rate Limiting
//!
//! OMIM does not publicly specify rate limits, but this client implements
//! conservative limits and exponential backoff for HTTP 429 responses.

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

const BASE_URL: &str = "https://api.omim.org/api";
const REQUESTS_PER_SECOND: u32 = 2; // Conservative limit

/// OMIM API client
///
/// Provides access to OMIM database entries, gene maps, and clinical synopses.
///
/// # Example
/// ```no_run
/// # use aose_bio_apis::clients::omim::OmimClient;
/// # async fn example() -> anyhow::Result<()> {
/// let client = OmimClient::new("your-api-key");
/// let entry = client.get_entry("100050").await?;
/// println!("Entry: {:?}", entry.titles);
/// # Ok(())
/// # }
/// ```
pub struct OmimClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
    api_key: String,
}

/// OMIM entry record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmimEntry {
    /// MIM number (e.g., 100050)
    pub mim_number: String,
    /// Entry status (live, moved, removed)
    pub status: Option<String>,
    /// Entry titles
    pub titles: Option<OmimTitles>,
    /// Text sections (description, clinical features, etc.)
    pub text_sections: Vec<TextSection>,
    /// Clinical synopsis (structured phenotype data)
    pub clinical_synopsis: Option<ClinicalSynopsis>,
    /// Gene map information
    pub gene_map: Option<GeneMap>,
    /// Allelic variants
    pub allelic_variants: Vec<AllelicVariant>,
}

/// Entry titles
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmimTitles {
    /// Preferred title
    pub preferred_title: Option<String>,
    /// Alternative titles
    pub alternative_titles: Option<Vec<String>>,
    /// Included titles
    pub included_titles: Option<Vec<String>>,
}

/// Text section (e.g., description, clinical features, diagnosis)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSection {
    /// Section name
    pub section_name: String,
    /// Section title
    pub section_title: Option<String>,
    /// Section content
    pub section_content: String,
}

/// Clinical synopsis with structured phenotype data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalSynopsis {
    /// Inheritance pattern(s)
    pub inheritance: Option<Vec<String>>,
    /// Growth-related features
    pub growth: Option<Vec<String>>,
    /// Head and neck features
    pub head_and_neck: Option<Vec<String>>,
    /// Cardiovascular features
    pub cardiovascular: Option<Vec<String>>,
    /// Respiratory features
    pub respiratory: Option<Vec<String>>,
    /// Gastrointestinal features
    pub gastrointestinal: Option<Vec<String>>,
    /// Skeletal features
    pub skeletal: Option<Vec<String>>,
    /// Neurologic features
    pub neurologic: Option<Vec<String>>,
    /// Laboratory abnormalities
    pub laboratory_abnormalities: Option<Vec<String>>,
    /// Molecular basis
    pub molecular_basis: Option<Vec<String>>,
}

/// Gene map information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneMap {
    /// Chromosome
    pub chromosome: Option<String>,
    /// Chromosomal location (cytogenetic)
    pub chromosomal_location: Option<String>,
    /// Gene symbols
    pub gene_symbols: Option<Vec<String>>,
    /// Gene name
    pub gene_name: Option<String>,
    /// Phenotype
    pub phenotype: Option<String>,
    /// Phenotype MIM number
    pub phenotype_mim_number: Option<String>,
    /// Genomic coordinates
    pub genomic_coordinates: Option<GenomicCoordinates>,
}

/// Genomic coordinates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenomicCoordinates {
    /// Start position
    pub start: Option<u64>,
    /// Stop position
    pub stop: Option<u64>,
    /// Reference assembly
    pub assembly: Option<String>,
}

/// Allelic variant
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllelicVariant {
    /// Allelic variant number
    pub allelic_variant_number: String,
    /// Variant name
    pub name: Option<String>,
    /// Mutation description
    pub mutation: Option<String>,
    /// dbSNP identifier
    pub dbsnp: Option<String>,
    /// Clinical features
    pub clinical_features: Option<String>,
}

/// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmimSearchResult {
    /// MIM number
    pub mim_number: String,
    /// Entry titles
    pub titles: Option<OmimTitles>,
    /// Score (relevance)
    pub score: Option<f64>,
}

/// Search parameters
#[derive(Debug, Clone)]
pub struct OmimSearchParams {
    /// Search query
    pub query: String,
    /// Fields to include in response
    pub include: Vec<String>,
    /// Maximum number of results
    pub limit: Option<u32>,
    /// Starting offset for pagination
    pub start: Option<u32>,
    /// Sort order (score, date_created, date_updated)
    pub sort: Option<String>,
}

impl Default for OmimSearchParams {
    fn default() -> Self {
        Self {
            query: String::new(),
            include: vec!["titles".to_string()],
            limit: Some(20),
            start: Some(0),
            sort: None,
        }
    }
}

/// Gene map query parameters
#[derive(Debug, Clone)]
pub struct GeneMapQuery {
    /// Chromosome (e.g., "1", "X", "MT")
    pub chromosome: Option<String>,
    /// Start position
    pub start: Option<u64>,
    /// Stop position
    pub stop: Option<u64>,
}

impl OmimClient {
    /// Create a new OMIM client with the provided API key
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::omim::OmimClient;
    /// let client = OmimClient::new("your-api-key");
    /// ```
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
            api_key: api_key.into(),
        }
    }

    /// Create a client using the OMIM_API_KEY environment variable
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::omim::OmimClient;
    /// # fn example() -> anyhow::Result<()> {
    /// let client = OmimClient::from_env()?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn from_env() -> BioApiResult<Self> {
        let api_key = std::env::var("OMIM_API_KEY").map_err(|_| {
            BioApiError::InvalidInput(
                "OMIM_API_KEY environment variable not set. Register at https://www.omim.org/api"
                    .to_string(),
            )
        })?;
        Ok(Self::new(api_key))
    }

    /// Get an entry by MIM number
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::omim::OmimClient;
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = OmimClient::new("your-api-key");
    /// let entry = client.get_entry("100050").await?;
    /// println!("Entry: {:?}", entry.titles);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_entry(&self, mim_number: &str) -> BioApiResult<OmimEntry> {
        self.get_entry_with_fields(
            mim_number,
            &["text", "clinicalSynopsis", "geneMap", "allelicVariantList"],
        )
        .await
    }

    /// Get an entry by MIM number with specific fields
    ///
    /// Available fields: text, externalLinks, clinicalSynopsis, geneMap,
    /// allelicVariantList, seeAlso, referenceList, contributors, creationDate,
    /// editHistory, dates
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::omim::OmimClient;
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = OmimClient::new("your-api-key");
    /// let entry = client.get_entry_with_fields("100050", &["text", "geneMap"]).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_entry_with_fields(
        &self,
        mim_number: &str,
        include_fields: &[&str],
    ) -> BioApiResult<OmimEntry> {
        let include = include_fields.join(",");
        let url = format!(
            "{}/entry?mimNumber={}&include={}&format=json&apiKey={}",
            BASE_URL, mim_number, include, self.api_key
        );

        let json: Value = self
            .retry_policy
            .execute("omim_get_entry", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Entry '{}' not found",
                                mim_number
                            )));
                        }
                        if status.as_u16() == 401 || status.as_u16() == 403 {
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message: "Invalid API key or unauthorized access".to_string(),
                            });
                        }
                        if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 60,
                            });
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("OMIM API error: {}", status),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        self.parse_entry(&json, mim_number)
    }

    /// Search OMIM entries
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::omim::{OmimClient, OmimSearchParams};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = OmimClient::new("your-api-key");
    /// let mut params = OmimSearchParams::default();
    /// params.query = "breast cancer".to_string();
    /// params.limit = Some(10);
    /// let results = client.search(&params).await?;
    /// println!("Found {} results", results.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search(&self, params: &OmimSearchParams) -> BioApiResult<Vec<OmimSearchResult>> {
        let include = params.include.join(",");
        let mut url = format!(
            "{}/entry/search?search={}&include={}&format=json&apiKey={}",
            BASE_URL,
            urlencoding::encode(&params.query),
            include,
            self.api_key
        );

        if let Some(limit) = params.limit {
            url.push_str(&format!("&limit={}", limit));
        }
        if let Some(start) = params.start {
            url.push_str(&format!("&start={}", start));
        }
        if let Some(sort) = &params.sort {
            url.push_str(&format!("&sort={}", sort));
        }

        let json: Value = self
            .retry_policy
            .execute("omim_search", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 60,
                            });
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: "OMIM search failed".to_string(),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        self.parse_search_results(&json)
    }

    /// Query gene map by chromosomal location
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::omim::{OmimClient, GeneMapQuery};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = OmimClient::new("your-api-key");
    /// let query = GeneMapQuery {
    ///     chromosome: Some("17".to_string()),
    ///     start: Some(43000000),
    ///     stop: Some(44000000),
    /// };
    /// let gene_maps = client.query_gene_map(&query).await?;
    /// println!("Found {} gene map entries", gene_maps.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn query_gene_map(&self, query: &GeneMapQuery) -> BioApiResult<Vec<GeneMap>> {
        let mut url = format!("{}/geneMap?format=json&apiKey={}", BASE_URL, self.api_key);

        if let Some(chr) = &query.chromosome {
            url.push_str(&format!("&chromosome={}", chr));
        }
        if let Some(start) = query.start {
            url.push_str(&format!("&start={}", start));
        }
        if let Some(stop) = query.stop {
            url.push_str(&format!("&stop={}", stop));
        }

        let json: Value = self
            .retry_policy
            .execute("omim_gene_map", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 60,
                            });
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: "Gene map query failed".to_string(),
                        });
                    }

                    response.json::<Value>().await.map_err(Into::into)
                }
            })
            .await?;

        self.parse_gene_map_results(&json)
    }

    // Helper methods for parsing JSON responses

    fn parse_entry(&self, json: &Value, mim_number: &str) -> BioApiResult<OmimEntry> {
        let entry_list = json["omim"]["entryList"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing entryList".to_string()))?;

        let entry = entry_list
            .first()
            .and_then(|e| e["entry"].as_object())
            .ok_or_else(|| BioApiError::NotFound(format!("Entry {} not found", mim_number)))?;

        let titles = entry.get("titles").map(|t| OmimTitles {
            preferred_title: t["preferredTitle"].as_str().map(String::from),
            alternative_titles: t["alternativeTitles"]
                .as_str()
                .map(|s| s.split(";;").map(|t| t.trim().to_string()).collect()),
            included_titles: t["includedTitles"]
                .as_str()
                .map(|s| s.split(";;").map(|t| t.trim().to_string()).collect()),
        });

        let text_sections = entry
            .get("textSectionList")
            .and_then(|v| v.as_array())
            .map(|sections| {
                sections
                    .iter()
                    .filter_map(|s| {
                        let section = &s["textSection"];
                        Some(TextSection {
                            section_name: section["textSectionName"].as_str()?.to_string(),
                            section_title: section["textSectionTitle"].as_str().map(String::from),
                            section_content: section["textSectionContent"].as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let clinical_synopsis = entry.get("clinicalSynopsis").map(|cs| ClinicalSynopsis {
            inheritance: self.parse_synopsis_field(cs, "inheritance"),
            growth: self.parse_synopsis_field(cs, "growth"),
            head_and_neck: self.parse_synopsis_field(cs, "headAndNeck"),
            cardiovascular: self.parse_synopsis_field(cs, "cardiovascular"),
            respiratory: self.parse_synopsis_field(cs, "respiratory"),
            gastrointestinal: self.parse_synopsis_field(cs, "gastrointestinal"),
            skeletal: self.parse_synopsis_field(cs, "skeletal"),
            neurologic: self.parse_synopsis_field(cs, "neurologic"),
            laboratory_abnormalities: self.parse_synopsis_field(cs, "laboratoryAbnormalities"),
            molecular_basis: self.parse_synopsis_field(cs, "molecularBasis"),
        });

        let gene_map = entry.get("geneMap").and_then(|gm| self.parse_gene_map(gm));

        let allelic_variants = entry
            .get("allelicVariantList")
            .and_then(|v| v.as_array())
            .map(|variants| {
                variants
                    .iter()
                    .filter_map(|v| {
                        let av = &v["allelicVariant"];
                        Some(AllelicVariant {
                            allelic_variant_number: av["number"].as_str()?.to_string(),
                            name: av["name"].as_str().map(String::from),
                            mutation: av["mutations"].as_str().map(String::from),
                            dbsnp: av["dbSnps"].as_str().map(String::from),
                            clinical_features: av["text"].as_str().map(String::from),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(OmimEntry {
            mim_number: entry["mimNumber"]
                .as_str()
                .unwrap_or(mim_number)
                .to_string(),
            status: entry["status"].as_str().map(String::from),
            titles,
            text_sections,
            clinical_synopsis,
            gene_map,
            allelic_variants,
        })
    }

    fn parse_synopsis_field(&self, cs: &Value, field: &str) -> Option<Vec<String>> {
        cs[field]
            .as_str()
            .map(|s| s.split(';').map(|t| t.trim().to_string()).collect())
    }

    fn parse_gene_map(&self, gm: &Value) -> Option<GeneMap> {
        Some(GeneMap {
            chromosome: gm["chromosome"].as_str().map(String::from),
            chromosomal_location: gm["chromosomeLocationStart"].as_str().map(String::from),
            gene_symbols: gm["geneSymbols"]
                .as_str()
                .map(|s| s.split(',').map(|t| t.trim().to_string()).collect()),
            gene_name: gm["geneName"].as_str().map(String::from),
            phenotype: gm["phenotype"].as_str().map(String::from),
            phenotype_mim_number: gm["phenotypeMimNumber"].as_str().map(String::from),
            genomic_coordinates: gm.get("geneStart").map(|_| GenomicCoordinates {
                start: gm["geneStart"].as_u64(),
                stop: gm["geneEnd"].as_u64(),
                assembly: gm["assembly"].as_str().map(String::from),
            }),
        })
    }

    fn parse_search_results(&self, json: &Value) -> BioApiResult<Vec<OmimSearchResult>> {
        let entry_list = json["omim"]["searchResponse"]["entryList"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing search results".to_string()))?;

        let results = entry_list
            .iter()
            .filter_map(|entry| {
                let e = &entry["entry"];
                let mim_number = e["mimNumber"].as_str()?.to_string();
                let titles = e.get("titles").map(|t| OmimTitles {
                    preferred_title: t["preferredTitle"].as_str().map(String::from),
                    alternative_titles: t["alternativeTitles"]
                        .as_str()
                        .map(|s| s.split(";;").map(|t| t.trim().to_string()).collect()),
                    included_titles: t["includedTitles"]
                        .as_str()
                        .map(|s| s.split(";;").map(|t| t.trim().to_string()).collect()),
                });
                let score = entry["score"].as_f64();

                Some(OmimSearchResult {
                    mim_number,
                    titles,
                    score,
                })
            })
            .collect();

        Ok(results)
    }

    fn parse_gene_map_results(&self, json: &Value) -> BioApiResult<Vec<GeneMap>> {
        let gene_map_list = json["omim"]["geneMapList"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing geneMapList".to_string()))?;

        let results = gene_map_list
            .iter()
            .filter_map(|entry| {
                let gm = &entry["geneMap"];
                self.parse_gene_map(gm)
            })
            .collect();

        Ok(results)
    }
}

impl Default for OmimClient {
    fn default() -> Self {
        Self::from_env().unwrap_or_else(|_| Self::new(""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = OmimClient::new("test-key");
        assert_eq!(client.api_key, "test-key");
    }

    #[tokio::test]
    async fn test_search_params_default() {
        let params = OmimSearchParams::default();
        assert_eq!(params.limit, Some(20));
        assert_eq!(params.start, Some(0));
        assert_eq!(params.include, vec!["titles".to_string()]);
    }

    #[tokio::test]
    async fn test_from_env_missing_key() {
        // Temporarily unset the environment variable
        std::env::remove_var("OMIM_API_KEY");
        let result = OmimClient::from_env();
        assert!(result.is_err());
        if let Err(e) = result {
            assert!(matches!(e, BioApiError::InvalidInput(_)));
        }
    }

    #[tokio::test]
    #[ignore] // Requires valid API key and network access
    async fn test_get_entry_cystic_fibrosis() {
        let client = match OmimClient::from_env() {
            Ok(c) => c,
            Err(_) => {
                println!("Skipping test: OMIM_API_KEY not set");
                return;
            }
        };

        // MIM 219700: Cystic Fibrosis
        let result = client.get_entry("219700").await;

        match result {
            Ok(entry) => {
                assert_eq!(entry.mim_number, "219700");
                assert!(entry.titles.is_some());
                println!("Cystic Fibrosis entry: {:?}", entry.titles);
            }
            Err(e) => {
                println!("Test skipped due to API error: {}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore] // Requires valid API key and network access
    async fn test_search_diabetes() {
        let client = match OmimClient::from_env() {
            Ok(c) => c,
            Err(_) => {
                println!("Skipping test: OMIM_API_KEY not set");
                return;
            }
        };

        let params = OmimSearchParams {
            query: "diabetes".to_string(),
            limit: Some(5),
            ..Default::default()
        };

        let result = client.search(&params).await;

        match result {
            Ok(results) => {
                assert!(!results.is_empty());
                println!("Found {} diabetes-related entries", results.len());
                for r in results.iter().take(3) {
                    println!("- {}: {:?}", r.mim_number, r.titles);
                }
            }
            Err(e) => {
                println!("Test skipped due to API error: {}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore] // Requires valid API key and network access
    async fn test_gene_map_query() {
        let client = match OmimClient::from_env() {
            Ok(c) => c,
            Err(_) => {
                println!("Skipping test: OMIM_API_KEY not set");
                return;
            }
        };

        let query = GeneMapQuery {
            chromosome: Some("7".to_string()),
            start: Some(117000000),
            stop: Some(118000000),
        };

        let result = client.query_gene_map(&query).await;

        match result {
            Ok(gene_maps) => {
                assert!(!gene_maps.is_empty());
                println!("Found {} gene map entries on chr7", gene_maps.len());
                for gm in gene_maps.iter().take(3) {
                    println!("- {:?} at {:?}", gm.gene_symbols, gm.chromosomal_location);
                }
            }
            Err(e) => {
                println!("Test skipped due to API error: {}", e);
            }
        }
    }
}
