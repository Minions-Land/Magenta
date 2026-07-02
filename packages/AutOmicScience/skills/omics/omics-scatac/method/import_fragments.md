# Import Fragments

**Maturity: REFERENCE** — `snap.pp.import_fragments` in `run_python` (version-volatile — confirm kwargs against the installed snapATAC2).

## Goal / When to Use

Turn a fragments file (or several) into a SnapATAC2 AnnData, with basic per-cell QC computed at import. Use when the input is fragments rather than a pre-built matrix.

## Decision Criteria

**The judgment this guides:**

- **Genome must match the upstream alignment** (GRCh38/hg38 vs GRCm39/mm10, etc.) — a mismatch silently corrupts TSSE and gene activity. Verify against the study description / organism (the dataset summary) and the fragments header. If unknown, **abstain and ask** — do not guess.

- **One sample → in-memory AnnData**; **many samples → import each to its own backed `.h5ad` then assemble an `AnnDataSet`** for joint analysis (out-of-core).

- **`min_num_fragments` at import = 500** is only a *coarse* floor to drop obviously-empty barcodes. It is **not** the real QC filter and is deliberately looser than the post-QC unique-fragment floor (1000, next recipe) so import doesn't pre-emptively discard cells that QC should judge from the observed distributions.

## Method Menu

- **`snap.pp.import_fragments`** (preferred; computes import QC) — **version-volatile**: older releases exposed a single `snap.pp.import_data`; current releases split it into `snap.pp.import_fragments` (fragment files) plus `snap.pp.import_contacts`/`import_values` for other inputs. Treat `snap.pp.import_fragments` as the canonical name and **confirm against the pinned installed version** before relying on exact kwargs.

- **Reading a pre-built peak/tile `.h5ad` directly** with `anndata`/`muon` — skip import, validate `obsm['insertion']` or fragment-backing is present.

## How-to

### Single sample

```python
import snapatac2 as snap

# Name the genome
genome = snap.genome.hg38  # or mm10, GRCh38, etc.

# Import
adata = snap.pp.import_fragments(
    fragment_file="/path/to/fragments.tsv.gz",
    chrom_sizes=genome.chrom_sizes,
    min_num_fragments=500,  # coarse floor, not final QC
    sorted_by_barcode=False  # set True if pre-sorted
)

print(f"Imported {adata.n_obs} cells, {adata.obs['n_fragment'].sum()} total fragments")
```

### Multi-sample (AnnDataSet)

```python
# Import each sample to its own backed .h5ad
samples = {
    "sample1": "/path/to/sample1_fragments.tsv.gz",
    "sample2": "/path/to/sample2_fragments.tsv.gz"
}

h5ads = []
for sample_id, frag_path in samples.items():
    adata = snap.pp.import_fragments(
        fragment_file=frag_path,
        chrom_sizes=genome.chrom_sizes,
        min_num_fragments=500
    )
    adata.obs['sample'] = sample_id

    # Write to backed .h5ad
    backed_path = f"/path/to/{sample_id}.h5ad"
    adata.write(backed_path)
    h5ads.append(backed_path)

# Assemble AnnDataSet for joint analysis (out-of-core)
import snapatac2 as snap
adatas = snap.AnnDataSet(
    adatas=h5ads,
    filename="/path/to/joint.zarr"
)
```

### Custom genome (offline / non-standard reference)

```python
from snapatac2 import Genome

# Provide chrom sizes + annotation
chrom_sizes = {"chr1": 248956422, "chr2": 242193529, ...}  # or read from .fai

genome = Genome(
    chrom_sizes=chrom_sizes,
    annotation="/path/to/genes.gtf"  # for TSS / gene activity later
)

adata = snap.pp.import_fragments(
    fragment_file="/path/to/fragments.tsv.gz",
    chrom_sizes=genome.chrom_sizes,
    min_num_fragments=500
)
```

## Pitfalls & Quality Checks

- **Wrong genome** — TSSE collapses to ~1 (no enrichment), gene activity is all-zero. If the import completes but TSSE is broken, the genome is wrong. Do not proceed — re-import with the correct genome.

- **Unsorted / contig-mismatched fragments** — if the fragments file is unsorted or has contig names that don't match `chrom_sizes`, import raises or silently drops reads. Verify contig names match (e.g., `chr1` vs `1`, `chrM` vs `MT`).

- **`chrM` / `chrY` handling** — mitochondrial and Y-chromosome reads are usually present but may need exclusion downstream. Record `frac_mito` at import and decide whether to filter later.

- **Barcode suffix (`-1`) drift** across samples — if merging multi-sample data, ensure barcode suffixes are consistent or stripped. SnapATAC2 does not auto-strip them.

- **No `observe_figure` at import** — but **record the genome build and n fragments** in the report dict, because a mismatch here poisons every downstream step.

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "n_cells_imported": 5000,
  "n_unique_fragments": 25_000_000,
  "median_fragments_per_cell": 5000,
  "pct_mito": 3.5,
  "duplication_rate": 0.15,
  "genome_build": "hg38",
  "source_path": "/path/to/fragments.tsv.gz",
  "min_num_fragments": 500  # coarse import floor
}
```

Ground: n cells imported, n unique fragments, % mito, duplication rate, genome build, source path.

## Honesty

- If the genome cannot be determined from the study description or fragments header, **abstain** — never silently default to a guess.

- If a fragments file is missing or malformed (no index `.tbi`, wrong format), **fail loud** with the exact error — do not fabricate a matrix.

- **The import floor (500) is not the final QC** — state that clearly. Cells below 1000 unique fragments will likely be filtered in the next step (QC recipe).
