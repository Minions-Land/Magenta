//! # aos-bio-apis
//!
//! Pure Rust bioinformatics API clients for AutOmicScience.
//!
//! This crate provides HTTP clients for major bioinformatics databases:
//! - Ensembl REST API (gene annotation, sequences, references)
//! - NCBI E-utilities (BLAST, sequence retrieval, virus data)
//! - UniProt (protein annotation and sequences)
//! - GWAS Catalog (genetic associations)
//! - AlphaFold DB (protein structure predictions)
//! - GTEx (gene expression and eQTLs)
//! - DepMap (cancer dependency data)
//!
//! ## Features
//!
//! - **Type-safe models**: Strongly-typed data structures with serde
//! - **Retry logic**: Exponential backoff with jitter
//! - **Rate limiting**: Compliant with each API's requirements
//! - **Provenance metadata**: Full trace of API calls for reproducibility
//! - **Performance**: <500ms for typical queries
//!
//! ## Usage
//!
//! ```no_run
//! use aose_bio_apis::clients::ensembl::EnsemblClient;
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let client = EnsemblClient::new();
//!     let genes = client.search_genes("BRCA2", None).await?;
//!     println!("Found {} genes", genes.len());
//!     Ok(())
//! }
//! ```

pub mod batch;
pub mod clients;
pub mod error;
pub mod healing;
pub mod local;
pub mod models;
pub mod rate_limiter;
pub mod registry;
pub mod retry;
pub mod testing;

#[cfg(feature = "cache")]
pub mod cache;

// Re-export commonly used types
pub use batch::{chunk_queries, parallel_execute, BatchExecutor};
pub use error::{BioApiError, BioApiResult};
pub use healing::{
    CircuitBreakerConfig, CircuitBreakerRegistry, CircuitDecision, CircuitState, CircuitStateKind,
    FailureClassifier, FailureKind, RepairStrategy,
};
pub use models::{
    BlastHit, Eqtl, Fasta, GeneDependency, GeneRecord, GtexTissue, GwasAssociation,
    ImmuneCorrelation, ImmuneInfiltration, ProteinRecord, SnpInfo, TissueExpression,
};
pub use rate_limiter::RateLimiter;
pub use registry::{
    BioApiClient, ClientMetadata, ClientRegistry, HealthCheckResult, RegistryBuilder,
};
pub use retry::RetryPolicy;
pub use testing::{BatchTestRunner, ClientTestSuite, TestResult, TestSummary};
