# Gene Activity Scores

**Maturity: READY** — `omics_compute(subcommand="gene_activity", modality="scatac", ...)`, or `snap.pp.make_gene_matrix` directly. A rough proxy, **not expression**.

## Goal / When to Use

Compute gene-space proxy from accessibility for RNA integration or cluster identity sanity checks. **Not expression** - rough proxy only.

## Decision Criteria

Gene activity = TN5 insertions in regulatory domain (promoter ± window, optionally gene body). Use for:
- Integration with scRNA (label transfer bridge)
- Marker-based cluster identity hints
- **Validate against real RNA when paired data exists**

## Method Menu

`snap.pp.make_gene_matrix(adata, gene_anno=genome, include_gene_body=True, upstream=2000, downstream=0)`

Returns a gene-space AnnData ready for the scRNA marker/annotation recipes

## How-to

```python
ga = snap.pp.make_gene_matrix(
    adata,
    gene_anno=snap.genome.hg38,
    include_gene_body=True,
    upstream=2000,
    downstream=0
)

# Validate non-zero
assert ga.X.sum() > 0, "All-zero matrix - wrong genome/annotation"

# Store raw, normalize
ga.layers["counts"] = ga.X.copy()
sc.pp.normalize_total(ga, target_sum=1e4)
sc.pp.log1p(ga)
```

Now use the scRNA marker/annotation recipes on `ga` (omics-scrna)

## Pitfalls & Quality Checks

- **Never present gene activity as expression** in conclusions
- **All-zero matrix** = wrong genome/annotation mismatch - assert and fail loud
- Very sparse genes unreliable
- Window/body choices change smoothing

## Grounding

Record: gene-matrix shape, genome, window params → `EvidenceRecord`

## Honesty

State "gene activity proxy" explicitly - not expression
