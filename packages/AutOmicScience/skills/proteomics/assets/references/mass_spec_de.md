# Reference — Mass-Spec Proteomics (MaxQuant / Perseus)

Parsing and analyzing shotgun mass-spectrometry proteomics output from MaxQuant and Perseus.

## MaxQuant proteinGroups.txt

The primary MaxQuant output. Tab-delimited, one row per protein group:

```python
import pandas as pd
pg = pd.read_csv("proteinGroups.txt", sep="\t", low_memory=False)
```

**Key columns:**
| Column | Meaning |
|--------|---------|
| `Protein IDs` | UniProt accessions (semicolon-separated for groups) |
| `Gene names` | Gene symbols (semicolon-separated) |
| `LFQ intensity <sample>` | Label-free quantification per sample |
| `Intensity <sample>` | Raw intensity |
| `Reverse` | `+` = decoy (reverse database hit) |
| `Potential contaminant` | `+` = contaminant (keratin, trypsin) |
| `Only identified by site` | `+` = ID'd only by modification site |

**Standard filtering (remove decoys/contaminants):**
```python
pg = pg[
    (pg["Reverse"] != "+") &
    (pg["Potential contaminant"] != "+") &
    (pg["Only identified by site"] != "+")
]
```

**Multi-gene protein groups:** a group like `GENEA;GENEB` is ambiguous. Either drop or take the leading (razor) protein:
```python
pg["Gene"] = pg["Gene names"].str.split(";").str[0]
pg = pg[pg["Gene names"].str.count(";") == 0]  # or keep leading only
```

## LFQ intensity → log2

LFQ intensities are NOT log-transformed. Log them before DE:

```python
import numpy as np
lfq_cols = [c for c in pg.columns if c.startswith("LFQ intensity ")]
lfq = pg[lfq_cols].replace(0, np.nan)      # 0 = not detected → NaN
log_lfq = np.log2(lfq)
```

## Perseus multi-header Excel

Perseus exports often have **multi-row headers** (a category row + a name row) and metadata columns:

```python
# Multi-header: rows 0 and 1 are both header
df = pd.read_excel("perseus_output.xlsx", header=[0, 1])
# Or skip metadata rows if single header lower down:
df = pd.read_excel("perseus_output.xlsx", skiprows=2)
```

Inspect the raw file first (`pd.read_excel(..., header=None).head(10)`) to find where data starts.

## Log2-ratio tables

Some proteomics studies ship pre-computed log2 ratios (case/control) with p-values:

```python
# Columns like: "log2 ratio", "-log10 p-value" or "p-value"
df["log2FC"] = df["log2 ratio"]
df["p"] = 10 ** (-df["-log10 p-value"])   # if given as -log10
# Filter significant:
sig = df[(df.p < 0.05) & (df.log2FC.abs() > 1)]
```

## Differential expression (from log2 intensities)

```python
from scipy.stats import ttest_ind
from statsmodels.stats.multitest import multipletests

# case vs control columns
results = []
for i, gene in enumerate(pg.Gene):
    case_vals = log_lfq.iloc[i][case_cols].dropna()
    ctrl_vals = log_lfq.iloc[i][ctrl_cols].dropna()
    if len(case_vals) < 2 or len(ctrl_vals) < 2:
        continue
    stat, p = ttest_ind(case_vals, ctrl_vals)
    log2fc = case_vals.mean() - ctrl_vals.mean()
    results.append({"gene": gene, "log2FC": log2fc, "p": p})
de = pd.DataFrame(results)
de["padj"] = multipletests(de.p, method="fdr_bh")[1]
```

For low replicate counts, consider **limma-style moderated t-test** (via `limma` in R, or a Python empirical-Bayes implementation) — MS proteomics often has n=3.

## Missing values

MS data has structured missingness (low-abundance proteins undetected in some samples):
- **MNAR** (missing not at random): below detection → impute with a low value (downshifted normal) or leave NaN
- **Filter**: require detection in ≥N samples per group before testing

```python
# Require ≥2 valid values per group
valid_case = log_lfq[case_cols].notna().sum(axis=1) >= 2
valid_ctrl = log_lfq[ctrl_cols].notna().sum(axis=1) >= 2
testable = pg[valid_case & valid_ctrl]
```

## Pitfalls

- **Not removing decoys/contaminants** — Reverse/contaminant hits inflate the protein count
- **Not logging LFQ** — raw intensities are not normal; log2 first
- **Treating 0 as a real value** — 0 = not detected → NaN
- **Multi-gene groups double-counted** — resolve to leading protein
- **Ignoring missingness structure** — MS missingness is informative (low abundance)
- **t-test with n=3** — underpowered; consider moderated t-test

## Grounding

`report`: n protein groups after filtering, log-transform applied, missingness handling, test used, n significant, top hits with log2FC.
