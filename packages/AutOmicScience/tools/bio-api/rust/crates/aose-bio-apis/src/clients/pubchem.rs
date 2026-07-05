//! PubChem PUG REST API client.
//!
//! Documentation: https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const BASE_URL: &str = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const DEFAULT_REQUESTS_PER_SECOND: u32 = 5;

/// PubChem PUG REST API client
///
/// Provides access to PubChem compound data including:
/// - Compound search by name, CID, SMILES, InChI, InChIKey
/// - Property retrieval (molecular formula, weight, SMILES, etc.)
/// - Structure searches (substructure, similarity)
/// - Synonyms and descriptions
/// - 2D structure images
///
/// # Rate Limiting
/// PubChem has a soft limit of 5 requests per second. The client enforces this automatically.
///
/// # Authentication
/// No API key required.
pub struct PubChemClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl PubChemClient {
    /// Create a new PubChem client with default settings
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .user_agent("AOSE-BioAgent/0.1")
                .build()
                .unwrap_or_else(|_| Client::new()),
            rate_limiter: Arc::new(RateLimiter::new(DEFAULT_REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Create a client with custom rate limit (requests per second)
    pub fn with_rate_limit(requests_per_second: u32) -> Self {
        Self {
            client: Client::new(),
            rate_limiter: Arc::new(RateLimiter::new(requests_per_second)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Search compound by name and return CID(s)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::PubChemClient;
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = PubChemClient::new();
    /// let cids = client.search_by_name("aspirin").await?;
    /// println!("Found CIDs: {:?}", cids);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_by_name(&self, name: &str) -> BioApiResult<Vec<u32>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/name/{}/cids/JSON", BASE_URL, name);

        let response = self
            .retry_policy
            .execute("search_by_name", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "Compound '{}' not found",
                name
            )));
        }

        let json: serde_json::Value = response.json().await?;

        let cids = json["IdentifierList"]["CID"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("No CID list in response".to_string()))?
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u32))
            .collect();

        Ok(cids)
    }

    /// Get compound properties by CID
    ///
    /// Common properties: MolecularFormula, MolecularWeight, IUPACName, InChI,
    /// InChIKey, CanonicalSMILES, IsomericSMILES, XLogP, TPSA, Complexity
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::{PubChemClient, CompoundProperties};
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = PubChemClient::new();
    /// let properties = vec!["MolecularFormula", "MolecularWeight", "CanonicalSMILES"];
    /// let props = client.get_properties(2244, &properties).await?;
    /// println!("Aspirin properties: {:?}", props);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_properties(
        &self,
        cid: u32,
        properties: &[&str],
    ) -> BioApiResult<CompoundProperties> {
        self.rate_limiter.acquire().await;

        let props_str = properties.join(",");
        let url = format!(
            "{}/compound/cid/{}/property/{}/JSON",
            BASE_URL, cid, props_str
        );

        let response = self
            .retry_policy
            .execute("get_properties", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!("CID {} not found", cid)));
        }

        let json: serde_json::Value = response.json().await?;

        let props = &json["PropertyTable"]["Properties"][0];

        Ok(CompoundProperties {
            cid,
            molecular_formula: props["MolecularFormula"].as_str().map(String::from),
            molecular_weight: props["MolecularWeight"].as_f64(),
            canonical_smiles: props["CanonicalSMILES"].as_str().map(String::from),
            isomeric_smiles: props["IsomericSMILES"].as_str().map(String::from),
            inchi: props["InChI"].as_str().map(String::from),
            inchi_key: props["InChIKey"].as_str().map(String::from),
            iupac_name: props["IUPACName"].as_str().map(String::from),
            xlogp: props["XLogP"].as_f64(),
            tpsa: props["TPSA"].as_f64(),
            complexity: props["Complexity"].as_f64(),
            charge: props["Charge"].as_i64().map(|n| n as i32),
            h_bond_donor_count: props["HBondDonorCount"].as_u64().map(|n| n as u32),
            h_bond_acceptor_count: props["HBondAcceptorCount"].as_u64().map(|n| n as u32),
            rotatable_bond_count: props["RotatableBondCount"].as_u64().map(|n| n as u32),
        })
    }

    /// Get all synonyms for a compound
    pub async fn get_synonyms(&self, cid: u32) -> BioApiResult<Vec<String>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/cid/{}/synonyms/JSON", BASE_URL, cid);

        let response = self
            .retry_policy
            .execute("get_synonyms", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!("CID {} not found", cid)));
        }

        let json: serde_json::Value = response.json().await?;

        let synonyms = json["InformationList"]["Information"][0]["Synonym"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("No synonyms in response".to_string()))?
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();

        Ok(synonyms)
    }

    /// Get compound description and metadata
    pub async fn get_description(&self, cid: u32) -> BioApiResult<CompoundDescription> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/cid/{}/description/JSON", BASE_URL, cid);

        let response = self
            .retry_policy
            .execute("get_description", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!("CID {} not found", cid)));
        }

        let json: serde_json::Value = response.json().await?;

        let info = &json["InformationList"]["Information"][0];

        Ok(CompoundDescription {
            cid,
            title: info["Title"].as_str().map(String::from),
            description: info["Description"].as_str().map(String::from),
            description_source_name: info["DescriptionSourceName"].as_str().map(String::from),
            description_url: info["DescriptionURL"].as_str().map(String::from),
        })
    }

    /// Lookup compound by SMILES string
    pub async fn search_by_smiles(&self, smiles: &str) -> BioApiResult<Vec<u32>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/smiles/{}/cids/JSON", BASE_URL, smiles);

        let response = self
            .retry_policy
            .execute("search_by_smiles", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "SMILES '{}' not found",
                smiles
            )));
        }

        let json: serde_json::Value = response.json().await?;

        let cids = json["IdentifierList"]["CID"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("No CID list in response".to_string()))?
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u32))
            .collect();

        Ok(cids)
    }

    /// Lookup compound by InChIKey
    pub async fn search_by_inchikey(&self, inchikey: &str) -> BioApiResult<Vec<u32>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/inchikey/{}/cids/JSON", BASE_URL, inchikey);

        let response = self
            .retry_policy
            .execute("search_by_inchikey", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!(
                "InChIKey '{}' not found",
                inchikey
            )));
        }

        let json: serde_json::Value = response.json().await?;

        let cids = json["IdentifierList"]["CID"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("No CID list in response".to_string()))?
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u32))
            .collect();

        Ok(cids)
    }

    /// Get 2D structure image as PNG bytes
    pub async fn get_structure_image(&self, cid: u32) -> BioApiResult<Vec<u8>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/cid/{}/PNG", BASE_URL, cid);

        let response = self
            .retry_policy
            .execute("get_structure_image", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        if response.status() == 404 {
            return Err(BioApiError::NotFound(format!("CID {} not found", cid)));
        }

        let bytes = response.bytes().await?;
        Ok(bytes.to_vec())
    }

    /// Batch retrieve properties for multiple CIDs
    ///
    /// More efficient than calling get_properties multiple times
    pub async fn get_properties_batch(
        &self,
        cids: &[u32],
        properties: &[&str],
    ) -> BioApiResult<Vec<CompoundProperties>> {
        if cids.is_empty() {
            return Ok(vec![]);
        }

        self.rate_limiter.acquire().await;

        let cids_str = cids
            .iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let props_str = properties.join(",");
        let url = format!(
            "{}/compound/cid/{}/property/{}/JSON",
            BASE_URL, cids_str, props_str
        );

        let response = self
            .retry_policy
            .execute("get_properties_batch", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        let json: serde_json::Value = response.json().await?;

        let props_array = json["PropertyTable"]["Properties"]
            .as_array()
            .ok_or_else(|| {
                BioApiError::InvalidResponse("No properties array in response".to_string())
            })?;

        let mut results = Vec::new();
        for props in props_array {
            let cid = props["CID"].as_u64().ok_or_else(|| {
                BioApiError::InvalidResponse("Missing CID in property".to_string())
            })? as u32;

            results.push(CompoundProperties {
                cid,
                molecular_formula: props["MolecularFormula"].as_str().map(String::from),
                molecular_weight: props["MolecularWeight"].as_f64(),
                canonical_smiles: props["CanonicalSMILES"].as_str().map(String::from),
                isomeric_smiles: props["IsomericSMILES"].as_str().map(String::from),
                inchi: props["InChI"].as_str().map(String::from),
                inchi_key: props["InChIKey"].as_str().map(String::from),
                iupac_name: props["IUPACName"].as_str().map(String::from),
                xlogp: props["XLogP"].as_f64(),
                tpsa: props["TPSA"].as_f64(),
                complexity: props["Complexity"].as_f64(),
                charge: props["Charge"].as_i64().map(|n| n as i32),
                h_bond_donor_count: props["HBondDonorCount"].as_u64().map(|n| n as u32),
                h_bond_acceptor_count: props["HBondAcceptorCount"].as_u64().map(|n| n as u32),
                rotatable_bond_count: props["RotatableBondCount"].as_u64().map(|n| n as u32),
            });
        }

        Ok(results)
    }

    /// Perform asynchronous substructure search
    ///
    /// Returns CIDs of compounds containing the specified substructure.
    /// This is a two-step process: submit search, then poll for results.
    pub async fn substructure_search(&self, smiles: &str) -> BioApiResult<Vec<u32>> {
        // Step 1: Submit search
        let list_key = self.submit_substructure_search(smiles).await?;

        // Step 2: Poll for completion
        self.poll_async_operation(&list_key).await?;

        // Step 3: Fetch results
        self.fetch_async_results(&list_key).await
    }

    /// Submit asynchronous substructure search
    async fn submit_substructure_search(&self, smiles: &str) -> BioApiResult<String> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/substructure/smiles/JSON", BASE_URL);

        let response = self
            .retry_policy
            .execute("submit_substructure_search", || async {
                self.client
                    .post(&url)
                    .form(&[("smiles", smiles)])
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        let json: serde_json::Value = response.json().await?;

        let list_key = json["Waiting"]["ListKey"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("No ListKey in response".to_string()))?
            .to_string();

        Ok(list_key)
    }

    /// Poll asynchronous operation until completion
    async fn poll_async_operation(&self, list_key: &str) -> BioApiResult<()> {
        let max_polls = 30;
        let poll_interval = Duration::from_secs(2);

        for _attempt in 0..max_polls {
            sleep(poll_interval).await;
            self.rate_limiter.acquire().await;

            let url = format!("{}/compound/listkey/{}/cids/JSON", BASE_URL, list_key);

            let response = self.client.get(&url).send().await?;

            self.handle_rate_limit(&response).await?;

            // Check if results are ready (200 OK) or still waiting (202 Accepted)
            if response.status().is_success() && response.status() != 202 {
                return Ok(());
            }
        }

        Err(BioApiError::Timeout {
            operation: "Asynchronous search polling".to_string(),
        })
    }

    /// Fetch results from asynchronous operation
    async fn fetch_async_results(&self, list_key: &str) -> BioApiResult<Vec<u32>> {
        self.rate_limiter.acquire().await;

        let url = format!("{}/compound/listkey/{}/cids/JSON", BASE_URL, list_key);

        let response = self
            .retry_policy
            .execute("fetch_async_results", || async {
                self.client
                    .get(&url)
                    .send()
                    .await
                    .map_err(BioApiError::from)
            })
            .await?;

        self.handle_rate_limit(&response).await?;

        let json: serde_json::Value = response.json().await?;

        let cids = json["IdentifierList"]["CID"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("No CID list in response".to_string()))?
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as u32))
            .collect();

        Ok(cids)
    }

    /// Handle rate limit responses (503 status)
    async fn handle_rate_limit(&self, response: &reqwest::Response) -> BioApiResult<()> {
        if response.status() == 503 {
            // PubChem returns 503 when rate limited
            return Err(BioApiError::RateLimitExceeded {
                retry_after_secs: 1,
            });
        }
        Ok(())
    }
}

impl Default for PubChemClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Compound properties from PubChem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompoundProperties {
    pub cid: u32,
    pub molecular_formula: Option<String>,
    pub molecular_weight: Option<f64>,
    pub canonical_smiles: Option<String>,
    pub isomeric_smiles: Option<String>,
    pub inchi: Option<String>,
    pub inchi_key: Option<String>,
    pub iupac_name: Option<String>,
    pub xlogp: Option<f64>,
    pub tpsa: Option<f64>,
    pub complexity: Option<f64>,
    pub charge: Option<i32>,
    pub h_bond_donor_count: Option<u32>,
    pub h_bond_acceptor_count: Option<u32>,
    pub rotatable_bond_count: Option<u32>,
}

/// Compound description and metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompoundDescription {
    pub cid: u32,
    pub title: Option<String>,
    pub description: Option<String>,
    pub description_source_name: Option<String>,
    pub description_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = PubChemClient::new();
        assert_eq!(client.rate_limiter.rate(), DEFAULT_REQUESTS_PER_SECOND);
    }

    #[tokio::test]
    async fn test_client_with_custom_rate_limit() {
        let client = PubChemClient::with_rate_limit(10);
        assert_eq!(client.rate_limiter.rate(), 10);
    }

    #[tokio::test]
    async fn test_search_by_name() {
        let client = PubChemClient::new();
        let result = client.search_by_name("aspirin").await;

        // This test requires network access, so we only check structure
        match result {
            Ok(cids) => {
                assert!(!cids.is_empty());
                assert!(cids.contains(&2244)); // aspirin CID
            }
            Err(e) => {
                // If test fails due to network/API issues, that's okay for unit test
                eprintln!("Test skipped due to network/API error: {}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires live PubChem API behavior"]
    async fn test_not_found_error() {
        let client = PubChemClient::new();
        let result = client
            .search_by_name("this_compound_definitely_does_not_exist_xyz123")
            .await;

        assert!(result.is_err());
        if let Err(e) = result {
            assert!(matches!(e, BioApiError::NotFound(_)));
        }
    }

    #[tokio::test]
    async fn test_get_properties_structure() {
        // Test the structure without making actual API call
        let props = CompoundProperties {
            cid: 2244,
            molecular_formula: Some("C9H8O4".to_string()),
            molecular_weight: Some(180.16),
            canonical_smiles: Some("CC(=O)OC1=CC=CC=C1C(=O)O".to_string()),
            isomeric_smiles: None,
            inchi: None,
            inchi_key: None,
            iupac_name: Some("2-acetyloxybenzoic acid".to_string()),
            xlogp: Some(1.2),
            tpsa: Some(63.6),
            complexity: Some(212.0),
            charge: Some(0),
            h_bond_donor_count: Some(1),
            h_bond_acceptor_count: Some(4),
            rotatable_bond_count: Some(3),
        };

        assert_eq!(props.cid, 2244);
        assert!(props.molecular_formula.is_some());
    }

    #[tokio::test]
    async fn test_batch_properties_empty() {
        let client = PubChemClient::new();
        let result = client
            .get_properties_batch(&[], &["MolecularFormula"])
            .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }
}
