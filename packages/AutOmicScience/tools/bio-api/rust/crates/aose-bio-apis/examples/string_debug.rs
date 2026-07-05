use aose_bio_apis::clients::string::StringClient;

#[tokio::main]
async fn main() {
    let client = StringClient::new();
    let identifiers = vec!["TP53".to_string()];

    println!("Testing get_link...");
    match client.get_link(&identifiers, 9606).await {
        Ok(link) => println!("Success: {}", link),
        Err(e) => println!("Error: {:?}", e),
    }

    println!("\nTesting enrichment...");
    let identifiers = vec!["TP53".to_string(), "BRCA1".to_string(), "BRCA2".to_string()];
    match client.enrichment(&identifiers, 9606).await {
        Ok(enrichments) => println!("Success: {} terms", enrichments.len()),
        Err(e) => println!("Error: {:?}", e),
    }

    println!("\nTesting ppi_enrichment...");
    match client.ppi_enrichment(&identifiers, 9606).await {
        Ok(enrichment) => println!("Success: {:?}", enrichment),
        Err(e) => println!("Error: {:?}", e),
    }
}
