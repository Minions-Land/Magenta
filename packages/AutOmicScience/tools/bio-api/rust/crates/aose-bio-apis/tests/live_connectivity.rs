//! Live connectivity tests for bio-API clients (network-dependent, ignored by default).

use aose_bio_apis::clients::{
    alphafold::AlphaFoldClient, enrichr::EnrichrClient, pdb::PdbClient, uniprot::UniProtClient,
};

#[tokio::test]
#[ignore]
async fn uniprot_rest_api_reachable() {
    let client = UniProtClient::new();
    // P04637 is p53, a well-known reviewed entry
    let result = client.get_protein_info("P04637").await;
    match result {
        Ok(info) => {
            println!("UniProt live: got protein {}", info.uniprot_id);
            assert!(!info.uniprot_id.is_empty());
        }
        Err(e) => panic!("UniProt unreachable: {}", e),
    }
}

#[tokio::test]
#[ignore]
async fn alphafold_api_reachable() {
    let client = AlphaFoldClient::new();
    // P04637 is p53, has AlphaFold structure
    let result = client.get_prediction("P04637").await;
    match result {
        Ok(structure) => {
            println!("AlphaFold live: got structure for {}", structure.uniprot_id);
            assert_eq!(structure.uniprot_id, "P04637");
        }
        Err(e) => panic!("AlphaFold unreachable: {}", e),
    }
}

#[tokio::test]
#[ignore]
async fn pdb_rest_api_reachable() {
    let client = PdbClient::new();
    // 4HHB is hemoglobin, a classic PDB entry
    let result = client.get_entry("4HHB").await;
    match result {
        Ok(entry) => {
            println!("PDB live: got entry {}", entry.pdb_id);
            assert_eq!(entry.pdb_id, "4HHB");
        }
        Err(e) => panic!("PDB unreachable: {}", e),
    }
}

#[tokio::test]
#[ignore]
async fn enrichr_api_reachable() {
    let client = EnrichrClient::new();
    let genes = vec!["PHF14".to_string(), "RBM3".to_string(), "MSL1".to_string()];
    let result = client.enrich(&genes, "GO_Biological_Process_2021").await;
    match result {
        Ok(results) => {
            println!("Enrichr live: got {} enrichment terms", results.len());
            assert!(!results.is_empty());
        }
        Err(e) => panic!("Enrichr unreachable: {}", e),
    }
}
