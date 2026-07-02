# Spatial Domains

**Maturity: PARTIAL** — spatial domain detection. The opinionated default (**SpaGCN**) is not in `task2` (install / side env); a **runnable baseline** (Leiden on the squidpy spatial graph) needs only the installed stack.

## Goal / When to Use

Partition the tissue into **coherent spatial domains** (anatomical/functional regions) — groups of spots/cells that are both transcriptionally similar AND spatially contiguous. Distinct from plain expression clustering, which ignores location and shreds domains.

## Decision Criteria — pick one default

- **Default: SpaGCN** — a graph-convolutional method that fuses expression, spatial position, **and the H&E histology image** into smooth, contiguous domains. The right choice for Visium with histology. Needs install (PyTorch; the adjacency build is O(n²) — heavy for very large slides).
- **Runnable baseline: expression Leiden + spatial smoothing** — when SpaGCN isn't available or there's no histology. Simpler and runs today, but tends to over-fragment without the spatial term.

## How-to (default — SpaGCN)

```python
import SpaGCN as spg
import scanpy as sc

# adata.obs has array coords (x_array/y_array) and pixel coords (x_pixel/y_pixel); img = H&E array
adj = spg.calculate_adj_matrix(x=x_pixel, y=y_pixel, x_pixel=x_pixel, y_pixel=y_pixel,
                               image=img, beta=49, alpha=1, histology=True)   # fuses RGB + space
spg.prefilter_genes(adata, min_cells=3); spg.prefilter_specialgenes(adata)
sc.pp.normalize_per_cell(adata); sc.pp.log1p(adata)

l   = spg.search_l(p=0.5, adj=adj)                       # length-scale: each spot's nhood ≈ 50% of its signal
res = spg.search_res(adata, adj, l, target_num=7)        # resolution to hit ~7 domains (set from anatomy)

clf = spg.SpaGCN(); clf.set_l(l)                         # set_l is mandatory before train
clf.train(adata, adj, init="louvain", res=res)
adata.obs["domain"], _ = clf.predict()                   # predict() returns (labels, probs); it does not write adata
adata.obs["domain"] = adata.obs["domain"].astype("category")
```

Parameter rationale:
- `histology=True`, `beta=49`, `alpha=1` — fuse the H&E image (49-pixel window per spot, equal weight to space vs color); use `histology=False` (x/y only) when there's no usable image.
- `p=0.5` in `search_l` — each spot's neighborhood contributes ~half its expression (SpaGCN's recommended smoothing).
- `target_num=7` — set the expected domain count from the tissue's anatomy, not arbitrarily.

**Runnable baseline (no SpaGCN):**
```python
import squidpy as sq, scanpy as sc
sc.pp.neighbors(adata, use_rep="X_pca"); sc.tl.leiden(adata, resolution=1.0)   # expression clusters
sq.gr.spatial_neighbors(adata, coord_type="grid", n_neighs=6)
# then majority-vote each spot's label over its spatial neighbors to enforce contiguity (smoothing)
```

## Failure Modes

- **Domains are salt-and-pepper, not contiguous** — *symptom:* speckled labels. *Diagnosis:* spatial smoothing too weak (Leiden baseline) or wrong `l`. *Fix:* use SpaGCN with histology, or refine (`spg.refine`); raise the spatial weight.
- **Wrong number of domains** — *symptom:* one giant + many tiny. *Diagnosis:* `target_num`/resolution off. *Fix:* set `target_num` from anatomy; re-run `search_res`.
- **SpaGCN OOM on a large slide** — *symptom:* `calculate_adj_matrix` hangs. *Diagnosis:* O(n²) adjacency. *Fix:* bin/subset, or use the Leiden baseline.

## observe_figure checkpoints

1. **Domains in space** (`sq.pl.spatial_scatter(adata, color="domain")`) — contiguous regions matching tissue architecture, or scattered noise?
2. **Domains vs H&E** — overlay on the histology; do boundaries follow real anatomical structure?

## Grounding

Record: method (SpaGCN / Leiden-spatial), n_domains, key params (`l`, `res`, `target_num`, histology used), domain sizes → `EvidenceRecord`.

## Honesty

- **Domains are hypotheses about tissue architecture** — validate against histology/known anatomy before naming them.
- **Expression clustering ≠ spatial domains** — if you used plain Leiden without spatial smoothing, say so; the result is not a spatial-domain segmentation.
- If domains don't match the histology, **flag it** rather than over-interpreting speckled clusters.
