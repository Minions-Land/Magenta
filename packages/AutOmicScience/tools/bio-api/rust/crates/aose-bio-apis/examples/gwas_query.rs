//! Example: Query GWAS Catalog for genetic associations
//!
//! Run with: cargo run --example gwas_query

use aose_bio_apis::clients::GwasCatalogClient;
use aose_bio_apis::retry::RetryPolicy;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create client with custom retry policy
    let retry_policy = RetryPolicy {
        max_retries: 3,
        initial_backoff: Duration::from_millis(500),
        ..Default::default()
    };
    let client = GwasCatalogClient::with_retry_policy(retry_policy);

    println!("=== GWAS Catalog Query Example ===\n");

    // Example 1: Get associations for PKD1 gene
    println!("1. Querying associations for PKD1 gene...");
    match client.get_gene_associations("PKD1").await {
        Ok(associations) => {
            println!("   Found {} associations", associations.len());
            if let Some(first) = associations.first() {
                println!("   Example association:");
                println!("     rsID: {}", first.rsid);
                println!("     Trait: {}", first.trait_name);
                println!("     P-value: {:.2e}", first.p_value);
                println!("     Genes: {:?}", first.mapped_genes);
                if let Some(or_val) = first.or_value {
                    println!("     Odds ratio: {:.2}", or_val);
                }
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 2: Get associations for a trait
    println!("2. Querying associations for 'polycystic kidney disease'...");
    match client
        .get_trait_associations("polycystic kidney disease")
        .await
    {
        Ok(associations) => {
            println!("   Found {} associations", associations.len());
            for (i, assoc) in associations.iter().take(3).enumerate() {
                println!("   Association {}:", i + 1);
                println!("     rsID: {}", assoc.rsid);
                println!("     P-value: {:.2e}", assoc.p_value);
                println!("     Genes: {:?}", assoc.mapped_genes);
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 3: Get SNP information
    println!("3. Querying SNP information for rs429358 (APOE)...");
    match client.get_snp_info("rs429358").await {
        Ok(snp_info) => {
            println!("   rsID: {}", snp_info.rsid);
            println!("   Chromosome: {:?}", snp_info.chromosome);
            println!("   Position: {:?}", snp_info.position);
            println!("   Functional class: {:?}", snp_info.functional_class);
            println!("   Gene region: {:?}", snp_info.gene_region);
            println!("   Merged: {}", snp_info.merged);
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 4: Search associations
    println!("4. Searching associations for 'type 2 diabetes'...");
    match client.search_associations("type 2 diabetes").await {
        Ok(associations) => {
            println!("   Found {} associations", associations.len());

            // Group by p-value significance
            let genome_wide: Vec<_> = associations.iter().filter(|a| a.p_value < 5e-8).collect();

            println!(
                "   Genome-wide significant (p < 5e-8): {}",
                genome_wide.len()
            );

            if let Some(top) = genome_wide.first() {
                println!("   Top association:");
                println!("     rsID: {}", top.rsid);
                println!("     P-value: {:.2e}", top.p_value);
                println!("     Risk allele: {:?}", top.risk_allele);
                println!("     Genes: {:?}", top.mapped_genes);
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!("\n=== Done ===");
    Ok(())
}
