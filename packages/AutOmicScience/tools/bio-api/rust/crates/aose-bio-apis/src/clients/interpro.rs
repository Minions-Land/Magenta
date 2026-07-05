//! InterPro (Protein families/domains database) API client.
//!
//! Documentation: https://www.ebi.ac.uk/interpro/api/utils/openapi

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://www.ebi.ac.uk/interpro/api";
const REQUESTS_PER_SECOND: u32 = 5; // Conservative rate for EBI fair-use policy

/// InterPro API client
pub struct InterProClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

/// InterPro entry (domain, family, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterProEntry {
    /// Entry accession (e.g., IPR000001)
    pub accession: String,
    /// Entry name
    pub name: Option<String>,
    /// Short name
    pub short_name: Option<String>,
    /// Entry type (domain, family, repeat, site, etc.)
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
    /// Source database (interpro, pfam, smart, etc.)
    pub source_database: Option<String>,
    /// Integrated signature (if member database)
    pub integrated: Option<String>,
    /// Member database list (if InterPro entry)
    pub member_databases: Option<Vec<MemberDatabase>>,
    /// GO terms associated with this entry
    pub go_terms: Option<Vec<GoTerm>>,
    /// Number of proteins with this annotation
    pub counts: Option<EntryCounts>,
}

/// Member database information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberDatabase {
    /// Database name (pfam, smart, etc.)
    pub database: String,
    /// Accession in member database
    pub accession: String,
    /// Entry name
    pub name: Option<String>,
}

/// GO term annotation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoTerm {
    /// GO identifier (e.g., GO:0005515)
    pub identifier: String,
    /// GO term name
    pub name: String,
    /// GO category (molecular_function, biological_process, cellular_component)
    pub category: Option<String>,
}

/// Entry counts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryCounts {
    /// Number of proteins
    pub proteins: Option<u64>,
    /// Number of structures
    pub structures: Option<u64>,
    /// Number of taxa
    pub taxa: Option<u64>,
    /// Number of proteomes
    pub proteomes: Option<u64>,
}

/// Protein information from InterPro
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterProProtein {
    /// Protein accession (UniProt ID)
    pub accession: String,
    /// Protein name
    pub name: Option<String>,
    /// Source database (usually uniprot)
    pub source_database: Option<String>,
    /// Organism name
    pub organism: Option<String>,
    /// Protein length (amino acids)
    pub length: Option<u32>,
    /// Entry matches (domains, families, etc.)
    pub entry_subset: Option<Vec<ProteinEntry>>,
}

/// Protein entry match
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProteinEntry {
    /// Entry accession
    pub accession: String,
    /// Entry name
    pub name: Option<String>,
    /// Entry type
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
    /// Source database
    pub source_database: Option<String>,
    /// Match locations on protein
    pub protein_locations: Option<Vec<ProteinLocation>>,
}

/// Location of domain/family on protein sequence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProteinLocation {
    /// Start position
    pub start: u32,
    /// End position
    pub end: u32,
    /// Match score (e-value or similar)
    pub score: Option<f64>,
}

/// Structure information from InterPro
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterProStructure {
    /// PDB ID
    pub accession: String,
    /// Structure name/title
    pub name: Option<String>,
    /// Resolution (Angstroms)
    pub resolution: Option<f64>,
    /// Experimental method
    pub experiment_type: Option<String>,
    /// Release date
    pub release_date: Option<String>,
}

/// Taxonomy information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterProTaxonomy {
    /// Taxonomy ID
    pub accession: String,
    /// Scientific name
    pub name: String,
    /// Rank (species, genus, etc.)
    pub rank: Option<String>,
    /// Parent taxon ID
    pub parent: Option<String>,
    /// Number of proteins
    pub counts: Option<EntryCounts>,
}

/// Search response with pagination
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse<T> {
    /// Total number of results
    pub count: u64,
    /// URL for next page
    pub next: Option<String>,
    /// URL for previous page
    pub previous: Option<String>,
    /// Results for this page
    pub results: Vec<T>,
}

/// Entry type filter
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    Domain,
    Family,
    #[serde(rename = "homologous_superfamily")]
    HomologousSuperfamily,
    Repeat,
    Site,
    #[serde(rename = "conserved_site")]
    ConservedSite,
    #[serde(rename = "binding_site")]
    BindingSite,
    #[serde(rename = "active_site")]
    ActiveSite,
    Ptm,
}

/// Source database filter
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceDatabase {
    Interpro,
    Pfam,
    Smart,
    Prosite,
    Panther,
    Cdd,
    Prints,
    Gene3d,
    Pirsf,
    Hamap,
    Cathgene3d,
    Superfamily,
}

/// Search parameters for entries
#[derive(Debug, Clone, Default)]
pub struct EntrySearchParams {
    /// Search term (free text)
    pub search: Option<String>,
    /// Filter by entry type
    pub entry_type: Option<EntryType>,
    /// Filter by source database
    pub source_database: Option<SourceDatabase>,
    /// Filter by GO term
    pub go_term: Option<String>,
    /// Filter by taxonomy ID
    pub tax_id: Option<String>,
    /// Page size (default 20, max 200)
    pub page_size: Option<u32>,
    /// Cursor for pagination
    pub cursor: Option<String>,
}

impl InterProClient {
    /// Create a new InterPro client
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .user_agent("aos-bio-apis/1.0")
                .build()
                .unwrap(),
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Get entry by accession
    pub async fn get_entry(&self, source_db: &str, accession: &str) -> BioApiResult<InterProEntry> {
        let url = format!("{}/entry/{}/{}", BASE_URL, source_db, accession);

        self.retry_policy
            .execute("interpro_get_entry", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "InterPro entry {}/{} not found",
                                source_db, accession
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("InterPro API error: {}", status),
                        });
                    }

                    let json: serde_json::Value = response.json().await?;
                    self.parse_entry(&json)
                }
            })
            .await
    }

    /// Search entries with filters and pagination
    pub async fn search_entries(
        &self,
        params: EntrySearchParams,
    ) -> BioApiResult<SearchResponse<InterProEntry>> {
        let mut url = format!("{}/entry/all", BASE_URL);
        let mut query_params = Vec::new();

        if let Some(search) = &params.search {
            query_params.push(("search", search.as_str()));
        }

        let type_str;
        if let Some(entry_type) = params.entry_type {
            type_str = serde_json::to_string(&entry_type)?
                .trim_matches('"')
                .to_string();
            query_params.push(("type", type_str.as_str()));
        }

        let page_size_str;
        if let Some(page_size) = params.page_size {
            page_size_str = page_size.to_string();
            query_params.push(("page_size", &page_size_str));
        }

        if let Some(cursor) = &params.cursor {
            query_params.push(("cursor", cursor));
        }

        if let Some(go_term) = &params.go_term {
            query_params.push(("go_term", go_term));
        }

        if let Some(tax_id) = &params.tax_id {
            query_params.push(("tax_id", tax_id));
        }

        if !query_params.is_empty() {
            url.push('?');
            for (i, (key, value)) in query_params.iter().enumerate() {
                if i > 0 {
                    url.push('&');
                }
                url.push_str(&format!("{}={}", key, urlencoding::encode(value)));
            }
        }

        self.retry_policy
            .execute("interpro_search_entries", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "InterPro search failed".to_string(),
                        });
                    }

                    let json: serde_json::Value = response.json().await?;
                    self.parse_search_response(&json)
                }
            })
            .await
    }

    /// Get protein information by UniProt accession
    pub async fn get_protein(&self, uniprot_id: &str) -> BioApiResult<InterProProtein> {
        let url = format!("{}/protein/uniprot/{}", BASE_URL, uniprot_id);

        self.retry_policy
            .execute("interpro_get_protein", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Protein {} not found in InterPro",
                                uniprot_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("InterPro API error: {}", status),
                        });
                    }

                    let json: serde_json::Value = response.json().await?;
                    self.parse_protein(&json)
                }
            })
            .await
    }

    /// Get structure information by PDB ID
    pub async fn get_structure(&self, pdb_id: &str) -> BioApiResult<InterProStructure> {
        let url = format!("{}/structure/pdb/{}", BASE_URL, pdb_id.to_uppercase());

        self.retry_policy
            .execute("interpro_get_structure", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Structure {} not found in InterPro",
                                pdb_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("InterPro API error: {}", status),
                        });
                    }

                    let json: serde_json::Value = response.json().await?;
                    self.parse_structure(&json)
                }
            })
            .await
    }

    /// Get taxonomy information by taxonomy ID
    pub async fn get_taxonomy(&self, tax_id: &str) -> BioApiResult<InterProTaxonomy> {
        let url = format!("{}/taxonomy/uniprot/{}", BASE_URL, tax_id);

        self.retry_policy
            .execute("interpro_get_taxonomy", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound(format!(
                                "Taxonomy {} not found in InterPro",
                                tax_id
                            )));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("InterPro API error: {}", status),
                        });
                    }

                    let json: serde_json::Value = response.json().await?;
                    self.parse_taxonomy(&json)
                }
            })
            .await
    }

    /// Get entries for a specific protein
    pub async fn get_protein_entries(&self, uniprot_id: &str) -> BioApiResult<Vec<ProteinEntry>> {
        let protein = self.get_protein(uniprot_id).await?;
        Ok(protein.entry_subset.unwrap_or_default())
    }

    /// Get API version information
    pub async fn get_version(&self) -> BioApiResult<serde_json::Value> {
        let url = format!("{}/utils/release", BASE_URL);

        self.retry_policy
            .execute("interpro_get_version", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to get InterPro version".to_string(),
                        });
                    }

                    response.json().await.map_err(Into::into)
                }
            })
            .await
    }

    // Helper methods to parse JSON responses

    fn parse_entry(&self, json: &serde_json::Value) -> BioApiResult<InterProEntry> {
        let metadata = &json["metadata"];

        let accession = metadata["accession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing accession".to_string()))?
            .to_string();

        let name = metadata["name"].as_str().map(String::from);
        let short_name = metadata["short_name"].as_str().map(String::from);
        let entry_type = metadata["type"].as_str().map(String::from);
        let source_database = metadata["source_database"].as_str().map(String::from);
        let integrated = metadata["integrated"].as_str().map(String::from);

        let member_databases = metadata["member_databases"].as_object().map(|obj| {
            obj.iter()
                .flat_map(|(db, entries)| {
                    entries.as_object().map(|entry_obj| {
                        entry_obj
                            .keys()
                            .map(|acc| MemberDatabase {
                                database: db.clone(),
                                accession: acc.clone(),
                                name: entry_obj[acc]["name"].as_str().map(String::from),
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .flatten()
                .collect()
        });

        let go_terms = metadata["go_terms"].as_array().map(|arr| {
            arr.iter()
                .filter_map(|term| {
                    Some(GoTerm {
                        identifier: term["identifier"].as_str()?.to_string(),
                        name: term["name"].as_str()?.to_string(),
                        category: term["category"]["name"].as_str().map(String::from),
                    })
                })
                .collect()
        });

        let counts = json["extra_fields"]["counters"]
            .as_object()
            .map(|obj| EntryCounts {
                proteins: obj.get("proteins").and_then(|v| v.as_u64()),
                structures: obj.get("structures").and_then(|v| v.as_u64()),
                taxa: obj.get("taxa").and_then(|v| v.as_u64()),
                proteomes: obj.get("proteomes").and_then(|v| v.as_u64()),
            });

        Ok(InterProEntry {
            accession,
            name,
            short_name,
            entry_type,
            source_database,
            integrated,
            member_databases,
            go_terms,
            counts,
        })
    }

    fn parse_search_response(
        &self,
        json: &serde_json::Value,
    ) -> BioApiResult<SearchResponse<InterProEntry>> {
        let count = json["count"]
            .as_u64()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing count".to_string()))?;

        let next = json["next"].as_str().map(String::from);
        let previous = json["previous"].as_str().map(String::from);

        let results = json["results"]
            .as_array()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing results".to_string()))?
            .iter()
            .filter_map(|item| self.parse_entry(item).ok())
            .collect();

        Ok(SearchResponse {
            count,
            next,
            previous,
            results,
        })
    }

    fn parse_protein(&self, json: &serde_json::Value) -> BioApiResult<InterProProtein> {
        let metadata = &json["metadata"];

        let accession = metadata["accession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing protein accession".to_string()))?
            .to_string();

        let name = metadata["name"].as_str().map(String::from);
        let source_database = metadata["source_database"].as_str().map(String::from);
        let organism = metadata["organism"]["name"].as_str().map(String::from);
        let length = metadata["length"].as_u64().map(|l| l as u32);

        let entry_subset = json["entries"].as_array().map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let metadata = &entry["metadata"];
                    let accession = metadata["accession"].as_str()?.to_string();
                    let name = metadata["name"].as_str().map(String::from);
                    let entry_type = metadata["type"].as_str().map(String::from);
                    let source_database = metadata["source_database"].as_str().map(String::from);

                    let protein_locations =
                        entry["entry_protein_locations"].as_array().map(|locs| {
                            locs.iter()
                                .filter_map(|loc| {
                                    let fragments = loc["fragments"].as_array()?;
                                    fragments
                                        .iter()
                                        .filter_map(|frag| {
                                            Some(ProteinLocation {
                                                start: frag["start"].as_u64()? as u32,
                                                end: frag["end"].as_u64()? as u32,
                                                score: frag["score"].as_f64(),
                                            })
                                        })
                                        .next()
                                })
                                .collect()
                        });

                    Some(ProteinEntry {
                        accession,
                        name,
                        entry_type,
                        source_database,
                        protein_locations,
                    })
                })
                .collect()
        });

        Ok(InterProProtein {
            accession,
            name,
            source_database,
            organism,
            length,
            entry_subset,
        })
    }

    fn parse_structure(&self, json: &serde_json::Value) -> BioApiResult<InterProStructure> {
        let metadata = &json["metadata"];

        let accession = metadata["accession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing structure accession".to_string()))?
            .to_string();

        Ok(InterProStructure {
            accession,
            name: metadata["name"].as_str().map(String::from),
            resolution: metadata["resolution"].as_f64(),
            experiment_type: metadata["experiment_type"].as_str().map(String::from),
            release_date: metadata["release_date"].as_str().map(String::from),
        })
    }

    fn parse_taxonomy(&self, json: &serde_json::Value) -> BioApiResult<InterProTaxonomy> {
        let metadata = &json["metadata"];

        let accession = metadata["accession"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing taxonomy accession".to_string()))?
            .to_string();

        let name = metadata["name"]
            .as_str()
            .ok_or_else(|| BioApiError::InvalidResponse("Missing taxonomy name".to_string()))?
            .to_string();

        let rank = metadata["rank"].as_str().map(String::from);
        let parent = metadata["parent"].as_str().map(String::from);

        let counts = json["extra_fields"]["counters"]
            .as_object()
            .map(|obj| EntryCounts {
                proteins: obj.get("proteins").and_then(|v| v.as_u64()),
                structures: obj.get("structures").and_then(|v| v.as_u64()),
                taxa: obj.get("taxa").and_then(|v| v.as_u64()),
                proteomes: obj.get("proteomes").and_then(|v| v.as_u64()),
            });

        Ok(InterProTaxonomy {
            accession,
            name,
            rank,
            parent,
            counts,
        })
    }
}

impl Default for InterProClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = InterProClient::new();
        assert_eq!(client.rate_limiter.rate(), REQUESTS_PER_SECOND);
    }

    #[tokio::test]
    async fn test_entry_search_params_default() {
        let params = EntrySearchParams::default();
        assert!(params.search.is_none());
        assert!(params.entry_type.is_none());
        assert!(params.page_size.is_none());
    }

    #[tokio::test]
    async fn test_entry_type_serialization() {
        let domain = EntryType::Domain;
        let json = serde_json::to_string(&domain).unwrap();
        assert_eq!(json, "\"domain\"");
    }

    #[tokio::test]
    async fn test_source_database_serialization() {
        let pfam = SourceDatabase::Pfam;
        let json = serde_json::to_string(&pfam).unwrap();
        assert_eq!(json, "\"pfam\"");
    }
}
