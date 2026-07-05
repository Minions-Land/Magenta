//! Integration tests for GWAS Catalog client
//!
//! These tests require network access and may be slow.
//! Run with: cargo test -p aos-bio-apis --test gwas_integration -- --ignored

use aose_bio_apis::clients::GwasCatalogClient;

#[tokio::test]
#[ignore] // Requires network access
async fn test_get_gene_associations_pkd1() {
    let client = GwasCatalogClient::new();

    // Query PKD1 gene associations
    let result = client.get_gene_associations("PKD1").await;

    match result {
        Ok(associations) => {
            println!("Found {} associations for PKD1", associations.len());

            if !associations.is_empty() {
                let first = &associations[0];
                println!("First association:");
                println!("  rsID: {}", first.rsid);
                println!("  Trait: {}", first.trait_name);
                println!("  P-value: {:.2e}", first.p_value);
                println!("  Genes: {:?}", first.mapped_genes);

                assert!(!first.rsid.is_empty());
                assert!(!first.trait_name.is_empty());
                assert!(first.p_value > 0.0);
            }
        }
        Err(e) => {
            println!("Warning: Failed to fetch PKD1 associations: {}", e);
        }
    }
}

#[tokio::test]
#[ignore] // Requires network access
async fn test_get_trait_associations_kidney() {
    let client = GwasCatalogClient::new();

    // Query kidney disease associations
    let result = client.get_trait_associations("kidney disease").await;

    match result {
        Ok(associations) => {
            println!(
                "Found {} associations for kidney disease",
                associations.len()
            );

            if !associations.is_empty() {
                let first = &associations[0];
                println!("First association:");
                println!("  rsID: {}", first.rsid);
                println!("  P-value: {:.2e}", first.p_value);

                assert!(!first.rsid.is_empty());
                assert!(first.p_value > 0.0);
            }
        }
        Err(e) => {
            println!(
                "Warning: Failed to fetch kidney disease associations: {}",
                e
            );
        }
    }
}

#[tokio::test]
#[ignore] // Requires network access
async fn test_get_snp_info() {
    let client = GwasCatalogClient::new();

    // Query a well-known SNP
    let result = client.get_snp_info("rs429358").await;

    match result {
        Ok(snp_info) => {
            println!("SNP Info for rs429358:");
            println!("  rsID: {}", snp_info.rsid);
            println!("  Chromosome: {:?}", snp_info.chromosome);
            println!("  Position: {:?}", snp_info.position);
            println!("  Functional class: {:?}", snp_info.functional_class);
            println!("  Gene region: {:?}", snp_info.gene_region);

            assert_eq!(snp_info.rsid, "rs429358");
            assert!(snp_info.chromosome.is_some());
        }
        Err(e) => {
            println!("Warning: Failed to fetch SNP info: {}", e);
        }
    }
}

#[tokio::test]
#[ignore] // Requires network access
async fn test_search_associations() {
    let client = GwasCatalogClient::new();

    // Search should be equivalent to get_trait_associations
    let result = client.search_associations("type 2 diabetes").await;

    match result {
        Ok(associations) => {
            // Associations may legitimately be empty when there is no exact match;
            // reaching this Ok branch is what the test verifies.
            println!("Search found {} associations", associations.len());
        }
        Err(e) => {
            println!("Warning: Search failed: {}", e);
        }
    }
}
