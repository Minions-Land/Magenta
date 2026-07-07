# Reference — SATURN Cross-Species / Cross-Modality Matching

SATURN aligns cells across species (human / mouse) or modalities (scRNA / scATAC) via a macrogene abstraction + VAE architecture. Use when simpler methods (scVI/scArches on shared genes) fail due to namespace mismatch.

## When SATURN justifies complexity

SATURN wins when:
- **Cross-species** with <70% ortholog coverage (e.g., zebrafish → human)
- **Cross-modality** (scRNA → scATAC) where gene-activity scores don't align well
- The baseline (scVI on shared genes or GLUE) scores <0.6 on the target metric

**Escape hatch:** Try **scVI on orthologs** first (human-mouse share ~80% orthologs; scVI on the shared set is often within 0.03 of SATURN). SATURN's macrogene construction is elegant but adds days of setup; only escalate if simpler methods miss the bar.

## The macrogene concept

SATURN groups genes into evolutionarily-conserved modules (macrogenes) via:
1. Ortholog mapping (Ensembl BioMart, OrthoFinder)
2. Co-expression clustering within each species
3. Alignment of clusters across species (consensus macrogenes)

A macrogene = a stable functional unit (pathway/complex) that exists in both species, even if individual gene names differ.

## Workflow (high-level)

```python
# 1. Build macrogene maps (from SATURN repo's preprocessing scripts)
# Requires: gene expression matrices for both species + ortholog table
# Output: macrogene × cell matrices for each species

# 2. Train SATURN VAE
from saturn import SATURN
model = SATURN(
    input_dim=n_macrogenes,
    latent_dim=30,
    species_key="species",
)
model.train(adata_combined, max_epochs=400)

# 3. Embed both species in shared latent
adata_combined.obsm["X_saturn"] = model.get_latent_representation()

# 4. Transfer labels via kNN in the shared space
from sklearn.neighbors import KNeighborsClassifier
knn = KNeighborsClassifier(n_neighbors=15)
knn.fit(adata_combined[adata_combined.obs.species=="human"].obsm["X_saturn"],
        adata_combined[adata_combined.obs.species=="human"].obs["cell_type"])
adata_combined.obs["predicted_type"] = knn.predict(adata_combined.obsm["X_saturn"])
```

## Output contract

Cross-species tasks often require:
- **Cell-type transfer accuracy** (fraction of query cells correctly labeled)
- **Shared embedding quality** (silhouette, batch-mixing, ASW)

Verify the evaluator's exact metric — some score ARI, some accuracy, some cosine on embeddings.

## Installation

SATURN is a research repo (not on PyPI). Clone and install:

```bash
git clone https://github.com/snap-stanford/SATURN.git
cd SATURN
pip install -e .
```

Document the commit SHA + dependencies in your environment lockfile.

## Pitfalls

- **Skipping the ortholog baseline** — scVI on orthologs often gets within 0.03 of SATURN for mouse-human at 10% of the effort
- **Macrogene construction failures** — need sufficient co-expression signal; low-quality data breaks clustering
- **Wrong species metadata** — SATURN's batch-correction keys on `species`; mislabeling scrambles the embedding
- **Ignoring the evaluator's metric** — cross-species papers report many metrics; use the one being scored

## Grounding

`report`: SATURN version + commit SHA, macrogene construction details (n macrogenes, ortholog source), embedding quality (silhouette, ASW), transfer accuracy or ARI, comparison to ortholog-based scVI baseline (and why SATURN was chosen over the simpler path).
