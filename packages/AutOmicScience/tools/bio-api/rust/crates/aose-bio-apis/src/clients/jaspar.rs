//! JASPAR transcription factor binding site database API client.
//!
//! Documentation: https://jaspar.elixir.no/api/v1/docs/

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://jaspar.elixir.no/api/v1";
const REQUESTS_PER_SECOND: u32 = 10;

/// JASPAR API client for transcription factor binding site data
pub struct JasparClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// Transcription factor position frequency matrix
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TfMatrix {
    /// Matrix ID (e.g., "MA0139.1")
    pub matrix_id: String,
    /// Transcription factor name
    pub name: String,
    /// TF family classification
    pub family: Option<String>,
    /// Species (NCBI taxonomy ID)
    pub species: Vec<TaxonomyInfo>,
    /// Matrix class (e.g., "PFM" for position frequency matrix)
    pub class_type: Option<String>,
    /// Position frequency matrix: A, C, G, T rows
    pub matrix: Option<Vec<Vec<f64>>>,
    /// Collection (e.g., "CORE")
    pub collection: Option<String>,
    /// Version
    pub version: Option<i32>,
}

/// Species taxonomy information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxonomyInfo {
    /// NCBI taxonomy ID
    pub tax_id: String,
    /// Scientific name
    pub name: Option<String>,
}

/// JASPAR species entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Species {
    /// NCBI taxonomy ID
    pub tax_id: String,
    /// Scientific name
    pub name: String,
    /// Common name
    pub common_name: Option<String>,
}

/// Matrix search filters
#[derive(Debug, Clone, Default)]
pub struct MatrixSearchParams {
    /// TF name keyword
    pub name: Option<String>,
    /// Species taxonomy ID (e.g., "9606" for human)
    pub species: Option<String>,
    /// TF family (e.g., "bZIP", "Homeodomain")
    pub tf_family: Option<String>,
    /// Collection (e.g., "CORE", "UNVALIDATED")
    pub collection: Option<String>,
    /// Matrix class
    pub class_type: Option<String>,
    /// Maximum results
    pub limit: Option<u32>,
}

impl JasparClient {
    /// Create a new JASPAR client
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

    /// Get transcription factor matrix by ID
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::jaspar::JasparClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = JasparClient::new();
    /// let matrix = client.get_matrix("MA0139.1").await?;
    /// println!("TF: {}, Species: {:?}", matrix.name, matrix.species);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get_matrix(&self, matrix_id: &str) -> BioApiResult<TfMatrix> {
        let url = format!("{}/matrix/{}/", BASE_URL, matrix_id);

        let json: serde_json::Value = self
            .retry_policy
            .execute("get_matrix", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Matrix '{}' not found",
                                matrix_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("JASPAR API error: {}", status),
                        });
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        self.parse_matrix(json)
    }

    /// Search matrices by name, species, family, etc.
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::jaspar::{JasparClient, MatrixSearchParams};
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// # let client = JasparClient::new();
    /// let params = MatrixSearchParams {
    ///     species: Some("9606".to_string()),  // human
    ///     tf_family: Some("bZIP".to_string()),
    ///     limit: Some(10),
    ///     ..Default::default()
    /// };
    /// let matrices = client.search_matrices(&params).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn search_matrices(
        &self,
        params: &MatrixSearchParams,
    ) -> BioApiResult<Vec<TfMatrix>> {
        let mut url = format!("{}/matrix/", BASE_URL);
        let mut query_params = Vec::new();

        if let Some(name) = &params.name {
            query_params.push(format!("name={}", urlencoding::encode(name)));
        }
        if let Some(species) = &params.species {
            query_params.push(format!("species={}", species));
        }
        if let Some(tf_family) = &params.tf_family {
            query_params.push(format!("tf_family={}", urlencoding::encode(tf_family)));
        }
        if let Some(collection) = &params.collection {
            query_params.push(format!("collection={}", urlencoding::encode(collection)));
        }
        if let Some(class_type) = &params.class_type {
            query_params.push(format!("type={}", urlencoding::encode(class_type)));
        }
        if let Some(limit) = params.limit {
            query_params.push(format!("page_size={}", limit));
        }

        if !query_params.is_empty() {
            url.push('?');
            url.push_str(&query_params.join("&"));
        }

        let json: serde_json::Value = self
            .retry_policy
            .execute("search_matrices", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Matrix search failed".to_string(),
                        });
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        // Parse results array
        let results = json["results"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing results array".to_string()))?;

        let mut matrices = Vec::new();
        for result in results {
            match self.parse_matrix(result.clone()) {
                Ok(matrix) => matrices.push(matrix),
                Err(e) => {
                    eprintln!("Warning: Failed to parse matrix: {}", e);
                    continue;
                }
            }
        }

        Ok(matrices)
    }

    /// List all available species in JASPAR
    pub async fn list_species(&self) -> BioApiResult<Vec<Species>> {
        let url = format!("{}/species/", BASE_URL);

        let json: serde_json::Value = self
            .retry_policy
            .execute("list_species", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Species list request failed".to_string(),
                        });
                    }

                    response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(Into::into)
                }
            })
            .await?;

        // Parse species array
        let species_array = json
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Expected array of species".to_string()))?;

        let mut species_list = Vec::new();
        for sp in species_array {
            let tax_id = sp["tax_id"]
                .as_str()
                .or_else(|| {
                    sp["tax_id"].as_i64().map(|n| {
                        // Store as string in temporary
                        Box::leak(Box::new(n.to_string())).as_str()
                    })
                })
                .ok_or_else(|| BioApiError::InvalidResponse("Missing tax_id".to_string()))?
                .to_string();

            let name = sp["name"]
                .as_str()
                .ok_or_else(|| BioApiError::InvalidResponse("Missing species name".to_string()))?
                .to_string();

            let common_name = sp["common_name"].as_str().map(String::from);

            species_list.push(Species {
                tax_id,
                name,
                common_name,
            });
        }

        Ok(species_list)
    }

    /// Parse JSON response into TfMatrix
    fn parse_matrix(&self, json: serde_json::Value) -> BioApiResult<TfMatrix> {
        let matrix_id = json["matrix_id"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing matrix_id".to_string()))?
            .to_string();

        let name = json["name"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing name".to_string()))?
            .to_string();

        let family = json["family"].as_str().map(String::from);
        let class_type = json["type"].as_str().map(String::from);
        let collection = json["collection"].as_str().map(String::from);
        let version = json["version"].as_i64().map(|v| v as i32);

        // Parse species array
        let species = if let Some(species_array) = json["species"].as_array() {
            species_array
                .iter()
                .filter_map(|sp| {
                    Some(TaxonomyInfo {
                        tax_id: sp["tax_id"].as_str()?.to_string(),
                        name: sp["name"].as_str().map(String::from),
                    })
                })
                .collect()
        } else {
            Vec::new()
        };

        // Parse PFM matrix if present
        let matrix = if let Some(pfm_obj) = json["pfm"].as_object() {
            // JASPAR returns PFM as {A: [...], C: [...], G: [...], T: [...]}
            let a_row = pfm_obj
                .get("A")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>());
            let c_row = pfm_obj
                .get("C")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>());
            let g_row = pfm_obj
                .get("G")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>());
            let t_row = pfm_obj
                .get("T")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>());

            match (a_row, c_row, g_row, t_row) {
                (Some(a), Some(c), Some(g), Some(t)) => Some(vec![a, c, g, t]),
                _ => None,
            }
        } else {
            None
        };

        Ok(TfMatrix {
            matrix_id,
            name,
            family,
            species,
            class_type,
            matrix,
            collection,
            version,
        })
    }
}

impl Default for JasparClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = JasparClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[test]
    fn test_matrix_search_params() {
        let params = MatrixSearchParams {
            species: Some("9606".to_string()),
            tf_family: Some("bZIP".to_string()),
            limit: Some(10),
            ..Default::default()
        };
        assert_eq!(params.species, Some("9606".to_string()));
        assert_eq!(params.limit, Some(10));
    }

    #[test]
    fn test_parse_matrix() {
        let client = JasparClient::new();
        let json = serde_json::json!({
            "matrix_id": "MA0139.1",
            "name": "CTCF",
            "family": "C2H2 ZF",
            "type": "PFM",
            "collection": "CORE",
            "version": 1,
            "species": [
                {"tax_id": "9606", "name": "Homo sapiens"}
            ],
            "pfm": {
                "A": [87.0, 167.0, 281.0],
                "C": [291.0, 145.0, 49.0],
                "G": [76.0, 130.0, 107.0],
                "T": [123.0, 135.0, 140.0]
            }
        });

        let matrix = client.parse_matrix(json).unwrap();
        assert_eq!(matrix.matrix_id, "MA0139.1");
        assert_eq!(matrix.name, "CTCF");
        assert_eq!(matrix.family, Some("C2H2 ZF".to_string()));
        assert_eq!(matrix.species.len(), 1);
        assert_eq!(matrix.species[0].tax_id, "9606");
        assert!(matrix.matrix.is_some());
        let pfm = matrix.matrix.unwrap();
        assert_eq!(pfm.len(), 4); // A, C, G, T
        assert_eq!(pfm[0].len(), 3); // 3 positions
    }
}
