"""Decoupler enrichment analysis implementation."""

import json
from datetime import datetime, UTC
from pathlib import Path
import decoupler as dc
import pandas as pd


def run_decoupler_enrichment(args):
    """
    Run gene set enrichment analysis using decoupler.

    Args:
        args: Argparse namespace with parameters

    Returns:
        dict: Result with enrichment scores, evidence metadata, and provenance
    """
    start_time = datetime.now(UTC)

    # Parse gene list
    gene_list = [g.strip() for g in args.gene_list.split(',') if g.strip()]
    if len(gene_list) == 0:
        raise ValueError("Empty gene list provided")

    # Get gene set resource
    resource_name = args.resource.lower()
    organism = args.organism.lower()

    try:
        if resource_name == "msigdb" or resource_name == "hallmark":
            net = dc.op.hallmark(organism=organism)
        elif resource_name == "progeny":
            net = dc.op.progeny(organism=organism, top=100)
        elif resource_name == "dorothea":
            net = dc.op.dorothea(organism=organism)
        elif resource_name == "collectri":
            net = dc.op.collectri(organism=organism)
        else:
            # Try generic resource loader
            net = dc.op.resource(resource_name, organism=organism)
    except Exception as e:
        raise ValueError(f"Failed to load resource '{resource_name}': {e}")

    # Run enrichment analysis
    method = args.method.lower()

    if method == "ora":
        # Over-representation analysis
        # Create a simple AnnData object with gene list
        import anndata as ad
        gene_df = pd.DataFrame(index=gene_list)
        gene_df['present'] = 1

        enrich_results = dc.mt.ora(
            gene_df,
            net,
            source='source',
            target='target',
            min_n=3
        )

        # If result is AnnData, extract the data
        if hasattr(enrich_results, 'obsm'):
            key = 'ora_estimate'
            if key in enrich_results.obsm:
                enrich_results = pd.DataFrame(enrich_results.obsm[key])
            else:
                # Find the right key
                possible_keys = [k for k in enrich_results.obsm.keys() if 'ora' in k.lower()]
                if possible_keys:
                    enrich_results = pd.DataFrame(enrich_results.obsm[possible_keys[0]])
                else:
                    raise ValueError("Could not extract ORA results")

        # Convert to DataFrame if needed
        if not isinstance(enrich_results, pd.DataFrame):
            enrich_results = pd.DataFrame(enrich_results)

    elif method == "gsea":
        # For GSEA, we would need ranked genes, not just a list
        raise ValueError("GSEA method requires ranked gene list (gene_name, score pairs)")
    else:
        raise ValueError(f"Unknown enrichment method: {method}")

    # Filter by p-value threshold
    # Handle different column names that decoupler might use
    pval_col = None
    for col in ['FDR p-value', 'pval', 'p_value', 'padj', 'FDR']:
        if col in enrich_results.columns:
            pval_col = col
            break

    if pval_col is None:
        # If no p-value column, use all results
        significant = enrich_results.copy()
    else:
        significant = enrich_results[enrich_results[pval_col] < args.padj_threshold]

    # Sort by significance if we have p-values
    if pval_col:
        significant = significant.sort_values(pval_col)

    top_pathways = significant.head(args.top_n)

    # Build result dictionary
    enrichment_data = {
        'method': method,
        'resource': resource_name,
        'organism': organism,
        'n_input_genes': len(gene_list),
        'n_pathways_tested': len(enrich_results),
        'n_significant_pathways': len(significant),
        'padj_threshold': args.padj_threshold,
        'top_pathways': top_pathways.to_dict('records'),
        'all_results': enrich_results.to_dict('records'),
        'timestamp': datetime.now(UTC).isoformat(),
    }

    # Save output
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(enrichment_data, f, indent=2)

    end_time = datetime.now(UTC)
    elapsed_ms = int((end_time - start_time).total_seconds() * 1000)

    # Build evidence record
    evidence = {
        "source": f"decoupler {dc.__version__}",
        "source_type": "computation",
        "query": f"{method} enrichment analysis",
        "description": f"Found {len(significant)} significant pathways from {len(gene_list)} genes using {method} on {resource_name}",
        "timestamp": end_time.isoformat(),
        "metadata": {
            "method": method,
            "resource": resource_name,
            "organism": organism,
            "n_input_genes": len(gene_list),
            "n_pathways_tested": len(enrich_results),
            "n_significant": len(significant),
            "padj_threshold": args.padj_threshold,
        }
    }

    # Build trace step
    trace = {
        "tool": "bio_decoupler_enrichment",
        "status": "success",
        "input": {
            "n_genes": len(gene_list),
            "method": method,
            "resource": resource_name,
            "organism": organism,
        },
        "output": {
            "n_pathways_tested": len(enrich_results),
            "n_significant": len(significant),
            "output_file": str(output_path),
        },
        "duration_ms": elapsed_ms,
        "timestamp": end_time.isoformat(),
    }

    # Extract top pathway info for summary
    top_5_pathways = []
    for idx, row in top_pathways.head(5).iterrows():
        pathway_info = {
            'name': str(idx) if isinstance(idx, str) else row.get('source', row.get('Term', 'Unknown')),
            'pvalue': float(row.get(pval_col, 1.0)) if pval_col else None,
        }
        # Try to get overlap/gene count
        for col in ['Overlap', 'n_genes', 'size', 'overlap']:
            if col in row:
                pathway_info['n_genes'] = int(row[col]) if pd.notna(row[col]) else 0
                break
        top_5_pathways.append(pathway_info)

    # Build result
    result = {
        "success": True,
        "output": str(output_path),
        "n_input_genes": len(gene_list),
        "n_pathways_tested": len(enrich_results),
        "n_significant_pathways": len(significant),
        "method": method,
        "resource": resource_name,
        "organism": organism,
        "top_pathways": top_5_pathways,
        "evidence": [evidence],
        "trace": [trace],
        "elapsed_ms": elapsed_ms,
    }

    return result


def main(args):
    """CLI entry for enrichment subcommand."""
    import json

    result = run_decoupler_enrichment(args)

    # Print summary
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Gene set enrichment analysis using decoupler')
    parser.add_argument('--output', required=True, help='Output JSON file')
    parser.add_argument('--gene-list', required=True, help='Comma-separated gene list')
    parser.add_argument('--resource', default='msigdb', help='Gene set resource (msigdb, hallmark, progeny, dorothea, collectri)')
    parser.add_argument('--method', default='ora', choices=['ora', 'gsea'], help='Enrichment method')
    parser.add_argument('--organism', default='human', help='Organism (human, mouse)')
    parser.add_argument('--padj-threshold', type=float, default=0.05, help='Adjusted p-value threshold')
    parser.add_argument('--top-n', type=int, default=20, help='Number of top pathways to report')
    args = parser.parse_args()
    main(args)
