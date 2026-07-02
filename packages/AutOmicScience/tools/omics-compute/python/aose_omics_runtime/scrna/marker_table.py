"""
Differential expression analysis for cluster markers.

Provides marker_table() frozen helper that wraps sc.tl.rank_genes_groups
and returns a clean pandas DataFrame with standardized filtering.

This extends markers.py with focus on returning tabular results suitable
for downstream annotation and reporting.
"""

from typing import Optional, Literal
from datetime import datetime, UTC
import pandas as pd
import scanpy as sc
from anndata import AnnData

from ..shared.conventions import OBS_LEIDEN

# Module-top constants (single source of truth)
DEFAULT_METHOD = "wilcoxon"
DEFAULT_MIN_LOGFC = 0.5
DEFAULT_MIN_IN_GROUP_FRACTION = 0.25
DEFAULT_MAX_OUT_GROUP_FRACTION = 0.5
DEFAULT_N_GENES = 100

# Noise-gene exclusion (ribosomal / mito / MALAT1 / hemoglobin). See markers.py.
NOISE_GENE_PREFIXES = ("MT-", "MT.", "mt-", "RPS", "RPL", "MRPS", "MRPL")
NOISE_GENE_EXACT = ("MALAT1", "NEAT1", "XIST")
HEMOGLOBIN_GENES = ("HBA1", "HBA2", "HBB", "HBD", "HBE1", "HBG1", "HBG2", "HBM", "HBQ1", "HBZ")


def is_noise_gene(name: str) -> bool:
    """True if a gene is a ribosomal / mito / MALAT1 / hemoglobin noise gene."""
    if name in NOISE_GENE_EXACT or name in HEMOGLOBIN_GENES:
        return True
    return any(name.startswith(p) for p in NOISE_GENE_PREFIXES)


def marker_table(
    adata: AnnData,
    *,
    groupby: str = OBS_LEIDEN,
    groups: Optional[str] = "all",
    reference: str = "rest",
    method: Literal["wilcoxon", "t-test", "logreg"] = DEFAULT_METHOD,
    use_raw: Optional[bool] = None,
    n_genes: int = DEFAULT_N_GENES,
    min_logfc: float = DEFAULT_MIN_LOGFC,
    min_in_group_fraction: float = DEFAULT_MIN_IN_GROUP_FRACTION,
    max_out_group_fraction: float = DEFAULT_MAX_OUT_GROUP_FRACTION,
    return_report: bool = True,
) -> tuple[pd.DataFrame, Optional[dict]]:
    """
    Generate marker gene table with standardized filtering.

    Runs sc.tl.rank_genes_groups, extracts results with pts mapping,
    and filters by logFC and expression fraction criteria.

    Parameters
    ----------
    adata : AnnData
        Annotated data matrix (modified in-place to add uns['rank_genes_groups'])
    groupby : str, default=OBS_LEIDEN
        Key in adata.obs for grouping (e.g., 'leiden', 'cell_type')
    groups : str or list, default='all'
        Which groups to compute markers for
    reference : str, default='rest'
        Reference group ('rest' for one-vs-rest)
    method : {'wilcoxon', 't-test', 'logreg'}, default='wilcoxon'
        Statistical test to use
    use_raw : bool or None
        Whether to use adata.raw for testing. If None, uses raw if available.
    n_genes : int, default=100
        Number of top genes to return per group
    min_logfc : float, default=0.5
        Minimum log fold-change to keep
    min_in_group_fraction : float, default=0.25
        Minimum fraction of cells expressing in group
    max_out_group_fraction : float, default=0.5
        Maximum fraction of cells expressing outside group
    return_report : bool, default=True
        Whether to return detailed report dict

    Returns
    -------
    markers : pd.DataFrame
        Marker table with columns:
        - group: cluster/group ID
        - names: gene names
        - scores: test statistic
        - logfoldchanges: log fold-change
        - pvals: p-values
        - pvals_adj: adjusted p-values
        - pts: fraction expressing in group
        - pts_rest: fraction expressing in rest
        - specificity: pts / (pts + pts_rest)
    report : dict or None
        Structured report with params and summary stats (if return_report=True)

    Raises
    ------
    KeyError
        If groupby key not found in adata.obs
    ValueError
        If method is invalid or data has issues
    """
    start_time = datetime.now(UTC)

    # Validate inputs
    if groupby not in adata.obs.columns:
        raise KeyError(
            f"Groupby key '{groupby}' not found in obs. "
            f"Available columns: {list(adata.obs.columns)}"
        )

    n_groups = adata.obs[groupby].nunique()

    # Run rank_genes_groups with pts=True
    sc.tl.rank_genes_groups(
        adata,
        groupby=groupby,
        groups=groups,
        reference=reference,
        method=method,
        use_raw=use_raw,
        pts=True,
        n_genes=None,
    )

    # Extract results for each group
    result_dfs = []

    for group in adata.uns['rank_genes_groups']['names'].dtype.names:
        # Get dataframe for this group
        group_df = sc.get.rank_genes_groups_df(adata, group=group)

        # Add group column
        group_df.insert(0, 'group', group)

        # Map pts / pts_rest by GENE-NAME index (the uns 'pts' DataFrame is
        # indexed by gene name, not ranked order — zipping positionally
        # misaligns every value). See markers.py for the detailed bug note.
        pts_series = adata.uns['rank_genes_groups']['pts'][group]
        group_df['pts'] = group_df['names'].map(pts_series)
        if 'pts_rest' in adata.uns['rank_genes_groups']:
            group_df['pts_rest'] = group_df['names'].map(
                adata.uns['rank_genes_groups']['pts_rest'][group])
        else:
            group_df['pts_rest'] = 0.0

        # Calculate specificity score
        group_df['specificity'] = group_df['pts'] / (group_df['pts'] + group_df['pts_rest'] + 1e-10)

        result_dfs.append(group_df)

    # Concatenate all groups
    markers = pd.concat(result_dfs, ignore_index=True)

    initial_count = len(markers)

    # Exclude noise genes before the quality filter so they never take a slot.
    markers = markers[~markers['names'].map(is_noise_gene)].copy()

    # Apply quality filters
    filtered = markers[
        (markers['logfoldchanges'] >= min_logfc) &
        (markers['pts'] >= min_in_group_fraction) &
        (markers['pts_rest'] <= max_out_group_fraction)
    ].copy()

    # Sort by group then by score, keep at most n_genes per group
    filtered = filtered.sort_values(['group', 'scores'], ascending=[True, False])
    filtered = filtered.groupby('group', sort=False, group_keys=False).head(n_genes)

    end_time = datetime.now(UTC)

    if return_report:
        report = {
            "operation": "marker_table",
            "n_groups": n_groups,
            "groups": sorted(adata.obs[groupby].unique().tolist()),
            "parameters": {
                "groupby": groupby,
                "groups": groups,
                "reference": reference,
                "method": method,
                "use_raw": use_raw,
                "n_genes": n_genes,
                "min_logfc": min_logfc,
                "min_in_group_fraction": min_in_group_fraction,
                "max_out_group_fraction": max_out_group_fraction,
            },
            "n_markers_before_filter": initial_count,
            "n_markers_after_filter": len(filtered),
            "markers_per_group": filtered['group'].value_counts().to_dict(),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "duration_seconds": (end_time - start_time).total_seconds(),
        }
        return filtered, report
    else:
        return filtered, None


def format_marker_summary(markers: pd.DataFrame, top_n: int = 5) -> str:
    """
    Format marker table as human-readable text summary.

    Parameters
    ----------
    markers : pd.DataFrame
        Output from marker_table()
    top_n : int, default=5
        Number of top markers per group to include

    Returns
    -------
    str
        Formatted text summary
    """
    lines = []
    lines.append(f"Marker genes (top {top_n} per group):")
    lines.append("")

    for group in markers['group'].unique():
        group_markers = markers[markers['group'] == group].head(top_n)
        genes = ", ".join(group_markers['names'].tolist())
        lines.append(f"  {group}: {genes}")

    return "\n".join(lines)


def export_markers_for_enrichment(
    markers: pd.DataFrame,
    *,
    top_n: int = 50,
    output_format: Literal["gene_list", "ranked"] = "gene_list",
) -> dict[str, list[str]]:
    """
    Export marker genes in format suitable for enrichment analysis (e.g., Enrichr, GSEA).

    Parameters
    ----------
    markers : pd.DataFrame
        Output from marker_table()
    top_n : int, default=50
        Number of top markers per group
    output_format : {'gene_list', 'ranked'}
        'gene_list': simple list of gene names
        'ranked': list of (gene, score) tuples

    Returns
    -------
    dict
        Mapping from group ID to gene list/ranked list
    """
    result = {}

    for group in markers['group'].unique():
        group_markers = markers[markers['group'] == group].head(top_n)

        if output_format == "gene_list":
            result[str(group)] = group_markers['names'].tolist()
        elif output_format == "ranked":
            result[str(group)] = list(zip(
                group_markers['names'].tolist(),
                group_markers['scores'].tolist()
            ))
        else:
            raise ValueError(f"Unknown output_format: {output_format}")

    return result


def main(args):
    """CLI entry for the `marker_table` subcommand. Fails loud: the previous
    version called a nonexistent `io.read_h5ad`, passed a `min_pct` kwarg the
    function does not accept, and treated the (DataFrame, report) tuple as a bare
    DataFrame for `.to_csv` -- all runtime errors."""
    import json
    from ..shared import io

    adata, _load_meta = io.load_h5ad(path=args.input)

    # CLI --min-pct maps to the in-group fraction threshold.
    table, report = marker_table(
        adata,
        groupby=args.groupby,
        min_logfc=args.min_logfc,
        min_in_group_fraction=args.min_pct,
        return_report=True,
    )

    table.to_csv(args.output, index=False)
    report = report or {}
    report["input"] = args.input
    report["output"] = args.output
    report["n_markers"] = int(len(table))
    print(json.dumps(report, indent=2, default=str))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--groupby', default='leiden')
    parser.add_argument('--min-logfc', type=float, default=0.5)
    parser.add_argument('--min-pct', type=float, default=0.1)
    main(parser.parse_args())
