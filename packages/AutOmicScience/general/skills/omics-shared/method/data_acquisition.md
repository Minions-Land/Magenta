# Data Acquisition

## Goal / When to Use

Use this guidance when the user provides an accession ID, public dataset description, or local file path before an omics analysis. In this Magenta3 package, local files and package-local runtime helpers are ready; database download tools are deliberately not exposed until their implementation modules are migrated.

## Current Package Status

**Ready**
- Local files: load with `omics_runtime load_dataset`, `summarize`, or direct scverse readers in a grounded `run_python` cell.
- Gene-level lookups: use whatever general Bio API tools the host harness explicitly provides; do not assume this package installs them.

**Not exposed in this package yet**
- `census_query`
- `geo_fetch`

These two commands existed in AOSE descriptors but the audited source lacked `aose_omics_runtime.data` implementation modules. Do not call them from this package until those modules are migrated.

## Decision Criteria

1. **Local file path provided** -> load directly and ground the load.
2. **GEO accession or CELLxGENE Census request** -> report that this package does not currently expose the downloader; ask for a local processed matrix or wait for the data-acquisition implementation package.
3. **Gene ID / sequence / ortholog lookup** -> use host-provided Bio API tools if available; otherwise state that no package-local lookup tool is available.
4. **Raw FASTQ request** -> out of scope for this package; request a count matrix or upstream preprocessing output.

## Local File Loading

Prefer `omics_runtime load_dataset` when format conversion is needed:

```python
omics_runtime(
  subcommand="load_dataset",
  modality="scrna",
  args={
    "path": "data/counts.csv",
    "output": "runs/omics/run_001/data/counts.h5ad",
    "format": "csv"
  }
)
```

If the file is already an `.h5ad` / `.h5mu`, load and summarize:

```python
omics_runtime(
  subcommand="summarize",
  modality="scrna",
  args={"input": "data/pbmc3k.h5ad"}
)
```

For hand-written cells, still ground the source:

```python
import json
import scanpy as sc

adata = sc.read_h5ad("data/pbmc3k.h5ad")
report = {
    "operation": "data_load",
    "source": "local_file",
    "path": "data/pbmc3k.h5ad",
    "n_obs": int(adata.n_obs),
    "n_vars": int(adata.n_vars),
}
print(json.dumps(report))
```

Pass the report through the normal grounding path before making quantitative claims.

## Pitfalls

- Do not call `census_query` or `geo_fetch` from this package; they are intentionally excluded until implemented.
- Do not silently substitute a different public dataset when the user asked for a specific accession.
- Do not guess file formats. Inspect filenames and load errors, then ask for the missing format detail or conversion step.
- Do not treat raw reads as single-cell matrices; request upstream preprocessing.

## Honesty

If a data-acquisition tool is unavailable, say that directly and continue only with user-provided local data or explicitly available host tools. Every analysis must start with an auditable source record.
