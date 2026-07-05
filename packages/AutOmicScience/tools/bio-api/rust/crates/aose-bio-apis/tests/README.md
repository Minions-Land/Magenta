# Bio-APIs Integration Tests

This directory contains live API integration tests for the `aose-bio-apis` crate. All tests are marked with `#[ignore]` because they require network access and hit real external APIs.

## Test Files

### `live_connectivity.rs`
Basic connectivity tests for major bioinformatics APIs. Verifies that the HTTP clients can reach the endpoints and parse responses.

**Tested APIs:**
- UniProt REST API
- AlphaFold Database
- Open Targets Platform (GraphQL)
- Protein Data Bank (PDB)
- Enrichr

**Purpose:** Smoke tests to detect API changes or connectivity issues.

### `verify_claims.rs`
Targeted verification tests for specific clients used in bio tools.

**Tested APIs:**
- gnomAD (variant frequencies)
- STRING (protein-protein interaction networks)
- KEGG (pathway and gene information)

**Purpose:** Verify that tool-facing APIs return expected data structures.

### `gwas_integration.rs`
Comprehensive tests for the GWAS Catalog client.

**Tested APIs:**
- GWAS Catalog (gene associations, trait associations, SNP info)

**Purpose:** Validate complex query patterns and response parsing for GWAS data.

## Running Tests

### Run All Integration Tests
```bash
cargo test --package aose-bio-apis --tests -- --ignored
```

### Run Specific Test File
```bash
cargo test --package aose-bio-apis --test live_connectivity -- --ignored
cargo test --package aose-bio-apis --test verify_claims -- --ignored
cargo test --package aose-bio-apis --test gwas_integration -- --ignored
```

### Run Single Test Function
```bash
cargo test --package aose-bio-apis --test live_connectivity uniprot_rest_api_reachable -- --ignored
```

## Test Maintenance

### When to Update Tests

1. **API client added** - Add connectivity test to `live_connectivity.rs`
2. **API client removed** - Remove corresponding test
3. **Client used in bio tool** - Add verification test to `verify_claims.rs`
4. **API endpoint changed** - Update test assertions

### Debugging Failed Tests

**Network errors:**
- Check internet connectivity
- Verify API endpoint is not down (check status pages)
- Check for rate limiting (wait and retry)

**Parsing errors:**
- API response format may have changed
- Update client models in `aose-bio-apis/src/clients/`
- Update test assertions to match new response structure

**Timeout errors:**
- Some APIs (e.g., BLAST) can be slow
- Increase timeout in test if needed
- Consider mocking for CI if API is unreliable

## CI Integration

These tests are **not run** in the standard CI pipeline because they:
- Require network access
- Depend on external service availability
- Can be slow (some APIs take seconds to respond)

A separate weekly CI job runs these tests to detect API drift.

## Coverage Summary

**Total:** 12 live API tests covering 8 active bioinformatics databases.

- ✅ All tested clients are actively used in `aose-tools`
- ✅ All tests verify real HTTP requests (no mocks)
- ✅ Tests use well-known stable identifiers (P04637/TP53, 4HHB, etc.)
