# aose-bio-apis

Pure Rust bioinformatics API clients for AutOmicScience.

## Overview

This crate provides HTTP clients for major bioinformatics databases, replacing Python GGET dependencies with native Rust implementations. It includes:

- **Type-safe models**: Strongly-typed data structures with serde
- **Retry logic**: Exponential backoff with jitter
- **Rate limiting**: Compliant with each API's requirements  
- **Provenance metadata**: Full trace of API calls for reproducibility
- **Performance**: Target <500ms for typical queries

## Supported APIs

### Implemented (Stubs)
- **EnsemblClient** - Gene annotation, sequences, references (15 req/sec)
- **NcbiClient** - BLAST, E-utilities, virus data (3-10 req/sec)
- **UniProtClient** - Protein annotation and sequences (10 req/sec)
- **GwasCatalogClient** - Genetic associations (10 req/sec)
- **AlphaFoldClient** - Protein structure predictions (10 req/sec)

### Planned
- **GtexClient** - Gene expression and eQTLs
- **DepMapClient** - Cancer dependency data

## Architecture

```
aose-bio-apis/
├── src/
│   ├── lib.rs              # Public API and re-exports
│   ├── error.rs            # Unified error types
│   ├── retry.rs            # Exponential backoff with jitter
│   ├── rate_limiter.rs     # Token bucket rate limiting
│   ├── models.rs           # Shared data structures
│   ├── clients.rs          # Client module re-exports
│   └── clients/
│       ├── ensembl.rs      # Ensembl REST API
│       ├── ncbi.rs         # NCBI E-utilities & BLAST
│       ├── uniprot.rs      # UniProt REST API
│       ├── gwas.rs         # GWAS Catalog API
│       └── alphafold.rs    # AlphaFold DB API
└── Cargo.toml
```

## Usage

```rust
use aose_bio_apis::clients::ensembl::EnsemblClient;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = EnsemblClient::new();
    let genes = client.search_genes("BRCA2", None).await?;
    println!("Found {} genes", genes.len());
    Ok(())
}
```

## Features

- `cache` - Enable optional LRU caching with moka
- `fasta` - Enable FASTA parsing with bio crate

## Dependencies

- **reqwest** - HTTP client with JSON support
- **serde/serde_json** - Serialization
- **tokio** - Async runtime
- **governor** - Rate limiting
- **anyhow/thiserror** - Error handling
- **chrono** - Timestamp handling
- **rand** - Jitter for retry backoff

## Implementation Status

**Phase 2A (Week 1-2):** Foundation - ✅ Complete
- Crate skeleton created
- Error handling, retry, rate limiting implemented
- Unit tests passing

**Phase 2B (Week 3):** NCBI Integration - 🔄 Planned
- Implement NCBI BLAST client
- Add E-utilities support
- Virus data retrieval

**Phase 2C (Week 4):** New APIs - 🔄 Planned
- Complete Ensembl client implementation
- GWAS Catalog integration
- AlphaFold DB integration
- Register all tools in aose-tools

**Phase 2D (Week 5):** Optimization - 🔄 Planned
- Add caching layer
- Performance benchmarking
- Documentation and examples

## Testing

```bash
# Run all tests
cargo test -p aose-bio-apis

# Run with output
cargo test -p aose-bio-apis -- --nocapture

# Run specific test
cargo test -p aose-bio-apis test_retry_success_first_attempt
```

## Related Documentation

- [RUST_BIO_APIS_DESIGN.md](../../docs/RUST_BIO_APIS_DESIGN.md) - Design specification
- [PROVENANCE_GAP_ANALYSIS.md](../../docs/PROVENANCE_GAP_ANALYSIS.md) - Problem analysis

## License

MIT
