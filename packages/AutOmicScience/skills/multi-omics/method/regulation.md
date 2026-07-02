# eGRN & Regulation (SCENIC+)

**Maturity: REFERENCE** — enhancer-driven GRN (eGRN) inference for multiome via **SCENIC+**. This is a heavy **external pipeline in its own isolated environment** (it cannot run in `task3`), driven by **Snakemake**, not a `run_python` recipe. Use only on explicit request, with paired RNA+ATAC.

## Goal / When to Use

Infer an enhancer-driven GRN — **TF → region → gene** eRegulons — from paired multiome data, and surface the **region→gene linkage** table that other steps reuse. For mechanism / regulatory hypotheses, not a default step.

## Decision Criteria

- **Needs paired RNA + ATAC** (multiome). For TF regulons from expression alone use scRNA (`rna`, pySCENIC); for pure scATAC there is no eGRN.
- **Heavy + version-isolated.** SCENIC+ (v1.0a) pins `pandas==1.5.0`, `numpy==1.26.4`, `scanpy==1.8.2`, Python ≤3.11.8 — **incompatible with `task3`**. It needs **pycisTopic** upstream (which needs **Mallet/Java + MACS2**), **cisTarget/DEM motif databases**, and genome annotation. Provision a dedicated env and confirm before starting.
- **If requirements unmet** → stop at motif enrichment + joint embedding; state eGRN is out of reach.

## How-to (external Snakemake pipeline)

SCENIC+ is run via its CLI + Snakemake, not a Python API. Prepare two upstream inputs separately:
- **scRNA** → a standard scanpy `adata.h5ad`.
- **scATAC** → a **pycisTopic** `cisTopic` object (`.pkl`) + a folder of candidate-region `.bed` sets (pycisTopic runs LDA topic modelling; needs Mallet + MACS2).

Then:

```bash
scenicplus init_snakemake --out_dir scplus_pipeline        # scaffolds Snakemake/{config,workflow}
# edit scplus_pipeline/Snakemake/config/config.yaml:
#   cisTopic_obj_fname, GEX_anndata_fname (scRNA .h5ad), region_set_folder,
#   ctx_db_fname (*.regions_vs_motifs.rankings.feather),
#   dem_db_fname (*.scores.feather), path_to_motif_annotations,
#   params_data_preparation.is_multiome: True
cd scplus_pipeline/Snakemake && snakemake --cores N        # runs the full DAG
```

The DAG (each step = `scenicplus <group> <subcmd>`) produces, in order:
`prepare_GEX_ACC` → `ACC_GEX.h5mu` (a two-modality **MuData**: `scRNA` + `scATAC`) · motif enrichment (cisTarget/DEM) · `search_spance` → `search_space.tsv` · `TF_to_gene` · **`region_to_gene` → `region_to_gene_adj.tsv`** · `eGRN` → `eRegulon_{direct,extended}.tsv` · `AUCell` · `create_scplus_mudata` → **`scplusmdata.h5mu`** (final).

## The surfaced results (reuse these)

- **Region→gene linkage** — `region_to_gene_adj.tsv`, columns `region, target` (gene), `importance, rho, importance_x_rho, importance_x_abs_rho, Distance`. This is the **reusable peak–gene linkage** other analyses consume (GBM `importance` + Spearman `rho` over a genomic search window — statistically stronger than a raw correlation cutoff).
- **eGRN** — TF–region–gene triplets in `eRegulon_{direct,extended}.tsv` and in `scplusmdata.h5mu` `.uns["direct_e_regulon_metadata"]` (`Region, Gene, importance, rho, TF, eRegulon_name, ...`); AUC matrices as `{direct,extended}_{gene,region}_based_AUC`.

## Failure Modes

- **Env collision** — *symptom:* solver/import errors mixing SCENIC+ with scanpy ≥1.10 / pandas ≥2. *Diagnosis:* installed into a modern env. *Fix:* a dedicated conda env (python=3.11 + the pinned deps); never install into `task3`.
- **Missing Mallet/MACS2** — *symptom:* pycisTopic topic-modelling / peak step fails before SCENIC+ starts. *Fix:* install Mallet (Java) + MACS2 in the pycisTopic step.
- **`search_spance` "not found"** — *symptom:* you "corrected" the spelling. *Diagnosis:* the subcommand is genuinely misspelled. *Fix:* use `search_spance` verbatim.
- **Thousands of edges taken as fact** — *symptom:* every TF→gene edge reported. *Diagnosis:* eRegulons are inferred. *Fix:* rank by AUC / triplet score and validate only the top ones.

## Grounding

Record: n eRegulons (direct/extended), n region–gene links, the TF list, key params, and the genome/motif-DB versions → `EvidenceRecord`. Cite `region_to_gene_adj.tsv` / `scplusmdata.h5mu` as the evidence artifacts.

## Honesty

- This is an **external, heavy, isolated-env pipeline** — say so; don't imply it runs inside the standard multiome env.
- eGRN edges are **inferred regulatory hypotheses**, not measured interactions — present them as such, with confidence from AUC / triplet scores.
- Without paired ATAC+RNA there is no eGRN here — route to scRNA (pySCENIC) instead.
