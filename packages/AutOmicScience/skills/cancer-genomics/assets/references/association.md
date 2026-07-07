# Reference — Mutation × Phenotype Association Testing

Testing whether a gene's alteration associates with a clinical phenotype (response, stage, subtype) via Fisher exact + FDR.

## The 2×2 table

For each gene, build a contingency table of alteration status × phenotype:

```
              Phenotype+   Phenotype-
Altered           a            b
Not altered       c            d
```

```python
from scipy.stats import fisher_exact

def gene_phenotype_test(gene, altered, phenotype_pos, alternative="two-sided"):
    is_altered = altered[gene]
    a = (is_altered & phenotype_pos).sum()
    b = (is_altered & ~phenotype_pos).sum()
    c = (~is_altered & phenotype_pos).sum()
    d = (~is_altered & ~phenotype_pos).sum()
    odds, p = fisher_exact([[a, b], [c, d]], alternative=alternative)
    return {"gene": gene, "a": a, "b": b, "c": c, "d": d, "odds_ratio": odds, "p": p}
```

## One-sided vs two-sided

- **Two-sided** (default): "is this gene associated with the phenotype?" (either direction)
- **One-sided** (`alternative="greater"` or `"less"`): "is this gene *enriched* in responders?" or directional **mutual exclusivity** (da-18-7)

**Mutual exclusivity** (two genes rarely co-altered) → one-sided `"less"` on co-occurrence, or test depletion of the double-altered cell. When the task asks specifically about exclusivity, use the directional test — a two-sided test caps the achievable score.

```python
# ESR1 vs MAPK-pathway mutual exclusivity (da-18-7): one-sided
odds, p = fisher_exact([[both, esr1_only], [mapk_only, neither]], alternative="less")
```

## BH-FDR across the gene set

Testing many genes inflates false positives. Apply Benjamini-Hochberg FDR:

```python
from statsmodels.stats.multitest import multipletests

results = pd.DataFrame([gene_phenotype_test(g, altered, pheno) for g in recurrent_genes])
results["padj"] = multipletests(results.p, method="fdr_bh")[1]
significant = results[results.padj < 0.05].sort_values("padj")
```

**FDR family = the set of genes tested.** Restrict to recurrent genes (≥5 patients) BEFORE testing — this shrinks the family and improves power.

## Minimum cell-count gate

Fisher exact is valid for small counts, but a gene altered in 1 patient gives an uninterpretable test. Gate to genes with adequate support:

```python
# Only test genes altered in ≥5 patients
testable = [g for g in genes if altered[g].sum() >= 5]
```

Some rubrics also require expected cell counts ≥5 (chi-square assumption) — Fisher exact doesn't need this, but the support gate is good practice.

## Clinical variable cleaning

Phenotype variables often need cleaning before testing:

**T-stage collapse** (da-25-1):
```python
# Collapse substages T1a/T1b/T1c → T1, then to early/late
clinical["T_stage"] = clinical["ajcc_T"].str.extract(r"(T\d)")   # T2a → T2
clinical = clinical[~clinical.T_stage.isin([None, "TX"])]         # drop unknowns
# Prefer pathological over clinical staging:
clinical["stage"] = clinical["path_T"].fillna(clinical["clin_T"])
```

**Response mapping** (irRECIST → binary):
```python
# CR/PR → Responder; SD/PD → Non-responder (or per protocol)
clinical["responder"] = clinical.irRECIST.isin(["CR", "PR"])
```

Drop ambiguous values ("Discrepancy", "Indeterminate", NA) explicitly.

## Full example (da-3-5: BRCA2 enrichment in responders)

```python
# 1. Per-patient alteration (already collapsed)
# 2. Responder phenotype
responder = clinical.set_index("patient").responder
# 3. Test each recurrent gene, one-sided (enrichment in responders)
results = pd.DataFrame([
    gene_phenotype_test(g, altered, responder, alternative="greater")
    for g in recurrent_genes
])
results["padj"] = multipletests(results.p, method="fdr_bh")[1]
# 4. Surface BRCA2
print(results[results.gene == "BRCA2"])
```

## Pitfalls

- **Wrong sidedness** — exclusivity/enrichment questions need one-sided; da-18-7 loss came from two-sided
- **No FDR** — testing 100 genes at p<0.05 gives ~5 false positives
- **FDR family too large** — testing all genes instead of recurrent ones dilutes power
- **No support gate** — singleton genes give meaningless tests
- **Phenotype not cleaned** — "Discrepancy"/NA rows leak in, substages not collapsed
- **Mutation counts not per-patient** — use the binary altered matrix (see `recurrence.md`)

## Grounding

`report`: genes tested (with family size), test (Fisher, sidedness), 2×2 counts for significant hits, odds ratio, raw p, padj.
