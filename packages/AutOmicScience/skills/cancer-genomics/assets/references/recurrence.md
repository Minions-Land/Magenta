# Reference — Per-Patient Gene Recurrence

The single most-rewarded convention in cancer genomics rubrics: **collapse to per-patient binary alteration, not per-mutation counts.**

## The hypermutator problem

If you count raw mutation rows, a single hypermutator patient (e.g., MSI-high, 10,000 mutations) dominates every gene's frequency. The biological question is almost always "in what fraction of *patients* is gene X altered?" — a binary per-patient call.

**Wrong:**
```python
# Counts mutations — hypermutators dominate
gene_counts = maf.groupby("Hugo_Symbol").size()
```

**Right:**
```python
# Per-patient binary: is this gene altered in this patient at all?
altered = (
    pathogenic
    .groupby(["Tumor_Sample_Barcode", "Hugo_Symbol"])
    .size()
    .gt(0)                          # any pathogenic mutation → True
    .unstack(fill_value=False)      # patients × genes boolean matrix
)
```

## Recurrence frequency

```python
n_patients = altered.shape[0]
freq = altered.sum(axis=0) / n_patients   # fraction of patients altered per gene
freq = freq.sort_values(ascending=False)
print(freq.head(20))  # top recurrently-altered genes
```

Report as `gene: n_altered/n_total (pct%)`.

## Minimum-support filtering

Genes altered in very few patients are statistical noise. For association testing, gate to genes altered in **≥5 patients** (or ≥5% frequency):

```python
recurrent_genes = freq[altered.sum(axis=0) >= 5].index.tolist()
```

This also controls the FDR family size (fewer tests → more power after correction).

## Building the analysis matrix

The patients × genes boolean matrix `altered` is the substrate for:
- Frequency ranking (above)
- Fisher mutation×phenotype tests (`association.md`)
- Oncoplot (`oncoplot.md`)
- Mutual-exclusivity / co-occurrence

**Combining mutation + CNA into one alteration matrix:**
```python
# mut_altered: patients × genes (from MAF)
# cna_amp: patients × genes (GISTIC +2)
# cna_del: patients × genes (GISTIC -2)
# "altered" = any of pathogenic mutation, amplification (oncogene), deletion (TSG)
combined = mut_altered | cna_amp_oncogenes | cna_del_tsg
```

Be explicit about the per-gene rule (see `pathway_alteration.md`).

## Patient-level frequency ranking example (da-25-1)

```python
# TCGA PRAD: rank genes by patient-level alteration frequency
freq = altered.sum(axis=0).sort_values(ascending=False)
# Expected top: TP53, SPOP, ... 
top10 = freq.head(10)
```

## Pitfalls

- **Counting mutations not patients** — the #1 error; always collapse to per-patient binary first
- **Not deduplicating multi-sample patients** — a patient with primary+met counted twice
- **Forgetting the minimum-support gate** before association testing
- **Including silent mutations** — filter to pathogenic first (see `variant_classification.md`)

## Grounding

Emit a `report` with: n_patients, n_genes tested, top recurrent genes with exact frequencies. Every frequency traces to `altered.sum() / n_patients`.
