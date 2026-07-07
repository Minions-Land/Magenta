def unsupervised_celltype_transfer_between_scRNA_datasets(
    path_to_annotated_h5ad: str,
    path_to_not_annotated_h5ad: str,
    ref_labels_key: str,
    query_batch_key: str = None,
    ref_batch_key: str = None,
    CELLTYPIST=False,
    KNN_BBKNN=False,
    KNN_HARMONY=False,
    KNN_SCANORAMA=False,
    KNN_SCVI=False,
    ONCLASS=False,
    Random_Forest=False,
    SCANVI_POPV=True,
    Support_Vector=False,
    XGboost=False,
    n_jobs: int = 1,
    output_folder: str = "./tmp/",
    n_samples_per_label: int = 10,
):
    import os

    import scanpy as sc

    os.environ["PYTHONUTF8"] = "1"
    import popv

    steps = []
    steps.append("Starting unsupervised cell type transfer using popV")

    steps.append(f"Loading reference annotated dataset from: {path_to_annotated_h5ad}")
    ref_adata = sc.read_h5ad(path_to_annotated_h5ad)
    steps.append(f"Reference annotated dataset loaded: {ref_adata.n_obs} cells, {ref_adata.n_vars} genes")

    steps.append(f"Loading not annotated query dataset from: {path_to_not_annotated_h5ad}")
    query_adata = sc.read_h5ad(path_to_not_annotated_h5ad)
    steps.append(f"query dataset loaded: {query_adata.n_obs} cells, {query_adata.n_vars} genes")

    # this is required for scvi/scanvi based classifier
    ref_adata.layers["counts"] = ref_adata.X.copy()
    query_adata.layers["counts"] = query_adata.X.copy()

    popv.settings.n_jobs = n_jobs
    output_folder = output_folder
    os.makedirs(output_folder, exist_ok=True)
    steps.append(f"Created output folder: {output_folder}")

    steps.append("Processing query dataset for annotation with popV")
    adata = popv.preprocessing.Process_Query(
        query_adata,
        ref_adata,
        ref_labels_key=ref_labels_key,
        query_batch_key=query_batch_key,
        ref_batch_key=ref_batch_key,
        save_path_trained_models=output_folder,
        cl_obo_folder=False,
        prediction_mode="retrain",
    ).adata

    # passing arugments this way decreases chance of LLM generation and parsing errors
    flags = {
        "CELLTYPIST": CELLTYPIST,
        "KNN_BBKNN": KNN_BBKNN,
        "KNN_HARMONY": KNN_HARMONY,
        "KNN_SCANORAMA": KNN_SCANORAMA,
        "KNN_SCVI": KNN_SCVI,
        "ONCLASS": ONCLASS,
        "Random_Forest": Random_Forest,
        "SCANVI_POPV": SCANVI_POPV,
        "Support_Vector": Support_Vector,
        "XGboost": XGboost,
    }
    selected_methods = [name for name, val in flags.items() if val]
    if selected_methods:
        steps.append(f"Selected annotation methods: {', '.join(selected_methods)}")
    else:
        steps.append("No annotation methods selected")

    steps.append("Starting annotation with SCANVI_POPV method")
    popv.annotation.annotate_data(
        adata,
        methods=selected_methods,
        save_path=f"{output_folder}/popv_output",
    )

    steps.append(f"Annotation completed. Results saved to: {output_folder}/popv_output/predictions.csv")

    return "\n".join(steps)


def interspecies_gene_conversion(
    gene_list: list[str],
    source_species: str,
    target_species: str,
) -> str:
    """Convert ENSEMBL gene IDs between different species using BioMart homology mapping.

    This function converts a list of ENSEMBL gene IDs from one species to their
    homologous counterparts in another species using the Ensembl BioMart database.
    The conversion is based on one-to-one ortholog mappings between species.

