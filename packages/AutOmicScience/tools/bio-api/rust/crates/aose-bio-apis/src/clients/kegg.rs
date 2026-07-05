//! KEGG (Kyoto Encyclopedia of Genes and Genomes) REST API client.
//!
//! Documentation: http://www.kegg.jp/kegg/rest/keggapi.html
//!
//! KEGG provides pathway, genome, and molecular network databases.
//! The REST API returns plain text (tab-delimited or structured field-value format).

use crate::error::{BioApiError, BioApiResult};
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const BASE_URL: &str = "https://rest.kegg.jp";
const REQUESTS_PER_SECOND: u32 = 10;

/// KEGG REST API client
pub struct KeggClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl KeggClient {
    /// Create a new KEGG client
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

    /// List entries in a KEGG database
    ///
    /// # Arguments
    /// * `database` - Database name (e.g., "pathway", "genome", "genes", "compound")
    /// * `organism` - Optional organism code (e.g., "hsa" for human, "mmu" for mouse)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::kegg::KeggClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = KeggClient::new();
    /// let pathways = client.list("pathway", Some("hsa")).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn list(
        &self,
        database: &str,
        organism: Option<&str>,
    ) -> BioApiResult<Vec<KeggEntry>> {
        let url = if let Some(org) = organism {
            format!("{}/list/{}/{}", BASE_URL, database, org)
        } else {
            format!("{}/list/{}", BASE_URL, database)
        };

        let text = self.fetch_text(&url, "kegg_list").await?;
        self.parse_list_response(&text)
    }

    /// Get detailed information for a KEGG entry
    ///
    /// # Arguments
    /// * `entry_id` - Entry identifier (e.g., "hsa00010", "hsa:7124")
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::kegg::KeggClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = KeggClient::new();
    /// let pathway_info = client.get("hsa00010").await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn get(&self, entry_id: &str) -> BioApiResult<KeggEntryDetail> {
        let url = format!("{}/get/{}", BASE_URL, entry_id);
        let text = self.fetch_text(&url, "kegg_get").await?;
        self.parse_entry_detail(&text, entry_id)
    }

    /// Find entries by keyword search
    ///
    /// # Arguments
    /// * `database` - Database name (e.g., "pathway", "genes", "compound")
    /// * `query` - Search keyword(s)
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::kegg::KeggClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = KeggClient::new();
    /// let results = client.find("pathway", "insulin signaling").await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn find(&self, database: &str, query: &str) -> BioApiResult<Vec<KeggEntry>> {
        let url = format!(
            "{}/find/{}/{}",
            BASE_URL,
            database,
            urlencoding::encode(query)
        );
        let text = self.fetch_text(&url, "kegg_find").await?;
        self.parse_list_response(&text)
    }

    /// Get cross-references between databases
    ///
    /// # Arguments
    /// * `target_db` - Target database name
    /// * `source_db` - Source database name or entry ID
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::kegg::KeggClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = KeggClient::new();
    /// // Get human genes in a pathway
    /// let links = client.link("hsa", "path:hsa00010").await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn link(&self, target_db: &str, source_db: &str) -> BioApiResult<Vec<KeggLink>> {
        let url = format!("{}/link/{}/{}", BASE_URL, target_db, source_db);
        let text = self.fetch_text(&url, "kegg_link").await?;
        self.parse_link_response(&text)
    }

    /// Convert identifiers between databases
    ///
    /// # Arguments
    /// * `target_db` - Target database name
    /// * `source_db` - Source database name or entry IDs
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::kegg::KeggClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = KeggClient::new();
    /// let conversions = client.conv("ncbi-geneid", "hsa:7124").await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn conv(
        &self,
        target_db: &str,
        source_db: &str,
    ) -> BioApiResult<Vec<KeggConversion>> {
        let url = format!("{}/conv/{}/{}", BASE_URL, target_db, source_db);
        let text = self.fetch_text(&url, "kegg_conv").await?;
        self.parse_conv_response(&text)
    }

    /// Get database metadata
    ///
    /// # Arguments
    /// * `database` - Database name (e.g., "pathway", "genome", "genes")
    ///
    /// # Example
    /// ```no_run
    /// # use aose_bio_apis::clients::kegg::KeggClient;
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = KeggClient::new();
    /// let info = client.info("pathway").await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn info(&self, database: &str) -> BioApiResult<String> {
        let url = format!("{}/info/{}", BASE_URL, database);
        self.fetch_text(&url, "kegg_info").await
    }

    /// Fetch text response from KEGG API
    async fn fetch_text(&self, url: &str, operation: &str) -> BioApiResult<String> {
        self.retry_policy
            .execute(operation, || {
                let url = url.to_string();
                async move {
                    self.rate_limiter.acquire().await;
                    let response = self.client.get(&url).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        if status.as_u16() == 404 {
                            return Err(BioApiError::NotFound("KEGG entry not found".to_string()));
                        }
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("KEGG API error: {}", status),
                        });
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await
    }

    /// Parse tab-delimited list response
    fn parse_list_response(&self, text: &str) -> BioApiResult<Vec<KeggEntry>> {
        let mut entries = Vec::new();

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // Format: "entry_id\tdescription"
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() >= 2 {
                entries.push(KeggEntry {
                    entry_id: parts[0].to_string(),
                    description: parts[1].to_string(),
                });
            } else if parts.len() == 1 {
                // Some responses may have just IDs
                entries.push(KeggEntry {
                    entry_id: parts[0].to_string(),
                    description: String::new(),
                });
            }
        }

        Ok(entries)
    }

    /// Parse structured entry detail response
    fn parse_entry_detail(&self, text: &str, entry_id: &str) -> BioApiResult<KeggEntryDetail> {
        let mut name = None;
        let mut description = None;
        let mut class = None;
        let mut pathway_map = None;
        let mut genes = Vec::new();
        let mut compounds = Vec::new();
        let mut references = Vec::new();
        let raw_content = text.to_string();

        let mut current_field = String::new();
        let mut current_value = String::new();

        for line in text.lines() {
            if line.is_empty() {
                continue;
            }

            // Field lines start at column 0, continuation lines are indented
            if !line.starts_with(' ') && line.contains(' ') {
                // Save previous field
                if !current_field.is_empty() {
                    self.process_field(
                        &current_field,
                        &current_value,
                        &mut name,
                        &mut description,
                        &mut class,
                        &mut pathway_map,
                        &mut genes,
                        &mut compounds,
                        &mut references,
                    );
                }

                // Start new field
                let parts: Vec<&str> = line.splitn(2, ' ').collect();
                if parts.len() == 2 {
                    current_field = parts[0].to_string();
                    current_value = parts[1].trim().to_string();
                }
            } else if !current_field.is_empty() {
                // Continuation of previous field
                current_value.push('\n');
                current_value.push_str(line.trim());
            }
        }

        // Process last field
        if !current_field.is_empty() {
            self.process_field(
                &current_field,
                &current_value,
                &mut name,
                &mut description,
                &mut class,
                &mut pathway_map,
                &mut genes,
                &mut compounds,
                &mut references,
            );
        }

        Ok(KeggEntryDetail {
            entry_id: entry_id.to_string(),
            name,
            description,
            class,
            pathway_map,
            genes,
            compounds,
            references,
            raw_content,
        })
    }

    /// Process a single field from entry detail
    #[allow(clippy::too_many_arguments)]
    fn process_field(
        &self,
        field: &str,
        value: &str,
        name: &mut Option<String>,
        description: &mut Option<String>,
        class: &mut Option<String>,
        pathway_map: &mut Option<String>,
        genes: &mut Vec<String>,
        compounds: &mut Vec<String>,
        references: &mut Vec<String>,
    ) {
        match field {
            "NAME" => *name = Some(value.to_string()),
            "DESCRIPTION" => *description = Some(value.to_string()),
            "CLASS" => *class = Some(value.to_string()),
            "PATHWAY_MAP" => *pathway_map = Some(value.to_string()),
            "GENE" => {
                // Parse gene entries (format varies)
                for line in value.lines() {
                    let gene = line.trim();
                    if !gene.is_empty() {
                        genes.push(gene.to_string());
                    }
                }
            }
            "COMPOUND" => {
                // Parse compound entries
                for line in value.lines() {
                    let compound = line.trim();
                    if !compound.is_empty() {
                        compounds.push(compound.to_string());
                    }
                }
            }
            "REFERENCE" => {
                references.push(value.to_string());
            }
            _ => {}
        }
    }

    /// Parse link response (tab-delimited pairs)
    fn parse_link_response(&self, text: &str) -> BioApiResult<Vec<KeggLink>> {
        let mut links = Vec::new();

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // Format: "source_id\ttarget_id"
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                links.push(KeggLink {
                    source_id: parts[0].to_string(),
                    target_id: parts[1].to_string(),
                });
            }
        }

        Ok(links)
    }

    /// Parse conversion response (tab-delimited pairs)
    fn parse_conv_response(&self, text: &str) -> BioApiResult<Vec<KeggConversion>> {
        let mut conversions = Vec::new();

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // Format: "source_id\ttarget_id"
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                conversions.push(KeggConversion {
                    source_id: parts[0].to_string(),
                    target_id: parts[1].to_string(),
                });
            }
        }

        Ok(conversions)
    }
}

impl Default for KeggClient {
    fn default() -> Self {
        Self::new()
    }
}

/// KEGG entry from list or find operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeggEntry {
    pub entry_id: String,
    pub description: String,
}

/// Detailed KEGG entry information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeggEntryDetail {
    pub entry_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub class: Option<String>,
    pub pathway_map: Option<String>,
    pub genes: Vec<String>,
    pub compounds: Vec<String>,
    pub references: Vec<String>,
    /// Raw text content for custom parsing
    pub raw_content: String,
}

/// Cross-reference link between KEGG databases
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeggLink {
    pub source_id: String,
    pub target_id: String,
}

/// Identifier conversion between databases
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeggConversion {
    pub source_id: String,
    pub target_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_client_creation() {
        let client = KeggClient::new();
        assert!(!std::ptr::addr_of!(client).is_null());
    }

    #[tokio::test]
    async fn test_parse_list_response() {
        let client = KeggClient::new();
        let text = "hsa00010\tGlycolysis / Gluconeogenesis - Homo sapiens (human)\nhsa00020\tCitrate cycle (TCA cycle) - Homo sapiens (human)";

        let entries = client.parse_list_response(text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].entry_id, "hsa00010");
        assert!(entries[0].description.contains("Glycolysis"));
        assert_eq!(entries[1].entry_id, "hsa00020");
        assert!(entries[1].description.contains("TCA cycle"));
    }

    #[tokio::test]
    async fn test_parse_link_response() {
        let client = KeggClient::new();
        let text = "path:hsa00010\thsa:7124\npath:hsa00010\thsa:3101";

        let links = client.parse_link_response(text).unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].source_id, "path:hsa00010");
        assert_eq!(links[0].target_id, "hsa:7124");
    }

    #[tokio::test]
    async fn test_parse_conv_response() {
        let client = KeggClient::new();
        let text = "hsa:7124\tncbi-geneid:7124\nhsa:3101\tncbi-geneid:3101";

        let conversions = client.parse_conv_response(text).unwrap();
        assert_eq!(conversions.len(), 2);
        assert_eq!(conversions[0].source_id, "hsa:7124");
        assert_eq!(conversions[0].target_id, "ncbi-geneid:7124");
    }

    #[tokio::test]
    async fn test_parse_empty_response() {
        let client = KeggClient::new();
        let text = "";

        let entries = client.parse_list_response(text).unwrap();
        assert_eq!(entries.len(), 0);
    }

    #[tokio::test]
    async fn test_parse_single_column_list() {
        let client = KeggClient::new();
        let text = "hsa00010\nhsa00020";

        let entries = client.parse_list_response(text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].entry_id, "hsa00010");
        assert_eq!(entries[0].description, "");
    }
}
