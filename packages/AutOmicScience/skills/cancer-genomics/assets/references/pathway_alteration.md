# Reference — Pathway Alteration & Gene-Set Analysis

Pathway alteration = **any-hit logic**: a pathway is "altered" in a patient if ≥1 gene in the set has a pathogenic mutation (or CNA).

## The any-hit rule

**NOT a sum, NOT a score.** If a patient has TP53 + MDM2 + CDKN2A mutations (all p53-pathway), that patient counts **once** for "p53 pathway altered," not three times.

```python
# Pathway gene set
p53_pathway = ["TP53", "MDM2", "MDM4", "CDKN2A", "CDKN2B", "ATM"]

# Per-patient binary: is the pathway altered?
pathway_altered = altered[p53_pathway].any(axis=1)  # True if ≥1 gene hit

# Pathway frequency
pathway_freq = pathway_altered.sum() / len(pathway_altered)
print(f"p53 pathway altered in {pathway_freq:.1%} of patients")
```

## Defining gene sets

Common sources:
- **MSigDB Hallmark** — 50 biologically-coherent gene sets (e.g., `HALLMARK_P53_PATHWAY`, `HALLMARK_MYC_TARGETS_V1`)
- **KEGG / Reactome** — mechanistic pathways (signaling cascades, metabolic)
- **Custom oncogenic pathways** (RTK-RAS-PI3K, cell cycle, DNA repair, …)
- **CGC functional groups** — oncogenes, TSGs, translocations

Download from MSigDB or define manually:

```python
import requests
# MSigDB H (hallmark) collection (requires free registration)
# Or hardcode the common sets:
pathways = {
    "p53": ["TP53", "MDM2", "MDM4", "CDKN2A", "CDKN2B", "ATM"],
    "RTK-RAS": ["KRAS", "NRAS", "HRAS", "BRAF", "EGFR", "ERBB2", "MET", "ALK"],
    "PI3K-AKT": ["PIK3CA", "PIK3R1", "PTEN", "AKT1", "AKT2", "MTOR"],
    "cell_cycle": ["CCND1", "CCNE1", "CDK4", "CDK6", "RB1", "E2F1"],
}
```

## Pathway alteration matrix

For multiple pathways:

```python
pathway_matrix = pd.DataFrame({
    name: altered[genes].any(axis=1)
    for name, genes in pathways.items()
})
# patients × pathways boolean matrix
```

Then compute frequencies, test associations, or visualize.

## Per-gene-in-pathway contributions (da-18-5 "top driver in pathway")

If you want to rank which genes in the pathway are most altered:

```python
# p53 pathway, per-gene frequency
p53_gene_freq = altered[p53_pathway].sum(axis=0).sort_values(ascending=False)
print(f"Top driver in p53 pathway: {p53_gene_freq.index[0]} ({p53_gene_freq.iloc[0]} / {len(altered)} patients)")
```

But the **pathway-level alteration** (for enrichment tests) is still the any-hit boolean, not the sum.

## Combining mutation + CNA for pathway analysis (da-18-5, da-18-7)

Per-gene rules:
- **Oncogenes**: mutation (hotspot) OR amplification (+2)
- **Tumor suppressors**: mutation (LoF) OR deep deletion (−2)

```python
oncogenes_in_pathway = ["KRAS", "BRAF"]
tsg_in_pathway = ["TP53", "PTEN"]

pathway_altered = (
    mut_altered[oncogenes_in_pathway].any(axis=1) |
    cna_amplified[oncogenes_in_pathway].any(axis=1) |
    mut_altered[tsg_in_pathway].any(axis=1) |
    cna_deleted[tsg_in_pathway].any(axis=1)
)
```

State the rule explicitly in the `report`.

## Pitfalls

- **Summing instead of any-hit** — double-counts patients with multiple hits
- **Wrong per-gene alteration rule** — treating TSG amplification as a driver, or oncogene deletion
- **Not defining the gene set source** — "MAPK pathway" is ambiguous; cite MSigDB or a paper
- **Including silent mutations** — filter to pathogenic first

## Grounding

`report`: pathway name, gene-set members, alteration rule (mut + CNA logic), frequency with exact n_altered / n_total.
