//! Examples demonstrating batch queries and self-healing features.
//!
//! Run with: cargo run --example batch_and_healing

use aose_bio_apis::{
    batch::BatchExecutor,
    clients::ensembl::EnsemblClient,
    clients::uniprot::UniProtClient,
    healing::{FailureClassifier, FailureContext},
    BioApiError, BioApiResult,
};

/// Example 1: Parallel batch queries for multiple genes
async fn example_parallel_queries() -> BioApiResult<()> {
    println!("=== Example 1: Parallel Batch Queries ===\n");

    use std::sync::Arc;
    let client = Arc::new(EnsemblClient::new());
    let genes = vec!["BRCA1", "TP53", "EGFR", "KRAS", "MYC"];

    println!("Querying {} genes in parallel...", genes.len());
    let start = std::time::Instant::now();

    // Create batch executor with concurrency limit of 5
    let executor = BatchExecutor::new(5);

    // Execute all queries in parallel
    let results = executor
        .execute_batch(genes.clone(), move |gene| {
            let client = Arc::clone(&client);
            async move { client.search_genes(gene, None).await }
        })
        .await;

    let elapsed = start.elapsed();
    println!("✅ Completed in {:?}", elapsed);

    // Process results
    for (gene, result) in genes.iter().zip(results.iter()) {
        match result {
            Ok(genes) => println!("  {} -> Found {} results", gene, genes.len()),
            Err(e) => println!("  {} -> Error: {}", gene, e),
        }
    }

    println!();
    Ok(())
}

/// Example 2: Self-healing failure detection and classification
async fn example_self_healing() -> BioApiResult<()> {
    println!("=== Example 2: Self-Healing Failure Detection ===\n");

    // Simulate different failure scenarios
    let scenarios = vec![
        (
            "Rate Limit Exceeded",
            BioApiError::RateLimitExceeded {
                retry_after_secs: 60,
            },
            429,
        ),
        (
            "Endpoint Not Found",
            BioApiError::NotFound("Gene not found".to_string()),
            404,
        ),
        (
            "Request Timeout",
            BioApiError::Timeout {
                operation: "fetch_gene".to_string(),
            },
            0,
        ),
    ];

    for (name, error, status_code) in scenarios {
        let mut context = FailureContext::new("ensembl", "/lookup/symbol/homo_sapiens/BRCA1", 1);
        if status_code > 0 {
            context.status_code = Some(status_code);
        }

        let diagnosis = FailureClassifier::classify(&error, &context);

        println!("Scenario: {}", name);
        println!("  Failure Kind: {:?}", diagnosis.kind);
        println!("  Confidence: {:.0}%", diagnosis.confidence * 100.0);
        println!("  Suggested Repair: {:?}", diagnosis.suggested_strategy);
        if !diagnosis.evidence.is_empty() {
            println!("  Evidence: {}", diagnosis.evidence.join(", "));
        }
        println!();
    }

    Ok(())
}

/// Example 3: Smart retry with exponential backoff
async fn example_smart_retry() -> BioApiResult<()> {
    println!("=== Example 3: Smart Retry Strategy ===\n");

    let client = UniProtClient::new();

    // Attempt to fetch with automatic retry on transient failures
    println!("Fetching protein data with auto-retry...");
    let start = std::time::Instant::now();

    match client.get_protein_info("P04637").await {
        Ok(protein) => {
            println!("✅ Success after {:?}", start.elapsed());
            println!("  Protein: {}", protein.uniprot_id);
            if let Some(name) = &protein.protein_name {
                println!("  Name: {}", name);
            }
        }
        Err(e) => {
            println!("❌ Failed after {:?}: {}", start.elapsed(), e);

            // Classify the failure
            let context = FailureContext::new("uniprot", "/uniprot/P04637", 3);
            let diagnosis = FailureClassifier::classify(&e, &context);

            println!("\nFailure Analysis:");
            println!("  Kind: {:?}", diagnosis.kind);
            println!("  Suggested action: {:?}", diagnosis.suggested_strategy);
        }
    }

    println!();
    Ok(())
}

/// Example 4: Batch queries with error handling
async fn example_batch_with_error_handling() -> BioApiResult<()> {
    println!("=== Example 4: Batch Queries with Error Handling ===\n");

    use std::sync::Arc;
    let client = Arc::new(EnsemblClient::new());
    let genes = vec!["BRCA1", "INVALID_GENE", "TP53", "FAKE_GENE", "EGFR"];

    println!("Querying {} genes (some invalid)...", genes.len());

    let executor = BatchExecutor::new(3);
    let results = executor
        .execute_batch(genes.clone(), move |gene| {
            let client = Arc::clone(&client);
            async move { client.search_genes(gene, None).await }
        })
        .await;

    // Separate successes and failures
    let mut successes = 0;
    let mut failures = 0;

    for (gene, result) in genes.iter().zip(results.iter()) {
        match result {
            Ok(data) => {
                successes += 1;
                println!("  ✅ {} -> {} results", gene, data.len());
            }
            Err(e) => {
                failures += 1;
                println!("  ❌ {} -> {}", gene, e);
            }
        }
    }

    println!("\nSummary: {} successes, {} failures", successes, failures);
    println!();
    Ok(())
}

#[tokio::main]
async fn main() -> BioApiResult<()> {
    println!("\n🧬 aos-bio-apis: Batch Queries & Self-Healing Examples\n");
    println!("{}", "=".repeat(60));
    println!();

    // Run all examples
    example_parallel_queries().await?;
    example_self_healing().await?;
    example_smart_retry().await?;
    example_batch_with_error_handling().await?;

    println!("{}", "=".repeat(60));
    println!("\n✅ All examples completed!\n");

    Ok(())
}
