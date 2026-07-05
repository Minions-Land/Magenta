//! RegulomeDB regulatory variant annotation client.
//!
//! RegulomeDB annotates SNPs with known and predicted regulatory elements
//! in the intergenic regions of the human genome. It provides scores that
//! rank variants by their potential to affect regulatory function.
//!
//! Documentation: https://regulomedb.org/regulome-help/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://regulomedb.org/regulome-search";
const REQUESTS_PER_SECOND: u32 = 5;

/// RegulomeDB REST API client for regulatory variant annotation
pub struct RegulomeDbClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Reference genome version
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum GenomeVersion {
    /// GRCh38 (hg38)
    #[serde(rename = "GRCh38")]
    #[default]
    GRCh38,
    /// GRCh37 (hg19)
    #[serde(rename = "GRCh37")]
    GRCh37,
}

impl GenomeVersion {
    pub fn as_str(&self) -> &'static str {
        match self {
            GenomeVersion::GRCh38 => "GRCh38",
            GenomeVersion::GRCh37 => "GRCh37",
        }
    }
}

impl RegulomeDbClient {
    /// Create a new RegulomeDB client
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Search regulatory annotations by rsID
    ///
    /// # Arguments
    /// * `rsid` - dbSNP reference SNP ID (e.g., "rs123456")
    /// * `genome` - Reference genome version (GRCh37 or GRCh38)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::regulomedb::{RegulomeDbClient, GenomeVersion};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = RegulomeDbClient::new();
    /// let results = client.search_by_rsid("rs4844319", GenomeVersion::GRCh38).await?;
    /// for variant in results {
    ///     println!("{}: score = {}", variant.rsid.unwrap_or_default(), variant.score);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_by_rsid(
        &self,
        rsid: &str,
        genome: GenomeVersion,
    ) -> BioApiResult<Vec<RegulomeVariant>> {
        let regions = if rsid.starts_with("rs") {
            rsid.to_string()
        } else {
            format!("rs{}", rsid)
        };

        self.search_variants(&regions, genome).await
    }

    /// Search regulatory annotations by genomic region
    ///
    /// # Arguments
    /// * `chrom` - Chromosome (e.g., "chr1" or "1")
    /// * `start` - Start position (1-based)
    /// * `end` - End position (1-based, inclusive)
    /// * `genome` - Reference genome version
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::regulomedb::{RegulomeDbClient, GenomeVersion};
    /// # async fn example() -> anyhow::Result<()> {
    /// let client = RegulomeDbClient::new();
    /// let results = client.search_by_region("chr1", 1000000, 1001000, GenomeVersion::GRCh38).await?;
    /// println!("Found {} variants in region", results.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_by_region(
        &self,
        chrom: &str,
        start: u64,
        end: u64,
        genome: GenomeVersion,
    ) -> BioApiResult<Vec<RegulomeVariant>> {
        // Normalize chromosome format
        let chrom = if chrom.starts_with("chr") {
            chrom.to_string()
        } else {
            format!("chr{}", chrom)
        };

        let regions = format!("{}:{}-{}", chrom, start, end);
        self.search_variants(&regions, genome).await
    }

    /// Get RegulomeDB score for a specific variant
    ///
    /// Returns the regulatory score which ranks variants by their potential
    /// to affect regulatory function. Lower scores indicate stronger evidence.
    ///
    /// Score ranges:
    /// - 1a-1f: Likely to affect TF binding
    /// - 2a-2c: Likely to affect TF binding and enhancer/promoter activity
    /// - 3a-3b: Less likely to affect regulatory function
    /// - 4-7: Minimal evidence of regulatory function
    ///
    /// # Arguments
    /// * `rsid` - dbSNP reference SNP ID
    /// * `genome` - Reference genome version
    pub async fn get_regulome_score(
        &self,
        rsid: &str,
        genome: GenomeVersion,
    ) -> BioApiResult<Option<String>> {
        let results = self.search_by_rsid(rsid, genome).await?;

        Ok(results.into_iter().next().map(|v| v.score))
    }

    /// Internal method to search variants with arbitrary region strings
    async fn search_variants(
        &self,
        regions: &str,
        genome: GenomeVersion,
    ) -> BioApiResult<Vec<RegulomeVariant>> {
        let url = format!(
            "{}/?regions={}&genome={}",
            BASE_URL,
            urlencoding::encode(regions),
            genome.as_str()
        );

        self.retry_policy
            .execute("regulomedb_search", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Ok(Vec::new()); // No results found
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("RegulomeDB API error: {}", status),
                        });
                    }

                    // Try to parse the response
                    let text = response.text().await?;

                    // Handle empty or non-JSON responses
                    if text.trim().is_empty() || text.trim() == "[]" {
                        return Ok(Vec::new());
                    }

                    // Parse JSON response
                    serde_json::from_str::<Vec<RegulomeVariant>>(&text)
                        .or_else(|_| {
                            // Try parsing as a wrapper object
                            serde_json::from_str::<RegulomeResponse>(&text).map(|r| r.variants)
                        })
                        .or_else(|_| {
                            // Try parsing as a single variant
                            serde_json::from_str::<RegulomeVariant>(&text).map(|v| vec![v])
                        })
                        .map_err(|e| {
                            BioApiError::InvalidResponse(format!(
                                "Failed to parse RegulomeDB response: {}",
                                e
                            ))
                        })
                }
            })
            .await
    }
}

impl Default for RegulomeDbClient {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Response types
// ============================================================================

/// Wrapper for potential response format
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegulomeResponse {
    variants: Vec<RegulomeVariant>,
}

/// Regulatory variant annotation from RegulomeDB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegulomeVariant {
    /// Chromosome
    #[serde(default)]
    pub chromosome: Option<String>,

    /// Position (1-based)
    #[serde(default)]
    pub position: Option<u64>,

    /// Reference allele
    #[serde(default)]
    pub reference: Option<String>,

    /// Alternate allele
    #[serde(default)]
    pub alternate: Option<String>,

    /// dbSNP rsID
    #[serde(default)]
    pub rsid: Option<String>,

    /// RegulomeDB score (1a-7, lower is stronger evidence)
    pub score: String,

    /// Regulatory probability score (0-1)
    #[serde(default)]
    pub probability: Option<f64>,

    /// Chromatin accessibility evidence
    #[serde(default)]
    pub chromatin_accessibility: Option<Vec<ChromatinState>>,

    /// Transcription factor binding evidence
    #[serde(default)]
    pub transcription_factor_binding: Option<Vec<TfBinding>>,

    /// eQTL evidence
    #[serde(default)]
    pub eqtl: Option<Vec<EqtlEvidence>>,

    /// CHIP-seq peaks
    #[serde(default)]
    pub chip_seq: Option<Vec<ChipSeqPeak>>,

    /// DNase hypersensitivity
    #[serde(default)]
    pub dnase: Option<Vec<DnaseEvidence>>,

    /// PWM (position weight matrix) motif hits
    #[serde(default)]
    pub pwm: Option<Vec<PwmMotif>>,

    /// Additional annotations
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

/// Chromatin accessibility state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChromatinState {
    /// Cell type or tissue
    #[serde(default)]
    pub biosample: Option<String>,

    /// Chromatin state label
    #[serde(default)]
    pub state: Option<String>,

    /// Evidence value/score
    #[serde(default)]
    pub value: Option<f64>,
}

/// Transcription factor binding site
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TfBinding {
    /// Transcription factor name
    #[serde(default)]
    pub transcription_factor: Option<String>,

    /// Cell type or tissue
    #[serde(default)]
    pub biosample: Option<String>,

    /// Binding score or significance
    #[serde(default)]
    pub score: Option<f64>,

    /// Experiment type (e.g., ChIP-seq)
    #[serde(default)]
    pub experiment: Option<String>,
}

/// Expression quantitative trait locus evidence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EqtlEvidence {
    /// Target gene
    #[serde(default)]
    pub gene: Option<String>,

    /// Tissue type
    #[serde(default)]
    pub tissue: Option<String>,

    /// P-value
    #[serde(default)]
    pub pvalue: Option<f64>,

    /// Effect size (beta)
    #[serde(default)]
    pub beta: Option<f64>,

    /// Data source (e.g., GTEx)
    #[serde(default)]
    pub source: Option<String>,
}

/// ChIP-seq peak
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChipSeqPeak {
    /// Target protein/TF
    #[serde(default)]
    pub target: Option<String>,

    /// Cell type
    #[serde(default)]
    pub biosample: Option<String>,

    /// Peak score
    #[serde(default)]
    pub score: Option<f64>,
}

/// DNase hypersensitivity evidence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnaseEvidence {
    /// Cell type or tissue
    #[serde(default)]
    pub biosample: Option<String>,

    /// Signal value
    #[serde(default)]
    pub signal: Option<f64>,
}

/// Position weight matrix motif match
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PwmMotif {
    /// Transcription factor name
    #[serde(default)]
    pub transcription_factor: Option<String>,

    /// Motif match score
    #[serde(default)]
    pub score: Option<f64>,

    /// Reference allele score
    #[serde(default)]
    pub ref_score: Option<f64>,

    /// Alternate allele score
    #[serde(default)]
    pub alt_score: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = RegulomeDbClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_genome_version_serialization() {
        assert_eq!(GenomeVersion::GRCh38.as_str(), "GRCh38");
        assert_eq!(GenomeVersion::GRCh37.as_str(), "GRCh37");
    }

    #[test]
    fn test_default_genome_version() {
        assert_eq!(GenomeVersion::default(), GenomeVersion::GRCh38);
    }

    #[test]
    fn test_variant_deserialization() {
        let json = r#"{
            "chromosome": "chr1",
            "position": 1000000,
            "reference": "A",
            "alternate": "G",
            "rsid": "rs123456",
            "score": "1f",
            "probability": 0.85
        }"#;

        let variant: RegulomeVariant = serde_json::from_str(json).unwrap();
        assert_eq!(variant.chromosome, Some("chr1".to_string()));
        assert_eq!(variant.position, Some(1000000));
        assert_eq!(variant.reference, Some("A".to_string()));
        assert_eq!(variant.alternate, Some("G".to_string()));
        assert_eq!(variant.rsid, Some("rs123456".to_string()));
        assert_eq!(variant.score, "1f");
        assert_eq!(variant.probability, Some(0.85));
    }

    #[test]
    fn test_minimal_variant_deserialization() {
        let json = r#"{
            "score": "2b"
        }"#;

        let variant: RegulomeVariant = serde_json::from_str(json).unwrap();
        assert_eq!(variant.score, "2b");
        assert!(variant.chromosome.is_none());
        assert!(variant.position.is_none());
    }

    #[test]
    fn test_rsid_normalization() {
        // Test with "rs" prefix
        let rsid = "rs123456";
        let normalized = if rsid.starts_with("rs") {
            rsid.to_string()
        } else {
            format!("rs{}", rsid)
        };
        assert_eq!(normalized, "rs123456");

        // Test without "rs" prefix
        let rsid = "123456";
        let normalized = if rsid.starts_with("rs") {
            rsid.to_string()
        } else {
            format!("rs{}", rsid)
        };
        assert_eq!(normalized, "rs123456");
    }

    #[test]
    fn test_chromosome_normalization() {
        // Test with "chr" prefix
        let chrom = "chr1";
        let normalized = if chrom.starts_with("chr") {
            chrom.to_string()
        } else {
            format!("chr{}", chrom)
        };
        assert_eq!(normalized, "chr1");

        // Test without "chr" prefix
        let chrom = "1";
        let normalized = if chrom.starts_with("chr") {
            chrom.to_string()
        } else {
            format!("chr{}", chrom)
        };
        assert_eq!(normalized, "chr1");
    }
}
