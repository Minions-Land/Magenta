def annotate_celltype_scRNA(
    adata_filename,
    data_dir,
    data_info,
    data_lake_path,
    cluster="leiden",
    llm="claude-3-5-sonnet-20241022",
    composition=None,
):
    """Annotate cell types based on gene markers and transferred labels using LLM.
    After leiden clustering, annotate clusters using differentially expressed genes
    and optionally incorporate transferred labels from reference datasets.

    Parameters
    ----------
    - adata_filename (str): Name of the AnnData file containing scRNA-seq data
    - data_dir (str): Directory containing the data files
    - data_info (str): Information about the scRNA-seq data (e.g., "homo sapiens, brain tissue, normal")
    - data_lake_path (str): Path to the data lake
    - llm (str): Language model instance for cell type prediction, such as 'claude-3-haiku-20240307'
    - composition (pd.DataFrame, optional): Transferred cell type composition for each cluster
    Returns:
    - str: Steps performed and file paths where results were saved

    """

    def _cluster_info(cluster_id, marker_genes, composition_df=None):
        """Format cluster information for LLM prompt."""
        if composition_df is None:
            return f"The enriched genes in this cluster are: {', '.join(marker_genes)}."

        info = [
            f"The enriched genes in this cluster are: {', '.join(marker_genes)}.",
            f"For a starting point, the transferred reference cell type composition {cluster_id} is:",
        ]

        cluster_comp = []
        for celltype, proportion in composition_df.loc[cluster_id].items():
            if proportion > 0:
                cluster_comp.append(f"{celltype}:{proportion:.2f}")

        return "\n".join(info) + " " + "; ".join(cluster_comp) + "\n"

    from langchain_core.prompts import PromptTemplate

    # from langchain.chains import LLMChain

    steps = []
    steps.append(f"Loading AnnData from {data_dir}/{adata_filename}")
    adata = sc.read_h5ad(f"{data_dir}/{adata_filename}")

    steps.append(f"Identifying marker genes for clusters defined by {cluster} clustering.")
    sc.tl.rank_genes_groups(adata, groupby="leiden", method="wilcoxon", use_raw=False)
    genes = pd.DataFrame(adata.uns["rank_genes_groups"]["names"]).head(20)
    scores = pd.DataFrame(adata.uns["rank_genes_groups"]["scores"]).head(20)

    markers = {}
    for i in range(genes.shape[1]):
        gene_names = genes.iloc[:, i].tolist()
        gene_scores = scores.iloc[:, i].tolist()
        markers[i] = list(np.array(gene_names)[np.array(gene_scores) > 0])

    # TODO: this can be optimized
    czi_celltype_path = data_lake_path + "/czi_census_datasets_v4.parquet"
    df = pd.read_parquet(czi_celltype_path)
    czi_celltype_set = {cell_type.strip() for cell_types in df["cell_type"] for cell_type in str(cell_types).split(";")}
    czi_celltype = ", ".join(sorted(czi_celltype_set))

    prompt_template = f"""
Please think carefully, and identify the cell type in {data_info} based on the gene markers.
Optionally refer to the transferred cell type information but do not trust it when the percentage is lower than 0.5.

{{cluster_info}}

The cell type names should come from cell ontology: {czi_celltype}.
Only provide the cell type name, confidence score (0-1), and detailed reason.
Output format: "name; score; reason".
No numbers before name or spaces before number.
"""
    # Some can be a mixture of multiple cell types.

    llm = get_llm(llm)
    prompt = PromptTemplate(input_variables=["cluster_info"], template=prompt_template)
    chain = prompt | llm

    steps.append("Annotating cell types of each cluster based on gene markers and transferred labels.")
    # valid_celltypes = set(czi_celltype.split(";"))
    cluster_annotations = {}
    annotation_reasons = []

    print(f"Annotate each cluster of {cluster}")
    for _idx in range(len(adata.obs[cluster].unique())):
        cluster_info = _cluster_info(str(_idx), markers[_idx], composition)

        while True:
            response = chain.invoke({"cluster_info": cluster_info})

            # Handle different response types
            if hasattr(response, "content"):  # For AIMessage
                response = response.content
            elif isinstance(response, dict) and "text" in response:
                response = response["text"]
            elif isinstance(response, str):
                response = response
            else:
                response = str(response)

            try:
                predicted_celltype, confidence, reason = [x.strip() for x in response.split(";", 2)]
                if predicted_celltype in czi_celltype_set or predicted_celltype.lower() in czi_celltype_set:
                    cluster_annotations[str(_idx)] = predicted_celltype
                    annotation_reasons.append((predicted_celltype, reason))
                    break
                else:
                    cluster_info += "\nAssigned cell type name must be in cell ontology!"
            except ValueError:
                cluster_info += "\nPlease follow the format: name; score; reason"
        print(f"Cluster {_idx}: {response}")

    # create reason dictionary
    reason_dict = {}
    for celltype, reason in annotation_reasons:
        if celltype not in reason_dict:
            reason_dict[celltype] = []
        reason_dict[celltype].append(reason)

    reason_dict = {k: "\n".join(v) for k, v in reason_dict.items()}

    adata.obs["cell_type"] = adata.obs[cluster].map(cluster_annotations)
    adata.obs["cell_type_reason"] = adata.obs["cell_type"].map(reason_dict).astype(str)

    steps.append(f"Saving annotated adata to {data_dir}/annotated.h5ad, the annotations are in the 'cell_type' column.")
    adata.write(f"{data_dir}/annotated.h5ad", compression="gzip")

    return "\n".join(steps)


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
