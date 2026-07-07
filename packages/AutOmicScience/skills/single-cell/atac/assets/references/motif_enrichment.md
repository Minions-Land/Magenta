# Motif & TF Activity

**Maturity: REFERENCE** — no compute subcommand; hand-rolled in `run_python`. Two complementary questions, two tools: per-cell **chromVAR** (default for TF *activity*) and marker-region **enrichment** (which TFs mark a cluster).

## Goal / When to Use

Find the TF regulators behind cell types/states — either as a **per-cell motif-activity matrix** (cells × TF, for clustering/correlation) or as **per-cluster motif enrichment** (which TF motifs are over-represented in a cluster's peaks). Run after peaks + clustering.

## Decision Criteria — pick by the question

- **Default: per-cell TF activity → pychromVAR (chromVAR).** Gives a `cells × motifs` deviation matrix, robust to per-peak noise, usable as a feature space or for correlating TF activity with cell type. Needs a genome FASTA + motif PWMs.
- **Per-cluster enrichment → snapATAC2 `tl.motif_enrichment`.** Faster; answers "which TF motifs are enriched in this cluster's marker peaks?" Use when you only want cluster-level TF hypotheses, not per-cell activity.

## How-to

**Per-cell chromVAR (default)** — real pychromVAR pipeline (peak matrix in `adata`, peak coords in `adata.var`):
```python
import pychromvar as pc
pc.add_peak_seq(adata, genome_file="hg38.fa")   # peak DNA sequences from the genome FASTA
pc.add_gc_bias(adata)                            # GC content per peak
pc.get_bg_peaks(adata)                           # GC/accessibility-matched background (the chromVAR control)
pc.match_motif(adata, motifs=motif_pwms)         # peak × motif matches (JASPAR / cisBP PWMs)
dev = pc.compute_deviations(adata)               # cells × motifs deviation z-scores (a new AnnData)
```
Why: `get_bg_peaks` is the GC-matched background that makes a deviation a *corrected* signal, not raw counts — never skip it. `dev` (cells × motifs) is the activity matrix; store/cluster on it.

**Per-cluster enrichment** — snapATAC2 over marker peaks:
```python
import snapatac2 as snap
motifs  = snap.datasets.cis_bp(unique=True)                      # PWM set (confirm args vs installed version)
markers = snap.tl.marker_regions(adata, groupby="leiden", pvalue=0.01)   # {cluster -> [regions]}
enrich  = snap.tl.motif_enrichment(motifs=motifs, regions=markers, genome_fasta=snap.genome.hg38)
# enrich: {cluster -> polars.DataFrame of enriched motifs}
```

## Failure Modes

- **Skipped `get_bg_peaks`** — *symptom:* every TF looks "active". *Diagnosis:* no GC-matched background → deviations reflect GC/accessibility, not TF binding. *Fix:* always run `get_bg_peaks` before `compute_deviations`.
- **Wrong genome build** — *symptom:* near-zero motif matches. *Diagnosis:* peak coords and the genome FASTA disagree (hg38 vs hg19/mm10). *Fix:* match the FASTA to the peak coordinate build.
- **Over-claiming a single TF** — *symptom:* "TF X drives cluster Y" from one enriched motif. *Diagnosis:* paralogous TFs share motifs (correlated deviations). *Fix:* report the motif/TF *family*; corroborate with the TF's own expression/accessibility.

## observe_figure checkpoints

1. **TF-activity UMAP** (`dev` deviation of a candidate TF on the cell UMAP) — is activity localized to the expected population, or smeared (background not controlled)?
2. **Enrichment table per cluster** — do the top motifs match known lineage TFs, or look random (wrong genome / too-broad peaks)?

## Grounding

Record: method (chromVAR / enrichment), motif DB + version, genome build, deviation-matrix shape or top enriched motifs per cluster → `EvidenceRecord`.

## Honesty

- chromVAR gives **motif activity**, not direct TF binding — a shared motif can't separate paralogous TFs; say so.
- Enrichment is over *marker peaks* — it depends on the clustering; if clusters are unstable, the TF calls are too.
