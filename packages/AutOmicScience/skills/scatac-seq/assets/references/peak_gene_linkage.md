# Peak-Gene Linkage

**Maturity: REFERENCE** — hand-rolled distance + correlation in `run_python` (no snapATAC2 peak-gene function exists). The **scATAC-only** path (gene activity / co-accessibility); for paired multiome with real RNA, see `multi-omics` (SCENIC+ region-gene links).

## Goal / When to Use

Connect candidate enhancers (peaks) to target genes for regulatory interpretation / GRN scaffolding. Use after peak calling and clustering, when you need peak→gene associations.

## Decision Criteria

**The judgment this guides:**

- **Distance-based linkage** (peak within N bp, e.g. 250-500 kb, of a gene TSS) is the cheap default and needs only ATAC. It's a candidate set, not proof of regulation.

- **Correlation / co-accessibility linkage** (peak accessibility vs gene activity, or better, paired RNA) is stronger but needs many cells and ideally **paired multiome**. If data is unpaired, say the links are distance-only candidates.

- **Restrict to differential / variable peaks** to keep it tractable — linking every peak to every gene is computationally expensive and mostly noise.

## Method Menu

- **Distance window** (compute from peak coords + gene annotation) — the baseline
- **Co-accessibility / correlation** (use gene activity from `gene_activity.md` or paired RNA from multiome)
- **`muon.atac.tl.add_peak_annotation`** + `muon.atac.tl.rank_peaks_groups` / `muon.atac.tl.add_genes_peaks_groups` — annotate peaks→genes for marker peaks

**Note:** There is **no SnapATAC2 `snap.tl.co_accessibility` or `snap.tl.peak_gene_linkage` function** (do not reach for one that doesn't exist). The linkage itself is computed **inline** from peak coordinates, the gene annotation, and accessibility↔activity correlation.

## How-to

### Distance-based linkage (inline)

```python
import pandas as pd
import numpy as np

# Get peak coords and gene TSS positions
peaks = adata.var  # peak annotations (chrom, start, end)
genes = genome.annotation  # or load from GTF

# Example: link peaks within 250kb of a gene TSS
links = []
for gene_name, gene_info in genes.items():
    gene_chrom = gene_info['chrom']
    gene_tss = gene_info['tss']

    # Find peaks on the same chrom within distance
    candidate_peaks = peaks[
        (peaks['chrom'] == gene_chrom) &
        (np.abs((peaks['start'] + peaks['end']) / 2 - gene_tss) <= 250_000)
    ]

    for peak_id in candidate_peaks.index:
        links.append({
            'peak': peak_id,
            'gene': gene_name,
            'distance': abs((peaks.loc[peak_id, 'start'] + peaks.loc[peak_id, 'end']) / 2 - gene_tss)
        })

link_table = pd.DataFrame(links)
print(f"Linked {len(link_table)} peak-gene pairs (distance ≤ 250kb)")
```

### Correlation-based linkage (with gene activity)

```python
# Assume you have gene activity from gene_activity.md
# ga = snap.pp.make_gene_matrix(...)

# For each peak-gene pair within distance, compute correlation
import scipy.stats as stats

link_table_with_corr = []
for _, row in link_table.iterrows():
    peak_id = row['peak']
    gene_name = row['gene']

    if gene_name not in ga.var_names:
        continue

    # Get accessibility and activity vectors
    peak_access = adata[:, peak_id].X.toarray().flatten()
    gene_act = ga[:, gene_name].X.toarray().flatten()

    # Pearson correlation
    r, p = stats.pearsonr(peak_access, gene_act)

    link_table_with_corr.append({
        **row,
        'correlation': r,
        'pvalue': p
    })

link_table_corr = pd.DataFrame(link_table_with_corr)

# Filter by correlation threshold
strong_links = link_table_corr[
    (link_table_corr['correlation'] > 0.3) &
    (link_table_corr['pvalue'] < 0.01)
]
print(f"{len(strong_links)} peak-gene pairs with r>0.3, p<0.01")
```

### muon annotation (marker peaks → nearby genes)

```python
import muon as mu

# Annotate peaks with nearby genes
mu.atac.tl.add_peak_annotation(
    adata,
    annotation_file='/path/to/genes.gtf',
    distance=250_000  # 250kb window
)
# Adds adata.uns['peak_annotation']

# Rank peaks per group
mu.atac.tl.rank_peaks_groups(adata, groupby='leiden', method='wilcoxon')

# Map ranked peaks to genes
mu.atac.tl.add_genes_peaks_groups(adata)
# Adds gene names to the ranked peaks table
```

## Pitfalls & Quality Checks

- **Distance ≠ regulation** — a peak within 250kb of a gene is a *candidate* regulatory element, not proof that it regulates that gene. Proximity is necessary but not sufficient.

- **Multiple-testing on correlations** — if you compute correlations for thousands of peak-gene pairs, apply FDR correction. Uncorrected p-values will give many false positives.

- **Do not assert causality from co-accessibility** — "peak X and gene Y are correlated" does not mean "peak X drives gene Y expression." It could be co-regulation by a third factor, or reverse causality.

- **`observe_figure`** — a heatmap or network diagram of top peak-gene links (e.g., TF-gene pairs where the peak overlaps a TF motif). Are the links biologically plausible?

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "method": "distance_plus_correlation",
  "distance_threshold_kb": 250,
  "n_peaks": 45000,
  "n_genes": 18000,
  "n_distance_links": 120000,
  "correlation_threshold": 0.3,
  "pvalue_threshold": 0.01,
  "n_correlated_links": 3500,
  "top_links": [
    {"peak": "chr1:12345-12600", "gene": "GATA1", "distance": 50000, "correlation": 0.65},
    ...
  ]
}
```

Ground: n peak-gene links, distance/correlation thresholds, top links with stats.

## Honesty

- **Label distance-only links as candidates** — "peak X is a candidate regulator of gene Y (distance 50kb)" is honest; "peak X regulates gene Y" is over-claiming without functional evidence.

- **Report when pairing is unavailable** — if you're working with unpaired ATAC (no matched RNA), say so and note that correlation-based links are computed via gene activity (a proxy, not expression).

- **Linkage is a scaffold, not a GRN** — peak-gene links are inputs to GRN inference (e.g., SCENIC+ in multiome), not the GRN itself. They constrain which peaks *could* regulate which genes, but they don't tell you which TFs are active or what the regulatory logic is.
