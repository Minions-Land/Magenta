"""Decoupler pathway activity inference implementation."""

import json
from datetime import datetime, UTC
from pathlib import Path
import anndata as ad
import decoupler as dc
import pandas as pd


def run_decoupler_pathway_activity(args):
    """
    Infer pathway activity from gene expression using decoupler.

    Args:
        args: Argparse namespace with parameters

    Returns:
        dict: Result with pathway scores, evidence metadata, and provenance
    """
    start_time = datetime.now(UTC)

    # Load input data
    adata = ad.read_h5ad(args.adata)
    input_shape = adata.shape

    # Get expression matrix
    if args.use_raw and adata.raw is not None:
        expr_data = adata.raw.to_adata()
    elif args.layer:
        expr_data = adata.copy()
        expr_data.X = expr_data.layers[args.layer]
    else:
        expr_data = adata.copy()

    # Get pathway resource
    resource_name = args.resource.lower()
    organism = args.organism.lower()

    try:
        if resource_name == "progeny":
            net = dc.op.progeny(organism=organism, top=100)
        elif resource_name == "msigdb" or resource_name == "hallmark":
            # Get MSigDB Hallmark pathways
            net = dc.op.hallmark(organism=organism)
        elif resource_name == "dorothea":
            net = dc.op.dorothea(organism=organism)
        elif resource_name == "collectri":
            net = dc.op.collectri(organism=organism)
        else:
            # Try generic resource loader
            net = dc.op.resource(resource_name, organism=organism)
    except Exception as e:
        raise ValueError(f"Failed to load resource '{resource_name}': {e}")

    # Filter by minimum pathway size
    pathway_sizes = net.groupby('source').size()
    valid_pathways = pathway_sizes[pathway_sizes >= args.min_size].index
    net = net[net['source'].isin(valid_pathways)]

    if len(net) == 0:
        raise ValueError(f"No pathways found with minimum size {args.min_size}")

    # Run pathway activity inference
    method = args.method.lower()

    try:
        if method == "mlm":
            result = dc.mt.mlm(expr_data, net, use_raw=False)
        elif method == "ulm":
            result = dc.mt.ulm(expr_data, net, use_raw=False, min_n=3)
        elif method == "wsum":
            result = dc.mt.zscore(expr_data, net, use_raw=False, min_n=3)
        elif method == "gsea":
            result = dc.mt.gsea(expr_data, net, use_raw=False, min_n=3)
        elif method == "ora":
            # ORA requires a gene list, not full expression
            raise ValueError("ORA method requires a gene list, use decoupler-enrichment instead")
        elif method == "viper":
            result = dc.mt.viper(expr_data, net, use_raw=False, min_n=3)
        elif method == "aucell":
            result = dc.mt.aucell(expr_data, net, use_raw=False, min_n=3)
        else:
            raise ValueError(f"Unknown method: {method}")
    except Exception as e:
        raise ValueError(f"Failed to run {method}: {e}")

    # Handle result format (some methods return tuple, some return AnnData)
    if isinstance(result, tuple):
        activities = result[0]
        pvals = result[1] if len(result) > 1 else None
    else:
        activities = result
        pvals = None

    # If result is AnnData, extract the scores
    if hasattr(activities, 'obsm'):
        # Result is stored in obsm with method name as key
        key = f'{method}_estimate'
        if key in activities.obsm:
            activities = activities.obsm[key]
        else:
            # Try to find the right key
            possible_keys = [k for k in activities.obsm.keys() if method in k.lower()]
            if possible_keys:
                activities = activities.obsm[possible_keys[0]]
            else:
                raise ValueError(f"Could not find activity scores in result")

        if pvals is not None and hasattr(pvals, 'obsm'):
            pval_key = f'{method}_pvals'
            if pval_key in pvals.obsm:
                pvals = pvals.obsm[pval_key]
            else:
                pvals = None

    # Add pathway scores to adata
    adata.obsm[f'pathway_{method}'] = activities
    if pvals is not None:
        adata.obsm[f'pathway_{method}_pvals'] = pvals

    # Store metadata
    adata.uns['pathway_analysis'] = {
        'method': method,
        'resource': resource_name,
        'organism': organism,
        'min_size': args.min_size,
        'n_pathways': activities.shape[1],
        'pathway_names': list(activities.columns),
        'timestamp': datetime.now(UTC).isoformat(),
    }

    # Save output
    adata.write_h5ad(args.output, compression='gzip')
    output_path = Path(args.output).resolve()

    end_time = datetime.now(UTC)
    elapsed_ms = int((end_time - start_time).total_seconds() * 1000)

    # Build evidence record
    evidence = {
        "source": f"decoupler {dc.__version__}",
        "source_type": "computation",
        "query": f"{method} pathway activity inference",
        "description": f"Inferred activity of {activities.shape[1]} pathways using {method} method on {resource_name} resource",
        "timestamp": end_time.isoformat(),
        "metadata": {
            "method": method,
            "resource": resource_name,
            "organism": organism,
            "n_pathways": activities.shape[1],
            "n_cells": activities.shape[0],
            "min_pathway_size": args.min_size,
            "input_shape": list(input_shape),
            "has_pvalues": pvals is not None,
        }
    }

    # Build trace step
    trace = {
        "tool": "bio_decoupler_pathway_activity",
        "status": "success",
        "input": {
            "adata": args.adata,
            "method": method,
            "resource": resource_name,
            "organism": organism,
        },
        "output": {
            "n_pathways": activities.shape[1],
            "output_file": str(output_path),
        },
        "duration_ms": elapsed_ms,
        "timestamp": end_time.isoformat(),
    }

    # Get pathway statistics
    pathway_stats = {
        'mean_activity': activities.mean().to_dict(),
        'std_activity': activities.std().to_dict(),
        'min_activity': activities.min().to_dict(),
        'max_activity': activities.max().to_dict(),
    }

    # Build result
    result = {
        "success": True,
        "output": str(output_path),
        "n_pathways": activities.shape[1],
        "n_cells": activities.shape[0],
        "method": method,
        "resource": resource_name,
        "organism": organism,
        "pathway_names": list(activities.columns)[:20],  # First 20 pathways
        "pathway_stats": {k: dict(list(v.items())[:5]) for k, v in pathway_stats.items()},  # First 5 pathways
        "evidence": [evidence],
        "trace": [trace],
        "elapsed_ms": elapsed_ms,
    }

    return result


def main(args):
    """CLI entry for pathway_activity subcommand."""
    import json

    result = run_decoupler_pathway_activity(args)

    # Print summary
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Pathway activity inference using decoupler')
    parser.add_argument('--adata', required=True, help='Input h5ad file')
    parser.add_argument('--output', required=True, help='Output h5ad file with pathway scores')
    parser.add_argument('--resource', default='progeny', help='Pathway resource (progeny, msigdb, dorothea, collectri)')
    parser.add_argument('--method', default='mlm', choices=['mlm', 'ulm', 'wsum', 'gsea', 'viper', 'aucell'],
                        help='Inference method')
    parser.add_argument('--organism', default='human', help='Organism (human, mouse)')
    parser.add_argument('--use-raw', action='store_true', help='Use adata.raw for expression')
    parser.add_argument('--layer', help='Layer to use for expression')
    parser.add_argument('--min-size', type=int, default=5, help='Minimum pathway size')
    args = parser.parse_args()
    main(args)
