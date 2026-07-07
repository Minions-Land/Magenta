# Reference — Hotspots & Protein-Domain Filtering

Restricting mutation analysis to specific protein positions (hotspots) or domains (functional regions) — often the difference between a passing and failing answer.

## Parsing protein position

From `HGVSp_Short` (e.g., `p.Y537S`) or `Protein_position` (e.g., `537/595`):

```python
import re

# From HGVSp_Short: "p.Y537S" → 537
maf["aa_pos"] = maf.HGVSp_Short.str.extract(r"p\.[A-Z*](\d+)").astype(float)

# From Protein_position: "537/595" → 537
maf["aa_pos"] = maf.Protein_position.str.split("/").str[0].astype(float)

# Reference AA and alt AA (for specific substitutions):
maf["aa_ref"] = maf.HGVSp_Short.str.extract(r"p\.([A-Z])\d+")
maf["aa_alt"] = maf.HGVSp_Short.str.extract(r"p\.[A-Z]\d+([A-Z*])")
```

## Hotspot identification

A hotspot = protein position recurrently mutated across samples (positive selection signal):

```python
# Count samples with each (gene, position)
hotspot_counts = (
    maf.groupby(["Hugo_Symbol", "aa_pos"])["Tumor_Sample_Barcode"]
    .nunique()
    .sort_values(ascending=False)
)
# Hotspots = positions mutated in ≥3 (or ≥5) distinct samples
hotspots = hotspot_counts[hotspot_counts >= 3]
```

Classic hotspots:
- **KRAS** p.G12, p.G13, p.Q61
- **BRAF** p.V600 (V600E)
- **PIK3CA** p.E542, p.E545, p.H1047
- **TP53** p.R175, p.R248, p.R273 (DNA-binding domain)
- **IDH1** p.R132
- **EGFR** p.L858R, exon 19 deletions

Or use the **cancerhotspots.org** catalog / OncoKB for curated hotspots.

## Protein-domain filtering

Restrict to mutations within a functional domain. Example — ESR1 ligand-binding domain (da-18-7):

```python
# ESR1 LBD: amino acids 300–550 (UniProt P03372)
esr1_lbd = maf[
    (maf.Hugo_Symbol == "ESR1") &
    (maf.aa_pos >= 300) &
    (maf.aa_pos <= 550)
]
# Key ESR1 LBD resistance mutations: Y537S, Y537N, Y537C, D538G
```

**Why it matters:** ESR1 mutations outside the LBD are not endocrine-resistance drivers. Testing whole-gene ESR1 dilutes the signal; the rubric expects the LBD restriction.

Domain coordinates come from **UniProt** (feature table) or **Pfam**:
```python
# Example domain windows (from UniProt):
domains = {
    ("ESR1", "LBD"): (300, 550),
    ("EGFR", "kinase"): (712, 979),
    ("BRAF", "kinase"): (457, 717),
}
```

## Specific residue lists

When a task names specific mutations (Y537S/Y537N/D538G):

```python
esr1_resistance = maf[
    (maf.Hugo_Symbol == "ESR1") &
    (maf.HGVSp_Short.isin(["p.Y537S", "p.Y537N", "p.Y537C", "p.D538G"]))
]
```

## Pitfalls

- **Whole-gene when hotspot/domain expected** — dilutes signal, misses the point (da-18-7)
- **Parsing failure on non-standard HGVSp** — check for NaN after extraction; some MAFs use different notation
- **Off-by-one in domain coordinates** — verify against UniProt (1-indexed AA positions)
- **No minimum recurrence for hotspot** — singleton positions aren't hotspots; require ≥3 samples
- **Missing frame-shift/nonsense in position parse** — those change the regex (`p.G12fs`, `p.R213*`)

## Grounding

`report`: gene, domain/hotspot definition (coordinates or residue list) with source, n mutations passing filter, sample count.

## Sources
- cancerhotspots.org — statistically-derived hotspots
- OncoKB — curated oncogenic hotspots
- UniProt — domain coordinates
