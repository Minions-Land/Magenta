# Pathway enrichment — pre-ranked GSEA & over-representation (ORA)

Two distinct methods for two distinct questions. Do not mix them up.

**Standard path — reuse the grounded subcommands** (deterministic, auto-recorded evidence):
`omics_compute(subcommand="enrichment", args={"adata": "...", "method": "gsea"|"ora", ...})` and
`omics_compute(subcommand="pathway_activity", args={"adata": "...", "resource": "msigdb"|"progeny"|"collectri", "method": "ulm"|"mlm"|"gsea"})`.
Load your DE ranking / expression matrix into an h5ad first (`omics_compute load_dataset`). Use these for the
standard run. Drop to the **hand-rolled recipes below** only when you need control the subcommand doesn't
expose — a custom ranking metric, a specific `.gmt`, a defined ORA background universe, or per-instance output.
Either way, the judgment (what to rank by, which collection, thresholds, interpretation) is yours to make.

- **GSEA (pre-ranked)** — uses the *whole ranked gene list* (every gene, ranked by a continuous statistic);
  asks whether a gene set is concentrated at the top/bottom. Use when you have a full DE result.
- **ORA (over-representation)** — uses a *thresholded gene set* (e.g. the significant DE genes); asks
  whether that set overlaps a pathway more than chance (Fisher's exact / hypergeometric).

## Pre-ranked GSEA (gseapy)

Rank by **log2FoldChange** (or shrunken LFC) descending; run `prerank` against MSigDB **Hallmark (H)**.

```python
import gseapy as gp, pandas as pd, json
res = pd.read_csv("de_results.csv", index_col=0)                 # from de.md
rnk = res["log2FoldChange"].dropna().sort_values(ascending=False)  # gene -> log2FC, ranked
pre = gp.prerank(rnk=rnk.reset_index().values.tolist(),
                 gene_sets="MSigDB_Hallmark_2020",                # or a local .gmt path
                 min_size=15, max_size=500, permutation_num=1000, seed=0, outdir=None)
out = pre.res2d[["Term", "NES", "NOM p-val", "FDR q-val"]].sort_values("NES")
sig = out[out["FDR q-val"] < 0.05]
print(json.dumps({"n_sets": int(len(out)),
                  "suppressed": sig[sig.NES < 0].head(10)["Term"].tolist(),   # negative NES
                  "activated":  sig[sig.NES > 0].head(10)["Term"].tolist()}))
```
Report **NES + adjusted p (FDR q-val)**; a set is "suppressed/down" when NES < 0 at FDR < 0.05.
Ranking metric matters: log2FC (effect direction/size) is the common default; a signed-statistic or
t-statistic ranking answers a slightly different question — pick and state one.

## ORA — Fisher's exact / hypergeometric

Requires an explicitly-defined **background universe** (M). The universe is the set of genes that *could*
have been tested — usually all genes in the annotation, or all expressed/background genes in your matrix.
State it; the wrong universe shifts every p-value.

```python
from scipy.stats import hypergeom
import pandas as pd
sig_genes = set(pd.read_csv("sig_genes.txt", header=None)[0])     # your thresholded DE set
universe  = set(background_genes)                                  # M — state how you defined it
for term, pathway in gene_sets.items():                           # {term: set(genes)}
    P = set(pathway) & universe
    k = len(sig_genes & P)                                         # overlap
    # P(X >= k) under hypergeometric(M=|universe|, n=|P|, N=|sig_genes ∩ universe|)
    p = hypergeom.sf(k-1, len(universe), len(P), len(sig_genes & universe))
# → collect p per term, apply Benjamini-Hochberg FDR across terms, report overlap counts + padj
```
Equivalent one-liners exist via `gseapy.enrich` / `enrichr` (MSigDB Hallmark, GO, KEGG) — same math.
Always report the **overlap counts** (e.g. 37/200), the p-value, and the BH-FDR.

## Gene-id namespace

Align the gene ids in your ranked list / DE set to the gene-set namespace (HGNC symbol vs Ensembl vs
Entrez) before enrichment, or every pathway will look empty.

## Sources

- Subramanian et al. 2005, *PNAS* 102:15545 — GSEA. · Korotkevich et al. 2021 (fgsea) — fast pre-ranked GSEA.
- Liberzon et al. 2015, *Cell Systems* 1:417 — MSigDB **Hallmark** gene sets.
- `gseapy` docs (Fang et al. 2023, *Bioinformatics*). · Yu et al. 2012, *OMICS* — clusterProfiler (ORA/GSEA).
- Hypergeometric/Fisher ORA: standard; e.g. Boyle et al. 2004, *Bioinformatics* (GO::TermFinder).
