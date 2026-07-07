# Reference — Olink NPX QC & Differential Expression

Olink is a targeted, antibody-based proteomics platform reporting NPX (Normalized Protein eXpression). Handling QC flags, LOD, and paired DE correctly.

## NPX scale

- **NPX is already log2-transformed** (arbitrary units on a log2 scale). **Do NOT log again.**
- Higher NPX = higher protein abundance.
- Differences in NPX are log2 fold-changes directly: `ΔNPX = log2FC`.

## QC columns

Olink exports carry QC metadata:

| Column | Values | Meaning |
|--------|--------|---------|
| `QC_Warning` | PASS / WARN / FAIL | Sample-level QC |
| `Assay_Warning` | PASS / WARN | Assay (protein) level |
| `LOD` | numeric | Limit of detection (NPX below = unreliable) |

**Filtering strategy:**
```python
# Conservative: PASS only
olink_clean = olink[(olink.QC_Warning == "PASS") & (olink.Assay_Warning == "PASS")]

# Permissive: PASS + WARN (report the WARN count)
olink_clean = olink[olink.QC_Warning != "FAIL"]
```

State which you used. FAIL samples/assays should almost always be dropped.

## LOD handling

Values below LOD are unreliable (near the noise floor):

```python
# Option 1: flag below-LOD
olink["below_lod"] = olink.NPX < olink.LOD

# Option 2: censor (set to LOD) — for detection-rate analysis
olink["NPX_censored"] = olink.NPX.clip(lower=olink.LOD)

# Option 3: drop proteins with high below-LOD rate (>50% of samples)
detection_rate = (olink.NPX >= olink.LOD).groupby(olink.Assay).mean()
detectable = detection_rate[detection_rate > 0.5].index
```

Report the detection rate per protein; proteins mostly below LOD give unreliable DE.

## Duplicate assays

Some proteins appear on multiple Olink panels. Average (or select by panel) after QC:

```python
# Average NPX for duplicated (sample, protein)
npx_dedup = olink_clean.groupby(["SampleID", "Assay"]).NPX.mean().reset_index()
```

## Long → wide pivot

Olink ships long (one row per sample × protein). Reshape for DE:

```python
npx_matrix = npx_dedup.pivot(index="SampleID", columns="Assay", values="NPX")
# samples × proteins
```

## Paired within-subject DE

For longitudinal designs (baseline vs follow-up in the same subject):

```python
from scipy.stats import ttest_rel
from statsmodels.stats.multitest import multipletests

# Align by subject: t1 and t2 must be same subjects, same order
subjects = sorted(set(meta[meta.timepoint=="baseline"].subject) &
                  set(meta[meta.timepoint=="followup"].subject))
t1 = npx_matrix.loc[[s+"_baseline" for s in subjects]]
t2 = npx_matrix.loc[[s+"_followup" for s in subjects]]

results = []
for protein in npx_matrix.columns:
    a, b = t1[protein].values, t2[protein].values
    mask = ~(np.isnan(a) | np.isnan(b))
    if mask.sum() < 3:  # need enough pairs
        continue
    stat, p = ttest_rel(a[mask], b[mask])
    log2fc = (b[mask] - a[mask]).mean()   # NPX already log2
    results.append({"protein": protein, "log2FC": log2fc, "t": stat, "p": p, "n_pairs": mask.sum()})

de = pd.DataFrame(results)
de["padj"] = multipletests(de.p, method="fdr_bh")[1]
```

**Paired t-test (`ttest_rel`), NOT independent (`ttest_ind`)** — the within-subject design removes between-subject variance, giving much more power.

## Unpaired two-group DE

For case-vs-control (independent groups):

```python
from scipy.stats import ttest_ind
# Or statsmodels OLS with covariates:
import statsmodels.formula.api as smf
model = smf.ols("NPX ~ group + age + sex", data=protein_df).fit()
# p-value for group effect: model.pvalues["group[T.case]"]
```

Use OLS/MixedLM when you need covariate adjustment.

## Pitfalls

- **Re-logging NPX** — it's already log2; taking log again is wrong
- **Independent t-test on paired data** — loses power; use `ttest_rel` for within-subject
- **Ignoring LOD** — below-LOD values are noise; flag or censor
- **Keeping FAIL QC** — drop them
- **No FDR** — hundreds of proteins tested need BH correction
- **Misaligned pairs** — t1 and t2 must be the same subjects in the same order

## Grounding

`report`: QC filter applied (PASS vs PASS+WARN, n dropped), LOD handling, test (paired/unpaired), n proteins tested, n significant at padj<0.05, top hits with log2FC.
