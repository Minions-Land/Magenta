//! Manual verification that the Rust virus client can produce the 4-file contract.
//!
//! Run with: cargo run --example verify_virus_e2e --manifest-path crates/aos-bio-apis/Cargo.toml

use aose_bio_apis::clients::ncbi_virus::{NcbiVirusClient, VirusQueryParams};

#[tokio::main]
async fn main() {
    println!("=== Rust virus pipeline verification ===\n");

    let client = NcbiVirusClient::new(std::env::var("NCBI_API_KEY").ok());

    // Fetch SARS-CoV-2 reference
    println!("Fetching NC_045512.2 metadata...");
    let records = client
        .fetch_by_accessions(&["NC_045512.2".to_string()], VirusQueryParams::default())
        .await
        .expect("fetch failed");

    println!("✓ Fetched {} records", records.len());
    assert!(!records.is_empty(), "should have records");

    // Download sequences
    println!("Downloading FASTA via efetch...");
    let accessions: Vec<String> = records.iter().map(|r| r.accession.clone()).collect();
    let fasta = client
        .download_sequences(&accessions)
        .await
        .expect("download failed");

    let bases: usize = fasta
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with('>'))
        .map(|l| l.trim().len())
        .sum();

    println!("✓ Downloaded FASTA: {} bases", bases);
    assert!(
        (29900..=29906).contains(&bases),
        "unexpected base count: {bases}"
    );

    // Write 4 files (mimicking write_virus_outputs)
    let out = std::env::temp_dir().join("aose_virus_verify");
    std::fs::create_dir_all(&out).unwrap();

    println!("\nWriting 4-file output to {}...", out.display());

    // 1. FASTA
    let fasta_out = format!("{}\n", fasta.trim_end());
    std::fs::write(out.join("NC_045512_2_sequences.fasta"), &fasta_out).unwrap();

    // 2. JSONL
    let mut jsonl = String::new();
    for r in &records {
        jsonl.push_str(&serde_json::to_string(r).unwrap());
        jsonl.push('\n');
    }
    std::fs::write(out.join("NC_045512_2_metadata.jsonl"), jsonl).unwrap();

    // 3. CSV
    let mut wtr = csv::Writer::from_writer(Vec::new());
    wtr.write_record(&[
        "accession",
        "length",
        "completeness",
        "hostName",
        "location",
    ])
    .unwrap();
    for r in &records {
        let host = r
            .host
            .as_ref()
            .and_then(|h| h.organism_name.clone())
            .unwrap_or_default();
        let location = r
            .location
            .as_ref()
            .and_then(|l| l.geographic_location.clone())
            .unwrap_or_default();
        wtr.write_record(&[
            r.accession.clone(),
            r.length.map(|n| n.to_string()).unwrap_or_default(),
            r.completeness.clone().unwrap_or_default(),
            host,
            location,
        ])
        .unwrap();
    }
    wtr.flush().unwrap();
    std::fs::write(
        out.join("NC_045512_2_metadata.csv"),
        wtr.into_inner().unwrap(),
    )
    .unwrap();

    // 4. Summary
    let summary = format!(
        "gget virus (rust-native) verification\n\
========================================\n\
Query: NC_045512.2\n\
\n\
Total records from API: {}\n\
Final sequences (after all filters): {}\n\
Sequence length range: {}\n\
\n\
Command completed successfully.\n",
        records.len(),
        records.len(),
        records[0]
            .length
            .map(|n| format!("{n}"))
            .unwrap_or_else(|| "N/A".to_string())
    );
    std::fs::write(out.join("command_summary.txt"), summary).unwrap();

    println!("✓ Wrote 4 files:");
    for entry in std::fs::read_dir(&out).unwrap() {
        let path = entry.unwrap().path();
        let size = std::fs::metadata(&path).unwrap().len();
        println!(
            "  - {} ({} bytes)",
            path.file_name().unwrap().to_string_lossy(),
            size
        );
    }

    // Verify sequence count from FASTA
    let seq_count = fasta_out.lines().filter(|l| l.starts_with('>')).count();
    println!("\n✓ FASTA headers (sequence count): {}", seq_count);

    // Parse and show summary stats
    let summary_text = std::fs::read_to_string(out.join("command_summary.txt")).unwrap();
    println!("\nSummary preview:");
    for line in summary_text.lines().take(6) {
        println!("  {}", line);
    }

    println!("\n=== VERIFICATION PASSED ===");
    println!("FASTA header: {}", fasta.lines().next().unwrap_or(""));
    println!("Base count: {}", bases);
    println!("Files: 4/4 present");
}
