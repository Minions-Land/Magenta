"""Pertpy perturbation analysis implementation."""

import json
from datetime import datetime, UTC
from pathlib import Path
import anndata as ad
import pandas as pd
import scanpy as sc


def run_pertpy_perturbation_analysis(args):
    """
    Analyze perturbation effects using differential expression.

    Args:
        args: Argparse namespace with parameters

    Returns:
        dict: Result with DE results, evidence metadata, and provenance
    """
    start_time = datetime.now(UTC)

    # Load input data
    adata = ad.read_h5ad(args.adata)
    input_shape = adata.shape

    # Validate perturbation column
    if args.perturbation_column not in adata.obs.columns:
        raise ValueError(f"Perturbation column '{args.perturbation_column}' not found in adata.obs")

    # Validate control value
    perturbation_values = adata.obs[args.perturbation_column].unique()
    if args.control_value not in perturbation_values:
        raise ValueError(f"Control value '{args.control_value}' not found in perturbation column")

    # Parse test values
    if args.test_values:
        try:
            # Try parsing as JSON array first
            test_values = json.loads(args.test_values)
            if not isinstance(test_values, list):
                # If not a list, treat as comma-separated
                test_values = [v.strip() for v in args.test_values.split(',')]
        except json.JSONDecodeError:
            # Fall back to comma-separated
            test_values = [v.strip() for v in args.test_values.split(',')]
    else:
        # Use all non-control values
        test_values = [v for v in perturbation_values if v != args.control_value]

    if len(test_values) == 0:
        raise ValueError("No test values specified or found")

    # Prepare expression data
    if args.use_raw and adata.raw is not None:
        adata_expr = adata.raw.to_adata()
        adata_expr.obs = adata.obs
    elif args.layer:
        adata_expr = adata.copy()
        adata_expr.X = adata_expr.layers[args.layer]
    else:
        adata_expr = adata.copy()

    # Run differential expression for each perturbation vs control
    de_results = {}
    n_significant_genes = {}

    for test_value in test_values:
        # Create binary grouping
        adata_expr.obs['_comparison_group'] = adata_expr.obs[args.perturbation_column].astype(str)
        mask = adata_expr.obs['_comparison_group'].isin([args.control_value, str(test_value)])
        adata_subset = adata_expr[mask].copy()

        if adata_subset.shape[0] < 10:
            print(f"Warning: Only {adata_subset.shape[0]} cells for comparison {test_value} vs {args.control_value}, skipping")
            continue

        # Run differential expression
        try:
            sc.tl.rank_genes_groups(
                adata_subset,
                groupby='_comparison_group',
                reference=args.control_value,
                groups=[str(test_value)],
                method=args.method,
                use_raw=False,
            )

            # Extract results
            result_df = sc.get.rank_genes_groups_df(
                adata_subset,
                group=str(test_value),
            )

            # Filter by thresholds
            significant = result_df[
                (result_df['pvals_adj'] < args.padj_threshold) &
                (abs(result_df['logfoldchanges']) > args.logfc_threshold)
            ]

            n_significant = len(significant)
            n_significant_genes[test_value] = n_significant

            # Get top genes
            if args.n_top_genes:
                top_genes = result_df.head(args.n_top_genes)
            else:
                top_genes = significant.head(100)  # Default to top 100

            de_results[test_value] = {
                'n_genes_tested': len(result_df),
                'n_significant': n_significant,
                'top_genes': top_genes.to_dict('records'),
            }

        except Exception as e:
            print(f"Warning: Failed to run DE for {test_value}: {e}")
            continue

    if len(de_results) == 0:
        raise ValueError("No successful differential expression comparisons")

    # Store results in adata
    adata.uns['perturbation_analysis'] = {
        'method': args.method,
        'perturbation_column': args.perturbation_column,
        'control_value': args.control_value,
        'test_values': test_values,
        'padj_threshold': args.padj_threshold,
        'logfc_threshold': args.logfc_threshold,
        'n_significant_genes': n_significant_genes,
        'timestamp': datetime.now(UTC).isoformat(),
    }

    # Save output
    adata.write_h5ad(args.output, compression='gzip')
    output_path = Path(args.output).resolve()

    end_time = datetime.now(UTC)
    elapsed_ms = int((end_time - start_time).total_seconds() * 1000)

    # Build evidence record
    evidence = {
        "source": f"scanpy {sc.__version__}",
        "source_type": "computation",
        "query": f"{args.method} differential expression",
        "description": f"Analyzed {len(de_results)} perturbations vs {args.control_value} using {args.method}",
        "timestamp": end_time.isoformat(),
        "metadata": {
            "method": args.method,
            "n_perturbations": len(de_results),
            "control_value": args.control_value,
            "test_values": test_values,
            "n_cells": input_shape[0],
            "n_genes": input_shape[1],
            "padj_threshold": args.padj_threshold,
            "logfc_threshold": args.logfc_threshold,
            "total_significant_genes": sum(n_significant_genes.values()),
        }
    }

    # Build trace step
    trace = {
        "tool": "bio_pertpy_perturbation_analysis",
        "status": "success",
        "input": {
            "adata": args.adata,
            "perturbation_column": args.perturbation_column,
            "control_value": args.control_value,
            "method": args.method,
        },
        "output": {
            "n_perturbations": len(de_results),
            "total_significant_genes": sum(n_significant_genes.values()),
            "output_file": str(output_path),
        },
        "duration_ms": elapsed_ms,
        "timestamp": end_time.isoformat(),
    }

    # Build result
    result = {
        "success": True,
        "output": str(output_path),
        "n_perturbations": len(de_results),
        "n_cells": input_shape[0],
        "method": args.method,
        "control_value": args.control_value,
        "test_values": test_values,
        "n_significant_genes": n_significant_genes,
        "de_summary": {k: {
            'n_genes_tested': v['n_genes_tested'],
            'n_significant': v['n_significant'],
            'top_5_genes': [g['names'] for g in v['top_genes'][:5]],
        } for k, v in de_results.items()},
        "evidence": [evidence],
        "trace": [trace],
        "elapsed_ms": elapsed_ms,
    }

    return result


def main(args):
    """CLI entry for perturbation subcommand."""
    import json

    result = run_pertpy_perturbation_analysis(args)

    # Print summary
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Perturbation analysis using differential expression')
    parser.add_argument('--adata', required=True, help='Input h5ad file')
    parser.add_argument('--output', required=True, help='Output h5ad file')
    parser.add_argument('--perturbation-column', required=True, help='Column with perturbation labels')
    parser.add_argument('--control-value', required=True, help='Control condition value')
    parser.add_argument('--test-values', help='Comma-separated test values (default: all non-control)')
    parser.add_argument('--method', default='wilcoxon', choices=['wilcoxon', 't-test', 'logreg'],
                        help='Differential expression method')
    parser.add_argument('--use-raw', action='store_true', help='Use adata.raw for expression')
    parser.add_argument('--layer', help='Layer to use for expression')
    parser.add_argument('--padj-threshold', type=float, default=0.05, help='Adjusted p-value threshold')
    parser.add_argument('--logfc-threshold', type=float, default=0.5, help='Log fold-change threshold')
    parser.add_argument('--n-top-genes', type=int, help='Number of top genes per comparison')
    args = parser.parse_args()
    main(args)
