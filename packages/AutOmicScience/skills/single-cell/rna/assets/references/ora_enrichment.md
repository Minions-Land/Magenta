# Reference — Over-Representation Analysis (ORA) after DE

ORA (over-representation analysis) tests whether a gene signature is enriched among differentially-expressed genes, using a hypergeometric/Fisher test with the correct background universe.

## Goal

After a DE analysis (e.g., pseudobulk DESeq2), test: "are the upregulated genes enriched for signature X (an ISG signature, a pathway, a published gene set)?"

## The hypergeometric test

Parameters:
- **N**: universe = all genes tested in the DE analysis (NOT the whole genome)
- **K**: genes in the signature that are also in the universe
- **n**: DE genes (e.g., upregulated at padj<0.05, |log2FC|>0.5)
- **k**: overlap = DE genes that are in the signature

```python
from scipy.stats import hypergeom

# Universe = all genes with a DE result (tested genes)
universe = set(de_results.index)
N = len(universe)

# Signature restricted to the universe
signature = set(isg_signature) & universe
K = len(signature)

# DE genes (upregulated)
de_genes = set(de_results[(de_results.padj < 0.05) & (de_results.log2FoldChange > 0.5)].index)
n = len(de_genes)

# Overlap
overlap = de_genes & signature
k = len(overlap)

# P(X >= k)
p = hypergeom.sf(k - 1, N, K, n)
fold_enrichment = (k / n) / (K / N)
print(f"ORA: {k}/{n} DE genes in signature (fold={fold_enrichment:.2f}, p={p:.3e})")
```

## Critical: the universe is the tested genes

**WRONG:** using all ~20,000 human genes as N.

**RIGHT:** using the genes that had a DE result (passed expression filters and were tested). If DESeq2 tested 12,000 genes after independent filtering, N = 12,000.

Using the whole genome inflates enrichment (the untested genes couldn't have been DE, so they don't belong in the draw).

## Fisher exact (equivalent 2×2 form)

```python
from scipy.stats import fisher_exact
#              In signature   Not in signature
# DE               k              n - k
# Not DE         K - k       N - n - (K - k)
table = [[k, n - k], [K - k, N - n - (K - k)]]
odds, p = fisher_exact(table, alternative="greater")  # one-sided: enrichment
```

## gseapy alternative

For standard gene-set collections (MSigDB, GO, KEGG), `gseapy.enrichr` handles the universe and multiple testing:

```python
import gseapy as gp
enr = gp.enrichr(
    gene_list=list(de_genes),
    gene_sets=["MSigDB_Hallmark_2020", "Reactome_2022"],
    background=list(universe),   # supply the correct background!
)
print(enr.results[enr.results["Adjusted P-value"] < 0.05])
```

**Always pass `background`** — enrichr defaults to a generic background otherwise.

## GSEA vs ORA

- **ORA** (this doc): tests a *thresholded* gene list (DE genes) for signature overlap. Simple, requires a cutoff.
- **GSEA** (prerank): tests whether a signature is enriched at the top/bottom of a *ranked* gene list (by log2FC or stat), no cutoff. Use `gseapy.prerank`. More sensitive to coordinated small changes.

Choose ORA when you have a clear DE cutoff; GSEA when you want the whole ranking.

## Directional ORA

Test up- and down-regulated genes separately — a signature may be enriched in one direction:

```python
up = set(de_results[(de_results.padj<0.05) & (de_results.log2FoldChange>0.5)].index)
down = set(de_results[(de_results.padj<0.05) & (de_results.log2FoldChange<-0.5)].index)
# Run hypergeometric for each against the signature
```

## Pitfalls

- **Whole-genome universe** — inflates enrichment; use tested genes
- **No background in enrichr** — defaults to a generic list, wrong denominator
- **Pooling up + down** — a signature enriched in up may be diluted if pooled with down
- **Signature genes not mapped to universe namespace** — symbol vs Ensembl mismatch drops overlap
- **No multiple-testing correction** — testing many signatures needs BH-FDR

## Grounding

`report`: universe size N (and its definition), signature size K, DE gene count n, overlap k, fold-enrichment, p-value, direction (up/down).
