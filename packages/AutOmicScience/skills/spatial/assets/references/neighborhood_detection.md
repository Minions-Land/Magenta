# Reference — Tissue Cellular Neighborhood Detection

Identifying recurrent cellular neighborhoods (CNs) — spatial niches defined by local cell-type composition. The Nolan-lab "cellular neighborhood" approach and its GNN alternative (CytoCommunity).

## The task (NatureBench s41592-023-02124-2)

**Input:** spatial proteomics (CODEX) with per-cell coordinates + cell-type labels.

**Output:** `predictions.csv` (sample, label) — a neighborhood label per cell (~245k cells).

**Evaluation:** Macro-F1 (Hungarian-matched to ground-truth neighborhoods). SOTA: CytoCommunity (0.58), baseline Spatial-LDA (0.40).

## Escape hatch: Windowed CN k-means (Nolan-lab, competitive shortcut)

The classic cellular-neighborhood method is **low-dependency and competitive** with the GNN. Run this first.

```python
import numpy as np
import pandas as pd
from sklearn.neighbors import NearestNeighbors
from sklearn.cluster import KMeans

def cellular_neighborhoods(coords, cell_types, k_neighbors=10, n_neighborhoods=10):
    """
    Nolan-lab cellular neighborhood detection.
    1. For each cell, find k nearest spatial neighbors
    2. Compute the cell-type composition of that window
    3. K-means cluster the composition vectors → neighborhoods
    """
    # One-hot encode cell types
    ct_dummies = pd.get_dummies(cell_types)
    n_types = ct_dummies.shape[1]
    
    # Spatial kNN
    nn = NearestNeighbors(n_neighbors=k_neighbors).fit(coords)
    _, indices = nn.kneighbors(coords)
    
    # Composition of each cell's neighborhood window
    window_composition = np.zeros((len(coords), n_types))
    ct_array = ct_dummies.values
    for i, neighbors in enumerate(indices):
        window_composition[i] = ct_array[neighbors].mean(axis=0)
    
    # Cluster windows into neighborhoods
    km = KMeans(n_clusters=n_neighborhoods, random_state=0)
    neighborhoods = km.fit_predict(window_composition)
    return neighborhoods
```

Key parameters:
- **k_neighbors**: window size (10–20 typical). Larger = coarser neighborhoods
- **n_neighborhoods**: number of CN clusters (match to expected tissue structures)

This is fast, dependency-light, and scores competitively with the GNN.

## CytoCommunity (GNN, higher ceiling)

CytoCommunity uses a graph neural network on the spatial cell graph for soft neighborhood assignment. It scores 0.58 (SOTA) but needs GPU + more setup.

```python
# Via CytoCommunity repo: build spatial graph → GNN → soft cluster
# Requires: torch-geometric, the CytoCommunity package
# Use when CN-kmeans macro-F1 < target
```

## Hungarian matching for evaluation

Neighborhood labels are arbitrary (cluster 0 vs 1 is meaningless). The evaluator uses Hungarian matching to align predicted labels to ground truth before computing macro-F1:

```python
from scipy.optimize import linear_sum_assignment
from sklearn.metrics import confusion_matrix

def hungarian_f1(y_true, y_pred):
    cm = confusion_matrix(y_true, y_pred)
    row_ind, col_ind = linear_sum_assignment(-cm)  # maximize overlap
    # Remap y_pred labels to matched y_true labels
    mapping = {col: row for row, col in zip(row_ind, col_ind)}
    y_pred_matched = np.array([mapping.get(p, p) for p in y_pred])
    from sklearn.metrics import f1_score
    return f1_score(y_true, y_pred_matched, average="macro")
```

## squidpy spatial graph (aose foundation)

squidpy builds the spatial neighbor graph used by both approaches:

```python
import squidpy as sq
sq.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=10)
# adata.obsp["spatial_connectivities"] — the spatial graph
```

## Choosing k_neighbors and n_neighborhoods

- **k_neighbors**: too small → noisy windows; too large → over-smoothed. Start with 10.
- **n_neighborhoods**: match the expected number of tissue niches. Sweep and check stability.

## Pitfalls

- **Wrong window size** — dominates the neighborhood definition
- **Not matching labels before F1** — arbitrary cluster IDs give near-zero F1 without Hungarian matching
- **Jumping to GNN** — CN k-means is competitive and far simpler; try it first
- **Ignoring cell-type quality** — garbage cell-type labels → garbage neighborhoods
- **Output schema mismatch** — evaluator expects (sample, label) rows

## Grounding

`report`: method (CN k-means / CytoCommunity), k_neighbors, n_neighborhoods, cell-type source, validation macro-F1 (Hungarian-matched), comparison to CN-kmeans baseline if GNN used.
