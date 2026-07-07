# Reference — Phosphoproteomics (Site-Specific & Activating Sites)

Phosphoproteomics measures phosphorylation site occupancy — not total protein abundance. Critical: ActivatingSite filtering and site nomenclature.

## Data structure

Phosphoproteomics tables have **site-level rows**, not gene-level:

| Protein | Site | Position | Phospho_abundance | Total_protein_abundance |
|---------|------|----------|-------------------|-------------------------|
| TP53    | S15  | 15       | 2.1               | 1.3                     |
| TP53    | S20  | 20       | 1.8               | 1.3                     |

Or a site identifier like `TP53_S15` (protein_site).

## Site nomenclature

- `S` = serine, `T` = threonine, `Y` = tyrosine (phosphorylatable)
- Position is AA number in the canonical UniProt isoform
- Example: `TP53_S15` = TP53 serine 15

## ActivatingSite filtering

Only a small subset of phosphosites are **activating** (enhance kinase/protein activity). Most are neutral or regulatory. PhosphoSitePlus curates "activating" annotations:

```python
# Download from phosphosite.org (Kinase_Substrate_Dataset)
activating_sites = pd.read_csv("activating_sites.csv")
# Columns: GENE, SITE, KINASE, ON_FUNCTION (e.g., "activates kinase")

# Filter phospho data to activating sites only
phospho_act = phospho[phospho.site_id.isin(activating_sites.site_id)]
```

**Why it matters:** Without activating-site filtering, DE phosphoproteomics picks up hundreds of neutral sites. The biological interpretation (which pathways are activated?) requires the functional subset.

## Phosphosite occupancy

Normalized phospho = phospho abundance / total protein abundance (to control for protein-level changes):

```python
phospho["occupancy"] = phospho.phospho_abundance / phospho.total_protein_abundance
# Or log2 ratio if already logged:
phospho["log2_occupancy"] = phospho.log_phospho - phospho.log_total
```

A site with high phospho_abundance but also high total_protein may not be specifically phosphorylated — the protein is just abundant. Occupancy corrects for this.

## Differential phosphorylation

```python
from scipy.stats import ttest_ind
from statsmodels.stats.multitest import multipletests

results = []
for site in phospho.site_id.unique():
    case = phospho[(phospho.site_id == site) & (phospho.group == "case")].occupancy
    ctrl = phospho[(phospho.site_id == site) & (phospho.group == "ctrl")].occupancy
    if len(case) < 2 or len(ctrl) < 2:
        continue
    stat, p = ttest_ind(case, ctrl)
    log2fc = np.log2(case.mean() / ctrl.mean())
    results.append({"site": site, "log2FC": log2fc, "p": p})
de = pd.DataFrame(results)
de["padj"] = multipletests(de.p, method="fdr_bh")[1]
```

## Integration with dependency (da-5-3)

Task: proteins upregulated in phospho AND dependency-flagged → driver candidates:

```python
# Phospho: activating-site upregulated (log2FC > 1, padj < 0.05)
phospho_up = set(de_phospho[(de_phospho.padj < 0.05) & (de_phospho.log2FC > 1)].gene)

# Dependency: gene-effect < -0.5 in relevant cancer
dep_genes = set(depmap[depmap.gene_effect < -0.5].gene)

# Overlap
candidates = phospho_up & dep_genes
```

Report the overlap with exact counts.

## PhosphoSitePlus curation

PhosphoSitePlus (phosphosite.org) provides:
- **ON_FUNCTION** annotations (activates kinase, enhances binding, …)
- **Kinase-substrate relationships** (which kinase phosphorylates this site)
- **Disease mutations** at or near phosphosites

Download the `Kinase_Substrate_Dataset` and `Regulatory_sites` tables (free for academic use).

## Pitfalls

- **Not normalizing by total protein** — high phospho may just reflect high protein
- **No ActivatingSite filter** — neutral sites dominate; biological signal buried
- **Treating phosphosites as genes** — `TP53_S15` ≠ TP53 gene-level
- **Not resolving isoform positions** — different isoforms have different numbering
- **Missing kinase-substrate context** — without the upstream kinase, interpretation is incomplete

## Grounding

`report`: n phosphosites measured, activating-site filter applied (source + n filtered), occupancy normalization method, test, n significant, top hits with gene/site/log2FC.
