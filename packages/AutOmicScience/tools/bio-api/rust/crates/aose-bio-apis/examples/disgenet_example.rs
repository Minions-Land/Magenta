//! Example usage of the DisGeNET API client.
//!
//! To run this example:
//! 1. Set your DISGENET_API_KEY environment variable
//!    export DISGENET_API_KEY="your_api_key_here"
//! 2. Run: cargo run --example disgenet_example

use aose_bio_apis::clients::disgenet::{AssociationQueryParams, DisGeNetClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create client from environment variable
    let client = DisGeNetClient::new()?;

    println!("=== DisGeNET API Example ===\n");

    // Example 1: Get gene-disease associations for BRCA1
    println!("1. Gene-Disease Associations for BRCA1:");
    let params = AssociationQueryParams {
        min_score: Some(0.3),
        limit: Some(10),
        ..Default::default()
    };

    match client.get_gene_disease_associations("BRCA1", &params).await {
        Ok(associations) => {
            println!("   Found {} disease associations", associations.len());
            for (i, assoc) in associations.iter().take(5).enumerate() {
                println!(
                    "   {}. {} (score: {:.3}, disease_id: {})",
                    i + 1,
                    assoc.disease_name,
                    assoc.score,
                    assoc.disease_id
                );
                if let Some(pmid_count) = assoc.pmid_count {
                    println!("      PubMed articles: {}", pmid_count);
                }
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 2: Get disease-gene associations for Breast Cancer
    println!("2. Gene Associations for Breast Cancer (C0006142):");
    let params = AssociationQueryParams {
        min_score: Some(0.5),
        limit: Some(10),
        source: Some("CURATED".to_string()),
        ..Default::default()
    };

    match client
        .get_disease_gene_associations("C0006142", &params)
        .await
    {
        Ok(associations) => {
            println!("   Found {} gene associations", associations.len());
            for (i, assoc) in associations.iter().take(5).enumerate() {
                println!(
                    "   {}. {} (score: {:.3})",
                    i + 1,
                    assoc.gene_symbol,
                    assoc.score
                );
                if let Some(evidence) = &assoc.evidence_level {
                    println!("      Evidence: {}", evidence);
                }
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 3: Get gene information
    println!("3. Gene Information for TP53:");
    match client.get_gene_info("TP53").await {
        Ok(gene) => {
            println!("   Gene: {} ({})", gene.gene_symbol, gene.gene_id);
            if let Some(desc) = gene.description {
                println!("   Description: {}", desc);
            }
            if let Some(protein_class) = gene.protein_class {
                println!("   Protein class: {}", protein_class);
            }
            if let Some(disease_count) = gene.disease_count {
                println!("   Associated diseases: {}", disease_count);
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 4: Get disease information
    println!("4. Disease Information for Alzheimer's Disease (C0002395):");
    match client.get_disease_info("C0002395").await {
        Ok(disease) => {
            println!(
                "   Disease: {} ({})",
                disease.disease_name, disease.disease_id
            );
            if let Some(disease_type) = disease.disease_type {
                println!("   Type: {}", disease_type);
            }
            if let Some(disease_class) = disease.disease_class {
                println!("   Class: {}", disease_class);
            }
            if let Some(gene_count) = disease.gene_count {
                println!("   Associated genes: {}", gene_count);
            }
            if let Some(variant_count) = disease.variant_count {
                println!("   Associated variants: {}", variant_count);
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!();

    // Example 5: Get variant-disease associations
    println!("5. Variant-Disease Associations for rs121913527:");
    let params = AssociationQueryParams {
        limit: Some(5),
        ..Default::default()
    };

    match client
        .get_variant_disease_associations("rs121913527", &params)
        .await
    {
        Ok(associations) => {
            println!("   Found {} disease associations", associations.len());
            for (i, assoc) in associations.iter().enumerate() {
                println!(
                    "   {}. {} (score: {:.3})",
                    i + 1,
                    assoc.disease_name,
                    assoc.score
                );
                if let Some(chr) = &assoc.chromosome {
                    println!("      Chromosome: {}", chr);
                }
                if let Some(pos) = assoc.position {
                    println!("      Position: {}", pos);
                }
            }
        }
        Err(e) => println!("   Error: {}", e),
    }

    println!("\n=== Example Complete ===");

    Ok(())
}
