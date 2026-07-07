# Reference — Abundance Table Loading & CLR Transformation

Loading 16S OTU/ASV or metagenomic taxonomic abundance tables, filtering, and CLR transformation.

## Format
**Taxa × samples** matrix. Rows = OTUs/ASVs/species; columns = samples. Values = counts (raw reads) or relative abundance.

```python
import pandas as pd
abundance = pd.read_csv("otu_table.csv", index_col=0)  # taxa in rows
taxonomy = pd.read_csv("taxonomy.csv", index_col=0)    # OTU_ID → taxonomy levels
```

Taxonomy columns: Kingdom, Phylum, Class, Order, Family, Genus, Species (or collapsed like "k__Bacteria;p__Firmicutes;...").

## Prevalence filtering
Taxa present in <10% of samples are noise:
```python
prevalence = (abundance > 0).sum(axis=1) / abundance.shape[1]
keep = prevalence >= 0.1
abundance_filt = abundance.loc[keep]
```

## CLR transformation (centered log-ratio)
Compositional data requires log-ratio transformation:
```python
import numpy as np
from scipy.stats.mstats import gmean

def clr(counts):
    counts_pseudo = counts + 1  # pseudocount for zeros
    gm = gmean(counts_pseudo, axis=0)  # geometric mean per sample
    return np.log(counts_pseudo / gm)

clr_abundance = clr(abundance_filt.values)
```

**Why CLR:** microbiome counts are compositional (sum-to-constant constraint). Raw counts violate independence. CLR removes the constraint.

## Rarefaction (deprecated for DE)
Subsampling to even depth (rarefying) was common but **deprecated** — it discards information. Use CLR or DESeq2 size factors instead.

## Aggregating taxonomy levels
Collapse to a specific level (e.g., Genus):
```python
# Group by Genus column, sum counts
genus_abundance = abundance.groupby(taxonomy["Genus"]).sum()
```

Analyze at the finest reliable level (Genus/Species for 16S; Species for shotgun). Phylum is too coarse.

## Pitfalls
- No prevalence filter → testing rare taxa
- Not CLR-transforming → violates parametric assumptions
- Rarefaction for DE → loses power
- Wrong taxonomy level (Phylum → loses signal)

## Grounding
`report`: n samples, n taxa (raw / filtered), prevalence threshold, transformation (CLR / log+pseudocount / raw), taxonomy level.
