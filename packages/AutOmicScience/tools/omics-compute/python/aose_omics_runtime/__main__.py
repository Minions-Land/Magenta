#!/usr/bin/env python3
"""Unified CLI entry for AOSE omics runtime — python -m aose_omics_runtime SUBCOMMAND.

This is the single entry point that replaces scattered sys.path.insert(...) +
per-script imports. Every omics capability is exposed as a subcommand (matching
the RuntimeSubcommand enum in aose-omics Rust crate), so the Rust side builds
one typed RuntimeRequest instead of constructing fragile per-script argv.

Subcommands are grouped by modality:
  shared: summarize, preprocess, validate_layout
  scrna: marker_table, integrate
  spatial: read_spatial
  scatac: atac_qc, peak_calling, gene_activity
  multiome: load_multiome
  functional: pathway_activity, enrichment, perturbation
  benchmark: score
"""

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(
        prog="aose_omics_runtime",
        description="AOSE omics runtime — unified Python entry for scverse analysis",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # --- shared ---
    sub = subparsers.add_parser("load_dataset", help="Universal loader: ANY format → h5ad")
    sub.add_argument("--path", required=True, help="Input file path")
    sub.add_argument("--output", required=True, help="Output .h5ad path")
    sub.add_argument("--format", default="auto", choices=["auto", "csv", "tsv", "txt", "excel", "h5ad", "h5", "mtx", "loom", "zarr"], help="Input format")
    sub.add_argument("--transpose", action="store_true", help="Transpose matrix (genes as rows → cells as rows)")
    sub.add_argument("--obs-names-col", type=int, default=0, help="Column for cell names (0-based)")
    sub.add_argument("--var-names-col", type=int, default=None, help="Column for gene names")
    sub.add_argument("--header", type=int, default=0, help="Row index for header")
    sub.add_argument("--sep", type=str, default=None, help="Column separator (auto-detected)")

    sub = subparsers.add_parser("summarize", help="Dataset summary")
    sub.add_argument("--input", required=True, help="Path to h5ad/h5mu")
    sub.add_argument("--output", help="Output text file (default: stdout)")

    sub = subparsers.add_parser("preprocess", help="Standard QC→PCA→UMAP→Leiden")
    sub.add_argument("--input", required=True)
    sub.add_argument("--output", required=True)
    sub.add_argument("--modality", default="scrna")

    sub = subparsers.add_parser("validate_layout", help="Validate keys vs conventions")
    sub.add_argument("--input", required=True)

    # --- scrna ---
    sub = subparsers.add_parser("marker_table", help="Per-cluster marker genes")
    sub.add_argument("--input", required=True)
    sub.add_argument("--output", required=True)
    sub.add_argument("--groupby", default="leiden")
    sub.add_argument("--min-logfc", type=float, default=0.5)
    sub.add_argument("--min-pct", type=float, default=0.1)

    sub = subparsers.add_parser("integrate", help="Batch integration")
    sub.add_argument("--input", required=True)
    sub.add_argument("--output", required=True)
    sub.add_argument("--batch-key", default="batch")
    sub.add_argument("--method", default="harmony", choices=["harmony", "scanorama"])

    # --- spatial ---
    sub = subparsers.add_parser("read_spatial", help="Read platform-specific spatial")
    sub.add_argument("--input", required=True)
    sub.add_argument("--output", required=True)
    sub.add_argument("--platform", required=True, choices=["visium", "xenium", "merfish"])

    # --- scatac ---
    sub = subparsers.add_parser("atac_qc", help="ATAC QC metrics")
    sub.add_argument("--adata", required=True, help="Input AnnData h5ad file")
    sub.add_argument("--output", required=True, help="Output h5ad file with QC metrics")
    sub.add_argument("--fragment-file", help="Fragment file (tsv.gz)")
    sub.add_argument("--tss-bed", help="TSS BED file for TSSE calculation")
    sub.add_argument("--compute-tsse", action="store_true", help="Compute TSS enrichment")
    sub.add_argument("--compute-fragment-size", action="store_true", help="Compute fragment size distribution")
    sub.add_argument("--compute-frip", action="store_true", help="Compute fraction of reads in peaks")
    sub.add_argument("--tss-window", type=int, default=2000, help="Window size around TSS (bp)")
    sub.add_argument("--filter", action="store_true", help="Apply QC filters")
    sub.add_argument("--min-fragments", type=int, default=1000, help="Minimum fragments per cell")
    sub.add_argument("--max-fragments", type=int, default=100000, help="Maximum fragments per cell")
    sub.add_argument("--min-tsse", type=float, default=5.0, help="Minimum TSS enrichment")
    sub.add_argument("--max-nucleosome-signal", type=float, default=2.0, help="Maximum nucleosome signal")
    sub.add_argument("--min-frip", type=float, default=0.15, help="Minimum FRiP")

    sub = subparsers.add_parser("peak_calling", help="Call peaks for scATAC-seq")
    sub.add_argument("--adata", required=True, help="Input AnnData h5ad file")
    sub.add_argument("--output", required=True, help="Output peak BED file")
    sub.add_argument("--fragment-file", required=True, help="Fragment file (tsv.gz)")
    sub.add_argument("--mode", default="bulk", choices=["bulk", "pseudobulk", "consensus"], help="Peak calling mode")
    sub.add_argument("--cluster-column", help="Column with cluster labels (for pseudobulk)")
    sub.add_argument("--genome", default="hs", help="Genome build (hs, mm, etc.)")
    sub.add_argument("--qvalue", type=float, default=0.05, help="Q-value cutoff")
    sub.add_argument("--min-length", type=int, default=200, help="Minimum peak length")
    sub.add_argument("--max-gap", type=int, default=300, help="Maximum gap for merging")
    sub.add_argument("--keep-duplicates", default="auto", help="Duplicate handling (auto, all, 1)")
    sub.add_argument("--shift", type=int, default=-100, help="Read shift")
    sub.add_argument("--extsize", type=int, default=200, help="Extension size")
    sub.add_argument("--min-cell-overlap", type=int, default=2, help="Min cells for consensus peaks")
    sub.add_argument("--create-matrix", action="store_true", help="Create peak x cell matrix")
    sub.add_argument("--outdir", help="Output directory for intermediate files")

    sub = subparsers.add_parser("gene_activity", help="Gene activity from peaks")
    sub.add_argument("--adata", required=True, help="Input AnnData h5ad file with peaks")
    sub.add_argument("--output", required=True, help="Output h5ad file with gene scores")
    sub.add_argument("--method", default="signac", choices=["cicero", "snapatac", "signac", "archR"], help="Gene activity method")
    sub.add_argument("--gtf-file", help="GTF annotation file")
    sub.add_argument("--organism", default="human", help="Organism (human or mouse)")
    sub.add_argument("--promoter-window", type=int, default=5000, help="Promoter window (bp)")
    sub.add_argument("--gene-body-weight", type=float, default=0.5, help="Gene body weight")
    sub.add_argument("--upstream", type=int, default=2000, help="Upstream extension (bp)")
    sub.add_argument("--downstream", type=int, default=0, help="Downstream extension (bp)")
    sub.add_argument("--extend-upstream", type=int, default=5000, help="Extended upstream (bp)")
    sub.add_argument("--extend-downstream", type=int, default=0, help="Extended downstream (bp)")
    sub.add_argument("--weight-by-distance", action="store_true", help="Weight by distance to TSS")
    sub.add_argument("--decay-distance", type=int, default=50000, help="Distance decay parameter (bp)")
    sub.add_argument("--distance-constraint", type=int, default=500000, help="Max distance for co-accessibility")
    sub.add_argument("--coaccessibility-cutoff", type=float, default=0.25, help="Co-accessibility cutoff")
    sub.add_argument("--tile-size", type=int, default=500, help="Tile size for binning")

    # --- multiome ---
    sub = subparsers.add_parser("load_multiome", help="Assemble MuData from RNA+ATAC")
    sub.add_argument("--rna", required=True)
    sub.add_argument("--atac", required=True)
    sub.add_argument("--output", required=True)

    # --- functional ---
    sub = subparsers.add_parser("pathway_activity", help="decoupler pathway/TF activity")
    sub.add_argument("--adata", required=True, help="Input AnnData h5ad file")
    sub.add_argument("--output", required=True, help="Output h5ad file with pathway scores")
    sub.add_argument("--method", default="mlm", help="Statistical method (mlm, ulm, wsum, etc.)")
    sub.add_argument("--resource", default="progeny", help="Pathway resource (progeny, msigdb, kegg, etc.)")
    sub.add_argument("--organism", default="human", help="Organism (human or mouse)")
    sub.add_argument("--layer", help="AnnData layer to use")
    sub.add_argument("--use-raw", action="store_true", help="Use adata.raw.X")
    sub.add_argument("--min-size", type=int, default=5, help="Minimum pathway size")

    sub = subparsers.add_parser("enrichment", help="Gene-set enrichment")
    sub.add_argument("--gene-list", required=True, help="Comma-separated gene list")
    sub.add_argument("--output", required=True, help="Output JSON file")
    sub.add_argument("--method", default="ora", help="Enrichment method (ora or gsea)")
    sub.add_argument("--resource", default="msigdb", help="Gene set resource")
    sub.add_argument("--organism", default="human", help="Organism (human or mouse)")
    sub.add_argument("--padj-threshold", type=float, default=0.05, help="Adjusted p-value threshold")
    sub.add_argument("--top-n", type=int, default=50, help="Number of top pathways to report")

    sub = subparsers.add_parser("perturbation", help="pertpy perturbation analysis")
    sub.add_argument("--adata", required=True, help="Input AnnData h5ad file")
    sub.add_argument("--output", required=True, help="Output h5ad file with analysis results")
    sub.add_argument("--perturbation-column", required=True, help="Column with perturbation labels")
    sub.add_argument("--control-value", required=True, help="Control/untreated value")
    sub.add_argument("--test-values", help="Comma-separated test values (or JSON array)")
    sub.add_argument("--method", default="wilcoxon", help="Statistical test method")
    sub.add_argument("--layer", help="AnnData layer to use")
    sub.add_argument("--use-raw", action="store_true", help="Use adata.raw")
    sub.add_argument("--n-top-genes", type=int, help="Number of top DE genes per perturbation")
    sub.add_argument("--padj-threshold", type=float, default=0.05, help="Adjusted p-value threshold")
    sub.add_argument("--logfc-threshold", type=float, default=0.5, help="Log fold change threshold")

    # --- benchmark ---
    sub = subparsers.add_parser("score", help="Score predictions vs GOLD reference")
    sub.add_argument("--input", required=True)
    sub.add_argument("--pred-key", required=True, help="predicted labeling (obs column or obsm key)")
    sub.add_argument("--ref-key", required=True, help="GOLD reference labeling (obs column or obsm key)")
    sub.add_argument("--metric", default="ari", choices=["ari", "nmi", "ami", "deconv_corr", "domain_ari"])

    # --- environment ---
    sub = subparsers.add_parser(
        "preflight", help="Verify the active Pixi env has the packages a modality needs"
    )
    # modality is optional: the harness launcher consumes it to select the
    # isolated env (--environment) and strips it from argv, so preflight falls
    # back to deriving the modality from PIXI_ENVIRONMENT_NAME at run time.
    sub.add_argument(
        "--modality", choices=["scrna", "spatial", "scatac", "multiome"], default=None
    )
    sub.add_argument("--check-gpu", action="store_true", help="Also probe GPU availability")

    args = parser.parse_args()

    # Dispatch to the actual implementation
    try:
        if args.subcommand == "load_dataset":
            from .shared import load_dataset
            load_dataset.main(args)
        elif args.subcommand == "summarize":
            from .shared import summarize
            summarize.main(args)
        elif args.subcommand == "preprocess":
            from .shared import preprocess
            preprocess.main(args)
        elif args.subcommand == "validate_layout":
            from .shared import io
            io.validate_layout(args)
        elif args.subcommand == "marker_table":
            from .scrna import marker_table
            marker_table.main(args)
        elif args.subcommand == "integrate":
            from .scrna import standard_integrate
            standard_integrate.main(args)
        elif args.subcommand == "read_spatial":
            from .spatial import read_spatial
            read_spatial.main(args)
        elif args.subcommand == "atac_qc":
            from .scatac import atac_qc
            atac_qc.main(args)
        elif args.subcommand == "peak_calling":
            from .scatac import peak_calling
            peak_calling.main(args)
        elif args.subcommand == "gene_activity":
            from .scatac import gene_activity
            gene_activity.main(args)
        elif args.subcommand == "load_multiome":
            from .multiome import load_multiome
            load_multiome.main(args)
        elif args.subcommand == "pathway_activity":
            from .functional import decoupler_pathway_activity
            decoupler_pathway_activity.main(args)
        elif args.subcommand == "enrichment":
            from .functional import decoupler_enrichment
            decoupler_enrichment.main(args)
        elif args.subcommand == "perturbation":
            from .functional import pertpy_perturbation_analysis
            pertpy_perturbation_analysis.main(args)
        elif args.subcommand == "score":
            from .shared import score
            score.main(args)
        elif args.subcommand == "preflight":
            from .shared import preflight
            preflight.main(args)
        else:
            parser.error(f"Unknown subcommand: {args.subcommand}")
    except ImportError as e:
        print(f"Failed to import {args.subcommand} module: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error executing {args.subcommand}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
