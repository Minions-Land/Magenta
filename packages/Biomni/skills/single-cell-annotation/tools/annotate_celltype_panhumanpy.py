def annotate_celltype_with_panhumanpy(
    adata_path,
    feature_names_col=None,
    refine=True,
    umap=True,
    output_dir="./output",
):
    """Perform hierarchical cell type annotation using panhumanpy and Azimuth Neural Network.

    This function implements the panhumanpy workflow for cell type annotation using the
    Azimuth Neural Network, providing hierarchical cell type labels with confidence scores.

    Parameters
    ----------
    adata_path : str
        Path to the AnnData file containing scRNA-seq data
    feature_names_col : str, optional
        Column name in adata.var containing gene names (default: None, uses index)
    refine : bool, optional
        Whether to perform label refinement for consistent granularity (default: True)
    umap : bool, optional
        Whether to generate ANN embeddings and UMAP (default: True)
    output_dir : str, optional
        Directory to save results (default: "./output")

    Returns
    -------
    str
        Research log summarizing the analysis steps and results

    Notes
    -----
    Performance is not ensured for diseased and/or non-human cells.
    """
    import json
    import shutil
    import subprocess
    import tempfile

    def conda_env_exists(env_name):
        try:
            result = subprocess.run(["conda", "env", "list"], capture_output=True, text=True, check=True)
            return any(env_name in line.split() for line in result.stdout.splitlines())
        except Exception:
            return False

    def create_panhumanpy_env(env_name):
        # Create env and install panhumanpy
        subprocess.run(["conda", "create", "-y", "-n", env_name, "python=3.10"], check=True)
        # Install panhumanpy in the new env
        subprocess.run(
            ["conda", "run", "-n", env_name, "pip", "install", "git+https://github.com/satijalab/panhumanpy.git"],
            check=True,
        )

    PANHUMANPY_ENV = "panhumanpy_env"

    # 1. Check/create panhumanpy_env
    if not conda_env_exists(PANHUMANPY_ENV):
        create_panhumanpy_env(PANHUMANPY_ENV)

    # 2. Write a temp script to run in the panhumanpy_env
    temp_dir = tempfile.mkdtemp()
    script_path = os.path.join(temp_dir, "run_panhumanpy.py")
    result_path = os.path.join(temp_dir, "result.json")
    with open(script_path, "w") as f:
        f.write(
            f"""
import os
import sys
import json
import numpy as np
import scanpy as sc
import pandas as pd
try:
    import panhumanpy as ph
except ImportError as e:
    with open(r'{result_path}', 'w') as out:
        out.write(json.dumps({{"error": str(e)}}))
    sys.exit(1)

adata_path = r'''{adata_path}'''
feature_names_col = {repr(feature_names_col)}
refine = {refine}
umap = {umap}
output_dir = r'''{output_dir}'''
log = []
try:
    os.makedirs(output_dir, exist_ok=True)
    log.append("# Performing cell type annotation with Panhuman Azimuth")
    log.append(f"Loading object from: {{adata_path}}")
    adata = sc.read_h5ad(adata_path)
    log.append(f"✓ Successfully loaded object with {{adata.n_obs}} cells and {{adata.n_vars}} genes")
    if feature_names_col is None:
        log.append("Using gene names from adata.var.index")
    else:
        log.append(f"Using gene names from column: {{feature_names_col}}")
        if feature_names_col not in adata.var.columns:
            log.append(f"⚠ Warning: Column '{{feature_names_col}}' not found in adata.var")
            log.append(f"Available columns: {{list(adata.var.columns)}}")
            log.append("Falling back to index")
