//! Verification tests hitting REAL APIs to prove clients work end-to-end.

use aose_bio_apis::clients::gnomad::{GnomadClient, ReferenceGenome};
use aose_bio_apis::clients::kegg::KeggClient;
use aose_bio_apis::clients::string::{NetworkParams, StringClient};

#[tokio::test]
#[ignore]
async fn verify_gnomad_works() {
    let client = GnomadClient::new();
    match client.get_gene("PCSK9", ReferenceGenome::GRCh38).await {
        Ok(_) => println!("GNOMAD OK"),
        Err(e) => panic!("GNOMAD FAILED: {}", e),
    }
}

#[tokio::test]
#[ignore]
async fn verify_string_works() {
    let client = StringClient::new();
    let params = NetworkParams {
        species: 9606,
        required_score: None,
        network_type: None,
        add_nodes: None,
    };
    match client.network(&["TP53".to_string()], params).await {
        Ok(net) => println!("STRING OK: {} interactions", net.len()),
        Err(e) => panic!("STRING FAILED: {}", e),
    }
}

#[tokio::test]
#[ignore]
async fn verify_kegg_works() {
    let client = KeggClient::new();
    match client.get("hsa:7157").await {
        Ok(entry) => println!("KEGG OK: {:?}", entry.entry_id),
        Err(e) => panic!("KEGG FAILED: {}", e),
    }
}
