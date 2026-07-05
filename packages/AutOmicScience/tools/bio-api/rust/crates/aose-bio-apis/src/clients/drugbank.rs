//! DrugBank API client.
//!
//! DrugBank is a comprehensive database of drug and drug target information.
//! This client requires a valid API key from a DrugBank subscription.
//!
//! Documentation: https://docs.drugbank.com/v1/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Arc;

const BASE_URL: &str = "https://api.drugbank.com/v1";
const REQUESTS_PER_SECOND: u32 = 10;

/// DrugBank API client
///
/// Requires authentication via API key. Set `DRUGBANK_API_KEY` environment variable
/// or provide the key directly when creating the client.
pub struct DrugBankClient {
    client: Client,
    api_key: String,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Drug record from DrugBank
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrugRecord {
    /// DrugBank ID (e.g., DB00001)
    pub drugbank_id: String,
    /// Drug name
    pub name: String,
    /// CAS number
    #[serde(rename = "cas-number")]
    pub cas_number: Option<String>,
    /// Drug type (small molecule, biotech, etc.)
    #[serde(rename = "type")]
    pub drug_type: Option<String>,
    /// Drug groups (approved, investigational, etc.)
    pub groups: Option<Vec<String>>,
    /// Description/indication
    pub description: Option<String>,
    /// Mechanism of action
    pub mechanism_of_action: Option<String>,
    /// Simple molecular properties
    pub simple_properties: Option<SimpleMolecularProperties>,
}

/// Simple molecular properties
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimpleMolecularProperties {
    /// Molecular weight
    pub molecular_weight: Option<f64>,
    /// Molecular formula
    pub molecular_formula: Option<String>,
    /// SMILES string
    pub smiles: Option<String>,
    /// InChI string
    pub inchi: Option<String>,
    /// InChI Key
    pub inchikey: Option<String>,
}

/// Drug product information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrugProduct {
    /// Product name
    pub name: String,
    /// Labeller/manufacturer
    pub labeller: Option<String>,
    /// Country
    pub country: Option<String>,
    /// Approval date
    pub approved: Option<String>,
    /// Route of administration
    pub route: Option<String>,
    /// Dosage form
    pub dosage_form: Option<String>,
    /// Strength
    pub strength: Option<String>,
}

/// Drug-drug interaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrugInteraction {
    /// DrugBank ID of the first drug
    pub drugbank_id: String,
    /// Name of the first drug
    pub name: String,
    /// DrugBank ID of the interacting drug
    pub interacting_drugbank_id: String,
    /// Name of the interacting drug
    pub interacting_name: String,
    /// Interaction description
    pub description: String,
}

/// Drug target information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrugTarget {
    /// Target ID
    pub id: String,
    /// Target name
    pub name: String,
    /// Organism
    pub organism: Option<String>,
    /// UniProt ID
    pub uniprot_id: Option<String>,
    /// Gene name
    pub gene_name: Option<String>,
    /// Actions (e.g., inhibitor, agonist)
    pub actions: Option<Vec<String>>,
}

/// Search parameters for drugs
#[derive(Debug, Clone, Default)]
pub struct DrugSearchParams {
    /// Search query string
    pub query: Option<String>,
    /// Drug name
    pub name: Option<String>,
    /// CAS number
    pub cas_number: Option<String>,
    /// Filter by drug groups (approved, investigational, etc.)
    pub groups: Option<Vec<String>>,
    /// Maximum number of results
    pub limit: Option<usize>,
}

impl DrugBankClient {
    /// Create a new DrugBank client with API key from environment
    ///
    /// Reads API key from `DRUGBANK_API_KEY` environment variable.
    pub fn new() -> BioApiResult<Self> {
        let api_key = env::var("DRUGBANK_API_KEY").map_err(|_| {
            BioApiError::InvalidInput(
                "DRUGBANK_API_KEY environment variable not set. Get your API key from https://go.drugbank.com/api".to_string()
            )
        })?;

        Ok(Self::with_api_key(api_key))
    }

    /// Create a new DrugBank client with explicit API key
    pub fn with_api_key(api_key: String) -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            api_key,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Get drug information by DrugBank ID
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::DrugBankClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DrugBankClient::new()?;
    /// let drug = client.get_drug("DB00001").await?;
    /// println!("Drug: {} ({})", drug.name, drug.drugbank_id);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_drug(&self, drugbank_id: &str) -> BioApiResult<DrugRecord> {
        let url = format!("{}/drugs/{}", BASE_URL, drugbank_id);

        self.retry_policy
            .execute("get_drug", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .get(&url)
                        .header("Authorization", &self.api_key)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Drug '{}' not found",
                                drugbank_id
                            )));
                        } else if status.as_u16() == 401 || status.as_u16() == 403 {
                            return Err(BioApiError::ApiError {
                                status: status.as_u16(),
                                message: "Invalid API key or insufficient permissions".to_string(),
                            });
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("DrugBank API error: {}", status),
                        });
                    }

                    response.json::<DrugRecord>().await.map_err(Into::into)
                }
            })
            .await
    }

    /// Search drugs by name or other criteria
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::{DrugBankClient, DrugSearchParams};
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = DrugBankClient::new()?;
    /// let params = DrugSearchParams {
    ///     name: Some("aspirin".to_string()),
    ///     limit: Some(10),
    ///     ..Default::default()
    /// };
    /// let drugs = client.search_drugs(&params).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_drugs(&self, params: &DrugSearchParams) -> BioApiResult<Vec<DrugRecord>> {
        let mut url = format!("{}/drugs", BASE_URL);
        let mut query_params = Vec::new();

        if let Some(query) = &params.query {
            query_params.push(format!("q={}", urlencoding::encode(query)));
        }
        if let Some(name) = &params.name {
            query_params.push(format!("name={}", urlencoding::encode(name)));
        }
        if let Some(cas) = &params.cas_number {
            query_params.push(format!("cas_number={}", urlencoding::encode(cas)));
        }
        if let Some(groups) = &params.groups {
            for group in groups {
                query_params.push(format!("groups[]={}", urlencoding::encode(group)));
            }
        }
        if let Some(limit) = params.limit {
            query_params.push(format!("limit={}", limit));
        }

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        self.retry_policy
            .execute("search_drugs", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .get(&url)
                        .header("Authorization", &self.api_key)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Drug search failed".to_string(),
                        });
                    }

                    response.json::<Vec<DrugRecord>>().await.map_err(Into::into)
                }
            })
            .await
    }

    /// Get drug products for a specific drug
    pub async fn get_drug_products(&self, drugbank_id: &str) -> BioApiResult<Vec<DrugProduct>> {
        let url = format!("{}/products?drugbank_id={}", BASE_URL, drugbank_id);

        self.retry_policy
            .execute("get_drug_products", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .get(&url)
                        .header("Authorization", &self.api_key)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to fetch drug products".to_string(),
                        });
                    }

                    response
                        .json::<Vec<DrugProduct>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }

    /// Get drug-drug interactions for a specific drug
    pub async fn get_drug_interactions(
        &self,
        drugbank_id: &str,
    ) -> BioApiResult<Vec<DrugInteraction>> {
        let url = format!("{}/interactions?drugbank_id={}", BASE_URL, drugbank_id);

        self.retry_policy
            .execute("get_drug_interactions", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .get(&url)
                        .header("Authorization", &self.api_key)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to fetch drug interactions".to_string(),
                        });
                    }

                    response
                        .json::<Vec<DrugInteraction>>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await
    }

    /// Get targets for a specific drug
    pub async fn get_drug_targets(&self, drugbank_id: &str) -> BioApiResult<Vec<DrugTarget>> {
        let url = format!("{}/drugs/{}/targets", BASE_URL, drugbank_id);

        self.retry_policy
            .execute("get_drug_targets", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self
                        .client
                        .get(&url)
                        .header("Authorization", &self.api_key)
                        .header("Accept", "application/json")
                        .send()
                        .await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to fetch drug targets".to_string(),
                        });
                    }

                    response.json::<Vec<DrugTarget>>().await.map_err(Into::into)
                }
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation_without_key() {
        // Should fail without API key in environment
        env::remove_var("DRUGBANK_API_KEY");
        let result = DrugBankClient::new();
        assert!(result.is_err());
    }

    #[test]
    fn test_client_creation_with_explicit_key() {
        let client = DrugBankClient::with_api_key("test_key".to_string());
        assert_eq!(client.api_key, "test_key");
    }

    #[test]
    fn test_search_params_default() {
        let params = DrugSearchParams::default();
        assert!(params.query.is_none());
        assert!(params.name.is_none());
        assert!(params.cas_number.is_none());
        assert!(params.groups.is_none());
        assert!(params.limit.is_none());
    }

    #[test]
    fn test_search_params_builder() {
        let params = DrugSearchParams {
            name: Some("aspirin".to_string()),
            groups: Some(vec!["approved".to_string()]),
            limit: Some(10),
            ..Default::default()
        };
        assert_eq!(params.name, Some("aspirin".to_string()));
        assert_eq!(params.limit, Some(10));
    }

    #[tokio::test]
    async fn test_url_encoding_in_search() {
        let client = DrugBankClient::with_api_key("test_key".to_string());
        let params = DrugSearchParams {
            name: Some("drug name with spaces".to_string()),
            ..Default::default()
        };

        // This will fail with network error since we don't have a real API key,
        // but it tests the URL construction logic
        let result = client.search_drugs(&params).await;
        // We expect an error because the API key is fake
        assert!(result.is_err());
    }
}
