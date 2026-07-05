//! Common data models for bioinformatics APIs.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Gene record from Ensembl or NCBI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneRecord {
    pub gene_id: String,
    pub gene_name: Option<String>,
    pub species: String,
    pub chromosome: Option<String>,
    pub start: Option<u64>,
    pub end: Option<u64>,
    pub strand: Option<i8>,
    pub description: Option<String>,
    pub biotype: Option<String>,
}

/// Protein record from UniProt
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProteinRecord {
    pub uniprot_id: String,
    pub protein_name: Option<String>,
    pub gene_names: Vec<String>,
    pub organism: String,
    pub sequence: Option<String>,
    pub length: Option<usize>,
    pub function: Option<String>,
    pub subcellular_location: Option<Vec<String>>,
}

/// BLAST hit result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlastHit {
    pub hit_num: u32,
    pub accession: String,
    pub description: String,

    pub length: u32,
    pub e_value: f64,
    pub bit_score: f64,
    pub percent_identity: f64,
    pub alignment_length: u32,
    pub query_start: u32,
    pub query_end: u32,
    pub subject_start: u32,
    pub subject_end: u32,
}

/// FASTA sequence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fasta {
    pub id: String,
    pub description: Option<String>,
    pub sequence: String,
}

impl Fasta {
    /// Parse FASTA format string
    pub fn parse(content: &str) -> Result<Vec<Self>, String> {
        let mut sequences = Vec::new();
        let mut current_id = None;
        let mut current_desc = None;
        let mut current_seq = String::new();

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Some(header) = line.strip_prefix('>') {
                // Save previous sequence if exists
                if let Some(id) = current_id.take() {
                    sequences.push(Fasta {
                        id,
                        description: current_desc.take(),
                        sequence: current_seq.clone(),
                    });
                    current_seq.clear();
                }

                // Parse header
                if let Some(space_pos) = header.find(char::is_whitespace) {
                    current_id = Some(header[..space_pos].to_string());
                    current_desc = Some(header[space_pos..].trim().to_string());
                } else {
                    current_id = Some(header.to_string());
                }
            } else {
                current_seq.push_str(line);
            }
        }

        // Save last sequence
        if let Some(id) = current_id {
            sequences.push(Fasta {
                id,
                description: current_desc,
                sequence: current_seq,
            });
        }

        Ok(sequences)
    }
}

impl fmt::Display for Fasta {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, ">{}", self.id)?;
        if let Some(desc) = &self.description {
            write!(f, " {}", desc)?;
        }
        writeln!(f)?;

        // Wrap sequence at 80 characters
        for chunk in self.sequence.as_bytes().chunks(80) {
            writeln!(f, "{}", std::str::from_utf8(chunk).unwrap())?;
        }

        Ok(())
    }
}

/// GWAS association record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GwasAssociation {
    pub rsid: String,
    pub trait_name: String,
    pub p_value: f64,
    pub risk_allele: Option<String>,
    pub mapped_genes: Vec<String>,
    pub chromosome: Option<String>,
    pub position: Option<u64>,
    pub study: Option<String>,
    pub or_value: Option<f64>,
    pub beta_value: Option<f64>,
    pub beta_unit: Option<String>,
    pub risk_frequency: Option<String>,
}

/// SNP information from GWAS Catalog
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnpInfo {
    pub rsid: String,
    pub chromosome: Option<String>,
    pub position: Option<u64>,
    pub functional_class: Option<String>,
    pub gene_region: Option<String>,
    pub merged: i32,
    pub last_update: Option<String>,
}

/// AlphaFold structure metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlphaFoldStructure {
    pub uniprot_id: String,
    pub model_version: String,
    pub model_date: Option<String>,
    pub confidence_scores: Option<Vec<f64>>,
    pub pdb_url: Option<String>,
    pub pae_url: Option<String>,
}

/// Expression Quantitative Trait Locus (eQTL) from GTEx
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Eqtl {
    pub gene_symbol: String,
    pub variant_id: String,
    pub tissue: String,
    pub p_value: f64,
    /// Normalized effect size (NES) reported by GTEx single-tissue eQTL API.
    pub nes: f64,
}

/// Tissue-specific gene expression from GTEx
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TissueExpression {
    pub gene_symbol: String,
    pub tissue: String,
    pub median_tpm: f64,
    pub mean_tpm: Option<f64>,
    pub sample_count: Option<u32>,
}

/// GTEx tissue metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GtexTissue {
    pub tissue_id: String,
    pub tissue_name: String,
    pub tissue_site_detail: Option<String>,
}

/// DepMap gene dependency score
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneDependency {
    pub gene_symbol: String,
    pub cell_line: String,
    pub dependency_score: f64,
    pub screen_type: String,
}

/// TIMER2.0 immune infiltration data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImmuneInfiltration {
    pub gene_symbol: String,
    pub cancer_type: String,
    pub immune_cell_type: String,
    pub infiltration_score: f64,
    pub p_value: Option<f64>,
}

/// TIMER2.0 gene-immune correlation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImmuneCorrelation {
    pub gene_symbol: String,
    pub cancer_type: String,
    pub immune_cell_type: String,
    pub correlation: f64,
    pub p_value: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fasta_parse_single() {
        let input = ">seq1 Test sequence\nACGTACGT\nGGCCTTAA";
        let sequences = Fasta::parse(input).unwrap();

        assert_eq!(sequences.len(), 1);
        assert_eq!(sequences[0].id, "seq1");
        assert_eq!(sequences[0].description, Some("Test sequence".to_string()));
        assert_eq!(sequences[0].sequence, "ACGTACGTGGCCTTAA");
    }

    #[test]
    fn test_fasta_parse_multiple() {
        let input = ">seq1\nACGT\n>seq2 Description\nGGCC\nTTAA";
        let sequences = Fasta::parse(input).unwrap();

        assert_eq!(sequences.len(), 2);
        assert_eq!(sequences[0].id, "seq1");
        assert_eq!(sequences[0].sequence, "ACGT");
        assert_eq!(sequences[1].id, "seq2");
        assert_eq!(sequences[1].sequence, "GGCCTTAA");
    }

    #[test]
    fn test_fasta_to_string() {
        let fasta = Fasta {
            id: "test".to_string(),
            description: Some("Test sequence".to_string()),
            sequence: "ACGT".to_string(),
        };

        let output = fasta.to_string();
        assert!(output.starts_with(">test Test sequence\n"));
        assert!(output.contains("ACGT"));
    }
}
