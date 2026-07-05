//! GWAS Catalog API client.
//!
//! Documentation: https://www.ebi.ac.uk/gwas/rest/docs/api

use crate::error::{BioApiError, BioApiResult};
use crate::models::{GwasAssociation, SnpInfo};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tracing::debug;

const BASE_URL: &str = "https://www.ebi.ac.uk/gwas/rest/api";
const REQUESTS_PER_SECOND: u32 = 10;

/// GWAS Catalog API client
pub struct GwasCatalogClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

#[derive(Debug, Deserialize)]
struct GwasApiResponse {
    #[serde(rename = "_embedded")]
    embedded: Option<EmbeddedContent>,
}

#[derive(Debug, Deserialize)]
struct EmbeddedContent {
    associations: Option<Vec<AssociationData>>,
    #[serde(rename = "singleNucleotidePolymorphisms")]
    #[allow(dead_code)]
    snps: Option<Vec<SnpData>>,
}

#[derive(Debug, Deserialize)]
struct AssociationData {
    #[serde(rename = "strongestAllele")]
    strongest_allele: Option<String>,
    #[serde(rename = "riskFrequency")]
    risk_frequency: Option<String>,
    #[serde(rename = "pvalueMantissa")]
    pvalue_mantissa: Option<f64>,
    #[serde(rename = "pvalueExponent")]
    pvalue_exponent: Option<i32>,
    #[serde(rename = "pvalueText")]
    pvalue_text: Option<String>,
    #[serde(rename = "orPerCopyNum")]
    or_per_copy_num: Option<f64>,
    #[serde(rename = "betaNum")]
    beta_num: Option<f64>,
    #[serde(rename = "betaUnit")]
    beta_unit: Option<String>,
    loci: Option<Vec<LocusData>>,
    #[serde(rename = "efoTraits")]
    efo_traits: Option<Vec<TraitData>>,
    study: Option<StudyData>,
}

#[derive(Debug, Deserialize)]
struct LocusData {
    #[serde(rename = "authorReportedGenes")]
    author_reported_genes: Option<Vec<GeneData>>,
    #[serde(rename = "strongestRiskAlleles")]
    strongest_risk_alleles: Option<Vec<RiskAlleleData>>,
}

#[derive(Debug, Deserialize)]
struct GeneData {
    #[serde(rename = "geneName")]
    gene_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RiskAlleleData {
    #[serde(rename = "riskAlleleName")]
    risk_allele_name: Option<String>,
    #[serde(rename = "snp")]
    snp: Option<SnpReference>,
}

#[derive(Debug, Deserialize)]
struct SnpReference {
    #[serde(rename = "rsId")]
    rs_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TraitData {
    trait_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StudyData {
    #[serde(rename = "publicationInfo")]
    publication_info: Option<PublicationData>,
}

#[derive(Debug, Deserialize)]
struct PublicationData {
    #[serde(rename = "pubmedId")]
    pubmed_id: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SnpData {
    #[serde(rename = "rsId")]
    rs_id: Option<String>,
    #[serde(rename = "merged")]
    merged: Option<i32>,
    locations: Option<Vec<LocationData>>,
    #[serde(rename = "functionalClass")]
    functional_class: Option<String>,
    #[serde(rename = "lastUpdateDate")]
    last_update_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LocationData {
    #[serde(rename = "chromosomeName")]
    chromosome_name: Option<String>,
    #[serde(rename = "chromosomePosition")]
    chromosome_position: Option<u64>,
    region: Option<RegionData>,
}

#[derive(Debug, Deserialize)]
struct RegionData {
    name: Option<String>,
}

impl GwasCatalogClient {
    /// Create a new GWAS Catalog client
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

    /// Create a client with custom retry policy
    pub fn with_retry_policy(retry_policy: RetryPolicy) -> Self {
        Self {
            client: Client::new(),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy,
        }
    }

    /// Search for trait associations
    pub async fn search_associations(
        &self,
        trait_name: &str,
    ) -> BioApiResult<Vec<GwasAssociation>> {
        self.get_trait_associations(trait_name).await
    }

    /// Get SNP information by rsID
    pub async fn get_snp_info(&self, rsid: &str) -> BioApiResult<SnpInfo> {
        let url = format!(
            "{}/singleNucleotidePolymorphisms/search/findByRsId?rsId={}",
            BASE_URL, rsid
        );
        let operation = format!("get_snp_info: {}", rsid);

        let snp_data = self
            .retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!("SNP '{}' not found", rsid)));
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let message = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }
                    }

                    let json: Value = response.json().await?;
                    Ok(json)
                }
            })
            .await?;

        self.parse_snp_info(&snp_data, rsid)
    }

    /// Get associations for a specific trait
    pub async fn get_trait_associations(
        &self,
        trait_name: &str,
    ) -> BioApiResult<Vec<GwasAssociation>> {
        let url = format!(
            "{}/associations/search/findByEfoTrait?efoTrait={}&size=100",
            BASE_URL,
            urlencoding::encode(trait_name)
        );
        let operation = format!("get_trait_associations: {}", trait_name);

        let json = self
            .retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Ok(Vec::new());
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let message = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }
                    }

                    let json: Value = response.json().await?;
                    let associations = self.parse_associations(&json)?;
                    Ok(associations)
                }
            })
            .await?;

        Ok(json)
    }

    /// Get associations for a specific gene
    pub async fn get_gene_associations(
        &self,
        gene_symbol: &str,
    ) -> BioApiResult<Vec<GwasAssociation>> {
        let url = format!(
            "{}/associations/search/findByGene?geneName={}&size=100",
            BASE_URL,
            urlencoding::encode(gene_symbol)
        );
        let operation = format!("get_gene_associations: {}", gene_symbol);

        let json = self
            .retry_policy
            .execute(&operation, || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    debug!("GET {}", url);
                    let response = self
                        .client
                        .get(&url)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Ok(Vec::new());
                        } else if status.as_u16() == 429 {
                            return Err(BioApiError::RateLimitExceeded {
                                retry_after_secs: 1,
                            });
                        } else {
                            let message = response.text().await.unwrap_or_default();
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message,
                            });
                        }
                    }

                    let json: Value = response.json().await?;
                    let associations = self.parse_associations(&json)?;
                    Ok(associations)
                }
            })
            .await?;

        Ok(json)
    }

    /// Parse association data from API response
    fn parse_associations(&self, json: &Value) -> BioApiResult<Vec<GwasAssociation>> {
        let response: GwasApiResponse = serde_json::from_value(json.clone()).map_err(|e| {
            BioApiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        let associations = response
            .embedded
            .and_then(|e| e.associations)
            .unwrap_or_default();

        let mut results = Vec::new();
        for assoc in associations {
            if let Some(parsed) = self.parse_association(&assoc) {
                results.push(parsed);
            }
        }

        Ok(results)
    }

    /// Parse a single association record
    fn parse_association(&self, data: &AssociationData) -> Option<GwasAssociation> {
        // Extract p-value
        let p_value = if let (Some(mantissa), Some(exponent)) =
            (data.pvalue_mantissa, data.pvalue_exponent)
        {
            mantissa * 10f64.powi(exponent)
        } else if let Some(text) = &data.pvalue_text {
            text.parse().ok()?
        } else {
            return None;
        };

        // Extract trait name
        let trait_name = data
            .efo_traits
            .as_ref()
            .and_then(|traits| traits.first())
            .and_then(|t| t.trait_name.clone())?;

        // Extract rsID and risk allele
        let (rsid, risk_allele) = data
            .loci
            .as_ref()
            .and_then(|loci| loci.first())
            .and_then(|locus| {
                locus.strongest_risk_alleles.as_ref().and_then(|alleles| {
                    alleles.first().and_then(|allele| {
                        let rsid = allele.snp.as_ref()?.rs_id.clone()?;
                        let risk = allele.risk_allele_name.clone();
                        Some((rsid, risk))
                    })
                })
            })
            .or_else(|| {
                data.strongest_allele.as_ref().map(|allele| {
                    // Parse format like "rs12345-A"
                    let parts: Vec<&str> = allele.split('-').collect();
                    if parts.len() == 2 {
                        (parts[0].to_string(), Some(parts[1].to_string()))
                    } else {
                        (allele.clone(), None)
                    }
                })
            })?;

        // Extract mapped genes
        let mapped_genes = data
            .loci
            .as_ref()
            .map(|loci| {
                loci.iter()
                    .flat_map(|locus| {
                        locus
                            .author_reported_genes
                            .as_ref()
                            .map(|genes| {
                                genes
                                    .iter()
                                    .filter_map(|g| g.gene_name.clone())
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Extract study info
        let study = data.study.as_ref().and_then(|s| {
            s.publication_info.as_ref().map(|p| {
                format!(
                    "PMID:{} - {}",
                    p.pubmed_id.as_deref().unwrap_or("unknown"),
                    p.title.as_deref().unwrap_or("No title")
                )
            })
        });

        Some(GwasAssociation {
            rsid,
            trait_name,
            p_value,
            risk_allele,
            mapped_genes,
            chromosome: None,
            position: None,
            study,
            or_value: data.or_per_copy_num,
            beta_value: data.beta_num,
            beta_unit: data.beta_unit.clone(),
            risk_frequency: data.risk_frequency.clone(),
        })
    }

    /// Parse SNP information
    fn parse_snp_info(&self, json: &Value, rsid: &str) -> BioApiResult<SnpInfo> {
        let snp_data: SnpData = serde_json::from_value(json.clone()).map_err(|e| {
            BioApiError::InvalidResponse(format!("Failed to parse SNP data: {}", e))
        })?;

        let location = snp_data.locations.and_then(|locs| locs.into_iter().next());

        Ok(SnpInfo {
            rsid: snp_data.rs_id.unwrap_or_else(|| rsid.to_string()),
            chromosome: location.as_ref().and_then(|l| l.chromosome_name.clone()),
            position: location.as_ref().and_then(|l| l.chromosome_position),
            functional_class: snp_data.functional_class,
            gene_region: location.and_then(|l| l.region.and_then(|r| r.name)),
            merged: snp_data.merged.unwrap_or(0),
            last_update: snp_data.last_update_date,
        })
    }
}

impl Default for GwasCatalogClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = GwasCatalogClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_parse_association() {
        let client = GwasCatalogClient::new();

        // Test with minimal data
        let data = AssociationData {
            strongest_allele: Some("rs123456-A".to_string()),
            risk_frequency: Some("0.45".to_string()),
            pvalue_mantissa: Some(5.0),
            pvalue_exponent: Some(-8),
            pvalue_text: None,
            or_per_copy_num: Some(1.2),
            beta_num: None,
            beta_unit: None,
            loci: None,
            efo_traits: Some(vec![TraitData {
                trait_name: Some("Type 2 diabetes".to_string()),
            }]),
            study: None,
        };

        let result = client.parse_association(&data);
        assert!(result.is_some());

        let assoc = result.unwrap();
        assert_eq!(assoc.rsid, "rs123456");
        assert_eq!(assoc.risk_allele, Some("A".to_string()));
        assert_eq!(assoc.trait_name, "Type 2 diabetes");
        assert!((assoc.p_value - 5e-8).abs() < 1e-10);
        assert_eq!(assoc.or_value, Some(1.2));
    }
}
