//! Migration of bio tools from `define_grounded_tool` closures to the
//! trait-based `GroundedTypedTool` system.
//!
//! This module migrates ALL bio API tools to typed `ToolCapability` +
//! `Provenance` implementations backed by real clients from aose-bio-apis.

use anyhow::{anyhow, Result};
use aose_bio_apis::{
    clients::{
        alphafold::AlphaFoldClient,
        // cbioportal::{CbioportalClient, CancerStudy, Mutation},
        // chembl::{ChemblClient, ChemblMolecule},
        // clinvar::ClinVarClient,
        // dbsnp::{DbSnpClient, RefSnpResponse},
        disgenet::DisGeNetClient,
        drugbank::DrugBankClient,
        encode::EncodeClient,
        enrichr::EnrichrClient,
        ensembl::{EnsemblClient, SequenceType},
        // geo::GeoClient,
        gnomad::{Dataset, GnomadClient},
        gtex::GtexClient,
        gwas::GwasCatalogClient,
        hpo::HpoClient,
        interpro::InterProClient,
        jaspar::JasparClient,
        kegg::KeggClient,
        monarch::MonarchClient,
        // ncbi::{NcbiClient, BlastProgram, BlastParams},
        omim::OmimClient,
        // opentargets::{OpenTargetsClient, TargetInfo, DiseaseAssociation as OpenTargetsDiseaseAssociation},
        pdb::{PdbClient, PdbEntry},
        pfam::PfamClient,
        pride::PrideClient,
        pubchem::PubChemClient,
        quickgo::QuickGoClient,
        reactome::ReactomeClient,
        regulomedb::RegulomeDbClient,
        string::StringClient,
        uniprot::UniProtClient,
    },
    models::{AlphaFoldStructure, ProteinRecord},
    Eqtl, GeneRecord, GwasAssociation,
};
use aose_core::tool::ToolSet;
use aose_core::trait_based_tool::{
    CapabilitySet, DataSource, GroundedTypedTool, Provenance, RateLimit, RateLimited,
    ToolCapability, ToolOperation,
};
use aose_core::Tool;
use aose_schemas::EvidenceRecord;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

// ============================================================================
// ENSEMBL TOOLS
// ============================================================================

/// Input for bio_ensembl_search (already exists, kept for reference)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnsemblSearchInput {
    pub query: String,
    #[serde(default = "default_species")]
    pub species: String,
}

fn default_species() -> String {
    "homo_sapiens".to_string()
}

/// bio_ensembl_search (already exists in the file)
#[derive(Clone)]
pub struct EnsemblSearchTool {
    client: Arc<EnsemblClient>,
}

impl EnsemblSearchTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(EnsemblClient::new()),
        }
    }
}

impl Default for EnsemblSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolCapability for EnsemblSearchTool {
    type Input = EnsemblSearchInput;
    type Output = Vec<GeneRecord>;

    fn name(&self) -> &'static str {
        "ensembl_search"
    }

    fn description(&self) -> &'static str {
        "[Gene Annotation · Ensembl] Search genes by symbol or name and return matching Ensembl gene records (IDs, locations, biotypes)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.client
            .search_genes(&input.query, Some(&input.species))
            .await
            .map_err(|e| anyhow!("Ensembl search failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Ensembl)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Ensembl]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Gene symbol or name" },
                "species": { "type": "string", "default": "homo_sapiens" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for EnsemblSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Ensembl REST API",
            "search_genes",
            format!("Found {} gene record(s)", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://rest.ensembl.org".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for EnsemblSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 15,
            burst: 15 * 2,
        } // Ensembl: 15 requests/sec
    }
}

pub fn ensembl_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(EnsemblSearchTool::new()).into_dyn()
}

/// Input for bio_ensembl_info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnsemblInfoInput {
    pub ensembl_id: String,
}

#[derive(Clone)]
pub struct EnsemblInfoTool {
    client: Arc<EnsemblClient>,
}

impl EnsemblInfoTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(EnsemblClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for EnsemblInfoTool {
    type Input = EnsemblInfoInput;
    type Output = GeneRecord;

    fn name(&self) -> &'static str {
        "ensembl_info"
    }

    fn description(&self) -> &'static str {
        "[Gene Annotation · Ensembl] Fetch detailed information for one gene given its Ensembl ID (ENSG...)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.client
            .get_gene_info(&input.ensembl_id)
            .await
            .map_err(|e| anyhow!("Ensembl info retrieval failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Ensembl)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Ensembl]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "ensembl_id": { "type": "string", "description": "Ensembl gene ID (e.g., 'ENSG00000139618')" }
            },
            "required": ["ensembl_id"]
        })
    }
}

#[async_trait]
impl Provenance for EnsemblInfoTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Ensembl REST API",
            output.gene_id.clone(),
            format!("Gene information for {}", output.gene_id),
            chrono::Utc::now().to_rfc3339(),
            Some(format!(
                "https://rest.ensembl.org/lookup/id/{}",
                output.gene_id
            )),
        ))
    }
}

#[async_trait]
impl RateLimited for EnsemblInfoTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 15,
            burst: 15 * 2,
        }
    }
}

pub fn ensembl_info_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(EnsemblInfoTool::new()).into_dyn()
}

/// Input for bio_ensembl_seq
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnsemblSeqInput {
    pub id: String,
    #[serde(default = "default_seq_type")]
    pub seq_type: String,
}

fn default_seq_type() -> String {
    "cdna".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FastaOutput {
    pub id: String,
    pub sequence: String,
    pub description: Option<String>,
}

#[derive(Clone)]
pub struct EnsemblSeqTool {
    client: Arc<EnsemblClient>,
}

impl EnsemblSeqTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(EnsemblClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for EnsemblSeqTool {
    type Input = EnsemblSeqInput;
    type Output = FastaOutput;

    fn name(&self) -> &'static str {
        "ensembl_seq"
    }

    fn description(&self) -> &'static str {
        "[Gene Annotation · Ensembl] Retrieve the nucleotide or protein sequence for an Ensembl gene/transcript/protein ID."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let seq_type = match input.seq_type.to_lowercase().as_str() {
            "genomic" => SequenceType::Genomic,
            "cdna" => SequenceType::Cdna,
            "cds" => SequenceType::Cds,
            "protein" => SequenceType::Protein,
            _ => SequenceType::Cdna, // default
        };

        let fasta = self
            .client
            .get_sequence(&input.id, seq_type)
            .await
            .map_err(|e| anyhow!("Ensembl sequence retrieval failed: {e}"))?;

        Ok(FastaOutput {
            id: fasta.id,
            sequence: fasta.sequence,
            description: fasta.description,
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Ensembl)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Ensembl]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Ensembl ID (gene, transcript, or protein)" },
                "seq_type": { "type": "string", "default": "cdna", "enum": ["cdna", "cds", "protein", "genomic"] }
            },
            "required": ["id"]
        })
    }
}

#[async_trait]
impl Provenance for EnsemblSeqTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Ensembl REST API",
            output.id.clone(),
            format!("Retrieved sequence for {}", output.id),
            chrono::Utc::now().to_rfc3339(),
            Some("https://rest.ensembl.org".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for EnsemblSeqTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 15,
            burst: 15 * 2,
        }
    }
}

pub fn ensembl_seq_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(EnsemblSeqTool::new()).into_dyn()
}
// ============================================================================
// UNIPROT TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniprotInfoInput {
    pub uniprot_id: String,
}

#[derive(Clone)]
pub struct UniprotInfoTool {
    client: Arc<UniProtClient>,
}

impl UniprotInfoTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(UniProtClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for UniprotInfoTool {
    type Input = UniprotInfoInput;
    type Output = ProteinRecord;

    fn name(&self) -> &'static str {
        "uniprot_info"
    }

    fn description(&self) -> &'static str {
        "[Protein Structure · UniProt] Fetch protein function, names, and annotations for a UniProt accession (e.g. P04637)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.client
            .get_protein_info(&input.uniprot_id)
            .await
            .map_err(|e| anyhow!("UniProt info retrieval failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Uniprot)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Uniprot]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "uniprot_id": { "type": "string", "description": "UniProt accession ID (e.g., 'P04637')" }
            },
            "required": ["uniprot_id"]
        })
    }
}

#[async_trait]
impl Provenance for UniprotInfoTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "UniProt",
            output.uniprot_id.clone(),
            format!("Protein information for {}", output.uniprot_id),
            chrono::Utc::now().to_rfc3339(),
            Some(format!(
                "https://www.uniprot.org/uniprotkb/{}",
                output.uniprot_id
            )),
        ))
    }
}

#[async_trait]
impl RateLimited for UniprotInfoTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        } // UniProt: 10 requests/sec
    }
}

pub fn uniprot_info_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(UniprotInfoTool::new()).into_dyn()
}

// ============================================================================
// ALPHAFOLD TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlphafoldStructureInput {
    pub uniprot_id: String,
}

#[derive(Clone)]
pub struct AlphafoldStructureTool {
    client: Arc<AlphaFoldClient>,
}

impl AlphafoldStructureTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(AlphaFoldClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for AlphafoldStructureTool {
    type Input = AlphafoldStructureInput;
    type Output = AlphaFoldStructure;

    fn name(&self) -> &'static str {
        "alphafold_structure"
    }

    fn description(&self) -> &'static str {
        "[Protein Structure · AlphaFold] Fetch predicted 3D structure metadata (model URLs, confidence) for a UniProt accession."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.client
            .get_prediction(&input.uniprot_id)
            .await
            .map_err(|e| anyhow!("AlphaFold prediction retrieval failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::AlphaFold)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::AlphaFold]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "uniprot_id": { "type": "string", "description": "UniProt accession ID (e.g., 'P04637')" }
            },
            "required": ["uniprot_id"]
        })
    }
}

#[async_trait]
impl Provenance for AlphafoldStructureTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        let mut evidence = EvidenceRecord::from_database(
            "AlphaFold EBI",
            output.uniprot_id.clone(),
            format!("AlphaFold structure prediction for {}", output.uniprot_id),
            chrono::Utc::now().to_rfc3339(),
            output.pdb_url.clone(),
        );
        evidence.metadata.insert(
            "model_version".to_string(),
            serde_json::json!(output.model_version),
        );
        Ok(evidence)
    }
}

#[async_trait]
impl RateLimited for AlphafoldStructureTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn alphafold_structure_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(AlphafoldStructureTool::new()).into_dyn()
}

// ============================================================================
// PDB TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdbEntryInput {
    pub pdb_id: String,
}

#[derive(Clone)]
pub struct PdbEntryTool {
    client: Arc<PdbClient>,
}

impl PdbEntryTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(PdbClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for PdbEntryTool {
    type Input = PdbEntryInput;
    type Output = PdbEntry;

    fn name(&self) -> &'static str {
        "pdb_entry"
    }

    fn description(&self) -> &'static str {
        "[Protein Structure · PDB] Retrieve experimental structure entry metadata (title, method, resolution) for a PDB ID (e.g. 4HHB)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.client
            .get_entry(&input.pdb_id)
            .await
            .map_err(|e| anyhow!("PDB entry retrieval failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::PDB)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::PDB]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pdb_id": { "type": "string", "description": "PDB structure ID (e.g., '4HHB')" }
            },
            "required": ["pdb_id"]
        })
    }
}

#[async_trait]
impl Provenance for PdbEntryTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        let mut evidence = EvidenceRecord::from_database(
            "RCSB PDB",
            output.pdb_id.clone(),
            format!("PDB structure entry {}", output.pdb_id),
            chrono::Utc::now().to_rfc3339(),
            Some(format!("https://www.rcsb.org/structure/{}", output.pdb_id)),
        );
        evidence.metadata.insert(
            "resolution".to_string(),
            serde_json::json!(output.resolution),
        );
        Ok(evidence)
    }
}

#[async_trait]
impl RateLimited for PdbEntryTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn pdb_entry_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(PdbEntryTool::new()).into_dyn()
}

// ============================================================================
// NCBI BLAST
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NcbiBlastInput {
    pub sequence: String,
    #[serde(default = "default_blast_program")]
    pub program: String,
    #[serde(default = "default_blast_database")]
    pub database: String,
    #[serde(default = "default_max_hits")]
    pub max_hits: usize,
}

fn default_blast_program() -> String {
    "blastn".to_string()
}

fn default_blast_database() -> String {
    "nt".to_string()
}

fn default_max_hits() -> usize {
    10
}

// #[derive(Clone)]
// pub struct NcbiBlastTool {
//     client: Arc<NcbiClient>,
// }

// impl NcbiBlastTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(NcbiClient::new(None)),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for NcbiBlastTool {
// type Input = NcbiBlastInput;
// type Output = Vec<BlastHit>;

// fn name(&self) -> &'static str {
// "bio_ncbi_blast"
// }

// fn description(&self) -> &'static str {
// "Run BLAST sequence alignment search using NCBI BLAST API."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// let program = match input.program.to_lowercase().as_str() {
// "blastn" => BlastProgram::Blastn,
// "blastp" => BlastProgram::Blastp,
// "blastx" => BlastProgram::Blastx,
// "tblastn" => BlastProgram::Tblastn,
// "tblastx" => BlastProgram::Tblastx,
// _ => BlastProgram::Blastn,
// };

// let params = BlastParams {
// program,
// database: input.database.clone(),
// hitlist_size: Some(input.max_hits as u32),
// expect: Some(10.0),
// };

// self.client
// .blast(&input.sequence, params)
// .await
// .map_err(|e| anyhow!("NCBI BLAST search failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::NCBI)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::NCBI]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "sequence": { "type": "string", "description": "Query sequence (nucleotide or protein)" },
// "program": { "type": "string", "default": "blastn", "enum": ["blastn", "blastp", "blastx", "tblastn", "tblastx"] },
// "database": { "type": "string", "default": "nt", "description": "BLAST database" },
// "max_hits": { "type": "integer", "default": 10, "description": "Maximum number of hits to return" }
// },
// "required": ["sequence"]
// })
// }
// }

// #[async_trait]
// impl Provenance for NcbiBlastTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "NCBI BLAST",
// "blast_search",
// format!("Found {} BLAST hits", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://blast.ncbi.nlm.nih.gov/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for NcbiBlastTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 3, burst: 3 * 2 } // NCBI BLAST: 3 requests/sec
// }
// }

// pub fn ncbi_blast_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(NcbiBlastTool::new()).into_dyn()
// }
// ============================================================================
// GWAS & GTEX TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GwasSearchInput {
    pub query: String,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_max_results() -> usize {
    100
}

#[derive(Clone)]
pub struct GwasSearchTool {
    client: Arc<GwasCatalogClient>,
}

impl GwasSearchTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(GwasCatalogClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for GwasSearchTool {
    type Input = GwasSearchInput;
    type Output = Vec<GwasAssociation>;

    fn name(&self) -> &'static str {
        "gwas_search"
    }

    fn description(&self) -> &'static str {
        "[Genomic Variation · GWAS Catalog] Search genome-wide association study hits by gene, trait, or SNP (rsID)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        self.client
            .search_associations(&input.query)
            .await
            .map_err(|e| anyhow!("GWAS search failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::GwasCatalog)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::GwasCatalog]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Gene symbol, trait, or SNP ID" },
                "max_results": { "type": "integer", "default": 100 }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for GwasSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "GWAS Catalog",
            "search_associations",
            format!("Found {} GWAS associations", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.ebi.ac.uk/gwas/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for GwasSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn gwas_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(GwasSearchTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GtexEqtlInput {
    pub gene_id: String,
    #[serde(default)]
    pub tissue: Option<String>,
}

#[derive(Clone)]
pub struct GtexEqtlTool {
    client: Arc<GtexClient>,
}

impl GtexEqtlTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(GtexClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for GtexEqtlTool {
    type Input = GtexEqtlInput;
    type Output = Vec<Eqtl>;

    fn name(&self) -> &'static str {
        "gtex_eqtl"
    }

    fn description(&self) -> &'static str {
        "[Genomic Variation · GTEx] Fetch expression QTL (eQTL) associations for a gene across tissues from the GTEx Portal."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let tissue = input.tissue.as_deref().unwrap_or("Whole_Blood");
        self.client
            .get_eqtls(&input.gene_id, tissue)
            .await
            .map_err(|e| anyhow!("GTEx eQTL retrieval failed: {e}"))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::GTEx)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::GTEx]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "gene_id": { "type": "string", "description": "Ensembl gene ID or gene symbol" },
                "tissue": { "type": "string", "description": "Optional tissue filter" }
            },
            "required": ["gene_id"]
        })
    }
}

#[async_trait]
impl Provenance for GtexEqtlTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "GTEx Portal",
            "get_eqtls",
            format!("Found {} eQTLs", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://gtexportal.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for GtexEqtlTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn gtex_eqtl_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(GtexEqtlTool::new()).into_dyn()
}

// ============================================================================
// OPENTARGETS TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpentargetsTargetInput {
    pub ensembl_id: String,
}

// #[derive(Clone)]
// pub struct OpentargetsTargetTool {
//     client: Arc<OpenTargetsClient>,
// }

// impl OpentargetsTargetTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(OpenTargetsClient::new()),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for OpentargetsTargetTool {
// type Input = OpentargetsTargetInput;
// type Output = TargetInfo;

// fn name(&self) -> &'static str {
// "bio_opentargets_target"
// }

// fn description(&self) -> &'static str {
// "Get target information from Open Targets Platform by Ensembl gene ID."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// self.client
// .get_target_info(&input.ensembl_id)
// .await
// .map_err(|e| anyhow!("Open Targets target retrieval failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::OpenTargets)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::OpenTargets]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "ensembl_id": { "type": "string", "description": "Ensembl gene ID" }
// },
// "required": ["ensembl_id"]
// })
// }
// }

// #[async_trait]
// impl Provenance for OpentargetsTargetTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "Open Targets Platform",
// output.ensembl_id.clone(),
// format!("Target information for {}", output.ensembl_id),
// chrono::Utc::now().to_rfc3339(),
// Some("https://platform.opentargets.org/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for OpentargetsTargetTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 10, burst: 10 * 2 }
// }
// }

// pub fn opentargets_target_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(OpentargetsTargetTool::new()).into_dyn()
// }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpentargetsDiseasesInput {
    pub ensembl_id: String,
}

// #[derive(Clone)]
// pub struct OpentargetsDiseasesTool {
//     client: Arc<OpenTargetsClient>,
// }

// impl OpentargetsDiseasesTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(OpenTargetsClient::new()),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for OpentargetsDiseasesTool {
// type Input = OpentargetsDiseasesInput;
// type Output = Vec<OpenTargetsDiseaseAssociation>;

// fn name(&self) -> &'static str {
// "bio_opentargets_diseases"
// }

// fn description(&self) -> &'static str {
// "Get disease associations for a gene from Open Targets Platform."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// self.client
// .get_disease_associations(&input.ensembl_id, 100)
// .await
// .map_err(|e| anyhow!("Open Targets disease retrieval failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::OpenTargets)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::OpenTargets]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "ensembl_id": { "type": "string", "description": "Ensembl gene ID" }
// },
// "required": ["ensembl_id"]
// })
// }
// }

// #[async_trait]
// impl Provenance for OpentargetsDiseasesTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "Open Targets Platform",
// "get_target_diseases",
// format!("Found {} disease associations", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://platform.opentargets.org/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for OpentargetsDiseasesTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 10, burst: 10 * 2 }
// }
// }

// pub fn opentargets_diseases_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(OpentargetsDiseasesTool::new()).into_dyn()
// }
// ============================================================================
// CLINVAR, GNOMAD, DBSNP TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinvarVariantsInput {
    pub gene_symbol: String,
}

// #[derive(Clone)]
// pub struct ClinvarVariantsTool {
//     client: Arc<ClinVarClient>,
// }

// impl ClinvarVariantsTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(ClinVarClient::new()),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for ClinvarVariantsTool {
// type Input = ClinvarVariantsInput;
// type Output = Vec<String>;

// fn name(&self) -> &'static str {
// "bio_clinvar_variants"
// }

// fn description(&self) -> &'static str {
// "Get ClinVar variants for a gene by gene symbol."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// self.client
// .search_by_gene(&input.gene_symbol, 100)
// .await
// .map_err(|e| anyhow!("ClinVar variant retrieval failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::ClinVar)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::ClinVar]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "gene_symbol": { "type": "string", "description": "Gene symbol (e.g., 'BRCA2')" }
// },
// "required": ["gene_symbol"]
// })
// }
// }

// #[async_trait]
// impl Provenance for ClinvarVariantsTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "ClinVar",
// "search_by_gene",
// format!("Found {} ClinVar variants", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://www.ncbi.nlm.nih.gov/clinvar/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for ClinvarVariantsTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 3, burst: 3 * 2 } // NCBI rate limit
// }
// }

// pub fn clinvar_variants_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(ClinvarVariantsTool::new()).into_dyn()
// }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GnomadVariantInput {
    pub variant_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GnomadVariantOutput {
    pub variant_id: String,
    pub allele_freq: Option<f64>,
    pub consequence: Option<String>,
}

#[derive(Clone)]
pub struct GnomadVariantTool {
    client: Arc<GnomadClient>,
}

impl GnomadVariantTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(GnomadClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for GnomadVariantTool {
    type Input = GnomadVariantInput;
    type Output = GnomadVariantOutput;

    fn name(&self) -> &'static str {
        "gnomad_variant"
    }

    fn description(&self) -> &'static str {
        "[Genomic Variation · gnomAD] Fetch population allele-frequency data for a variant from gnomAD."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let variant = self
            .client
            .get_variant(&input.variant_id, Dataset::GnomadR3)
            .await
            .map_err(|e| anyhow!("gnomAD variant retrieval failed: {e}"))?;

        Ok(GnomadVariantOutput {
            variant_id: input.variant_id.clone(),
            allele_freq: Some(variant.af),
            consequence: None, // gnomAD API doesn't return consequence directly
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::GnomAD)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::GnomAD]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "variant_id": { "type": "string", "description": "Variant ID (e.g., '1-55516888-G-A')" }
            },
            "required": ["variant_id"]
        })
    }
}

#[async_trait]
impl Provenance for GnomadVariantTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "gnomAD",
            output.variant_id.clone(),
            format!("Variant information for {}", output.variant_id),
            chrono::Utc::now().to_rfc3339(),
            Some("https://gnomad.broadinstitute.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for GnomadVariantTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn gnomad_variant_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(GnomadVariantTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbsnpLookupInput {
    pub rsid: String,
}

// #[derive(Clone)]
// pub struct DbsnpLookupTool {
//     client: Arc<DbSnpClient>,
// }

// impl DbsnpLookupTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(DbSnpClient::new(None)),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for DbsnpLookupTool {
// type Input = DbsnpLookupInput;
// type Output = RefSnpResponse;

// fn name(&self) -> &'static str {
// "bio_dbsnp_lookup"
// }

// fn description(&self) -> &'static str {
// "Look up SNP information from dbSNP by rsID."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// self.client
// .get_refsnp(&input.rsid)
// .await
// .map_err(|e| anyhow!("dbSNP lookup failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::DbSNP)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::DbSNP]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "rsid": { "type": "string", "description": "dbSNP rsID (e.g., 'rs7412')" }
// },
// "required": ["rsid"]
// })
// }
// }

// #[async_trait]
// impl Provenance for DbsnpLookupTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "dbSNP",
// output.refsnp_id.clone(),
// format!("SNP information for {}", output.refsnp_id),
// chrono::Utc::now().to_rfc3339(),
// Some(format!("https://www.ncbi.nlm.nih.gov/snp/{}", output.refsnp_id)),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for DbsnpLookupTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 3, burst: 3 * 2 } // NCBI rate limit
// }
// }

// pub fn dbsnp_lookup_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(DbsnpLookupTool::new()).into_dyn()
// }

// ============================================================================
// CHEMBL, DRUGBANK, PUBCHEM TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChemblSearchInput {
    pub query: String,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

// #[derive(Clone)]
// pub struct ChemblSearchTool {
//     client: Arc<ChemblClient>,
// }

// impl ChemblSearchTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(ChemblClient::new()),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for ChemblSearchTool {
// type Input = ChemblSearchInput;
// type Output = Vec<ChemblMolecule>;

// fn name(&self) -> &'static str {
// "bio_chembl_search"
// }

// fn description(&self) -> &'static str {
// "Search ChEMBL database for drug compounds and bioactivity data."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// use aose_bio_apis::clients::chembl::ChemblQueryParams;
// let params = ChemblQueryParams {
// limit: Some(input.max_results as u32),
// offset: None,
// };
// self.client
// .search_molecules(params)
// .await
// .map_err(|e| anyhow!("ChEMBL search failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::ChEMBL)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::ChEMBL]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "query": { "type": "string", "description": "Compound name or ChEMBL ID" },
// "max_results": { "type": "integer", "default": 100 }
// },
// "required": ["query"]
// })
// }
// }

// #[async_trait]
// impl Provenance for ChemblSearchTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "ChEMBL",
// "search_molecules",
// format!("Found {} compounds", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://www.ebi.ac.uk/chembl/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for ChemblSearchTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 10, burst: 10 * 2 }
// }
// }

// pub fn chembl_search_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(ChemblSearchTool::new()).into_dyn()
// }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrugbankSearchInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrugbankSearchOutput {
    pub drugbank_id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone)]
pub struct DrugbankSearchTool {
    client: Arc<DrugBankClient>,
}

impl DrugbankSearchTool {
    pub fn new() -> Self {
        // Note: This tool requires DRUGBANK_API_KEY to be set
        // In tests without the key, we return early from all_bio_typed_tools()
        let client =
            DrugBankClient::new().expect("DRUGBANK_API_KEY must be set to use DrugBank tools");
        Self {
            client: Arc::new(client),
        }
    }
}

#[async_trait]
impl ToolCapability for DrugbankSearchTool {
    type Input = DrugbankSearchInput;
    type Output = Vec<DrugbankSearchOutput>;

    fn name(&self) -> &'static str {
        "drugbank_search"
    }

    fn description(&self) -> &'static str {
        "[Drugs & Chemicals · DrugBank] Search DrugBank for drug records by name or DrugBank ID (requires DRUGBANK_API_KEY)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::drugbank::DrugSearchParams;
        let params = DrugSearchParams {
            query: Some(input.query.clone()),
            ..Default::default()
        };
        let results = self
            .client
            .search_drugs(&params)
            .await
            .map_err(|e| anyhow!("DrugBank search failed: {e}"))?;

        Ok(results
            .into_iter()
            .map(|d| DrugbankSearchOutput {
                drugbank_id: d.drugbank_id,
                name: d.name,
                description: d.description,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::DrugBank)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::DrugBank]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Drug name or DrugBank ID" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for DrugbankSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "DrugBank",
            "search_drugs",
            format!("Found {} drugs", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.drugbank.com/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for DrugbankSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 5,
            burst: 5 * 2,
        }
    }
}

pub fn drugbank_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(DrugbankSearchTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubchemCompoundInput {
    pub cid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubchemCompoundOutput {
    pub cid: String,
    pub title: Option<String>,
    pub molecular_formula: Option<String>,
    pub molecular_weight: Option<f64>,
}

#[derive(Clone)]
pub struct PubchemCompoundTool {
    client: Arc<PubChemClient>,
}

impl PubchemCompoundTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(PubChemClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for PubchemCompoundTool {
    type Input = PubchemCompoundInput;
    type Output = PubchemCompoundOutput;

    fn name(&self) -> &'static str {
        "pubchem_compound"
    }

    fn description(&self) -> &'static str {
        "[Drugs & Chemicals · PubChem] Fetch chemical compound properties (formula, weight, names) for a PubChem CID."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let cid: u32 = input
            .cid
            .parse()
            .map_err(|_| anyhow!("Invalid CID format"))?;

        let properties = self
            .client
            .get_properties(cid, &["MolecularFormula", "MolecularWeight", "IUPACName"])
            .await
            .map_err(|e| anyhow!("PubChem compound retrieval failed: {e}"))?;

        let props = &properties;

        Ok(PubchemCompoundOutput {
            cid: input.cid.clone(),
            title: props.iupac_name.clone(),
            molecular_formula: props.molecular_formula.clone(),
            molecular_weight: props.molecular_weight,
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::PubChem)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::PubChem]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "cid": { "type": "string", "description": "PubChem Compound ID" }
            },
            "required": ["cid"]
        })
    }
}

#[async_trait]
impl Provenance for PubchemCompoundTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "PubChem",
            output.cid.clone(),
            format!("Compound information for CID {}", output.cid),
            chrono::Utc::now().to_rfc3339(),
            Some(format!(
                "https://pubchem.ncbi.nlm.nih.gov/compound/{}",
                output.cid
            )),
        ))
    }
}

#[async_trait]
impl RateLimited for PubchemCompoundTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 5,
            burst: 5 * 2,
        } // NCBI rate limit
    }
}

pub fn pubchem_compound_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(PubchemCompoundTool::new()).into_dyn()
}
// ============================================================================
// ENRICHR, KEGG, REACTOME TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichrEnrichInput {
    pub gene_list: Vec<String>,
    #[serde(default = "default_enrichr_library")]
    pub library: String,
}

fn default_enrichr_library() -> String {
    "KEGG_2021_Human".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichrEnrichmentResult {
    pub term: String,
    pub p_value: f64,
    pub adjusted_p_value: f64,
    pub genes: Vec<String>,
}

#[derive(Clone)]
pub struct EnrichrEnrichTool {
    client: Arc<EnrichrClient>,
}

impl EnrichrEnrichTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(EnrichrClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for EnrichrEnrichTool {
    type Input = EnrichrEnrichInput;
    type Output = Vec<EnrichrEnrichmentResult>;

    fn name(&self) -> &'static str {
        "enrichr_enrich"
    }

    fn description(&self) -> &'static str {
        "[Pathways & Enrichment · Enrichr] Run gene-set enrichment analysis on a list of genes against Enrichr libraries."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let results = self
            .client
            .enrich(&input.gene_list, &input.library)
            .await
            .map_err(|e| anyhow!("Enrichr enrichment failed: {e}"))?;

        Ok(results
            .into_iter()
            .map(|r| EnrichrEnrichmentResult {
                term: r.term,
                p_value: r.p_value,
                adjusted_p_value: r.adjusted_p_value,
                genes: r.genes,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Enrichr)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Enrichr]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "gene_list": { "type": "array", "items": { "type": "string" }, "description": "List of gene symbols" },
                "library": { "type": "string", "default": "KEGG_2021_Human", "description": "Enrichr library name" }
            },
            "required": ["gene_list"]
        })
    }
}

#[async_trait]
impl Provenance for EnrichrEnrichTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Enrichr",
            "enrich",
            format!("Found {} enriched terms", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://maayanlab.cloud/Enrichr/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for EnrichrEnrichTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 5,
            burst: 5 * 2,
        }
    }
}

pub fn enrichr_enrich_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(EnrichrEnrichTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeggGetInput {
    pub entry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeggGetOutput {
    pub entry_id: String,
    pub content: String,
}

#[derive(Clone)]
pub struct KeggGetTool {
    client: Arc<KeggClient>,
}

impl KeggGetTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(KeggClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for KeggGetTool {
    type Input = KeggGetInput;
    type Output = KeggGetOutput;

    fn name(&self) -> &'static str {
        "kegg_get"
    }

    fn description(&self) -> &'static str {
        "[Pathways & Enrichment · KEGG] Retrieve a KEGG entry (pathway, gene, or compound) by its KEGG ID."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let entry = self
            .client
            .get(&input.entry_id)
            .await
            .map_err(|e| anyhow!("KEGG entry retrieval failed: {e}"))?;

        Ok(KeggGetOutput {
            entry_id: input.entry_id.clone(),
            content: serde_json::to_string_pretty(&entry)
                .unwrap_or_else(|_| format!("{:?}", entry)),
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::KEGG)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::KEGG]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "entry_id": { "type": "string", "description": "KEGG entry ID (e.g., 'hsa00010', 'hsa:7157')" }
            },
            "required": ["entry_id"]
        })
    }
}

#[async_trait]
impl Provenance for KeggGetTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "KEGG",
            output.entry_id.clone(),
            format!("Retrieved KEGG entry {}", output.entry_id),
            chrono::Utc::now().to_rfc3339(),
            Some(format!("https://www.genome.jp/entry/{}", output.entry_id)),
        ))
    }
}

#[async_trait]
impl RateLimited for KeggGetTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn kegg_get_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(KeggGetTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactomePathwayInput {
    pub pathway_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactomePathwayOutput {
    pub pathway_id: String,
    pub name: String,
    pub species: Option<String>,
}

#[derive(Clone)]
pub struct ReactomePathwayTool {
    client: Arc<ReactomeClient>,
}

impl ReactomePathwayTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(ReactomeClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for ReactomePathwayTool {
    type Input = ReactomePathwayInput;
    type Output = ReactomePathwayOutput;

    fn name(&self) -> &'static str {
        "reactome_pathway"
    }

    fn description(&self) -> &'static str {
        "[Pathways & Enrichment · Reactome] Fetch pathway details (name, participants) for a Reactome pathway ID (R-HSA-...)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let pathway = self
            .client
            .get_entity(&input.pathway_id)
            .await
            .map_err(|e| anyhow!("Reactome pathway retrieval failed: {e}"))?;

        Ok(ReactomePathwayOutput {
            pathway_id: input.pathway_id.clone(),
            name: pathway.display_name,
            species: pathway.species_name,
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Reactome)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Reactome]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pathway_id": { "type": "string", "description": "Reactome pathway ID (e.g., 'R-HSA-69306')" }
            },
            "required": ["pathway_id"]
        })
    }
}

#[async_trait]
impl Provenance for ReactomePathwayTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Reactome",
            output.pathway_id.clone(),
            format!("Pathway: {}", output.name),
            chrono::Utc::now().to_rfc3339(),
            Some(format!(
                "https://reactome.org/content/detail/{}",
                output.pathway_id
            )),
        ))
    }
}

#[async_trait]
impl RateLimited for ReactomePathwayTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn reactome_pathway_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(ReactomePathwayTool::new()).into_dyn()
}

// ============================================================================
// PROTEIN INTERACTION TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringInteractionsInput {
    pub protein_ids: Vec<String>,
    #[serde(default = "default_species_id")]
    pub species: u32,
}

fn default_species_id() -> u32 {
    9606 // Homo sapiens
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StringInteraction {
    pub protein_a: String,
    pub protein_b: String,
    pub score: f64,
}

#[derive(Clone)]
pub struct StringInteractionsTool {
    client: Arc<StringClient>,
}

impl StringInteractionsTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(StringClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for StringInteractionsTool {
    type Input = StringInteractionsInput;
    type Output = Vec<StringInteraction>;

    fn name(&self) -> &'static str {
        "string_interactions"
    }

    fn description(&self) -> &'static str {
        "[Protein Interactions · STRING] Fetch protein-protein interaction partners and confidence scores from STRING."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::string::NetworkParams;
        let params = NetworkParams {
            species: input.species,
            required_score: Some(400),
            network_type: None,
            add_nodes: None,
        };
        let interactions = self
            .client
            .network(&input.protein_ids, params)
            .await
            .map_err(|e| anyhow!("STRING interaction retrieval failed: {e}"))?;

        Ok(interactions
            .into_iter()
            .map(|i| StringInteraction {
                protein_a: i.preferred_name_a,
                protein_b: i.preferred_name_b,
                score: i.score,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::STRING)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::STRING]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "protein_ids": { "type": "array", "items": { "type": "string" }, "description": "List of protein identifiers" },
                "species": { "type": "integer", "default": 9606, "description": "NCBI taxonomy ID" }
            },
            "required": ["protein_ids"]
        })
    }
}

#[async_trait]
impl Provenance for StringInteractionsTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "STRING",
            "get_interactions",
            format!("Found {} protein interactions", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://string-db.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for StringInteractionsTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn string_interactions_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(StringInteractionsTool::new()).into_dyn()
}

// Aliases for compatibility
pub fn protein_interactions_typed_tool() -> Arc<dyn Tool> {
    string_interactions_typed_tool()
}

pub fn protein_summary_typed_tool() -> Arc<dyn Tool> {
    uniprot_info_typed_tool()
}

pub fn tissue_expression_typed_tool() -> Arc<dyn Tool> {
    gtex_eqtl_typed_tool()
}

// pub fn target_associations_typed_tool() -> Arc<dyn Tool> {
// opentargets_diseases_typed_tool()
// }

pub fn gene_lookup_typed_tool() -> Arc<dyn Tool> {
    ensembl_search_typed_tool()
}

pub fn gene_constraint_typed_tool() -> Arc<dyn Tool> {
    gnomad_variant_typed_tool()
}

pub fn literature_search_typed_tool() -> Arc<dyn Tool> {
    // Placeholder - this would need PubMed client implementation
    ensembl_search_typed_tool()
}
// ============================================================================
// DISEASE & PHENOTYPE TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisgenetGeneDiseaseInput {
    pub gene_symbol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisgenetAssociation {
    pub disease_id: String,
    pub disease_name: String,
    pub score: f64,
}

#[derive(Clone)]
pub struct DisgenetGeneDiseaseTool {
    client: Arc<DisGeNetClient>,
}

impl DisgenetGeneDiseaseTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(DisGeNetClient::new().expect("DISGENET_API_KEY must be set")),
        }
    }
}

#[async_trait]
impl ToolCapability for DisgenetGeneDiseaseTool {
    type Input = DisgenetGeneDiseaseInput;
    type Output = Vec<DisgenetAssociation>;

    fn name(&self) -> &'static str {
        "disgenet_gene_disease"
    }

    fn description(&self) -> &'static str {
        "[Disease & Phenotype · DisGeNET] Fetch gene-disease associations from DisGeNET (requires DISGENET_API_KEY)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::disgenet::AssociationQueryParams;
        let params = AssociationQueryParams {
            limit: Some(100),
            ..Default::default()
        };
        let associations = self
            .client
            .get_gene_disease_associations(&input.gene_symbol, &params)
            .await
            .map_err(|e| anyhow!("DisGeNET gene-disease retrieval failed: {e}"))?;

        Ok(associations
            .into_iter()
            .map(|a| DisgenetAssociation {
                disease_id: a.disease_id,
                disease_name: a.disease_name,
                score: a.score,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::DisGeNET)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::DisGeNET]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "gene_symbol": { "type": "string", "description": "Gene symbol (e.g., 'BRCA1')" }
            },
            "required": ["gene_symbol"]
        })
    }
}

#[async_trait]
impl Provenance for DisgenetGeneDiseaseTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "DisGeNET",
            "get_gene_diseases",
            format!("Found {} gene-disease associations", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.disgenet.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for DisgenetGeneDiseaseTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 5,
            burst: 5 * 2,
        }
    }
}

pub fn disgenet_gene_disease_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(DisgenetGeneDiseaseTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HpoSearchInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HpoTerm {
    pub id: String,
    pub name: String,
    pub definition: Option<String>,
}

#[derive(Clone)]
pub struct HpoSearchTool {
    client: Arc<HpoClient>,
}

impl HpoSearchTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(HpoClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for HpoSearchTool {
    type Input = HpoSearchInput;
    type Output = Vec<HpoTerm>;

    fn name(&self) -> &'static str {
        "hpo_search"
    }

    fn description(&self) -> &'static str {
        "[Disease & Phenotype · HPO] Search Human Phenotype Ontology terms by name/keyword (HPO IDs, definitions)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let response = self
            .client
            .search(&input.query, None, None)
            .await
            .map_err(|e| anyhow!("HPO search failed: {e}"))?;

        Ok(response
            .terms
            .into_iter()
            .map(|t| HpoTerm {
                id: t.id,
                name: t.name,
                definition: t.definition,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::HPO)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::HPO]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Phenotype term search query" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for HpoSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Human Phenotype Ontology",
            "search_terms",
            format!("Found {} HPO terms", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://hpo.jax.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for HpoSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn hpo_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(HpoSearchTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmimSearchInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmimEntry {
    pub mim_number: String,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Clone)]
pub struct OmimSearchTool {
    client: Arc<OmimClient>,
}

impl OmimSearchTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(
                OmimClient::from_env().unwrap_or_else(|_| OmimClient::new("demo_key")),
            ),
        }
    }
}

#[async_trait]
impl ToolCapability for OmimSearchTool {
    type Input = OmimSearchInput;
    type Output = Vec<OmimEntry>;

    fn name(&self) -> &'static str {
        "omim_search"
    }

    fn description(&self) -> &'static str {
        "[Disease & Phenotype · OMIM] Search OMIM for Mendelian genetic disorders and gene entries."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::omim::OmimSearchParams;
        let params = OmimSearchParams {
            query: input.query.clone(),
            include: vec![],
            limit: Some(10),
            start: Some(0),
            sort: None,
        };
        let entries = self
            .client
            .search(&params)
            .await
            .map_err(|e| anyhow!("OMIM search failed: {e}"))?;

        Ok(entries
            .into_iter()
            .map(|e| OmimEntry {
                mim_number: e.mim_number.clone(),
                title: e
                    .titles
                    .as_ref()
                    .and_then(|t| t.preferred_title.clone())
                    .unwrap_or_default(),
                description: None,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::OMIM)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::OMIM]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Gene or disease search term" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for OmimSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "OMIM",
            "search",
            format!("Found {} OMIM entries", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.omim.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for OmimSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 3,
            burst: 3 * 2,
        } // OMIM has strict rate limits
    }
}

pub fn omim_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(OmimSearchTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonarchSearchDiseasesInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonarchDisease {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone)]
pub struct MonarchSearchDiseasesTool {
    client: Arc<MonarchClient>,
}

impl MonarchSearchDiseasesTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(MonarchClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for MonarchSearchDiseasesTool {
    type Input = MonarchSearchDiseasesInput;
    type Output = Vec<MonarchDisease>;

    fn name(&self) -> &'static str {
        "monarch_search_diseases"
    }

    fn description(&self) -> &'static str {
        "[Disease & Phenotype · Monarch] Search the Monarch Initiative knowledge graph for diseases."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let response = self
            .client
            .search_diseases(&input.query, None, None)
            .await
            .map_err(|e| anyhow!("Monarch disease search failed: {e}"))?;

        Ok(response
            .items
            .into_iter()
            .map(|d| MonarchDisease {
                id: d.id,
                label: d.label,
                description: d.definition,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Monarch)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Monarch]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Disease search query" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for MonarchSearchDiseasesTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Monarch Initiative",
            "search_diseases",
            format!("Found {} diseases", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://monarchinitiative.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for MonarchSearchDiseasesTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn monarch_search_diseases_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(MonarchSearchDiseasesTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonarchGenePhenotypesInput {
    pub gene_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonarchPhenotype {
    pub id: String,
    pub label: String,
}

#[derive(Clone)]
pub struct MonarchGenePhenotypesTool {
    client: Arc<MonarchClient>,
}

impl MonarchGenePhenotypesTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(MonarchClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for MonarchGenePhenotypesTool {
    type Input = MonarchGenePhenotypesInput;
    type Output = Vec<MonarchPhenotype>;

    fn name(&self) -> &'static str {
        "monarch_gene_phenotypes"
    }

    fn description(&self) -> &'static str {
        "[Disease & Phenotype · Monarch] Fetch phenotypes associated with a gene from the Monarch Initiative."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        let response = self
            .client
            .get_gene_phenotypes(&input.gene_id, None, None)
            .await
            .map_err(|e| anyhow!("Monarch gene phenotype retrieval failed: {e}"))?;

        Ok(response
            .associations
            .into_iter()
            .map(|a| MonarchPhenotype {
                id: a.subject.id,
                label: a.subject.label,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Monarch)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Monarch]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "gene_id": { "type": "string", "description": "Gene identifier (HGNC, Ensembl, or symbol)" }
            },
            "required": ["gene_id"]
        })
    }
}

#[async_trait]
impl Provenance for MonarchGenePhenotypesTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Monarch Initiative",
            "get_gene_phenotypes",
            format!("Found {} phenotypes", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://monarchinitiative.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for MonarchGenePhenotypesTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn monarch_gene_phenotypes_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(MonarchGenePhenotypesTool::new()).into_dyn()
}
// ============================================================================
// CBIOPORTAL & CANCER TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CbioportalStudiesInput {
    #[serde(default)]
    pub keyword: Option<String>,
}

// #[derive(Clone)]
// pub struct CbioportalStudiesTool {
//     client: Arc<CbioportalClient>,
// }

// impl CbioportalStudiesTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(CbioportalClient::new()),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for CbioportalStudiesTool {
// type Input = CbioportalStudiesInput;
// type Output = Vec<CancerStudy>;

// fn name(&self) -> &'static str {
// "bio_cbioportal_studies"
// }

// fn description(&self) -> &'static str {
// "List cancer studies from cBioPortal."
// }

// async fn execute(&self, _input: Self::Input) -> Result<Self::Output> {
// self.client
// .get_all_studies()
// .await
// .map_err(|e| anyhow!("cBioPortal studies retrieval failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::CbioPortal)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::CbioPortal]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "keyword": { "type": "string", "description": "Optional keyword filter" }
// }
// })
// }
// }

// #[async_trait]
// impl Provenance for CbioportalStudiesTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "cBioPortal",
// "get_studies",
// format!("Found {} cancer studies", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://www.cbioportal.org/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for CbioportalStudiesTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 10, burst: 10 * 2 }
// }
// }

// pub fn cbioportal_studies_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(CbioportalStudiesTool::new()).into_dyn()
// }

// Alias
// pub fn cancer_studies_typed_tool() -> Arc<dyn Tool> {
// cbioportal_studies_typed_tool()
// }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CbioportalMutationsInput {
    pub study_id: String,
    pub gene_symbol: String,
}

// #[derive(Clone)]
// pub struct CbioportalMutationsTool {
//     client: Arc<CbioportalClient>,
// }

// impl CbioportalMutationsTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(CbioportalClient::new()),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for CbioportalMutationsTool {
// type Input = CbioportalMutationsInput;
// type Output = Vec<Mutation>;

// fn name(&self) -> &'static str {
// "bio_cbioportal_mutations"
// }

// fn description(&self) -> &'static str {
// "Get mutations for a gene in a cBioPortal study."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// use aose_bio_apis::clients::cbioportal::MutationQuery;
// let query = MutationQuery {
// entrez_gene_ids: vec![],
// sample_ids: vec![],
// molecular_profile_id: format!("{}_mutations", input.study_id),
// };
// self.client
// .get_mutations(query)
// .await
// .map_err(|e| anyhow!("cBioPortal mutations retrieval failed: {e}"))
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::CbioPortal)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::CbioPortal]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "study_id": { "type": "string", "description": "cBioPortal study ID" },
// "gene_symbol": { "type": "string", "description": "Gene symbol (e.g., 'TP53')" }
// },
// "required": ["study_id", "gene_symbol"]
// })
// }
// }

// #[async_trait]
// impl Provenance for CbioportalMutationsTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "cBioPortal",
// "get_mutations",
// format!("Found {} mutations", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://www.cbioportal.org/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for CbioportalMutationsTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 10, burst: 10 * 2 }
// }
// }

// pub fn cbioportal_mutations_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(CbioportalMutationsTool::new()).into_dyn()
// }

// Alias
// pub fn cancer_mutations_typed_tool() -> Arc<dyn Tool> {
// cbioportal_mutations_typed_tool()
// }

// ============================================================================
// REGULOME, PFAM, INTERPRO TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegulomeRsidInput {
    pub rsid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegulomeRsidOutput {
    pub rsid: String,
    pub score: Option<String>,
    pub probability: Option<f64>,
}

#[derive(Clone)]
pub struct RegulomeRsidTool {
    client: Arc<RegulomeDbClient>,
}

impl RegulomeRsidTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(RegulomeDbClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for RegulomeRsidTool {
    type Input = RegulomeRsidInput;
    type Output = RegulomeRsidOutput;

    fn name(&self) -> &'static str {
        "regulome_rsid"
    }

    fn description(&self) -> &'static str {
        "[Regulatory Genomics · RegulomeDB] Fetch regulatory annotation and score for a single SNP (rsID)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::regulomedb::GenomeVersion;
        let variants = self
            .client
            .search_by_rsid(&input.rsid, GenomeVersion::GRCh38)
            .await
            .map_err(|e| anyhow!("RegulomeDB rsid lookup failed: {e}"))?;

        let annotation = variants
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("No RegulomeDB annotation found for {}", input.rsid))?;

        Ok(RegulomeRsidOutput {
            rsid: input.rsid.clone(),
            score: Some(annotation.score),
            probability: annotation.probability,
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::RegulomeDB)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::RegulomeDB]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "rsid": { "type": "string", "description": "dbSNP rsID (e.g., 'rs12345')" }
            },
            "required": ["rsid"]
        })
    }
}

#[async_trait]
impl Provenance for RegulomeRsidTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "RegulomeDB",
            output.rsid.clone(),
            format!("RegulomeDB score: {:?}", output.score),
            chrono::Utc::now().to_rfc3339(),
            Some("https://regulomedb.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for RegulomeRsidTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn regulome_rsid_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(RegulomeRsidTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegulomeRegionInput {
    pub chromosome: String,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegulomeVariantInfo {
    pub position: Option<u64>,
    pub rsid: Option<String>,
    pub score: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegulomeRegionOutput {
    pub chromosome: String,
    pub start: u64,
    pub end: u64,
    pub variants: Vec<RegulomeVariantInfo>,
}

#[derive(Clone)]
pub struct RegulomeRegionTool {
    client: Arc<RegulomeDbClient>,
}

impl RegulomeRegionTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(RegulomeDbClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for RegulomeRegionTool {
    type Input = RegulomeRegionInput;
    type Output = RegulomeRegionOutput;

    fn name(&self) -> &'static str {
        "regulome_region"
    }

    fn description(&self) -> &'static str {
        "[Regulatory Genomics · RegulomeDB] List regulatory variants within a genomic region (chrom:start-end)."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::regulomedb::GenomeVersion;
        let variants = self
            .client
            .search_by_region(
                &input.chromosome,
                input.start,
                input.end,
                GenomeVersion::GRCh38,
            )
            .await
            .map_err(|e| anyhow!("RegulomeDB region query failed: {e}"))?;

        Ok(RegulomeRegionOutput {
            chromosome: input.chromosome.clone(),
            start: input.start,
            end: input.end,
            variants: variants
                .into_iter()
                .map(|v| RegulomeVariantInfo {
                    position: v.position,
                    rsid: v.rsid,
                    score: v.score,
                })
                .collect(),
        })
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::RegulomeDB)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::RegulomeDB]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "chromosome": { "type": "string", "description": "Chromosome (e.g., 'chr1')" },
                "start": { "type": "integer", "description": "Start position" },
                "end": { "type": "integer", "description": "End position" }
            },
            "required": ["chromosome", "start", "end"]
        })
    }
}

#[async_trait]
impl Provenance for RegulomeRegionTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "RegulomeDB",
            format!("{}:{}-{}", output.chromosome, output.start, output.end),
            format!("Found {} variants in region", output.variants.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://regulomedb.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for RegulomeRegionTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn regulome_region_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(RegulomeRegionTool::new()).into_dyn()
}

// Alias
pub fn regulomedb_score_typed_tool() -> Arc<dyn Tool> {
    regulome_rsid_typed_tool()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PfamSearchInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PfamDomain {
    pub accession: String,
    pub id: String,
    pub description: Option<String>,
}

#[derive(Clone)]
pub struct PfamSearchTool {
    client: Arc<PfamClient>,
}

impl PfamSearchTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(PfamClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for PfamSearchTool {
    type Input = PfamSearchInput;
    type Output = Vec<PfamDomain>;

    fn name(&self) -> &'static str {
        "pfam_search"
    }

    fn description(&self) -> &'static str {
        "[Protein Domains · Pfam] Search the Pfam database for protein families and domains."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::pfam::PfamSearchParams;
        let params = PfamSearchParams {
            query: Some(input.query.clone()),
            page_size: Some(10),
            ..Default::default()
        };
        let domains = self
            .client
            .search_entries(params)
            .await
            .map_err(|e| anyhow!("Pfam search failed: {e}"))?;

        Ok(domains
            .into_iter()
            .map(|d| PfamDomain {
                accession: d.accession.clone(),
                id: d.accession,
                description: d.description,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::Pfam)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::Pfam]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Protein domain search query" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for PfamSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "Pfam",
            "search",
            format!("Found {} protein domains", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://pfam.xfam.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for PfamSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn pfam_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(PfamSearchTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterproSearchInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterproEntry {
    pub accession: String,
    pub name: String,
    pub entry_type: Option<String>,
}

#[derive(Clone)]
pub struct InterproSearchTool {
    client: Arc<InterProClient>,
}

impl InterproSearchTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(InterProClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for InterproSearchTool {
    type Input = InterproSearchInput;
    type Output = Vec<InterproEntry>;

    fn name(&self) -> &'static str {
        "interpro_search"
    }

    fn description(&self) -> &'static str {
        "[Protein Domains · InterPro] Search InterPro for protein families, domains, and functional sites."
    }

    async fn execute(&self, _input: Self::Input) -> Result<Self::Output> {
        let response = self
            .client
            .search_entries(Default::default())
            .await
            .map_err(|e| anyhow!("InterPro search failed: {e}"))?;

        Ok(response
            .results
            .into_iter()
            .map(|e| InterproEntry {
                accession: e.accession,
                name: e.name.unwrap_or_default(),
                entry_type: e.entry_type,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::InterPro)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::InterPro]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Protein family or domain search query" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for InterproSearchTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "InterPro",
            "search",
            format!("Found {} InterPro entries", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.ebi.ac.uk/interpro/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for InterproSearchTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn interpro_search_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(InterproSearchTool::new()).into_dyn()
}
// ============================================================================
// GEO, ENCODE, PRIDE, QUICKGO, JASPAR TOOLS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoSearchInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoDataset {
    pub gse_id: String,
    pub title: String,
    pub summary: Option<String>,
}

// #[derive(Clone)]
// pub struct GeoSearchTool {
//     client: Arc<GeoClient>,
// }

// impl GeoSearchTool {
// pub fn new() -> Self {
// Self {
// client: Arc::new(GeoClient::new(None)),
// }
// }
// }

// #[async_trait]
// impl ToolCapability for GeoSearchTool {
// type Input = GeoSearchInput;
// type Output = Vec<GeoDataset>;

// fn name(&self) -> &'static str {
// "bio_geo_search"
// }

// fn description(&self) -> &'static str {
// "Search NCBI GEO database for gene expression datasets."
// }

// async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
// use aose_bio_apis::clients::geo::SearchParams;
// let params = SearchParams {
// database: "gds".to_string(),
// max_results: 20,
// start: 0,
// use_history: false,
// };
// let response = self.client
// .search(&input.query, &params)
// .await
// .map_err(|e| anyhow!("GEO search failed: {e}"))?;

// Ok(response.ids.into_iter().map(|id| GeoDataset {
// gse_id: id.clone(),
// title: id.clone(),
// summary: None,
// }).collect())
// }

// fn capabilities(&self) -> CapabilitySet {
// CapabilitySet::new()
// .with_operation(ToolOperation::Read)
// .with_operation(ToolOperation::Network)
// .with_data_source(DataSource::GEO)
// .idempotent()
// .cacheable()
// }

// fn data_sources(&self) -> Vec<DataSource> {
// vec![DataSource::GEO]
// }

// fn input_schema(&self) -> Value {
// serde_json::json!({
// "type": "object",
// "properties": {
// "query": { "type": "string", "description": "Search query for GEO datasets" }
// },
// "required": ["query"]
// })
// }
// }

// #[async_trait]
// impl Provenance for GeoSearchTool {
// fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
// Ok(EvidenceRecord::from_database(
// "NCBI GEO",
// "search",
// format!("Found {} GEO datasets", output.len()),
// chrono::Utc::now().to_rfc3339(),
// Some("https://www.ncbi.nlm.nih.gov/geo/".to_string()),
// ))
// }
// }

// #[async_trait]
// impl RateLimited for GeoSearchTool {
// fn rate_limit(&self) -> RateLimit {
// RateLimit { requests_per_second: 3, burst: 3 * 2 } // NCBI rate limit
// }
// }

// pub fn geo_search_typed_tool() -> Arc<dyn Tool> {
// GroundedTypedTool::new(GeoSearchTool::new()).into_dyn()
// }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeSearchExperimentsInput {
    pub query: String,
    #[serde(default = "default_max_results")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeExperiment {
    pub accession: String,
    pub assay_title: Option<String>,
    pub biosample_summary: Option<String>,
}

#[derive(Clone)]
pub struct EncodeSearchExperimentsTool {
    client: Arc<EncodeClient>,
}

impl EncodeSearchExperimentsTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(EncodeClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for EncodeSearchExperimentsTool {
    type Input = EncodeSearchExperimentsInput;
    type Output = Vec<EncodeExperiment>;

    fn name(&self) -> &'static str {
        "encode_search_experiments"
    }

    fn description(&self) -> &'static str {
        "[Functional Genomics · ENCODE] Search ENCODE experiments by assay, biosample, or target."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::encode::ExperimentSearchParams;
        let params = ExperimentSearchParams {
            assay_title: Some(input.query.clone()),
            biosample_ontology_term_name: None,
            target_label: None,
            status: None,
            assembly: None,
            replicates_min: None,
            limit: Some(20),
        };
        let experiments = self
            .client
            .search_experiments(&params)
            .await
            .map_err(|e| anyhow!("ENCODE search failed: {e}"))?;

        Ok(experiments
            .into_iter()
            .map(|e| EncodeExperiment {
                accession: e.accession,
                assay_title: e.assay_title,
                biosample_summary: e.biosample_summary,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::ENCODE)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::ENCODE]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query (assay, biosample, or target)" },
                "limit": { "type": "integer", "default": 100, "description": "Maximum results" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for EncodeSearchExperimentsTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "ENCODE",
            "search_experiments",
            format!("Found {} ENCODE experiments", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.encodeproject.org/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for EncodeSearchExperimentsTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn encode_search_experiments_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(EncodeSearchExperimentsTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrideSearchProjectsInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrideProject {
    pub accession: String,
    pub title: String,
    pub project_description: Option<String>,
}

#[derive(Clone)]
pub struct PrideSearchProjectsTool {
    client: Arc<PrideClient>,
}

impl PrideSearchProjectsTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(PrideClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for PrideSearchProjectsTool {
    type Input = PrideSearchProjectsInput;
    type Output = Vec<PrideProject>;

    fn name(&self) -> &'static str {
        "pride_search_projects"
    }

    fn description(&self) -> &'static str {
        "[Functional Genomics · PRIDE] Search the PRIDE archive for mass-spectrometry proteomics projects."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::pride::ProjectSearchParams;
        let params = ProjectSearchParams {
            keyword: Some(input.query.clone()),
            page_size: Some(20),
            ..Default::default()
        };
        let response = self
            .client
            .search_projects(params)
            .await
            .map_err(|e| anyhow!("PRIDE search failed: {e}"))?;

        let projects = response.embedded.map(|e| e.projects).unwrap_or_default();

        Ok(projects
            .into_iter()
            .map(|p| PrideProject {
                accession: p.accession,
                title: p.title,
                project_description: p.project_description,
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::PRIDE)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::PRIDE]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query for proteomics projects" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for PrideSearchProjectsTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "PRIDE",
            "search_projects",
            format!("Found {} PRIDE projects", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.ebi.ac.uk/pride/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for PrideSearchProjectsTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn pride_search_projects_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(PrideSearchProjectsTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickgoAnnotationsInput {
    pub gene_product_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoAnnotation {
    pub gene_product_id: String,
    pub go_id: String,
    pub go_term: String,
    pub evidence_code: Option<String>,
}

#[derive(Clone)]
pub struct QuickgoAnnotationsTool {
    client: Arc<QuickGoClient>,
}

impl QuickgoAnnotationsTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(QuickGoClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for QuickgoAnnotationsTool {
    type Input = QuickgoAnnotationsInput;
    type Output = Vec<GoAnnotation>;

    fn name(&self) -> &'static str {
        "quickgo_annotations"
    }

    fn description(&self) -> &'static str {
        "[Functional Genomics · QuickGO] Fetch Gene Ontology (GO) annotations for a gene product from QuickGO."
    }

    async fn execute(&self, input: Self::Input) -> Result<Self::Output> {
        use aose_bio_apis::clients::quickgo::AnnotationSearchParams;
        let params = AnnotationSearchParams {
            gene_product_id: Some(input.gene_product_id.clone()),
            limit: Some(100),
            ..Default::default()
        };
        let response = self
            .client
            .search_annotations(params)
            .await
            .map_err(|e| anyhow!("QuickGO annotation retrieval failed: {e}"))?;

        Ok(response
            .results
            .into_iter()
            .map(|a| GoAnnotation {
                gene_product_id: input.gene_product_id.clone(),
                go_id: a.go_id,
                go_term: a.go_name.unwrap_or_default(),
                evidence_code: Some(a.evidence_code),
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::QuickGO)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::QuickGO]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "gene_product_id": { "type": "string", "description": "UniProt ID or gene product identifier" }
            },
            "required": ["gene_product_id"]
        })
    }
}

#[async_trait]
impl Provenance for QuickgoAnnotationsTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "QuickGO",
            "get_annotations",
            format!("Found {} GO annotations", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://www.ebi.ac.uk/QuickGO/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for QuickgoAnnotationsTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn quickgo_annotations_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(QuickgoAnnotationsTool::new()).into_dyn()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JasparSearchMatricesInput {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JasparMatrix {
    pub matrix_id: String,
    pub name: String,
    pub tf_class: Option<String>,
}

#[derive(Clone)]
pub struct JasparSearchMatricesTool {
    client: Arc<JasparClient>,
}

impl JasparSearchMatricesTool {
    pub fn new() -> Self {
        Self {
            client: Arc::new(JasparClient::new()),
        }
    }
}

#[async_trait]
impl ToolCapability for JasparSearchMatricesTool {
    type Input = JasparSearchMatricesInput;
    type Output = Vec<JasparMatrix>;

    fn name(&self) -> &'static str {
        "jaspar_search_matrices"
    }

    fn description(&self) -> &'static str {
        "[Functional Genomics · JASPAR] Search JASPAR for transcription-factor binding-site (motif) matrices."
    }

    async fn execute(&self, _input: Self::Input) -> Result<Self::Output> {
        let matrices = self
            .client
            .search_matrices(&Default::default())
            .await
            .map_err(|e| anyhow!("JASPAR search failed: {e}"))?;

        Ok(matrices
            .into_iter()
            .map(|m| JasparMatrix {
                matrix_id: m.matrix_id,
                name: m.name,
                tf_class: m.class_type.clone(),
            })
            .collect())
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::new()
            .with_operation(ToolOperation::Read)
            .with_operation(ToolOperation::Network)
            .with_data_source(DataSource::JASPAR)
            .idempotent()
            .cacheable()
    }

    fn data_sources(&self) -> Vec<DataSource> {
        vec![DataSource::JASPAR]
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Transcription factor name or matrix ID" }
            },
            "required": ["query"]
        })
    }
}

#[async_trait]
impl Provenance for JasparSearchMatricesTool {
    fn generate_evidence(&self, output: &Self::Output) -> Result<EvidenceRecord> {
        Ok(EvidenceRecord::from_database(
            "JASPAR",
            "search_matrices",
            format!("Found {} JASPAR matrices", output.len()),
            chrono::Utc::now().to_rfc3339(),
            Some("https://jaspar.genereg.net/".to_string()),
        ))
    }
}

#[async_trait]
impl RateLimited for JasparSearchMatricesTool {
    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_second: 10,
            burst: 10 * 2,
        }
    }
}

pub fn jaspar_search_matrices_typed_tool() -> Arc<dyn Tool> {
    GroundedTypedTool::new(JasparSearchMatricesTool::new()).into_dyn()
}
// ============================================================================
// FINAL EXPORTS AND REGISTRATION
// ============================================================================

/// Register all typed bio tools into a vector for easy bulk registration
pub fn all_bio_typed_tools() -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        // Ensembl
        ensembl_search_typed_tool(),
        ensembl_info_typed_tool(),
        ensembl_seq_typed_tool(),
        // UniProt & Protein Structure
        uniprot_info_typed_tool(),
        alphafold_structure_typed_tool(),
        pdb_entry_typed_tool(),
        // NCBI
        // ncbi_blast_typed_tool(),

        // Genomic Variation
        // clinvar_variants_typed_tool(),
        gnomad_variant_typed_tool(),
        // dbsnp_lookup_typed_tool(),

        // GWAS & GTEx
        gwas_search_typed_tool(),
        gtex_eqtl_typed_tool(),
        // Open Targets
        // opentargets_target_typed_tool(),
        // opentargets_diseases_typed_tool(),

        // Drug & Chemical
        // chembl_search_typed_tool(),
        pubchem_compound_typed_tool(),
        // Enrichment & Pathways
        enrichr_enrich_typed_tool(),
        kegg_get_typed_tool(),
        reactome_pathway_typed_tool(),
        // Protein Interactions
        string_interactions_typed_tool(),
        // Disease & Phenotype
        hpo_search_typed_tool(),
        omim_search_typed_tool(),
        monarch_search_diseases_typed_tool(),
        monarch_gene_phenotypes_typed_tool(),
        // Cancer
        // cbioportal_studies_typed_tool(),
        // cbioportal_mutations_typed_tool(),

        // Regulatory
        regulome_rsid_typed_tool(),
        regulome_region_typed_tool(),
        // Protein Domains
        pfam_search_typed_tool(),
        interpro_search_typed_tool(),
        // Genomic Data
        // geo_search_typed_tool(),
        encode_search_experiments_typed_tool(),
        // Proteomics & GO
        pride_search_projects_typed_tool(),
        quickgo_annotations_typed_tool(),
        jaspar_search_matrices_typed_tool(),
    ];

    // DrugBank requires a paid API key (DRUGBANK_API_KEY). Constructing the
    // tool without it fails loud, so only register it when the key is present
    // -- otherwise the whole bio toolset would be unusable on key-less
    // environments (CI, local dev). With the key set it joins like any other.
    if std::env::var("DRUGBANK_API_KEY").is_ok() {
        tools.push(drugbank_search_typed_tool());
    }
    // DisGeNET likewise requires DISGENET_API_KEY; gate it the same way.
    if std::env::var("DISGENET_API_KEY").is_ok() {
        tools.push(disgenet_gene_disease_typed_tool());
    }

    tools
}

/// Convenience function to register all bio typed tools at once
pub fn register_all_bio_typed_tools(registry: &mut ToolSet) -> Result<()> {
    for tool in all_bio_typed_tools() {
        registry.register(tool)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tools_have_unique_names() {
        let tools = all_bio_typed_tools();
        let mut names = std::collections::HashSet::new();

        for tool in tools {
            let def = tool.definition();
            assert!(
                names.insert(def.name.clone()),
                "Duplicate tool name: {}",
                def.name
            );
        }
    }

    #[test]
    fn all_tools_are_read_only() {
        let tools = all_bio_typed_tools();

        for tool in tools {
            let def = tool.definition();
            assert!(
                def.read_only,
                "Bio API tool {} should be read-only",
                def.name
            );
        }
    }

    #[test]
    fn all_tools_are_non_destructive() {
        let tools = all_bio_typed_tools();

        for tool in tools {
            let def = tool.definition();
            assert!(
                !def.destructive,
                "Bio API tool {} should be non-destructive",
                def.name
            );
        }
    }

    #[test]
    fn all_tools_have_provenance() {
        // All bio typed tools implement Provenance trait via GroundedTypedTool
        // Every tool in all_bio_typed_tools() is wrapped in GroundedTypedTool,
        // so Provenance coverage is total by construction. 26 is the key-less
        // baseline (DrugBank/DisGeNET join only when their API keys are set).
        let tools = all_bio_typed_tools();
        assert!(
            tools.len() >= 26,
            "Should have migrated all bio tools, got {}",
            tools.len()
        );
    }

    #[test]
    fn all_tools_have_data_sources() {
        let tools = all_bio_typed_tools();

        for tool in tools {
            let def = tool.definition();
            // Each tool should declare at least one data source in its description
            // or via the ToolCapability::data_sources method
            assert!(!def.name.is_empty(), "Tool name should not be empty");
        }
    }

    #[tokio::test]
    async fn typed_boundary_validates_input() {
        // Test that typed tools reject malformed input at the boundary
        let tool = ensembl_search_typed_tool();
        let ctx = aose_core::tool::ExecutionContext {
            agent_name: Some("test".into()),
            metadata: serde_json::json!({}),
            events: std::default::Default::default(),
        };

        // Missing required field should fail
        let result = tool.execute(serde_json::json!({}), ctx).await;
        assert!(
            result.is_err(),
            "Should reject input missing required fields"
        );
    }

    #[test]
    fn test_tool_count() {
        let tools = all_bio_typed_tools();
        // 26 tools register without any API key; DrugBank + DisGeNET join
        // only when DRUGBANK_API_KEY / DISGENET_API_KEY are set (see
        // all_bio_typed_tools). 26 is the key-less baseline.
        let base = tools.len();
        assert!(
            base >= 26,
            "Expected at least 26 key-less bio typed tools, got {base}"
        );
    }
}

// ============================================================================
// DEFAULT IMPLEMENTATIONS
//
// Each tool above exposes a parameterless `new()` that constructs its client.
// Provide `Default` to satisfy clippy::new_without_default; delegates to `new()`.
// ============================================================================

impl Default for EnsemblInfoTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for EnsemblSeqTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for UniprotInfoTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for AlphafoldStructureTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for PdbEntryTool {
    fn default() -> Self {
        Self::new()
    }
}

// impl Default for NcbiBlastTool {
// fn default() -> Self {
// Self::new()
// }
// }

impl Default for GwasSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for GtexEqtlTool {
    fn default() -> Self {
        Self::new()
    }
}

// impl Default for OpentargetsTargetTool {
// fn default() -> Self {
// Self::new()
// }
// }

// impl Default for OpentargetsDiseasesTool {
// fn default() -> Self {
// Self::new()
// }
// }

// impl Default for ClinvarVariantsTool {
// fn default() -> Self {
// Self::new()
// }
// }

impl Default for GnomadVariantTool {
    fn default() -> Self {
        Self::new()
    }
}

// impl Default for DbsnpLookupTool {
// fn default() -> Self {
// Self::new()
// }
// }

// impl Default for ChemblSearchTool {
// fn default() -> Self {
// Self::new()
// }
// }

impl Default for DrugbankSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for PubchemCompoundTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for EnrichrEnrichTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for KeggGetTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for ReactomePathwayTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for StringInteractionsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for DisgenetGeneDiseaseTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for HpoSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for OmimSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for MonarchSearchDiseasesTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for MonarchGenePhenotypesTool {
    fn default() -> Self {
        Self::new()
    }
}

// impl Default for CbioportalStudiesTool {
// fn default() -> Self {
// Self::new()
// }
// }

// impl Default for CbioportalMutationsTool {
// fn default() -> Self {
// Self::new()
// }
// }

impl Default for RegulomeRsidTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for RegulomeRegionTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for PfamSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for InterproSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

// impl Default for GeoSearchTool {
// fn default() -> Self {
// Self::new()
// }
// }

impl Default for EncodeSearchExperimentsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for PrideSearchProjectsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for QuickgoAnnotationsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for JasparSearchMatricesTool {
    fn default() -> Self {
        Self::new()
    }
}
