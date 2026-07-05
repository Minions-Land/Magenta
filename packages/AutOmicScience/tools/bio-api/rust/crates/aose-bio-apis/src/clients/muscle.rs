//! MUSCLE Multiple Sequence Alignment client.
//!
//! MUSCLE (MUltiple Sequence Comparison by Log-Expectation) is a tool for creating
//! multiple sequence alignments of protein or nucleotide sequences.
//!
//! This client uses the EBI Web Services API for MUSCLE alignment.
//! Documentation: https://www.ebi.ac.uk/Tools/msa/muscle/

use crate::error::{BioApiError, BioApiResult};
use crate::models::Fasta;
use crate::rate_limiter::RateLimiter;
use crate::retry::RetryPolicy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

const BASE_URL: &str = "https://www.ebi.ac.uk/Tools/services/rest/muscle";
const REQUESTS_PER_SECOND: u32 = 2;
const MAX_POLL_ATTEMPTS: u32 = 60;
const POLL_INTERVAL_SECS: u64 = 5;

/// Output format for MUSCLE alignment
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MuscleOutputFormat {
    /// FASTA format
    Fasta,
    /// Clustal format with consensus line
    Clustal,
    /// Clustal format without numbers
    #[serde(rename = "clw")]
    ClustalW,
    /// Clustal format strict
    #[serde(rename = "clwstrict")]
    ClustalWStrict,
    /// HTML format
    Html,
    /// MSF format
    Msf,
    /// Phylip format (interleaved)
    Phylip,
    /// Phylip format (sequential)
    #[serde(rename = "phylips")]
    PhylipSequential,
}

impl MuscleOutputFormat {
    fn to_api_param(self) -> &'static str {
        match self {
            MuscleOutputFormat::Fasta => "fasta",
            MuscleOutputFormat::Clustal => "clustal",
            MuscleOutputFormat::ClustalW => "clw",
            MuscleOutputFormat::ClustalWStrict => "clwstrict",
            MuscleOutputFormat::Html => "html",
            MuscleOutputFormat::Msf => "msf",
            MuscleOutputFormat::Phylip => "phylip",
            MuscleOutputFormat::PhylipSequential => "phylips",
        }
    }
}

/// Tree output format for MUSCLE
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeFormat {
    /// Newick format
    #[serde(rename = "tree1")]
    Tree1,
    /// Newick format (tree2)
    #[serde(rename = "tree2")]
    Tree2,
    /// No tree output
    None,
}

impl TreeFormat {
    fn to_api_param(self) -> &'static str {
        match self {
            TreeFormat::Tree1 => "tree1",
            TreeFormat::Tree2 => "tree2",
            TreeFormat::None => "none",
        }
    }
}

/// MUSCLE alignment parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuscleParams {
    /// Output format (default: Fasta)
    pub format: MuscleOutputFormat,
    /// Tree output format (default: None)
    pub tree: TreeFormat,
    /// Maximum number of iterations (default: 16, range: 1-1000)
    pub max_iterations: Option<u32>,
    /// Clustering method for iteration 1 and 2
    pub cluster_method: Option<ClusterMethod>,
    /// Distance measure for iteration 1
    pub distance1: Option<DistanceMeasure>,
    /// Distance measure for iteration 2
    pub distance2: Option<DistanceMeasure>,
}

impl Default for MuscleParams {
    fn default() -> Self {
        Self {
            format: MuscleOutputFormat::Fasta,
            tree: TreeFormat::None,
            max_iterations: None,
            cluster_method: None,
            distance1: None,
            distance2: None,
        }
    }
}

/// Clustering method for MUSCLE
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClusterMethod {
    /// UPGMA clustering
    #[serde(rename = "upgma")]
    Upgma,
    /// Neighbor-joining
    #[serde(rename = "neighborjoining")]
    NeighborJoining,
}

impl ClusterMethod {
    fn to_api_param(self) -> &'static str {
        match self {
            ClusterMethod::Upgma => "upgma",
            ClusterMethod::NeighborJoining => "neighborjoining",
        }
    }
}

/// Distance measure for MUSCLE iterations
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistanceMeasure {
    /// Kimura distance
    #[serde(rename = "kmer6_6")]
    Kmer6_6,
    /// k-mer distance (4,6)
    #[serde(rename = "kmer20_3")]
    Kmer20_3,
    /// k-mer distance (20,4)
    #[serde(rename = "kmer20_4")]
    Kmer20_4,
    /// Percent identity
    #[serde(rename = "pctid_kimura")]
    PctIdKimura,
}

impl DistanceMeasure {
    fn to_api_param(self) -> &'static str {
        match self {
            DistanceMeasure::Kmer6_6 => "kmer6_6",
            DistanceMeasure::Kmer20_3 => "kmer20_3",
            DistanceMeasure::Kmer20_4 => "kmer20_4",
            DistanceMeasure::PctIdKimura => "pctid_kimura",
        }
    }
}

/// MUSCLE alignment result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuscleAlignment {
    /// Job identifier
    pub job_id: String,
    /// Aligned sequences in requested format
    pub alignment: String,
    /// Guide tree (if requested)
    pub tree: Option<String>,
    /// Number of sequences aligned
    pub sequence_count: usize,
    /// Alignment length
    pub alignment_length: usize,
}

/// Job status from EBI API
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum JobStatus {
    Running,
    Finished,
    Error,
    Failure,
    #[serde(rename = "NOT_FOUND")]
    NotFound,
}

/// EBI MUSCLE API client
pub struct MuscleClient {
    client: Client,
    rate_limiter: Arc<RateLimiter>,
    retry_policy: RetryPolicy,
}

impl MuscleClient {
    /// Create a new MUSCLE client
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("AOSE-BioAgent/0.1 (MUSCLE)")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            client,
            rate_limiter: Arc::new(RateLimiter::new(REQUESTS_PER_SECOND)),
            retry_policy: RetryPolicy::default(),
        }
    }

    /// Create a new MUSCLE client with custom rate limit
    pub fn with_rate_limit(requests_per_second: u32) -> Self {
        let mut client = Self::new();
        client.rate_limiter = Arc::new(RateLimiter::new(requests_per_second));
        client
    }

    /// Align multiple sequences using MUSCLE
    ///
    /// # Arguments
    /// * `sequences` - FASTA format sequences or a vector of Fasta structs
    /// * `params` - Alignment parameters (optional)
    ///
    /// # Returns
    /// Aligned sequences in the requested format
    pub async fn align(
        &self,
        sequences: &str,
        params: Option<MuscleParams>,
    ) -> BioApiResult<MuscleAlignment> {
        // Validate input
        if sequences.trim().is_empty() {
            return Err(BioApiError::InvalidInput("Empty sequences".to_string()));
        }

        // Parse to check we have valid FASTA with at least 2 sequences
        let parsed = Fasta::parse(sequences)
            .map_err(|e| BioApiError::InvalidInput(format!("Invalid FASTA format: {}", e)))?;

        if parsed.len() < 2 {
            return Err(BioApiError::InvalidInput(
                "MUSCLE requires at least 2 sequences for alignment".to_string(),
            ));
        }

        let params = params.unwrap_or_default();

        // Submit job
        let job_id = self.submit_job(sequences, &params).await?;

        // Poll for completion
        let status = self.poll_job_completion(&job_id).await?;

        if status != JobStatus::Finished {
            return Err(BioApiError::Other(format!(
                "Job {} failed with status: {:?}",
                job_id, status
            )));
        }

        // Retrieve results
        let alignment = self.get_result(&job_id, &params.format).await?;
        let tree = if params.tree != TreeFormat::None {
            Some(self.get_tree(&job_id, &params.tree).await?)
        } else {
            None
        };

        // Parse alignment to get metadata
        let (sequence_count, alignment_length) =
            Self::parse_alignment_metadata(&alignment, &params.format);

        Ok(MuscleAlignment {
            job_id,
            alignment,
            tree,
            sequence_count,
            alignment_length,
        })
    }

    /// Align sequences from Fasta structs
    pub async fn align_sequences(
        &self,
        sequences: &[Fasta],
        params: Option<MuscleParams>,
    ) -> BioApiResult<MuscleAlignment> {
        if sequences.len() < 2 {
            return Err(BioApiError::InvalidInput(
                "MUSCLE requires at least 2 sequences for alignment".to_string(),
            ));
        }

        // Convert to FASTA format string
        let fasta_string = sequences.iter().map(|f| f.to_string()).collect::<String>();

        self.align(&fasta_string, params).await
    }

    /// Submit alignment job to EBI API
    async fn submit_job(&self, sequences: &str, params: &MuscleParams) -> BioApiResult<String> {
        let url = format!("{}/run", BASE_URL);

        let mut form_params = vec![
            ("email", "anonymous@example.com"),
            ("sequence", sequences),
            ("format", params.format.to_api_param()),
            ("tree", params.tree.to_api_param()),
        ];

        // Add optional parameters
        let max_iter_str;
        if let Some(max_iter) = params.max_iterations {
            max_iter_str = max_iter.to_string();
            form_params.push(("maxiterations", &max_iter_str));
        }

        let cluster_str;
        if let Some(cluster) = params.cluster_method {
            cluster_str = cluster.to_api_param().to_string();
            form_params.push(("clustering", &cluster_str));
        }

        let dist1_str;
        if let Some(dist1) = params.distance1 {
            dist1_str = dist1.to_api_param().to_string();
            form_params.push(("distance1", &dist1_str));
        }

        let dist2_str;
        if let Some(dist2) = params.distance2 {
            dist2_str = dist2.to_api_param().to_string();
            form_params.push(("distance2", &dist2_str));
        }

        let job_id = self
            .retry_policy
            .execute("submit_job", || {
                let url = url.clone();
                let form_params = form_params.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.post(&url).form(&form_params).send().await?;

                    let status = response.status();
                    if !status.is_success() {
                        return Err(BioApiError::ApiError {
                            status: status.as_u16(),
                            message: format!("Failed to submit MUSCLE job: {}", status),
                        });
                    }

                    let job_id = response.text().await?;
                    Ok(job_id.trim().to_string())
                }
            })
            .await?;

        Ok(job_id)
    }

    /// Poll job status until completion
    async fn poll_job_completion(&self, job_id: &str) -> BioApiResult<JobStatus> {
        let url = format!("{}/status/{}", BASE_URL, job_id);

        for attempt in 1..=MAX_POLL_ATTEMPTS {
            self.rate_limiter.acquire().await;

            let response = self.client.get(&url).send().await?;

            if !response.status().is_success() {
                return Err(BioApiError::ApiError {
                    status: response.status().as_u16(),
                    message: format!("Failed to check job status: {}", response.status()),
                });
            }

            let status_text = response.text().await?;
            let status: JobStatus = serde_json::from_str(&format!("\"{}\"", status_text.trim()))
                .unwrap_or(JobStatus::Error);

            match status {
                JobStatus::Finished => return Ok(JobStatus::Finished),
                JobStatus::Error | JobStatus::Failure | JobStatus::NotFound => {
                    return Ok(status);
                }
                JobStatus::Running => {
                    if attempt < MAX_POLL_ATTEMPTS {
                        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
                    }
                }
            }
        }

        Err(BioApiError::Timeout {
            operation: format!("MUSCLE alignment job {}", job_id),
        })
    }

    /// Retrieve alignment result
    async fn get_result(&self, job_id: &str, format: &MuscleOutputFormat) -> BioApiResult<String> {
        let result_type = match format {
            MuscleOutputFormat::Fasta => "aln-fasta",
            MuscleOutputFormat::Clustal => "aln-clustal",
            MuscleOutputFormat::ClustalW => "aln-clw",
            MuscleOutputFormat::ClustalWStrict => "aln-clwstrict",
            MuscleOutputFormat::Html => "aln-html",
            MuscleOutputFormat::Msf => "aln-msf",
            MuscleOutputFormat::Phylip => "aln-phylip",
            MuscleOutputFormat::PhylipSequential => "aln-phylips",
        };

        let url = format!("{}/result/{}/{}", BASE_URL, job_id, result_type);

        let alignment = self
            .retry_policy
            .execute("get_result", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to retrieve alignment result".to_string(),
                        });
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await?;

        Ok(alignment)
    }

    /// Retrieve phylogenetic tree
    async fn get_tree(&self, job_id: &str, tree_format: &TreeFormat) -> BioApiResult<String> {
        let result_type = match tree_format {
            TreeFormat::Tree1 => "tree",
            TreeFormat::Tree2 => "tree2",
            TreeFormat::None => return Ok(String::new()),
        };

        let url = format!("{}/result/{}/{}", BASE_URL, job_id, result_type);

        let tree = self
            .retry_policy
            .execute("get_tree", || {
                let url = url.clone();
                async move {
                    self.rate_limiter.acquire().await;

                    let response = self.client.get(&url).send().await?;

                    if !response.status().is_success() {
                        return Err(BioApiError::ApiError {
                            status: response.status().as_u16(),
                            message: "Failed to retrieve tree result".to_string(),
                        });
                    }

                    response.text().await.map_err(Into::into)
                }
            })
            .await?;

        Ok(tree)
    }

    /// Parse alignment metadata from result
    fn parse_alignment_metadata(alignment: &str, format: &MuscleOutputFormat) -> (usize, usize) {
        match format {
            MuscleOutputFormat::Fasta => {
                // Count FASTA headers and sequence length
                let fasta_seqs = Fasta::parse(alignment).unwrap_or_default();
                let count = fasta_seqs.len();
                let length = fasta_seqs.first().map(|f| f.sequence.len()).unwrap_or(0);
                (count, length)
            }
            MuscleOutputFormat::Clustal
            | MuscleOutputFormat::ClustalW
            | MuscleOutputFormat::ClustalWStrict => {
                // Parse Clustal format
                let mut count = 0;
                let mut length = 0;
                let mut seen_ids = std::collections::HashSet::new();

                for line in alignment.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with("CLUSTAL") || line.starts_with('*') {
                        continue;
                    }

                    // Clustal format: ID SEQUENCE
                    if let Some(space_pos) = line.find(char::is_whitespace) {
                        let id = &line[..space_pos];
                        if !id.is_empty() && !seen_ids.contains(id) {
                            seen_ids.insert(id.to_string());
                            count += 1;
                        }

                        // Get sequence part
                        let seq_part = &line[space_pos..].trim();
                        if !seq_part.is_empty() && !seq_part.chars().all(char::is_numeric) {
                            length += seq_part.split_whitespace().next().unwrap_or("").len();
                        }
                    }
                }

                if let Some(avg) = length.checked_div(count) {
                    length = avg;
                }
                (count, length)
            }
            _ => {
                // For other formats, do simple counting
                let lines: Vec<_> = alignment.lines().collect();
                (lines.len(), 0)
            }
        }
    }

    /// Get job parameters information (for debugging)
    pub async fn get_job_parameters(&self, job_id: &str) -> BioApiResult<String> {
        let url = format!("{}/parameters/{}", BASE_URL, job_id);

        self.rate_limiter.acquire().await;

        let response = self.client.get(&url).send().await?;

        if !response.status().is_success() {
            return Err(BioApiError::ApiError {
                status: response.status().as_u16(),
                message: "Failed to retrieve job parameters".to_string(),
            });
        }

        response.text().await.map_err(Into::into)
    }
}

impl Default for MuscleClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_output_format_api_param() {
        assert_eq!(MuscleOutputFormat::Fasta.to_api_param(), "fasta");
        assert_eq!(MuscleOutputFormat::Clustal.to_api_param(), "clustal");
        assert_eq!(MuscleOutputFormat::ClustalW.to_api_param(), "clw");
        assert_eq!(MuscleOutputFormat::Html.to_api_param(), "html");
    }

    #[test]
    fn test_tree_format_api_param() {
        assert_eq!(TreeFormat::Tree1.to_api_param(), "tree1");
        assert_eq!(TreeFormat::Tree2.to_api_param(), "tree2");
        assert_eq!(TreeFormat::None.to_api_param(), "none");
    }

    #[test]
    fn test_cluster_method_api_param() {
        assert_eq!(ClusterMethod::Upgma.to_api_param(), "upgma");
        assert_eq!(
            ClusterMethod::NeighborJoining.to_api_param(),
            "neighborjoining"
        );
    }

    #[test]
    fn test_distance_measure_api_param() {
        assert_eq!(DistanceMeasure::Kmer6_6.to_api_param(), "kmer6_6");
        assert_eq!(DistanceMeasure::Kmer20_3.to_api_param(), "kmer20_3");
        assert_eq!(DistanceMeasure::PctIdKimura.to_api_param(), "pctid_kimura");
    }

    #[test]
    fn test_default_params() {
        let params = MuscleParams::default();
        assert_eq!(params.format, MuscleOutputFormat::Fasta);
        assert_eq!(params.tree, TreeFormat::None);
        assert!(params.max_iterations.is_none());
    }

    #[test]
    fn test_client_creation() {
        let client = MuscleClient::new();
        assert!(std::ptr::addr_of!(client).is_null() == false);
    }

    #[test]
    fn test_client_with_rate_limit() {
        let client = MuscleClient::with_rate_limit(5);
        assert!(std::ptr::addr_of!(client).is_null() == false);
    }

    #[test]
    fn test_parse_fasta_alignment() {
        let alignment = ">seq1
ACGT-ACGT
>seq2
ACGTGACGT
";
        let (count, length) =
            MuscleClient::parse_alignment_metadata(alignment, &MuscleOutputFormat::Fasta);
        assert_eq!(count, 2);
        assert_eq!(length, 9);
    }

    #[test]
    fn test_parse_clustal_alignment() {
        let alignment = r#"CLUSTAL multiple sequence alignment

seq1        ACGT-ACGT
seq2        ACGTGACGT
            **** ****
"#;
        let (count, length) =
            MuscleClient::parse_alignment_metadata(alignment, &MuscleOutputFormat::Clustal);
        assert_eq!(count, 2);
        assert!(length > 0);
    }

    #[tokio::test]
    async fn test_validate_empty_sequences() {
        let client = MuscleClient::new();
        let result = client.align("", None).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn test_validate_single_sequence() {
        let client = MuscleClient::new();
        let fasta = ">seq1
ACGT
";
        let result = client.align(fasta, None).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
    }
}
