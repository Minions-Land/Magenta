//! gnomAD (Genome Aggregation Database) GraphQL API client.
//!
//! Documentation: https://gnomad.broadinstitute.org/api
//! Interactive explorer: https://gnomad.broadinstitute.org/api (GraphiQL interface)

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

const BASE_URL: &str = "https://gnomad.broadinstitute.org/api";
const REQUESTS_PER_SECOND: u32 = 10;

/// gnomAD API client
pub struct GnomadClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// gnomAD dataset identifiers
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum Dataset {
    /// gnomAD v4 (latest)
    #[serde(rename = "gnomad_r4")]
    #[default]
    GnomadR4,
    /// gnomAD v3
    #[serde(rename = "gnomad_r3")]
    GnomadR3,
    /// gnomAD v2.1
    #[serde(rename = "gnomad_r2_1")]
    GnomadR2_1,
    /// ExAC
    #[serde(rename = "exac")]
    Exac,
}

impl Dataset {
    pub fn as_str(&self) -> &'static str {
        match self {
            Dataset::GnomadR4 => "gnomad_r4",
            Dataset::GnomadR3 => "gnomad_r3",
            Dataset::GnomadR2_1 => "gnomad_r2_1",
            Dataset::Exac => "exac",
        }
    }
}

/// Reference genome identifiers
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum ReferenceGenome {
    /// GRCh38 (hg38)
    #[serde(rename = "GRCh38")]
    #[default]
    GRCh38,
    /// GRCh37 (hg19)
    #[serde(rename = "GRCh37")]
    GRCh37,
}

impl ReferenceGenome {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReferenceGenome::GRCh38 => "GRCh38",
            ReferenceGenome::GRCh37 => "GRCh37",
        }
    }
}

/// Population frequency data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopulationFrequency {
    /// Population ID (e.g., "afr", "eas", "nfe")
    pub id: String,
    /// Allele count
    pub ac: i64,
    /// Allele number (total chromosomes)
    pub an: i64,
    /// Allele frequency
    pub af: f64,
    /// Homozygote count
    pub ac_hom: Option<i64>,
}

/// Variant information from gnomAD
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    /// Variant ID (format: chrom-pos-ref-alt)
    pub variant_id: String,
    /// Chromosome
    pub chrom: String,
    /// Position
    pub pos: i64,
    /// Reference allele
    pub reference: String,
    /// Alternate allele
    pub alternate: String,
    /// rsID (if available)
    pub rsid: Option<String>,
    /// Overall allele count
    pub ac: i64,
    /// Overall allele number
    pub an: i64,
    /// Overall allele frequency
    pub af: f64,
    /// Homozygote count
    pub ac_hom: Option<i64>,
    /// Population-specific frequencies
    pub populations: Vec<PopulationFrequency>,
}

/// Gene information from gnomAD
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gene {
    /// Gene symbol
    pub symbol: String,
    /// Gene ID (Ensembl)
    pub gene_id: String,
    /// Chromosome
    pub chrom: String,
    /// Start position
    pub start: i64,
    /// Stop position
    pub stop: i64,
    /// Gene name
    pub name: Option<String>,
}

/// Region query parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionQuery {
    /// Chromosome
    pub chrom: String,
    /// Start position
    pub start: i64,
    /// Stop position
    pub stop: i64,
    /// Reference genome
    pub reference_genome: ReferenceGenome,
}

impl GnomadClient {
    /// Create a new gnomAD client
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

    /// Get variant by ID
    ///
    /// # Arguments
    /// * `variant_id` - Variant ID in format "chrom-pos-ref-alt" (e.g., "1-55051215-G-GA")
    /// * `dataset` - gnomAD dataset to query
    ///
    /// # Example
    /// ```no_run
    /// use aose_bio_apis::clients::gnomad::{GnomadClient, Dataset};
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = GnomadClient::new();
    /// let variant = client.get_variant("19-44908684-T-C", Dataset::GnomadR4).await?;
    /// println!("Allele frequency: {}", variant.af);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_variant(&self, variant_id: &str, dataset: Dataset) -> BioApiResult<Variant> {
        let query = format!(
            r#"{{
                variant(variantId: "{}", dataset: {}) {{
                    variant_id
                    chrom
                    pos
                    ref
                    alt
                    rsids
                    genome {{
                        ac
                        an
                        af
                        ac_hom
                        populations {{
                            id
                            ac
                            an
                            af
                            ac_hom
                        }}
                    }}
                }}
            }}"#,
            variant_id,
            dataset.as_str()
        );

        let json = self.graphql_query(&query).await?;

        let variant_data = json["data"]["variant"]
            .as_object()
            .ok_or_else(|| BioApiError::NotFound(format!("Variant {} not found", variant_id)))?;

        self.parse_variant(variant_data)
    }

    /// Search variants by rsID or other identifier
    pub async fn search_variant(
        &self,
        query: &str,
        dataset: Dataset,
    ) -> BioApiResult<Vec<Variant>> {
        let graphql_query = format!(
            r#"{{
                variant_search(query: "{}", dataset: {}) {{
                    variant_id
                    chrom
                    pos
                    ref
                    alt
                    rsids
                }}
            }}"#,
            query,
            dataset.as_str()
        );

        let json = self.graphql_query(&graphql_query).await?;

        let results = json["data"]["variant_search"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing search results".to_string()))?;

        let mut variants = Vec::new();
        for result in results {
            let variant_id = result["variant_id"]
                .as_str()
                .ok_or_else(|| BioApiError::InvalidResponse("Missing variant_id".to_string()))?;

            // Fetch full variant details
            match self.get_variant(variant_id, dataset).await {
                Ok(variant) => variants.push(variant),
                Err(_) => continue, // Skip variants that fail to fetch
            }
        }

        Ok(variants)
    }

    /// Get gene information by gene symbol
    pub async fn get_gene(
        &self,
        gene_symbol: &str,
        reference_genome: ReferenceGenome,
    ) -> BioApiResult<Gene> {
        let query = format!(
            r#"{{
                gene(gene_symbol: "{}", reference_genome: {}) {{
                    symbol
                    gene_id
                    chrom
                    start
                    stop
                    name
                }}
            }}"#,
            gene_symbol,
            reference_genome.as_str()
        );

        let json = self.graphql_query(&query).await?;

        let gene_data = json["data"]["gene"]
            .as_object()
            .ok_or_else(|| BioApiError::NotFound(format!("Gene {} not found", gene_symbol)))?;

        Ok(Gene {
            symbol: gene_data["symbol"]
                .as_str()
                .unwrap_or(gene_symbol)
                .to_string(),
            gene_id: gene_data["gene_id"].as_str().unwrap_or("").to_string(),
            chrom: gene_data["chrom"].as_str().unwrap_or("").to_string(),
            start: gene_data["start"].as_i64().unwrap_or(0),
            stop: gene_data["stop"].as_i64().unwrap_or(0),
            name: gene_data["name"].as_str().map(String::from),
        })
    }

    /// Query variants in a genomic region
    pub async fn query_region(
        &self,
        region: &RegionQuery,
        dataset: Dataset,
    ) -> BioApiResult<Vec<String>> {
        let query = format!(
            r#"{{
                region(
                    chrom: "{}",
                    start: {},
                    stop: {},
                    reference_genome: {}
                ) {{
                    variants(dataset: {}) {{
                        variant_id
                    }}
                }}
            }}"#,
            region.chrom,
            region.start,
            region.stop,
            region.reference_genome.as_str(),
            dataset.as_str()
        );

        let json = self.graphql_query(&query).await?;

        let variants = json["data"]["region"]["variants"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing region variants".to_string()))?;

        let variant_ids = variants
            .iter()
            .filter_map(|v| v["variant_id"].as_str().map(String::from))
            .collect();

        Ok(variant_ids)
    }

    /// Execute a GraphQL query
    async fn graphql_query(&self, query: &str) -> BioApiResult<Value> {
        let body = serde_json::json!({ "query": query });

        self.retry_policy
            .execute("gnomad_query", || {
                let body = body.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .post(BASE_URL)
                        .header("Content-Type", "application/json")
                        .json(&body)
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "gnomAD GraphQL query failed".to_string(),
                        });
                    }

                    let json: Value = response.json().await?;

                    // Check for GraphQL errors
                    if let Some(errors) = json.get("errors") {
                        return Err(BioApiError::InvalidResponse(format!(
                            "GraphQL errors: {}",
                            errors
                        )));
                    }

                    Ok(json)
                }
            })
            .await
    }

    /// Parse variant data from JSON
    fn parse_variant(&self, data: &serde_json::Map<String, Value>) -> BioApiResult<Variant> {
        let variant_id = data["variant_id"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing variant_id".to_string()))?
            .to_string();

        let chrom = data["chrom"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing chrom".to_string()))?
            .to_string();

        let pos = data["pos"]
            .as_i64()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing pos".to_string()))?;

        let reference = data["ref"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing ref".to_string()))?
            .to_string();

        let alternate = data["alt"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing alt".to_string()))?
            .to_string();

        let rsid = data["rsids"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .map(String::from);

        let genome = data["genome"]
            .as_object()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing genome data".to_string()))?;

        let ac = genome["ac"].as_i64().unwrap_or(0);
        let an = genome["an"].as_i64().unwrap_or(1);
        let af = genome["af"].as_f64().unwrap_or(0.0);
        let ac_hom = genome["ac_hom"].as_i64();

        let populations = genome["populations"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let id = p["id"].as_str()?.to_string();
                        let ac = p["ac"].as_i64().unwrap_or(0);
                        let an = p["an"].as_i64().unwrap_or(1);
                        let af = p["af"].as_f64().unwrap_or(0.0);
                        let ac_hom = p["ac_hom"].as_i64();

                        Some(PopulationFrequency {
                            id,
                            ac,
                            an,
                            af,
                            ac_hom,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(Variant {
            variant_id,
            chrom,
            pos,
            reference,
            alternate,
            rsid,
            ac,
            an,
            af,
            ac_hom,
            populations,
        })
    }
}

impl Default for GnomadClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = GnomadClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_dataset_serialization() {
        assert_eq!(Dataset::GnomadR4.as_str(), "gnomad_r4");
        assert_eq!(Dataset::GnomadR3.as_str(), "gnomad_r3");
        assert_eq!(Dataset::GnomadR2_1.as_str(), "gnomad_r2_1");
        assert_eq!(Dataset::Exac.as_str(), "exac");
    }

    #[test]
    fn test_reference_genome_serialization() {
        assert_eq!(ReferenceGenome::GRCh38.as_str(), "GRCh38");
        assert_eq!(ReferenceGenome::GRCh37.as_str(), "GRCh37");
    }

    #[test]
    fn test_default_values() {
        assert_eq!(Dataset::default(), Dataset::GnomadR4);
        assert_eq!(ReferenceGenome::default(), ReferenceGenome::GRCh38);
    }

    #[tokio::test]
    async fn test_variant_parsing() {
        let client = GnomadClient::new();
        let json_str = r#"{
            "variant_id": "1-55051215-G-GA",
            "chrom": "1",
            "pos": 55051215,
            "ref": "G",
            "alt": "GA",
            "rsids": ["rs12345"],
            "genome": {
                "ac": 100,
                "an": 1000,
                "af": 0.1,
                "ac_hom": 5,
                "populations": [
                    {
                        "id": "afr",
                        "ac": 20,
                        "an": 200,
                        "af": 0.1,
                        "ac_hom": 1
                    }
                ]
            }
        }"#;

        let data: serde_json::Map<String, Value> = serde_json::from_str(json_str).unwrap();
        let variant = client.parse_variant(&data).unwrap();

        assert_eq!(variant.variant_id, "1-55051215-G-GA");
        assert_eq!(variant.chrom, "1");
        assert_eq!(variant.pos, 55051215);
        assert_eq!(variant.reference, "G");
        assert_eq!(variant.alternate, "GA");
        assert_eq!(variant.rsid, Some("rs12345".to_string()));
        assert_eq!(variant.ac, 100);
        assert_eq!(variant.an, 1000);
        assert!((variant.af - 0.1).abs() < 1e-6);
        assert_eq!(variant.ac_hom, Some(5));
        assert_eq!(variant.populations.len(), 1);
        assert_eq!(variant.populations[0].id, "afr");
    }
}
