# NatureBench (Cellular-Omics slice) — per-task skill/capability & feasibility analysis for Magenta / AutOmicScience (aose)

> For each of the 31 locally-downloaded NatureBench "Cellular Omics" tasks: what published method it
> reproduces, what a solver must PRODUCE, how hard it is to **match/beat the paper's SOTA**, whether
> **aose** (single-cell/spatial scverse skills) helps, and **what capability to add**. Ordered by task id.
>
> - Date: 2026-07-06 · Method: 5 parallel agents read each task's `problem/README.md` + `data_description.md`
>   + `metadata.json` + `evaluation/evaluator.py` + data size.
> - **NatureBench ≠ BiomniBench.** Not a rubric-graded write-up. Each task = **implement a computational
>   method that writes an EXACT output file**, scored objectively by the task's own `evaluator.py` against
>   hidden `ground_truth/`, normalized vs the paper's published SOTA: **aggregate score 0 = matches SOTA,
>   >0 = beats it, <0 = below.** So the "skill" is *deep-learning method reproduction + ML engineering*,
>   NOT domain analytical conventions.

---

## 1. Executive summary

**Nature of the "skills":** almost every task requires reproducing a specific published model
(SATURN, scBERT, scooby, Nucleotide Transformer, MultiGATE, TopoVelo, DeepPBS, mNODE, Metient…) to a
tight objective metric. aose's 5 skills are single-cell/spatial **analysis** (scanpy QC/clustering/
markers/integration) — they **scaffold preprocessing**, but the deliverable is a *trained model*.

**Coverage / feasibility (of the 30 omics tasks; 1 non-omics excluded):**

| Bucket | ~count | Meaning |
|---|---:|---|
| **aose genuinely helps (Core / Core-adjacent)** | **~5–7** | Single-cell *analysis-flavored* tasks: label transfer, atlas mapping, annotation, multimodal clustering, spatial-domain ID, trajectory — aose scaffolds a competitive baseline. |
| **"Do-well" tractable** (strong agent can match/approach SOTA) | **~13** | SOTA is loose / near-solved, OR a public simpler method already ≈/> SOTA, OR an **escape hatch** exists (a baseline beats SOTA). |
| **Hard** (feasible only by running the paper's repo, or bespoke) | **~10** | Reproduce a specific GNN/VAE/foundation-model pipeline; success hinges on the repo installing + tuning. |
| **Very-hard / likely infeasible in a bounded run** | **~5** | Needs un-reproducible mega-pretraining or huge compute: scooby (116 GB, 8×A40·2d), EMO (1 Mb seqs, 30 h/epoch), SpatialEx (22 GB WSI), RNAErnie structure, scTranslator 0.94. |
| **Non-omics (exclude)** | 1 | s42256-025-01003-z = DNA-storage coding theory. |

**⚠️ The strategic insight (biggest lever, more than any single skill):** for MOST tasks the winning move
is NOT to reinvent the method but to **(a) clone & run the SOTA method's public GitHub repo and adapt I/O
to the required output file**, **(b) use a mature simpler method that already ≈/beats SOTA**, or **(c)
exploit escape hatches** where a baseline beats SOTA. Documented escape hatches found:
`deepstarr` CNN > Nucleotide Transformer · Borzoi baseline > scooby (eQTL) · scVI-KMeans > meK-means (2/4)
· scANVI > scPoli (lung) · `cmemit` samples high-scoring RNA directly. So the #1 capability is **general
ML-engineering: run-the-paper's-repo + big-data/GPU streaming + escape-hatch awareness**, not domain skills.

**Capability roadmap to ADD (ranked by #tasks × tractability):**

| Rank | Capability / skill module | Tasks | # |
|---|---|---|---:|
| **1** | **Single-cell deep-model skill** — wrap scvi-tools / scArches / scGPT (scVI, scANVI, scArches, contrastiveVI, scPoli, Concerto, scGPT, SATURN, PHLOWER, scTranslator). *aose-adjacent + high tractability.* | 02035-2, 022-00518-z, 022-00534-z, 00689-2, 01955-3, 02191-z, 025-02870-5, 025-01528-z, 00765-7, 00698-1 | **~10** |
| **2** | **Genomic/biological sequence foundation-model skill** — HF finetuning harness: NT / DNABERT / HyenaDNA / Enformer-Borzoi / ESM / GPN / RNA-FM + task CNNs (DeepSTARR); parquet/FASTA loaders, MCC/Pearson eval | 024-02523-z, 025-02854-5, 025-01016-8, 025-00878-7, 024-02414-w, 024-00836-4 | **~6** |
| **3** | **Spatial-omics DL skill** — STAGATE/GraphST/SpatialGlue/spaVAE domain-ID + scVelo/TopoVelo velocity + CytoCommunity neighborhoods | 63418-x, 024-02316-4, 024-02257-y, 025-02688-8, 023-02124-2, 025-02926-6 | **~6** |
| **4** | **Graph / geometric-DL (PyTorch-Geometric) capability** — transductive node classification, structure/mesh GNNs, equivariant message passing | 024-01312-5, 024-02372-w, 025-02983-x (+ spatial GNNs) | **~3–4** |
| **5** | Singletons/small: tabular-ML GBM (CheckM2), combinatorial phylogeny (Metient), neural-ODE (mNODE), classical CCA+assignment (MARIO), histology-WSI→omics (SpatialEx), RNA generative + Infernal CLI (RfamGen) | 023-01940-w, 025-02924-8, 023-00627-3, 022-01709-7, 025-02926-6, 023-02148-8 | ~6 |
| **0** | **META (the real #1): ML-engineering harness** — clone/build a paper's repo, fetch external weights (ESM/Borzoi/NT/gene2vec), adapt outputs to the exact file/shape, stream multi-GB data on GPU, and recognize escape hatches | ~all | — |

**Compute reality:** the box's 2×H100 (80 GB) cover the 4 gpu_high tasks, but the binding constraints are
often **data size + wall-clock**, not GPU: scooby 116 GB/2 days, scBERT 51 GB (skippable pretrain), EMO
16 GB/30 h-epoch, SpatialEx 22 GB WSI, TREE 19 GB dense adjacency, RfamGen 628 per-family models/24 h+,
DREAM 24–48 h training. Tiers of the 31: **3 cpu · 24 gpu_low · 4 gpu_high**.

**vs BiomniBench:** BiomniBench needs *domain analytical conventions* (encodable as skill docs; a strong
generalist clears many). NatureBench needs *ML method reproduction + compute*; a bare generalist matches
SOTA on the near-solved / escape-hatch tasks but is blocked on the mega-compute / bespoke-method ones.

---

## 2. Master table (ordered by task)

Legend — **Do-well** = difficulty to match/beat SOTA (Low/Med/High/VHigh). **aose** = Core / Prep(reprocessing-only) / No.

| Task | Sub-domain | SOTA method | Metric | GPU · data | Do-well | aose | Capability family to add |
|---|---|---|---|---|:--:|:--:|---|
| s41467-025-63418-x | Spatial Genomics | MultiGATE | ARI | low · 151 MB | High | Prep | spatial multi-omics GNN autoencoder |
| s41551-024-01312-5 | Cancer Genomics | TREE | AUPRC | low · **19 GB** | Med-High | No | graph-ML node classification (PyG) |
| s41551-025-01528-z | Single-Cell (CITE) | scTranslator | cosine | **high** · 1.5 GB | High* | Prep | scRNA→protein deep translator (sciPENN≈0.89 shortcut) |
| s41587-024-02414-w | Genomics | DREAM-CNN/RNN | Pearson | low · 1.6 GB · **24-48 h** | Med-High | No | DNA seq-to-function CNN |
| s41587-025-02688-8 | Spatial Transcriptomics | TopoVelo | CBDir | low · 233 MB | High | Prep | spatial RNA velocity (graph-VAE) |
| s41592-022-01709-7 | Single-Cell Proteomics | MARIO | matching acc | **cpu** · 261 MB | **Med** ✓ | Prep | cross-modal matching (CCA + bipartite assignment) |
| s41592-023-01940-w | Metagenomics | CheckM2 | Completeness MAE | low · 11 GB RAM | **Med** ✓ | No | tabular GBM/MLP regression at scale |
| s41592-023-01955-3 | Single-Cell | contrastiveVI | silhouette | low · 1.6 GB | Med | Prep | single-cell contrastive VAE (scvi-tools) |
| s41592-023-02035-2 | Single-Cell | scPoli | weighted F1 | low · 885 MB | **Low-Med** ✓ | **Core** | reference mapping / label transfer (scArches) |
| s41592-023-02124-2 | Spatial Proteomics | CytoCommunity | Macro-F1 | low · 5.6 MB | Med (CN-kmeans shortcut) | Prep | spatial neighborhood detection |
| s41592-023-02148-8 | RNA Biology | RfamGen | bit score | low · 1.8 GB · **long** | VHigh (cmemit shortcut) | No | RNA generative model + Infernal CLI |
| s41592-024-02191-z | Single-Cell | SATURN | accuracy | low · 2.7 GB | High (run repo) | Prep | protein-LM cross-species integration (ESM2) |
| s41592-024-02257-y | Spatial Transcriptomics | spaVAE | ARI | low · 724 MB | Med | Prep+ | spatial domain ID (GP-VAE / spatial-GNN) |
| s41592-024-02316-4 | Spatial Genomics | SpatialGlue | ARI | low · 56 MB | Match Low / **Beat VHigh** (0.97 ceiling) | Prep | spatial multi-omics GNN |
| s41592-024-02372-w | Structural Bioinf | DeepPBS | MAE | low · 61 MB | High | No | geometric DL (PyG) structure→PWM |
| s41592-024-02523-z | Genomics | Nucleotide Transformer | MCC/Pearson | **high**/med · 371 MB | **Med** ✓ (deepstarr CNN beats NT) | No | DNA foundation-model finetune |
| s41592-025-02854-5 | Single-Cell | scooby | spearman eQTL | **high · 116 GB · 2 d** | **VHigh** (eQTL Borzoi shortcut) | Prep⁻ | seq-to-function (Borzoi decoder) |
| s41592-025-02870-5 | Single-Cell | PHLOWER | accuracy | **cpu** · 2.1 GB | Med-High | Core-ish | trajectory inference + dynverse output |
| s41592-025-02924-8 | Cancer Phylogenetics | Metient | Macro-F1 | low · 35 MB | **Med** ✓ | No | phylogeny site-labeling (combinatorial parsimony) |
| s41592-025-02926-6 | Spatial Omics | SpatialEx | PCC | low-med · **22 GB** WSI | **High-VHigh** | Prep | histology→omics (WSI patch + graph decoder) |
| s41592-025-02983-x | Developmental Bio | geometric GNN | AUC/Pearson | low · 689 MB | Med-High (heavy preprocess) | No | geometric-DL cell-mesh GNN + MATLAB loader |
| s42256-022-00518-z | Single-Cell | Concerto | ASW/ACC | low · 15 GB | **Med** ✓ | **Core** | atlas mapping + integration (scArches/Symphony) |
| s42256-022-00534-z | Single-Cell | scBERT | accuracy | low · **51 GB** (skippable) | **Low-Med** ✓ | **Core** | cross-dataset annotation (+ GEO label fetch) |
| s42256-023-00627-3 | Microbiome Metab | mNODE | mean SCC | low · 12 MB | Med | No | neural-ODE microbiome→metabolome regression |
| s42256-024-00836-4 | RNA Bioinf | RNAErnie | F1 | **high** · ~20 MB | High | No | RNA LM + secondary-structure predictor |
| s42256-025-01003-z ⛔ | **DNA Storage (CS)** | DNAformer | Failure Rate | low · 3.3 GB | High-VHigh | No | (exclude — non-biology coding theory) |
| s42256-025-01016-8 | Genomics | DYNA | AUPR | low · 284 MB | **Med** ✓ | No | PLM/DNA-FM variant-effect head (ESM1b/GPN) |
| s43588-024-00689-2 | Single-Cell | meK-means | ARI | **cpu** · 79 MB | **Low-Med** ✓ (scVI-KMeans beats) | **Core** | spliced+unspliced multimodal clustering |
| s43588-024-00698-1 | Functional Genomics | scGPT+STAMP | ROC-AUC | low · 1.3 GB | Med-High | Prep | perturbation-outcome multi-task head |
| s43588-024-00765-7 | Single-Cell | PolyGene | F1 | low · 213 MB | Med | Prep+ | supervised phenotype classifier |
| s43588-025-00878-7 | Genomic Regulation | EMO | AUC | low(huge bin) · **16 GB · 30 h/ep** | **High-VHigh** | No | long-range DNA+ATAC seq-to-function |

`✓` = "do-well" tractable · `*` scTranslator: SOTA 0.94 needs mega-pretrain, but sciPENN reaches ~0.89 close · `⛔` non-omics.

---

## 3. Per-task detail

*(sub-domain · what to produce + metric + SOTA · method family · compute · do-well difficulty · aose · capability)*

### s41467-025-63418-x — Spatial Multi-Omics Domain Identification
Spatial Genomics (ATAC+RNA). Produce `predictions.npy` int cluster labels (2500/2513), metric **ARI** vs **MultiGATE** (0.60/0.46; SpatialGlue baseline 0.36–0.39). Method: multi-modal **graph-attention autoencoder** (gene–peak + spatial graphs) → clustering. GPU low·151 MB. **Do-well High** (SOTA 0.24 ARI above best scverse baseline). **aose Prep** (loads h5ad/HVG/neighbors; not the GNN). **Add:** spatial multi-omics GNN module (MultiGATE/STAGATE/SpatialGlue family).

### s41551-024-01312-5 — Cancer Gene Identification on Biological Networks
Cancer Genomics. Produce per-net `predictions.npy` float probs (test-node order) over 8 networks, metric **AUPRC** vs **TREE** (~0.54–0.82; EMOGI 0.47–0.76). Method: **transductive GNN node classification** (64-dim multi-omics features on 6 PPI + 2 regulatory graphs, ≤26K nodes). GPU low·**19 GB** dense adjacency. **Do-well Med-High** (reaches ~EMOGI easily; TREE's 0.05 edge tight; 19 GB memory is the real risk). **aose No.** **Add:** PyG/DGL transductive node-classification capability (heterogeneous graphs, AUPRC training, dense→sparse ingestion).

### s41551-025-01528-z — Single-Cell Transcriptome→Proteome Prediction
Single-Cell (CITE-seq). Produce `predictions.npy` (1618,224) surface-protein abundance, metric **per-cell cosine** vs **scTranslator** (0.94 pretrained; sciPENN 0.89). Method: RNA→protein deep translator (transformer / sciPENN / totalVI). **GPU high**·1.5 GB (SOTA pretrain = 1 month×32 GPU, infeasible). **Do-well High to hit 0.94** but forgiving metric → sciPENN ~0.89–0.91 lands close. **aose Prep.** **Add:** RNA→protein module (wrap sciPENN/totalVI + from-scratch transformer translator).

### s41587-024-02414-w — Yeast Promoter Expression Prediction
Genomics. Produce `predictions.npy` (71103,) expression, metric **Pearson Score** (weighted r² over 8 subsets) vs **DREAM-CNN/RNN/Attn** (0.81–0.82; Vaishnav transformer 0.50). Method: **DNA one-hot → CNN/RNN/attention regression from scratch** (6.7 M seqs, no pretrained allowed). GPU low·1.6 GB·**24–48 h**. **Do-well Med-High** (public winning code; standard CNN; gated on long training). **aose No.** **Add:** DNA seq-to-function CNN training harness (Enformer/DREAM-style, large-corpus streaming).

### s41587-025-02688-8 — Spatial RNA Velocity Inference
Spatial Transcriptomics. Produce per-dataset `time.npy`/`velocity.npy`(+`spatial_velocity.npy` for 2 sims), metric **CBDir** vs **TopoVelo** (0.18–0.35; scVelo 0.05–0.12). Method: **spatial graph-VAE / neural-ODE** velocity. GPU low·233 MB. **Do-well High** (scVelo only reaches baseline; TopoVelo needs its spatial graph-VAE; 6 heterogeneous instances). **aose Prep** (spatial/KNN graphs; no velocity skill). **Add:** spatial RNA-velocity module (scVelo moments + TopoVelo-family graph-VAE).

### s41592-022-01709-7 — Cross-Modal Single-Cell Protein Data Matching
Single-Cell Proteomics. Produce per-instance `matching.csv` (1-to-1 cell indices) over 4 instances, metric **coverage-weighted matching accuracy** vs **MARIO** (0.88–0.96; Scanorama/Seurat 0.87–0.91). Method: **classical** — marker-alias harmonization → shared-feature NN + **CCA** alignment → large-scale **bipartite assignment** (no GPU/DL). **CPU**·261 MB. **Do-well Med ✓** (deterministic public algo; baselines already ~0.9; success = engineering: alias resolution, scalable assignment). **aose Prep/partial.** **Add:** cross-modal matching module (CCA + sparse linear-assignment; MARIO pipeline).

### s41592-023-01940-w — Microbial Genome Quality Prediction
Metagenomics. Produce `predictions.csv` (Accession,Completeness,Contamination) 35k rows, metric **Completeness MAE** vs **CheckM2** (2.5; CheckM1 4.7). Method: **tabular GBM/MLP regression** on **pre-computed** KEGG-KO + AA-composition features (annotation already done). GPU low; **11 GB / ~10 GB RAM** sparse matrices. **Do-well Med ✓** (CheckM2 = LightGBM + Keras MLP; features handed to you; single tuned GBM lands close). **aose No.** **Add:** large-sparse tabular GBM/MLP regression (out-of-core), or a CheckM2-style module.

### s41592-023-01955-3 — Contrastive Representation Learning for Treatment Response
Single-Cell. Produce per-instance `representations.npy` (n,latent), metric **silhouette** vs **contrastiveVI** (0.24/0.14/0.10). Method: **single-cell contrastive VAE** (shared+salient latents), now shipped in `scvi-tools`. GPU low·1.6 GB. **Do-well Med** (pip-installable; real work = fiddly per-instance preprocessing: Haber metadata, Norman doublet filter, MixSeq TP53 from DepMap). **aose Prep.** **Add:** single-cell deep-generative skill wrapping scvi-tools external models.

### s41592-023-02035-2 — Single-Cell Cross-Study Label Transfer
Single-Cell. Produce per-instance `predictions.csv` (cell_type), metric **weighted F1** vs **scPoli** (pancreas 0.97 / immune 0.89 / **lung 0.75**; scANVI beats scPoli on lung). Method: **reference-based label transfer** (conditional VAE + classifier). GPU low·885 MB (pre-HVG'd). **Do-well Low-Med ✓ + BEATABLE** (uneven SOTA; beating lung lifts aggregate >0). **aose Core (closest of all)** — integration + kNN transfer is aose territory. **Add:** reference-mapping/label-transfer skill (scArches scPoli/scANVI + kNN) — natural aose extension.

### s41592-023-02124-2 — Tissue Cellular Neighborhood Detection
Spatial Proteomics (CODEX). Produce `predictions.csv` (sample,label) 245,280 rows, metric **Macro-F1** (Hungarian-matched) vs **CytoCommunity** (0.58; Spatial-LDA 0.40). Method: spatial graph + GNN, OR **classic windowed cell-type-composition k-means** (Nolan-lab CN) — competitive shortcut. GPU low·5.6 MB. **Do-well Med** (CN-kmeans shortcut is low-dependency and competitive). **aose Prep** (squidpy graphs). **Add:** spatial neighborhood-detection skill (CN k-means + CytoCommunity GNN).

### s41592-023-02148-8 — RNA Family Sequence Generation
RNA Biology (domain_specific_tooling: Infernal). Produce per-family `{family}.fa` (exactly 1000 seqs) for ~628/18 families, metric **mean bit score** (Infernal cmalign) vs **RfamGen** (6.53/118.4; GCVAE 5.73/101.6). Method: **CM-guided generative VAE** per family. GPU low·1.8 GB·**24 h+** (628 models). **Do-well VHigh** to reproduce; **shortcut: `cmemit`** samples directly from each covariance model (may match by construction). **aose No.** **Add:** RNA generative skill + **Infernal CLI integration** (cmbuild/cmalign/cmfetch/cmemit) — a new domain package.

### s41592-024-02191-z — Cross-Species scRNA Integration + Label Transfer
Single-Cell. Produce `embeddings.h5ad` (160306,k), metric **accuracy** of fixed logistic transfer vs **SATURN** (~0.85; SAMap 0.39). Method: **ESM2 protein-LM gene embeddings → macrogene clustering → ZINB autoencoder + metric learning** (ESM2 features pre-shipped). GPU low·2.7 GB. **Do-well High** (feasible by running SATURN repo; intricate to tune). **aose Prep.** **Add:** cross-species/protein-LM integration skill (wrap SATURN) + ESM2 gene-embedding tooling.

### s41592-024-02257-y — Spatial Domain Identification (SRT)
Spatial Transcriptomics. Produce per-section `{id}.npy` domain labels (20 sections), metric **ARI** vs **spaVAE** (DLPFC 0.53 / HER2 0.42; GraphST 0.35). Method: **GP-VAE** or spatial-GNN + fixed-k clustering. GPU low·724 MB. **Do-well Med** (loose SOTA; public spatial-clustering tools reach ~0.45–0.55). **aose Prep+ (partial method)** — QC/HVG/neighbor/Leiden scaffold is aose's; smoothed-Leiden/GraphST route is in-wheelhouse. **Add:** spatial domain-ID skill (STAGATE/GraphST/spaVAE + fixed-k).

### s41592-024-02316-4 — Spatial Domain Identification from Multi-Omics
Spatial Genomics. Produce per-sim `predictions.npy` (1296,) labels (5 sims), metric **ARI** vs **SpatialGlue** (~0.97; Seurat 0.75). Method: **dual-modality spatial GNN** (attention integration). GPU low·56 MB. **Do-well: Match Low / Beat VHigh** (public code runs on tiny sims → matches ~0.97, but near-ceiling → beating score>0 very hard). **aose Prep.** **Add:** spatial multi-omics GNN (wrap SpatialGlue).

### s41592-024-02372-w — Protein-DNA Binding Specificity Prediction
Structural Bioinformatics. Produce per-complex `{sample}.npy` (L,4) PWM (rows sum 1), 130 complexes, metric **MAE** vs **DeepPBS** (0.13; groove-only 0.15). Method: **geometric DL (PyG)** — protein-atom graph + DNA sym-helix graph → equivariant readout → per-position nucleotide dist. GPU low·61 MB (features pre-extracted). **Do-well High** (from-scratch dual groove+shape GNN). **aose No.** **Add (Magenta):** geometric-DL/PyG "structure→property" module + PWM head (reimplement DeepPBS).

### s41592-024-02523-z — Genomic Sequence Prediction
Genomics. 18 classification + 1 regression instance → `predictions.csv`, metrics **MCC** / **Pearson** vs **Nucleotide Transformer** (splice/promoter ~0.95; histone 0.4–0.65; deepstarr NT 0.64). Method: **DNA foundation-model finetune** (HF NT weights) + DeepSTARR CNN for regression. GPU high(2.5B)/med·371 MB. **Do-well Med ✓** (public HF weights; these ARE the NT benchmark; **deepstarr CNN 0.68 > NT 0.64 = free win**; gate = GPU time × 18). **aose No.** **Add (Magenta):** DNA-FM finetune harness (NT/DNABERT/HyenaDNA) + DeepSTARR CNN.

### s41592-025-02854-5 — Single-Cell Genomic Profile from DNA Sequence
Single-Cell (seq-to-function). Produce hematopoiesis `predictions.npy` (2539,21) + eQTL `predictions.csv` (31004), metrics **Pearson-across-genes** / **spearman eQTL** vs **scooby** (0.86 / 0.45; Borzoi 0.47 beats scooby on eQTL). Method: **Borzoi/Enformer backbone + single-cell decoder** over 524 kb windows + SnapATAC2 coverage. **GPU high · 116 GB · ~2 days on 8×A40**. **Do-well VHigh — full train infeasible in a bounded run**; **shortcut:** off-the-shelf Borzoi variant scoring handles the eQTL half (>scooby). **aose Prep⁻ (marginal).** **Add (Magenta):** seq-to-function capability (Borzoi/Enformer loader + scooby decoder + SnapATAC2 adapters + variant scorer) + big-data streaming.

### s41592-025-02870-5 — Cell Differentiation Trajectory Inference
Single-Cell. Produce dynverse triple-CSV (milestone_network/percentages/progressions) for 43 datasets, metric **accuracy** (HIM+Corr+F1_branches+F1_milestones) vs **PHLOWER** (sim 0.85/real 0.74; PAGA-tree 0.76). Method: **classical spectral / Hodge-Laplacian** tree reconstruction (no DL). **CPU**·2.1 GB. **Do-well Med-High** (CPU-only; PAGA-tree/Slingshot reach ~0.68–0.76 band; real friction = **dynverse output contract** + recovering branch topology). **aose Core-ish** (scanpy PAGA scaffold). **Add:** trajectory-inference skill (topology-recovering backbone + dynverse formatter).

### s41592-025-02924-8 — Clone Tree Site Labeling (Metastatic Migration)
Cancer Phylogenetics. Produce 80 per-patient JSON (migration_edges + seeding_clones), metric **migration-graph Macro-F1** vs **Metient-calibrate** (0.823; MACHINA 0.806). Method: **combinatorial optimization** — vertex site-labeling of given clone trees to minimize migration/comigration/seeding (Gumbel-Softmax or ILP), + organotropism prior. GPU low(opt)/CPU·35 MB. **Do-well Med ✓** (tiny trees ≤11 sites; a from-scratch Sankoff/Fitch weighted-parsimony labeler + organotropism tie-break is feasible; small SOTA gap). **aose No.** **Add:** tumor-phylogeny migration-history tool (wrap Metient / parsimony labeler).

### s41592-025-02926-6 — Spatial Omics Prediction from Histology
Spatial Omics (H&E → transcriptomics/metabolomics). Produce 7 dense `.h5ad` prediction matrices (exact train scale), metric **mean per-feature PCC** vs **SpatialEx/SpatialEx+** (0.35–0.40; DeepPT 0.25). Method: **pathology foundation-model H&E patch encoder + spatial-graph decoder + cycle-consistent diagonal integration**. GPU low-med·**22 GB WSI** (~900K cells/slice). **Do-well High-VHigh** (recent 2025; WSI tiling+alignment+per-cell encoding at scale; external encoder weights; diagonal-integration machinery). **aose Prep** (Xenium/Visium I/O + output normalization). **Add:** histology→omics skill (WSI patch pipeline + pathology encoder + graph decoder + cycle-consistency).

### s41592-025-02983-x — Cell Behavior Prediction in Embryogenesis
Developmental Biology (Drosophila 3D cell mesh). Produce 2 `predictions.json` (junction-loss AUC; multi-task Pearson) vs **Full geometric model** (0.95 AUC; 0.79/0.87/0.78 Pearson). Method: **geometric GNN** on cell-adjacency graph + heavy geometry feature engineering (areas/curvatures/junction length/derivatives). GPU low·689 MB. **Do-well Med-High** (modest GNN, small compute; **dominant risk = MATLAB-mesh preprocessing** + exact feature/target definitions). **aose No.** **Add (Magenta):** geometric-DL cell-mesh skill (MATLAB mesh→graph loader + geometry feature engine + multi-head GNN).

### s42256-022-00518-z — Single-Cell Atlas Mapping and Integration
Single-Cell (CITE-seq). 3 instances: mapping `predictions.npy` (ACC), unseen projection, integration `embeddings.npy` (ASW) vs **Concerto** (0.98 / 0.99 / 0.533; Harmony 0.37). Method: **self-supervised contrastive** encoder → kNN mapping/integration. GPU low·15 GB. **Do-well Med ✓** (cross-tech pancreas mapping ~0.98 is well-solved by scANVI/scArches/Symphony; ASW parity is the stretch). **aose Core** (integration/label-transfer is aose territory). **Add:** reference mapping + integration skill (scArches/Symphony + Concerto-style contrastive encoder).

### s42256-022-00534-z — Single-Cell RNA-seq Cell Type Annotation
Single-Cell. 4 leave-one-out instances → `predictions.csv` (cell_id,cell_type) over 4 endocrine types, metric **accuracy** vs **scBERT** (~0.99; SingleR 0.987). Method: transformer FM — **but 4-class pancreas is near-saturated**. GPU low·**51 GB** (pretrain corpus, skippable). **Do-well Low-Med ✓** (simple classifier on aligned HVGs ~0.98; real difficulty = **data engineering: gene-ID alignment + recover labels from GEO metadata** (may need network)). **aose Core.** **Add:** cross-dataset annotation skill (gene harmonization + lightweight classifier + GEO fetch; optional scBERT head).

### s42256-023-00627-3 — Metabolomic Profile Prediction from Microbial Composition
Microbiome Metabolomics. 3 instances → `predictions.csv` (metabolites×samples), metric **mean SCC** vs **mNODE** (ibd 0.287, CF 0.49, soil 0.33; MiMeNet 0.191). Method: **neural-ODE** (torchdiffeq) taxa→metabolite regression (ref code is Julia). GPU low/CPU·12 MB. **Do-well Med** (trivial data; straightforward PyTorch reimpl; but weak/high-variance metric on 65 test samples makes exact parity finicky). **aose No.** **Add:** microbiome↔metabolome regression skill (CLR preprocessing + neural-ODE).

### s42256-024-00836-4 — RNA Sequence Analysis
RNA Bioinformatics. 3 instances: ncRNA `predictions.csv` (macro-F1) + 2 structure `{name}.bpseq` (base-pair F1) vs **RNAErnie/+** (cls 0.96; struct 0.85–0.88; UFold 0.81–0.85). Method: **RNA language model finetune** (cls) + **deep secondary-structure predictor** (contact-map head). **GPU high**·~20 MB (weights public, Paddle stack). **Do-well High** (cls Medium via RNA-FM/RNAErnie; **structure half is the hard part** — UFold/MXfold2 ~0.81–0.85 below SOTA). **aose No.** **Add:** RNA-LM skill (RNA-FM/RNAErnie finetune) + RNA secondary-structure module (UFold/MXfold2 + bpseq writer).

### s42256-025-01003-z ⛔ — DNA Sequence Reconstruction from Noisy Reads (NON-omics)
**Computer Science / DNA data storage** — coding theory. Produce `predictions.txt` (reconstructed seqs), metric **failure rate** vs **DNAformer** (5.5e-5 … 0.16). Method: transformer trace reconstruction + pilot error simulation + consensus. GPU low·3.3 GB. **Do-well High-VHigh** (failure rates extremely tight). **aose No.** **Exclude from omics scope** — pure coding-theory/ML, no biology.

### s42256-025-01016-8 — Disease-Specific Variant Effect Prediction
Genomics (clinical VEP). 6 instances → `predictions.npy` pathogenicity scores, metric **AUPR** vs **DYNA** (0.87–0.95; MFASS 0.097). Method: **frozen ESM1b (protein) / GPN (DNA) embeddings + Siamese/MLP head**. GPU low·284 MB. **Do-well Med ✓** (standard reproducible recipe; public HF ESM1b/GPN; MFASS near-SOTA easy). **aose No.** **Add:** sequence-FM VEP module (ESM/GPN embedding + PLLR + Siamese pathogenicity head; wt/mut pairs, two-step transfer).

### s43588-024-00689-2 — Multimodal scRNA-seq Cell Clustering
Single-Cell (spliced+unspliced). 4 instances → `predictions.npy` labels (K given), metric **ARI** vs **meK-means** (0.99/0.98/0.58/0.69; **scVI-KMeans beats on 2/4**). Method: **joint embedding of spliced+unspliced HVGs → KMeans/Leiden** (or mechanistic EM). **CPU**·79 MB. **Do-well Low-Med ✓ (most tractable)** (cl3/cl5 near-trivial via scanpy PCA+KMeans; SOTA beaten by scVI-KMeans on 2/4). **aose Core.** **Add:** small aose recipe — spliced+unspliced (RNA-velocity-layer) multimodal clustering (loom bimodal load → joint latent → forced-K).

### s43588-024-00698-1 — Genetic Perturbation Outcome Prediction
Functional Genomics (Perturb-seq, multi-task). 7 instances → `predictions.npz` (level1/2/3: DEG score/direction/FC), metric **ROC-AUC subtask1** vs **scGPT+STAMP** (0.78–0.92; GEARS 0.51–0.62). Method: **multi-task per-gene head over pre-supplied scGPT/ontology embeddings**. GPU low·1.3 GB. **Do-well Med-High** (embeddings supplied → scope = bespoke multi-task head + flatten-metric protocol; weak GEARS baseline; matching every instance harder). **aose No/Prep.** **Add:** perturbation-outcome predictor (perturbation-embedding → 3-level DEG/direction/FC heads, DEG-masked loss).

### s43588-024-00765-7 — Single-Cell Phenotype Prediction
Single-Cell. `predictions.csv` (cell_id,tissue,cell_type) 22,206 rows, metric macro-**F1** vs **PolyGene 512** (Tissue 0.86 / CellType 0.75; scGPT 512 = 0.60/0.44). Method: supervised classification (tokenized transformer, OR classic/DL classifier on 2,432 HVGs + metadata). GPU low/CPU·213 MB. **Do-well Med** (**weak scGPT baseline** → classic/DL classifier competitive; tissue easier than 160-class cell-type macro-F1). **aose Prep+ (partial Core).** **Add:** supervised single-cell annotation skill (tissue+cell-type classifiers; vocab-constrained output).

### s43588-025-00878-7 — Noncoding Variant Effect on Gene Expression
Genomic Regulation (GTEx eQTL + ATAC). 4 distance bins → `predictions.csv` (direction + slope), metric **AUC** vs **EMO-zeroshot** (avg 0.82; small 0.92 → huge 0.70). Method: **long-range DNA-sequence + ATAC model** (≤1 Mb context, multi-task cls+reg). GPU (huge bin heavy)·**16 GB · ~30 h/epoch**. **Do-well High-VHigh** (1 Mb modeling; huge bin compute; recent 2025 method). **aose No.** **Add:** regulatory-variant seq-to-function module (long-range DNA+ATAC encoder, per-bin models, direction+slope heads).

---

## 4. Appendix

**Compute tiers (task-set):** cpu (3) = s41592-022-01709-7, s41592-025-02870-5, s43588-024-00689-2 · gpu_high (4) = s41592-024-02523-z, s41551-025-01528-z, s41592-025-02854-5, s42256-024-00836-4 · gpu_low (24) = rest. Local box = 2×H100 80 GB (covers all GPU tiers); binding constraint is usually data/wall-clock.

**aose current skills (single-cell/spatial scverse, ANALYSIS only):** omics-shared, rna, spatial, scatac-seq, multi-omics. Core-relevant NatureBench tasks: label transfer (023-02035-2), atlas mapping (022-00518-z), annotation (022-00534-z), multimodal clustering (00689-2), spatial domain ID (024-02257-y), trajectory (025-02870-5), phenotype (00765-7, partial). All others: preprocessing-only or no help.

**Escape hatches (baseline ≈/beats SOTA — score >0 without the SOTA method):** deepstarr CNN > NT (024-02523-z) · Borzoi > scooby eQTL (025-02854-5) · scVI-KMeans > meK-means 2/4 (00689-2) · scANVI > scPoli lung (023-02035-2) · `cmemit` direct sampling (023-02148-8) · Iterative ≈ DNAformer on Illumina (025-01003-z).

**Non-omics to exclude:** s42256-025-01003-z (DNA data storage / coding theory).
