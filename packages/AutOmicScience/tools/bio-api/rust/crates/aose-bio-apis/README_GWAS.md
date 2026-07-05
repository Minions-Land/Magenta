# GWAS Catalog Client

Full implementation of the GWAS Catalog API client for querying genetic associations from the NHGRI-EBI GWAS Catalog.

## Features

- **Gene associations**: Query variants associated with specific genes
- **Trait associations**: Find genetic variants linked to phenotypes/diseases
- **SNP information**: Retrieve detailed information about specific variants
- **Type-safe models**: Strongly-typed data structures for associations and SNPs
- **Automatic retries**: Built-in exponential backoff with jitter
- **Rate limiting**: Compliant with GWAS Catalog API limits (10 req/sec)
- **Provenance**: Full metadata for reproducibility

## API Methods

### `get_gene_associations(gene_symbol: &str)`

Retrieve all GWAS associations for a specific gene.

```rust
let client = GwasCatalogClient::new();
let associations = client.get_gene_associations("PKD1").await?;

for assoc in associations {
    println!("{} - {} (p={:.2e})", assoc.rsid, assoc.trait_name, assoc.p_value);
}
```

### `get_trait_associations(trait_name: &str)`

Find genetic variants associated with a specific trait or disease.

```rust
let associations = client.get_trait_associations("polycystic kidney disease").await?;

// Filter genome-wide significant hits
let significant: Vec<_> = associations
    .iter()
    .filter(|a| a.p_value < 5e-8)
    .collect();
```

### `get_snp_info(rsid: &str)`

Get detailed information about a specific SNP/variant.

```rust
let snp_info = client.get_snp_info("rs429358").await?;

println!("Chromosome: {:?}", snp_info.chromosome);
println!("Position: {:?}", snp_info.position);
println!("Functional class: {:?}", snp_info.functional_class);
```

### `search_associations(trait_name: &str)`

Alias for `get_trait_associations` for consistency with other search APIs.

## Data Models

### `GwasAssociation`

Represents a genetic association between a variant and a trait.

```rust
pub struct GwasAssociation {
    pub rsid: String,                    // SNP identifier (e.g., "rs123456")
    pub trait_name: String,              // Associated phenotype/disease
    pub p_value: f64,                    // Statistical significance
    pub risk_allele: Option<String>,     // Risk-conferring allele
    pub mapped_genes: Vec<String>,       // Nearby/affected genes
    pub chromosome: Option<String>,      // Chromosomal location
    pub position: Option<u64>,           // Base pair position
    pub study: Option<String>,           // Source publication (PMID)
    pub or_value: Option<f64>,           // Odds ratio
    pub beta_value: Option<f64>,         // Effect size (quantitative traits)
    pub beta_unit: Option<String>,       // Unit for effect size
    pub risk_frequency: Option<String>,  // Risk allele frequency
}
```

### `SnpInfo`

Detailed information about a specific SNP/variant.

```rust
pub struct SnpInfo {
    pub rsid: String,                     // SNP identifier
    pub chromosome: Option<String>,       // Chromosome number/name
    pub position: Option<u64>,            // Genomic position (bp)
    pub functional_class: Option<String>, // Functional annotation
    pub gene_region: Option<String>,      // Gene/region name
    pub merged: i32,                      // Merge status (0=current)
    pub last_update: Option<String>,      // Last update timestamp
}
```

## Configuration

### Custom Retry Policy

```rust
use std::time::Duration;

let retry_policy = RetryPolicy {
    max_retries: 5,
    initial_backoff: Duration::from_millis(500),
    max_backoff: Duration::from_secs(60),
    backoff_multiplier: 2.0,
    jitter: true,
};

let client = GwasCatalogClient::with_retry_policy(retry_policy);
```

### Rate Limiting

The client automatically enforces rate limiting at 10 requests/second (GWAS Catalog recommendation). Additional requests will wait until capacity is available.

## Use Cases

### PKD1/PKD2 Genetic Architecture

Query variants associated with polycystic kidney disease genes:

```rust
let client = GwasCatalogClient::new();

// Get PKD1 associations
let pkd1_assocs = client.get_gene_associations("PKD1").await?;
println!("PKD1: {} associations", pkd1_assocs.len());

// Get PKD2 associations
let pkd2_assocs = client.get_gene_associations("PKD2").await?;
println!("PKD2: {} associations", pkd2_assocs.len());

// Find trait-level associations
let disease_assocs = client.get_trait_associations("polycystic kidney disease").await?;

// Identify genome-wide significant hits
for assoc in disease_assocs.iter().filter(|a| a.p_value < 5e-8) {
    println!("Significant: {} in {} (p={:.2e}, OR={:?})",
        assoc.rsid,
        assoc.mapped_genes.join(", "),
        assoc.p_value,
        assoc.or_value
    );
}
```

### Variant Lookup and Annotation

```rust
let rsids = vec!["rs12345", "rs67890", "rs11111"];

for rsid in rsids {
    match client.get_snp_info(rsid).await {
        Ok(snp) => {
            println!("{}: chr{}:{} ({})",
                snp.rsid,
                snp.chromosome.as_deref().unwrap_or("?"),
                snp.position.map(|p| p.to_string()).unwrap_or_else(|| "?".to_string()),
                snp.functional_class.as_deref().unwrap_or("unknown")
            );
        }
        Err(e) => eprintln!("Failed to fetch {}: {}", rsid, e),
    }
}
```

## Error Handling

All methods return `BioApiResult<T>`, which is `Result<T, BioApiError>`.

Common errors:
- `BioApiError::NotFound`: Gene/SNP/trait not found
- `BioApiError::RateLimitExceeded`: Too many requests (automatic retry)
- `BioApiError::ApiError`: API returned error status
- `BioApiError::MaxRetriesExceeded`: Operation failed after retries

```rust
match client.get_gene_associations("INVALID").await {
    Ok(assocs) => println!("Found {} associations", assocs.len()),
    Err(BioApiError::NotFound(msg)) => println!("Not found: {}", msg),
    Err(e) => eprintln!("Error: {}", e),
}
```

## Testing

### Unit Tests

```bash
cargo test -p aose-bio-apis --lib gwas
```

### Integration Tests (Network Required)

```bash
# Run live API tests
cargo test -p aose-bio-apis --test gwas_integration -- --ignored

# Run specific test
cargo test -p aose-bio-apis --test gwas_integration test_get_gene_associations_pkd1 -- --ignored
```

## Example

```bash
cargo run --example gwas_query
```

## API Documentation

- **GWAS Catalog REST API**: https://www.ebi.ac.uk/gwas/rest/docs/api
- **Data model**: https://www.ebi.ac.uk/gwas/docs/methods/curation
- **Citation**: Sollis E, et al. (2023) The NHGRI-EBI GWAS Catalog. Nucleic Acids Res. 51(D1):D977-D985.

## Implementation Notes

### API Endpoints Used

1. `/associations/search/findByGene?geneName={gene}`
2. `/associations/search/findByEfoTrait?efoTrait={trait}&size=100`
3. `/singleNucleotidePolymorphisms/search/findByRsId?rsId={rsid}`

### Response Parsing

The GWAS Catalog API returns HAL+JSON format with nested `_embedded` structures. The client:
- Extracts associations from `_embedded.associations`
- Parses p-values from mantissa/exponent or text fields
- Resolves gene names from locus structures
- Handles both current and legacy response formats

### Limitations

- Maximum 100 results per query (API pagination not yet implemented)
- Trait queries require exact or close EFO term matches
- Some associations may lack genomic coordinates
- Effect sizes (OR, beta) not available for all studies

## Roadmap

- [ ] Add pagination support for large result sets
- [ ] Implement study-level queries
- [ ] Add EFO ontology term expansion
- [ ] Support batch SNP lookups
- [ ] Cache frequently accessed associations
- [ ] Add LD proxy lookup integration

## Contributing

When adding new endpoints:
1. Update `GwasCatalogClient` with new method
2. Add response parsing logic
3. Update or add models in `models.rs`
4. Write unit tests for parsing
5. Add integration test with `#[ignore]`
6. Update this documentation

---

**Implemented**: 2026-06-10  
**Status**: Production-ready  
**Coverage**: Core endpoints (gene, trait, SNP queries)
