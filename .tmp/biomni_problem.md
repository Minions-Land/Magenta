# BiomniBench-DA — per-task skill requirements & capability gaps for Magenta / AutOmicScience (aose)

> What each of the 50 BiomniBench-DA tasks actually requires, whether a **bare generalist Magenta**
> can clear the 0.7 pass line without a domain skill, whether **AutOmicScience (aose)** already covers
> it, and **what capability to add**. Ordered by task id.
>
> - Date: 2026-07-05 · Method: 5 parallel agents read each task's `instruction.md` + `tests/rubric.txt`
>   + `task.toml` + the omicos gpt-5.5 baseline `grade.json` (`final_text` = which specialist omicos's
>   router picked; `grader_notes` + per-criterion scores = what a strong run did/missed).
> - Signals per task: **omicos specialist** (empirical "what skill this needs"), **rubric methodology**
>   (what a correct answer must do), **omicos score** (how hard even a domain specialist found it).

---

## 1. Executive summary — the capability roadmap

**Coverage reality:** aose's 5 shipped skills are **all single-cell / spatial (scverse)**:
`omics-shared, rna, spatial, scatac-seq, multi-omics`. Against the 50 BiomniBench-DA tasks:

| Bucket | ~count | Meaning |
|---|---:|---|
| **Generalist already clears ≥0.7** (no new skill) | **~16–19** | Generic tabular/stats: correlation, ANOVA, Fisher+FDR, KM/Cox via lifelines, ORA via gseapy, hierarchical clustering, precomputed-DE table parsing. Magenta-as-generalist should pass these. |
| **aose already covers (single-cell modality)** | **~2 full + ~5 partial** | Only da-17-1, da-17-5 fully; da-1-3/1-4/4-1/11-1/17-3 are in-modality but need a **method extension** (Ro/e, consensus-NMF, cell-cell communication, pseudobulk DE). |
| **Needs a NEW domain skill aose lacks** | **~25–30** | Everything below. |

**Highest-leverage skills to add (ranked by #tasks × difficulty-without-skill):**

| Rank | Skill to add (maps to omicos specialist) | Tasks it unlocks | # |
|---|---|---|---:|
| **1** | **Bulk RNA-seq** — count DE (DESeq2/edgeR/limma-voom + shrinkage), TMM/VST/logCPM normalization, covariate design, GSEA/ORA (MSigDB Hallmark, gseapy prerank), WGCNA co-expression, pseudobulk, GEO/GEOparse, DRUG-seq/Cuffdiff outputs (`bulk_rna_analyst`) | da-6-2, 12-2, 14-8, 15-1, 15-2, 15-7, 15-8, 16-1, 17-3, 19-1, 20-1, 20-3, 20-4 | **~13** |
| **2** | **Cancer / tabular genomics** — MAF+CNA (cBioPortal/MSK-IMPACT), Variant_Classification/CGC pathogenicity, per-patient gene recurrence, protein-domain/hotspot filtering (`Protein_position`), pathway alteration gene-sets, mutation×phenotype Fisher+FDR, oncoplots (`tabular_genomics_analyst`/`variant_analyst`) | da-3-4, 3-5, 18-1, 18-5, 18-7, 25-1 | **~6** |
| **3** | **Proteomics (plasma Olink / MS)** — NPX QC (PASS/WARN/FAIL, LOD), paired within-subject DE, MaxQuant/Perseus log2-ratio tables, cross-cohort hypergeometric enrichment (defined universe), directional concordance, effect-size ranking (`proteomics_analyst_pro`) | da-13-1, 13-3, 13-5, 13-6, 15-8, (5-3 phospho) | **~5–6** |
| **4** | **Cancer dependency / DepMap** — CCLE/DepMap CRISPR, Pharos druggability tiers, pan-essentiality/therapeutic window, **normLRT** selective dependency, synthetic-lethality (mutual-exclusivity/UNCOVER + paralog/PPI priors) (`cancer_dependency_analyst`) | da-5-1, 5-3, 26-2, 26-4 | **~4** |
| **5** | **Bulk epigenomics** — ChIP-seq/ATAC-seq peaks (narrowPeak/BAM, bedtools merge/multicov), CPM differential occupancy/accessibility, TSS/promoter feature annotation, TF-anchored enhancer calling (`bulk_epigenomics_analyst`) | da-19-3, 19-4, 19-6 | **3** |
| **6** | **Single-cell extensions to `rna`** — cell-cell communication (LIANA/CellChat/CellPhoneDB), Ro/e tissue-enrichment, consensus-NMF, pseudobulk-DESeq2 + ORA, differential-abundance (donor-level, pseudoreplication guard) | da-1-3, 4-1, 11-1, 17-3 | **4** |
| **7** | **Metabolomics / lipidomics + clinical metabolic phenotyping** — DE+mediation, LIPID MAPS class nomenclature, IR indices (DI/SSPG/HOMA-IR), acylcarnitine/β-cell biology (`metabolomics_analyst_pro`) | da-8-1, 8-2, 8-3 | **3** |
| **8** | **Survival analysis** — KM/log-rank/Cox PH, HR/CI, censoring, immortal-time bias (`clinical_translator_pro`); mostly generalist-reachable via lifelines | da-4-6, 9-1, 12-4 | **3** |
| **9** | **Phase separation / LLPS biophysics** — IDR handling, LLPS predictors (PScore/PLAAC/catGRANULE/FuzDrop), sticker-spacer/prion-like composition, MLO dataset taxonomy (`phase_separation_analyst`) | da-10-1, 10-3 | **2** |
| **10** | **Statistical genetics** — GWAS summary-stat meta-analysis (inverse-variance/Z), MAF/locus handling, **colocalization** (R `coloc`/`coloc.abf`, sdY/varbeta, PP.H4) (`statistical_genetics_analyst`) | da-24-3 | **1** (hardest; least generalist-reachable) |
| **11** | **Immune repertoire (TCR/BCR)** — paired-chain clonotype definition, public/expanded-clonotype discovery, TCR-T translational biology (`immune_repertoire_analyst_pro`) | da-4-7 | **1** |

**Reading of the omicos advantage:** its router sent 50 tasks across **~12 distinct specialists** (top: `tabular_genomics_analyst` ~11, `bulk_rna_analyst` ~8, `proteomics_analyst_pro` ~4, `cancer_dependency_analyst` ~4). Magenta-as-generalist lacks that domain library entirely, so it (a) clears the generic-stats tasks but (b) loses the domain-convention criteria (exactly the da-10-1 pattern: right stats, wrong domain framing). Two skills — **bulk RNA-seq** and **cancer/tabular genomics** — alone cover ~19 tasks and are the highest-ROI additions.

> Caveat: many losses are partly "rubric-strict" (the rubric prescribes a methodology the instruction
> doesn't state — see BiomniBench's own failure-case docs). A domain skill helps by encoding those
> conventions; it does not fix the ~4 documented benchmark-broken tasks (da-6-2, da-12-4, da-18-7, da-20-1).

---

## 2. Master table (ordered by task)

Legend — **Gen≥0.7?** = can a strong *bare* Magenta pass without a domain skill (Y / ~ partial / N).
**aose?** = AutOmicScience currently covers (Y / ~ partial / N). **omicos** = specialist its router picked.

| Task | Modality | task_type / diff | omicos specialist | Gen≥0.7? | aose? | Capability to add |
|---|---|---|---|:--:|:--:|---|
| da-1-3 | scRNA composition / TME (CRC) | cell-composition / easy | single_cell_preprocessor | ~ | ~ | scRNA Ro/e tissue-enrichment + TME annotation (extend `rna`) |
| da-1-4 | scRNA comp → outcome corr | association-testing / easy | tabular_genomics_analyst | Y | ~ | none (generalist stats) |
| da-3-4 | WES TMB vs response | mutation-analysis / easy | tabular_genomics_analyst | Y | N | none (generalist) |
| da-3-5 | somatic-mutation enrichment (BRCA2) | mutation-analysis / med | tabular_genomics_analyst | ~ | N | cancer/tabular genomics (MAF, per-patient recurrence, Fisher+FDR, HRD) |
| da-4-1 | scRNA → consensus-NMF (NSCLC TIME) | clustering / easy | tabular_genomics_analyst | ~ | ~ | consensus-NMF (cophenetic) + TIME interpretation |
| da-4-6 | survival RFS (Texp) | survival-analysis / med | tabular_genomics_analyst | ~ | N | survival analysis (KM/log-rank/Cox, censoring) |
| da-4-7 | TCR repertoire → TCR-T | tcr-repertoire / hard | immune_repertoire_analyst_pro | ~ | N | immune-repertoire/TCR clonotype + TCR-T |
| da-5-1 | druggable-target prioritization (PDAC) | multi-omic-integration / med | cancer_dependency_analyst | ~ | N | cancer-dependency/druggability (DepMap + Pharos) |
| da-5-3 | activating phosphosites + dependency | multi-omic-integration / easy | cancer_dependency_analyst | ~ | N | cancer-dependency + phosphoproteomics |
| da-6-2 | bulk RNA temporal DE (sex-strat) ⚠ | longitudinal-analysis / hard | bulk_rna_analyst | ~ | N | bulk-RNA temporal encoding (real miss = spec adherence; **broken task**) |
| da-6-5 | bulk multi-omic set-similarity | multi-omic-integration / med | tabular_genomics_analyst | Y | N | none (generalist set-ops) |
| da-8-1 | metabolomics assoc (SBP) | association-testing / easy | metabolomics_analyst_pro | Y | N | none (opt HMDB/KEGG lookup) |
| da-8-2 | clinical IR × preload ANOVA | association-testing / med | tabular_genomics_analyst | ~ | N | clinical metabolic phenotyping (IR indices DI/SSPG) |
| da-8-3 | lipidomics DE + mediation | differential-expression / med | metabolomics_analyst_pro | ~/N | N | metabolomics/lipidomics DE+mediation (lipid classes, β-cell biology) |
| da-9-1 | survival KM/log-rank (CyTOF) | survival-analysis / med | tabular_genomics_analyst | Y~ | N | survival analysis (+ CyTOF marker interp.) |
| da-9-7 | multi-platform correlation (CyTOF/Olink) | association-testing / med | (generalist) | Y | N | none (Spearman + per-family FDR) |
| da-10-1 | phase separation (AA comp + predictors) | predictive-modeling / easy | phase_separation_analyst | ~ | N | phase-separation/LLPS biophysics |
| da-10-3 | phase separation / MLO benchmarking | predictive-modeling / easy | phase_separation_analyst | ~ | N | phase-separation + MLO dataset taxonomy |
| da-11-1 | scRNA cell-cell communication (celiac) | cell-cell-communication / easy | cellchat_rust_h5ad_runner | ~/N | ~ | **cell-cell communication** (LIANA/CellChat) — extend `rna` |
| da-12-2 | bulk RNA ORA (Hallmark G2M) | pathway-enrichment / med | bulk_rna_analyst | Y | N | none (opt ORA background convention) |
| da-12-4 | Cox survival (tumor microbiome) ⚠ | survival-analysis / med | tabular_genomics_analyst | Y | N | survival (Cox) — light; **broken task** |
| da-13-1 | Olink paired DE (GAHT) | differential-expression / easy | proteomics_analyst_pro | ~ | N | proteomics-DE (Olink NPX QC, paired, set-overlap) |
| da-13-3 | Olink assoc (effect-size rank) | association-testing / easy | proteomics_analyst_pro | Y | N | none (opt effect-size ranking + adipokine biology) |
| da-13-5 | proteomics cross-cohort enrichment | cross-cohort-comparison / med | proteomics_analyst_pro | ~ | N | proteomics enrichment (hypergeometric+universe, top-N, direction) |
| da-13-6 | proteomics concordance (GAHT vs MHT) | cross-cohort-comparison / med | proteomics_analyst_pro | Y~ | N | proteomics cross-cohort (shared w/ 13-5) |
| da-14-1 | correlation + hierarchical clustering | clustering / easy | tabular_genomics_analyst | Y | N | none |
| da-14-3 | z-score thresholds → proportions | association-testing / med | tabular_genomics_analyst | Y | N | none |
| da-14-8 | within-set co-expression coherence | association-testing / med | bulk_rna_analyst | Y | N | none (opt bulk co-expression module) |
| da-15-1 | bulk RNA DE (ALS spinal cord) | differential-expression / easy | bulk_rna_analyst | ~ | N | bulk RNA DE (DESeq2/edgeR/limma-voom) |
| da-15-2 | bulk RNA WGCNA (ALS) | co-expression-networks / med | bulk_rna_analyst | ~ | N | bulk RNA WGCNA (soft-power, signed TOM, eigengenes) |
| da-15-7 | bulk RNA continuous-trait DE (ALS) | association-testing / med | bulk_rna_analyst | ~ | N | bulk RNA DE/association (limma-voom, covariates) |
| da-15-8 | RNA+proteome+CSF concordance | multi-omic-integration / med | bulk_rna_analyst | ~ | N | proteomics + multi-omic concordance integration |
| da-16-1 | bulk RNA clustering (NAFLD subtypes) | clustering / easy | bulk_rna_analyst | ~ | N | bulk RNA normalization (VST/TMM) + GEO ingestion |
| da-17-1 | scRNA differential abundance (SLE) | cell-composition / med | single_cell_preprocessor | ~ | **Y** | none new (opt diff-abundance recipe) |
| da-17-3 | scRNA pseudobulk DE + ISG ORA (SLE) | differential-expression / easy | bulk_rna_analyst | ~/N | ~ | pseudobulk-DESeq2 + ORA (extend `rna`) |
| da-17-5 | scRNA composition, ancestry-strat | cell-composition / easy | tabular_genomics_analyst | Y | **Y** | none |
| da-18-1 | cancer genomics MAF+CNA landscape | mutation-analysis / easy | tabular_genomics_analyst | ~/Y | N | cancer/tabular genomics (cBioPortal MAF+CNA) |
| da-18-5 | MAPK pathway alteration freq | mutation-analysis / hard | tabular_genomics_analyst | ~ | N | cancer genomics + pathway alteration gene-sets |
| da-18-7 | ESR1-LBD × MAPK exclusivity ⚠ | mutation-analysis / med | tabular_genomics_analyst | ~/N | N | cancer genomics + hotspot filtering; **broken task** |
| da-19-1 | bulk RNA Cuffdiff parse (AML) | differential-expression / easy | bulk_rna_analyst | Y | N | minor (bulk DE-output conventions) |
| da-19-3 | bulk ChIP-seq diff occupancy (RUNX1) | chromatin-profiling / med | bulk_epigenomics_analyst | ~ | N | bulk epigenomics ChIP-seq |
| da-19-4 | H3K27ac diff + MYC enhancers | chromatin-profiling / hard | bulk_epigenomics_analyst | N | N | bulk epigenomics enhancer analysis (TF-anchored) |
| da-19-6 | bulk ATAC-seq diff accessibility | chromatin-profiling / med | bulk_epigenomics_analyst | ~ | N | bulk epigenomics ATAC (≠ aose's single-cell ATAC) |
| da-20-1 | bulk DRUG-seq clustering ⚠ | clustering / hard | bulk_rna_analyst | ~ | ~ | bulk/DRUG-seq normalization+clustering; **broken task** |
| da-20-3 | bulk RNA GSEA (BFA Hallmark) | pathway-enrichment / med | bulk_rna_analyst | ~ | ~ | GSEA/MSigDB prerank convention |
| da-20-4 | bulk RNA count DE + GSEA (dabrafenib) | pathway-enrichment / hard | bulk_rna_analyst | N | N | bulk RNA count DE (+shrinkage) + GSEA + BRAF/MAPK biology |
| da-24-3 | GWAS meta-analysis + coloc | gwas-eqtl / hard | statistical_genetics_analyst | N | N | statistical genetics (meta + `coloc.abf`) — **least generalist-reachable** |
| da-25-1 | TCGA PRAD MAF ranking + stage | mutation-analysis / med | tabular_genomics_analyst | ~/Y | N | tabular/mutation genomics (MAF, thin) |
| da-26-2 | DepMap normLRT biomarkers (BRCA) | predictive-modeling / hard | cancer_dependency_analyst | N~ | N | cancer dependency (normLRT + druggability) |
| da-26-4 | synthetic-lethality (BRCA) | predictive-modeling / hard | cancer_dependency_analyst | N | N | cancer dependency / synthetic lethality (ME + paralog/PPI) |

⚠ = one of BiomniBench's 4 documented benchmark-broken/rubric-defect tasks (excluded from the capability mean).

---

## 3. Per-task detail

*(Each entry: domain · rubric methodology · unique skill · omicos specialist · generalist-sufficiency · aose coverage · capability to add.)*

### da-1-3 — Tumor-specific enriched cell subsets across compartments (CRC anti-PD-1)
scRNA cell-composition. **Rubric:** Ro/e enrichment (observed/expected via chi² or sampling-normalized proportion FC) at SubCellType granularity on baseline cells, triple-filter (Tumor>1 & Normal<1 & Blood<1), annotate expected hits (Mph_SPP1, Fibro_FAP, Endo_COL4A1, CD8_Tex_LAYN). **Skill:** scRNA compositional tissue-enrichment (Ro/e) + TME immunology. **omicos:** single_cell_preprocessor. **Gen:** Partial (stats reachable; TME interp caps top band). **aose:** Partial. **Add:** Ro/e + TME annotation module (extends `rna`).

### da-1-4 — Baseline subtype proportions vs tumor regression ratio
scRNA composition → patient-level correlation. **Rubric:** baseline filter → patient×subtype proportions → per-subtype Pearson/Spearman with rare-cell/zero-variance filtering → hot/cold interpretation. **Skill:** generic tabular correlation + immuno-onc interp. **omicos:** tabular_genomics_analyst. **Gen:** Yes. **aose:** Partial. **Add:** none.

### da-3-4 — Tumor mutational load vs anti-PD-1 response (melanoma WES)
Tabular WES summary. **Rubric:** load S1B, `TotalNonSyn` vs `Response`, two-sided Mann-Whitney + median/IQR, TMB-immunotherapy framing. **Skill:** basic biostats + TMB context. **omicos:** tabular_genomics_analyst (0.89). **Gen:** Yes. **aose:** No. **Add:** none.

### da-3-5 — Gene-level mutation enrichment, responders vs non (BRCA2)
Somatic mutation genomics. **Rubric:** irRECIST→R/NR, aggregate per-mutation → per-patient per-gene recurrence (avoid hypermutator overcount), per-gene Fisher 2×2 + BH, BRCA2 enrichment, HRD/neoantigen interp. **Skill:** somatic-mutation enrichment (MAF, per-patient recurrence). **omicos:** tabular_genomics_analyst. **Gen:** Partial. **aose:** No. **Add:** cancer/somatic-mutation skill.

### da-4-1 — NMF patient classification by immune composition (NSCLC)
scRNA composition → consensus NMF. **Rubric:** patient×subtype matrix, NMF rank sweep ≥5 inits, consensus/connectivity + cophenetic/silhouette stability, rank on stability+biology, W modules/H assignment, TIME (hot/cold/myeloid-resistance) vs MPR. **Skill:** consensus-NMF stability + TIME immunology. **omicos:** tabular_genomics_analyst. **Gen:** Partial (consensus-NMF is a non-obvious workflow). **aose:** Partial. **Add:** consensus-NMF module + TIME interp.

### da-4-6 — Survival stratification of non-MPR by Texp (RFS)
Survival analysis. **Rubric:** RFS with explicit censoring, within-non-MPR median split, KM 3-group + pairwise log-rank, Cox HR/95%CI, immortal-time-bias caveat. **Skill:** survival (KM/log-rank/Cox) + exhausted-T biology. **omicos:** tabular_genomics_analyst (0.93). **Gen:** Partial (lifelines reachable; censoring/bias are the lift). **aose:** No. **Add:** survival-analysis skill.

### da-4-7 — Public expanded-Tex TCR clonotypes for TCR-T (NSCLC)
Immune repertoire (paired scTCR). **Rubric:** subset expanded_terminal_Tex; clonotype = paired TRA+TRB CDR3+V+J (NOT patient IDs); per-patient ≥10-cell; public = shared ≥2 patients; paired candidate table; MPR/pCR prioritization; TCR-T rationale (HLA, antigen, safety). **Skill:** TCR clonotype analysis + TCR-T translational. **omicos:** immune_repertoire_analyst_pro. **Gen:** Partial (clonotype rigor + biology specialized). **aose:** No. **Add:** immune-repertoire skill.

### da-5-1 — PDAC druggable-target prioritization
Cancer dependency + proteogenomics. **Rubric:** filter dual-evidence PDAC flag, merge Pharos tiers on Ensembl, tier stratification (T1/T2 repurposing-ready), pan-essential split for therapeutic window, rank by multi-cancer validation, surface MET/ERBB2/ATIC/GART/SRC… with PDAC pathway biology. **Skill:** cancer-dependency/druggability. **omicos:** cancer_dependency_analyst. **Gen:** Partial. **aose:** No. **Add:** cancer-dependency/druggability skill.

### da-5-3 — Activating phosphosites w/ upregulation + dependency (CPTAC)
Phosphoproteomics + dependency. **Rubric:** load S4A+S2A, joint upregulation+dependency per-cancer flag, filter ActivatingSite==1 + druggable, melt to phosphosite×cancer, tier + drug annotation (TOP2A/HDAC1/EGFR/XPO1), multi-cancer breadth, PD-biomarker interp. **Skill:** phosphoproteomics + druggability. **omicos:** cancer_dependency_analyst. **Gen:** Partial (explicit brief lifts mechanics). **aose:** No. **Add:** cancer-dependency + phosphoproteomics.

### da-6-2 ⚠ — Sex-stratified temporal directional patterns (SKM-VL, MoTrPAC)
Bulk RNA DE (precomputed) — temporal encoding. **Rubric:** restrict TRNSCRPT×SKM-VL, require significance at ALL 4 timepoints/sex, 4-char Up/Down state string (|logFC|>0.2), mutually-exclusive shared vs sex-specific, rank by count, oxphos/hormonal interp. **Skill:** bulk-RNA temporal-pattern encoding (mechanics generic). **omicos:** bulk_rna_analyst (0.35 — failed). **Gen:** Partial — **real miss is analytical-convention inference (broken task)**, not omics domain. **aose:** No. **Add:** bulk-RNA DE + temporal encoding (secondary).

### da-6-5 — Cross-tissue coordination of endurance-training multi-omics (MoTrPAC)
Bulk multi-omic DE tables. **Rubric:** per-(tissue,assay) training-regulated sets at q<0.05, dedup across sex/tp, per-assay tissue×tissue Jaccard/overlap, require ≥3 shared assays, aggregate without transcriptomics dominating, exercise-physiology interp. **Skill:** multi-omic set-similarity (generic). **omicos:** tabular_genomics_analyst (1.0). **Gen:** Yes. **aose:** No. **Add:** none.

### da-8-1 — Hypertension metabolites vs systolic BP in bread-spikers
Targeted metabolomics + CGM + clinical. **Rubric:** CGM baseline + peak-delta per subject-rep, exclude mitigated meals, avg replicates, median-split bread-spikers, per-metabolite OLS `SBP ~ metabolite + Age + BMI`, filter p<0.05 & coef>0. **Skill:** metabolomics association + covariate adjustment (generic OLS). **omicos:** metabolomics_analyst_pro (1.0). **Gen:** Yes. **aose:** No. **Add:** none (opt metabolite lookup).

### da-8-2 — Insulin-resistance × preload interaction on rice glucose
CGM + clinical metabolic physiology. **Rubric:** classify IR by **Disposition Index primary (SSPG fallback)**, median-split, per-condition peak-glucose delta, per-subject Fiber−Protein reduction, two-way ANOVA condition×IR, partial η² + Cohen. **Skill:** clinical IR-index knowledge (DI/SSPG/HOMA) + ANOVA. **omicos:** tabular_genomics_analyst (0.9, used SSPG-only). **Gen:** Partial. **aose:** No. **Add:** clinical metabolic-phenotyping knowledge.

### da-8-3 — Mediating lipid species between potato/grape-spikers
Metabolomics + lipidomics + clinical. **Rubric:** per-food median-split, per-subject aggregation, DE (t/MWU + log2FC), top-10, **identify lipid species by class (AC/CAR, PC/LPC, TAG, CE)**, correlate top-10 vs **4 phenotypes (SSPG, Hepatic IR, DI, IE)**, integrate DE+corr → "mediating", BH-FDR, acylcarnitine/β-cell biology. **Skill:** lipidomics DE + mediation + nomenclature. **omicos:** metabolomics_analyst_pro (**0.68 — even specialist failed** the phenotype-correlation integration). **Gen:** Partial/No. **aose:** No. **Add:** metabolomics/lipidomics DE+mediation skill.

### da-9-1 — Baseline T-cell biomarkers of survival under PD-1 (PRINCE)
CyTOF frequencies + survival. **Rubric:** pivot long→wide, baseline C1D1 + arm A1 + %leuk scale, per-feature median split + **KM + log-rank (lifelines)** on OS, identify 4 significant pops (NKT, Tbet+, Tbet+TCRgd+, Ki-67+), call HLA-DR+ non-sig, PD-1 biology. **Skill:** survival + CyTOF immunophenotyping. **omicos:** tabular_genomics_analyst (0.83). **Gen:** Yes (borderline). **aose:** No. **Add:** survival skill (+CyTOF interp).

### da-9-7 — CyTOF frequency vs Olink protein correlation (PRINCE C2D1)
Cross-platform CyTOF+Olink. **Rubric:** harmonize to C2D1, pivot wide, match ~73 patients, 3×4=12 pairs, **Spearman** pooled + per-arm, **BH-FDR per family**, report pooled-null + Arm-C2 hit (HLA-DR+CD4 vs IFN-γ ρ≈−0.63). **Skill:** multi-platform correlation + FDR scoping (generic). **omicos:** generalist (0.76). **Gen:** Yes. **aose:** No. **Add:** none.

### da-10-1 — Amino-acid composition & phase-separation predictor eval
Protein biophysics / LLPS. **Rubric:** leakage-free SaPS/PdPS/NoPS(+human), **pooled** 20-AA freq, fold-change vs NoPS, property/IDR-propensity ordering, extract IDR segments (1-based incl.), replicate on human, **ROC-AUC per predictor separately SaPS-vs-NoPS & PdPS-vs-NoPS**, aromatic-sticker/prion-like interp. **Skill:** phase-separation / protein-sequence biophysics. **omicos:** phase_separation_analyst (0.94). **Gen:** Partial (AA/ROC generic; ordering+biophysics need domain). **aose:** No. **Add:** phase-separation/LLPS skill.

### da-10-3 — PS-predictor screening: MLO participants vs membrane controls
Phase separation / MLO proteomics. **Rubric:** separate MLO datasets (OpenCell/G3BP1/PhaSepDB/DACT1) vs membrane-bound (mito), fixed hNoPS background, labels w/ overlap removal, per-predictor NaN handling, ROC-AUC per dataset×predictor, group aggregation + MLO-vs-control test. **Skill:** phase-separation/MLO + ROC (generic). **omicos:** phase_separation_analyst (1.0). **Gen:** Partial (only dataset taxonomy is domain). **aose:** No. **Add:** phase-separation + MLO taxonomy.

### da-11-1 — KIR+CD8 → gliadin-CD4 cell-cell communication (celiac scRNA)
scRNA + cell-cell communication. **Rubric:** load matrices + QC, normalize→HVG→PCA→neighbors→UMAP→Leiden, marker-score CD8/CD4/KIR/cytotoxic/activation, threshold KIR+CD8 & gliadin-CD4, **directional LR analysis (LIANA/CellChat/CellPhoneDB) excl MHC-I + permutation stats**, pathway aggregation. **Skill:** scRNA preprocessing + cell-cell communication. **omicos:** cellchat_rust_h5ad_runner (0.94, LIANA). **Gen:** Partial/No (CCC core = 40 pts needs tooling). **aose:** Partial (preprocessing yes, **no CCC**). **Add:** cell-cell communication skill (extends `rna`).

### da-12-2 — G2M-checkpoint ORA among shared DEGs (LUAD)
Bulk RNA ORA. **Rubric:** parse split-header TS7, extract 'v'-flagged shared DEGs (~1543), **ORA (Fisher/hypergeometric) vs MSigDB Hallmark (49)** + BH, report G2M 37/200 p≈1.7e-5 FDR≈2.8e-4 rank 3 → YES. **Skill:** bulk ORA (GMT, Fisher, background). **omicos:** bulk_rna_analyst (0.82). **Gen:** Yes. **aose:** No (gseapy generic). **Add:** none (opt background convention).

### da-12-4 ⚠ — Kocuria poor-prognosis Cox survival (tumor microbiome)
Tabular microbiome + clinical survival. **Rubric:** matched microbiome×survival cohort, **univariate Cox per taxon** (HR+p), rule HR>1 & p<0.05, confirm Kocuria HR≈1.012 p≈0.023. **Skill:** survival (Cox). **omicos:** tabular_genomics_analyst (0.86). **Gen:** Yes. **aose:** No. **Add:** survival (light); **broken task**.

### da-13-1 — Plasma Olink proteins altered by feminizing GAHT
Plasma proteomics (Olink NPX). **Rubric:** long NPX log2, QC PASS/WARN/FAIL, LOD/missingness, avg duplicate assays, reshape sample×protein, **paired** test 6mo-vs-baseline per regimen + BH, per-regimen CPA/SPIRO unique/shared **set ops**. **Skill:** Olink paired DE + set-overlap. **omicos:** proteomics_analyst_pro (0.72, dropped set-overlap). **Gen:** Partial. **aose:** No. **Add:** proteomics-DE (Olink) skill.

### da-13-3 — Proteins correlating with body-composition change
Plasma proteomics (precomputed MLM). **Rubric:** parse 2-row-header CSV, filter adj p<0.05 per trait, **rank by |estimate|** (not p), adipokine biology (LEP, fat∩breast overlap). **Skill:** effect-size ranking + adipokine interp. **omicos:** proteomics_analyst_pro (0.64 — ranked by p not |estimate|). **Gen:** Yes (mechanically). **aose:** No. **Add:** none (opt heuristic).

### da-13-5 — Overlap of GAHT-altered vs sex-associated proteins
Proteomics cross-cohort enrichment. **Rubric:** **top 100** by Sex_log10_p, GAHT∩top-100 per regimen, **hypergeometric with correct universe** (M=UKB table), **directional concordance** (GAHT vs Beta_females toward cis-female). **Skill:** set-enrichment (hypergeometric+universe) + direction. **omicos:** proteomics_analyst_pro (0.5 — used full set not top-100). **Gen:** Partial. **aose:** No. **Add:** proteomics cross-cohort enrichment.

### da-13-6 — GAHT vs menopause/MHT concordance
Proteomics cross-cohort direction. **Rubric:** filter GAHT-sig per regimen, join MHT selecting among age-stratified estimates (most sig), sign concordance count, concordance %, named discordant (CXCL13, NOS3) + hormone-axis. **Skill:** sign-concordance + hormone biology. **omicos:** proteomics_analyst_pro (0.9). **Gen:** Yes/Partial. **aose:** No. **Add:** proteomics cross-cohort (shared).

### da-14-1 — Correlation clustering of sepsis endotype scores
Tabular immunology scores. **Rubric:** full **Spearman** matrix (~21 scores), **hierarchical clustering on 1−corr** + justified linkage, symmetric reorder, cluster ID (inflammatory vs protective), restrained interp + limitations. **Skill:** generic multivariate stats. **omicos:** tabular_genomics_analyst (1.0). **Gen:** Yes. **aose:** No (not needed). **Add:** none.

### da-14-3 — Proportion per immune-dysregulation subgroup
Tabular immunology. **Rubric:** 4 mutually-exclusive subgroups from myeloid/lymphoid **z-scores (z≥1.65)**, handle negatives, exact per-subgroup proportions. **Skill:** z-score thresholding + proportions. **omicos:** tabular_genomics_analyst (1.0). **Gen:** Yes. **aose:** No. **Add:** none.

### da-14-8 — Within-set co-expression coherence of modules
Bulk gene-expression correlation. **Rubric:** derive sets (top ~50 by correlation with score), **within-set pairwise Spearman** (excl diagonal), mean within-set r (myeloid≈0.36, lymphoid≈0.64), **flag low-coherence genes (mean r<0.2)**, module interp. **Skill:** co-expression coherence (bulk idea) + Spearman. **omicos:** bulk_rna_analyst (0.73). **Gen:** Yes. **aose:** No. **Add:** none (opt bulk co-expression).

### da-15-1 — ALS vs control DE, cervical spinal cord
Bulk RNA-seq DE. **Rubric:** DE model disease-primary, **covariate adjustment** (sex/age/RIN/prep/site/genotype PCs), **RNA-seq normalization + variance modeling (limma-voom/DESeq2/edgeR)**, FDR, log2FC ranking. **Skill:** bulk RNA DE (NB/voom + design). **omicos:** bulk_rna_analyst (0.87, capped at B for OLS-on-CPM). **Gen:** Partial. **aose:** No. **Add:** bulk RNA DE skill.

### da-15-2 — WGCNA co-expression modules in ALS
Bulk RNA co-expression. **Rubric:** ALS-only, TMM+voom + batch/covariate QC, **WGCNA** (soft-power ~8, signed adjacency, TOM, ~24 modules, eigengenes), **cell-type marker enrichment Fisher+FDR** (astro/micro/oligo/neuron). **Skill:** WGCNA + marker enrichment. **omicos:** bulk_rna_analyst (0.9). **Gen:** Partial. **aose:** No. **Add:** bulk RNA WGCNA skill.

### da-15-7 — Genes correlating with ALS disease duration
Bulk RNA-seq continuous-trait. **Rubric:** voom+limma continuous `disease_duration`, TPM low-expr filter, quantile+TMM, covariate battery (sex, rin, rin², pct_mrna_bases, prep, site, gPC1-5), eBayes, BH, Spearman validation → CHIT1. **Skill:** bulk RNA DE/association (limma-voom). **omicos:** bulk_rna_analyst (0.8). **Gen:** Partial. **aose:** No. **Add:** bulk RNA DE/association.

### da-15-8 — Triple-concordant CSF biomarkers (RNA + tissue + CSF proteome)
Bulk RNA DE + shotgun proteomics. **Rubric:** parse 2 MaxQuant Excel (title/header rows, log2 ratio, `10^-logp`), upregulated + CSF FDR<0.05, drop `;`-multi-gene, 3-way join positive in all, **rank by product of |effect sizes|**, surface GPNMB/SERPINA3, note CHIT1 absence. **Skill:** proteomics tables + cross-modality concordance. **omicos:** bulk_rna_analyst (0.7). **Gen:** Partial. **aose:** No. **Add:** proteomics + multi-omic concordance.

### da-16-1 — NAFLD molecular subtypes by clustering (hepatic bulk RNA)
Bulk RNA clustering. **Rubric:** gene×sample matrix (drop HTSeq summary rows), GEO SOFT parse (GEOparse), exclude controls, **count-appropriate VST/TMM-logCPM/voom** + low-expr filter, PCA + Ward clustering (report PCs/metric/linkage/k via silhouette), clusters vs clinical (Kruskal/χ²) + correction, trial-enrichment interp. **Skill:** bulk RNA normalization + GEO (clustering generic). **omicos:** bulk_rna_analyst (0.93). **Gen:** Partial. **aose:** No. **Add:** bulk RNA normalization + GEO ingestion.

### da-17-1 — Altered immune-cell frequencies in SLE (scRNA PBMC)
scRNA differential abundance. **Rubric:** load 12GB AnnData, use `author_cell_type` (11), **per-donor %** (avoid pseudoreplication), ≥10-cell filter, donor-level Wilcoxon/MWU + BH, report 8 altered types + directions. **Skill:** AnnData/scanpy + diff-abundance stats. **omicos:** single_cell_preprocessor (0.78). **Gen:** Partial. **aose:** **Yes** (rna/omics-shared wheelhouse). **Add:** none new (opt diff-abundance recipe).

### da-17-3 — DE genes in SLE classical monocytes + ISG enrichment
scRNA → pseudobulk DE. **Rubric:** filter cM, **sum raw counts per donor** (261 pseudobulk), **count-based DE (DESeq2/PyDESeq2/edgeR)** `|log2FC|>0.5 & FDR<0.05`, 25-gene ISG signature, **formal ORA (Fisher/hypergeometric)**. **Skill:** pseudobulk DE + enrichment. **omicos:** bulk_rna_analyst (0.65 — used OLS-on-CPM, skipped cutoff). **Gen:** Partial/No. **aose:** Partial. **Add:** pseudobulk-DESeq2 + ORA (extend `rna`).

### da-17-5 — Ancestry-specific SLE immune changes
scRNA composition, stratified. **Rubric:** `self_reported_ethnicity`, per-group donor counts, per-donor proportions ancestry×disease, within-ancestry MWU + FDR, **between-ancestry interaction test** (diff-in-diff p≈1e-4) → CD4 loss stronger in Asians. **Skill:** composition extraction + stratified stats (generic). **omicos:** tabular_genomics_analyst (1.0). **Gen:** Yes. **aose:** **Yes**. **Add:** none.

### da-18-1 — Genomic landscape across BC receptor subtypes (MSK-IMPACT)
Cancer genomics MAF+CNA. **Rubric:** parse cBioPortal (4 comment rows), HR/HER2 → 4 subtypes, TMB median/IQR (Kruskal), per-subtype driver freq (PIK3CA/GATA3/TP53), **separate ERBB2 mutation vs amplification** via CNA (−2..2), subtype biology. **Skill:** cancer/tabular genomics (MAF+CNA oncoprint). **omicos:** tabular_genomics_analyst (0.9). **Gen:** Partial/Yes (format spelled out). **aose:** No. **Add:** cancer/tabular genomics skill.

### da-18-5 — Cumulative MAPK alteration freq in endocrine-resistant BC
Cancer genomics pathway aggregation. **Rubric:** HR+/HER2- naive vs post-therapy, **specific MAPK gene set + per-gene rules** (ERBB2/KRAS/HRAS/BRAF/MAP2K1/ERBB3 mut + NF1 LoF + EGFR amp), union of altered, freq per stratum incl ESR1-WT, Fisher exclusivity with ESR1. **Skill:** cancer genomics + pathway alteration gene-sets. **omicos:** tabular_genomics_analyst (0.74). **Gen:** Partial. **aose:** No. **Add:** cancer genomics + pathway sets.

### da-18-7 ⚠ — ESR1-LBD vs MAPK mutual exclusivity
Cancer genomics exclusivity. **Rubric:** post-therapy HR+/HER2- metastatic, ESR1-LBD by **AA position 300-550** (Y537S/N, D538G via Protein_position), 7-gene MAPK (+NF1 del, +EGFR amp), 2×2, **one-sided** Fisher. **Skill:** cancer genomics + protein-domain/hotspot filtering + directional exclusivity. **omicos:** tabular_genomics_analyst (0.62 — ignored LBD restriction, two-sided). **Gen:** Partial/No. **aose:** No. **Add:** cancer genomics + hotspot filtering; **broken task**.

### da-19-1 — Top downregulated genes on AI-10-49 in inv(16) AML (Cuffdiff)
Bulk RNA DE (precomputed Cuffdiff). **Rubric:** verify contrast orientation (sample_1=DMSO), apply status==OK, log2FC<=-1, q<0.01 (~716), rank by |log2FC|, handle inf-FC (value_2=0), place MYC (log2FC≈-3.30, ~#4) + CBFβ-SMMHC/MYC interp. **Skill:** bulk RNA DE-output (Cuffdiff) — light. **omicos:** bulk_rna_analyst (0.72). **Gen:** Yes. **aose:** No. **Add:** minor (DE-output conventions).

### da-19-3 — RUNX1 ChIP-seq differential occupancy
Bulk ChIP-seq. **Rubric:** symmetric interval comparison (bedtools merge + condition labels) → gained/lost/unchanged, GTF feature annotation with precedence (promoter ±2kb TSS > exon > intron > intergenic), Fisher enrichment gained vs unchanged. **Skill:** bulk ChIP-seq peak diff + TSS annotation. **omicos:** bulk_epigenomics_analyst. **Gen:** Partial. **aose:** No. **Add:** bulk epigenomics ChIP-seq.

### da-19-4 — H3K27ac reduced regions + MYC ME1/ME2/BDME enhancers
Bulk ChIP-seq H3K27ac. **Rubric:** union-interval BAM counting + CPM, one-sided depletion + BH + log2FC≤−1 + min-coverage; AND ME1/ME2/BDME enhancer anchors from RUNX1 peaks in distance bands downstream of MYC (~0.1-0.3/0.4-0.7/1.5-2.0 Mb) + per-enhancer calls. **Skill:** bulk epigenomics H3K27ac + MYC-enhancer domain. **omicos:** bulk_epigenomics_analyst (0.65 — 0 on enhancer half). **Gen:** No. **aose:** No. **Add:** bulk epigenomics enhancer analysis.

### da-19-6 — Global chromatin accessibility change (ATAC) under AI-10-49
Bulk ATAC-seq. **Rubric:** consensus peaks (bedtools merge), per-sample coverage (multicov on filtered BAMs), CPM, condition-avg log2FC, increased/decreased counts, n=2 + DiffBind/DESeq2 caveat. **Skill:** bulk ATAC differential accessibility. **omicos:** bulk_epigenomics_analyst (0.87). **Gen:** Partial. **aose:** No (has *single-cell* ATAC, different toolchain). **Add:** bulk epigenomics ATAC.

### da-20-1 ⚠ — Baseline transcriptional clustering of 4 primary cell types (DRUG-seq)
Bulk 3'-UMI RNA-seq. **Rubric:** DMSO at percent_volume_dmso==0.0625 (→192 subset), logCPM, top ~10k variance genes, TruncatedSVD (sparse), K-means k=4 + cross-tab, lineage markers (ACTA2/TAGLN AoSMC, DCN/LUM fibro, PMEL/MLANA melanocyte) + AoSMC-SkMM shared-mesenchymal interp. **Skill:** bulk/DRUG-seq normalization+clustering + marker biology. **omicos:** bulk_rna_analyst (0.46 — wrong DMSO %, 5k HVG, dense PCA). **Gen:** Partial. **aose:** Partial. **Add:** bulk/DRUG-seq skill; **broken task**.

### da-20-3 — Hallmark pathways suppressed by Brefeldin-A (GSEA)
Bulk RNA GSEA. **Rubric:** pre-ranked GSEA (gseapy.prerank/fgsea) vs MSigDB Hallmark, rank by **log2FoldChange** desc, all 24 lists, extract TNFA/APOPTOSIS/INFLAMMATORY NES+padj, neg-NES padj<0.05 rule + 9.5nM caveat. **Skill:** pre-ranked GSEA + Hallmark. **omicos:** bulk_rna_analyst (0.68 — ranked by signed-z not log2FC). **Gen:** Partial. **aose:** Partial (gseapy generic). **Add:** GSEA/MSigDB convention.

### da-20-4 — Dabrafenib cross-cell-type transcriptional divergence
Bulk RNA count DE + GSEA. **Rubric:** count DE (DESeq2/PyDESeq2/edgeR + apeglm/ashr shrinkage), volume-matched DMSO, 24 tables, GSEA by shrunken log2FC vs Hallmark, interpret KRAS_SIGNALING_UP (cell-type suppression vs paradox), EMT (dose), MYOGENESIS, melanocyte BRAF-inhibition tied to BRAF/MAPK. **Skill:** count DE (shrinkage) + GSEA + BRAF/MAPK biology. **omicos:** bulk_rna_analyst (0.28 — Welch t-test, no shrinkage). **Gen:** No. **aose:** No. **Add:** bulk RNA count DE + GSEA.

### da-24-3 — Shared genetic factors across neonatal metabolites (GWAS + coloc)
Statistical genetics. **Rubric:** inverse-variance fixed-effects meta (weighted beta, Z p), sample-size-weighted AF→MAF, locus windowing, GW-sig + discovery/replication direction consistency, multi-phenotype loci, pairwise **coloc.abf** (R coloc; pvalues/beta/varbeta/snp/MAF/sdY) + PP.H0-H4. **Skill:** GWAS meta + Bayesian colocalization. **omicos:** statistical_genetics_analyst (0.6 — dropped sdY/direction). **Gen:** No (coloc deeply package-specific). **aose:** No. **Add:** statistical-genetics skill. **Least generalist-reachable of all 50.**

### da-25-1 — TCGA PRAD pathogenic mutation ranking + T-stage (MAF)
Tabular/mutation genomics. **Rubric:** MAF lacks pathogenicity → oncogenic proxy (non-silent Variant_Classification ∪ CGC/MutSig genes), patient-level freq ranking (TP53, SPOP), T-stage cleaning (drop NA/Discrepancy, collapse T1-T4, PATH>CLIN), Fisher mutation×stage (≥5 patients) + BH, oncoplot. **Skill:** MAF parsing + variant classification + association. **omicos:** tabular_genomics_analyst (0.78). **Gen:** Partial/Yes. **aose:** No. **Add:** tabular/mutation genomics (thin).

### da-26-2 — Patient-specific dependency biomarkers in BRCA (DepMap)
Cancer dependency. **Rubric:** **normLRT** (normal vs skew-normal) selective-dependency classification in both cohorts, sum-of-squared-deviations w/ NA, druggable-gene (TTD) integration, patient-vs-cell-line comparison, BRCA filter, surface **PTPN11**. **Skill:** DepMap normLRT + druggability. **omicos:** cancer_dependency_analyst (0.71 — missed druggable + PTPN11). **Gen:** No (borderline). **aose:** No. **Add:** cancer-dependency (DepMap) skill.

### da-26-4 — Synthetic-lethal partner discovery for BRCA
Cancer dependency / synthetic lethality. **Rubric:** LassoCV feature→dependency, dual-threshold (|coef|+FDR), iterative/greedy mutual-exclusivity (UNCOVER), permutation ME significance, paralog ID (Ensembl/biomaRt/HCOP + identity filter), STRING PPI + prevalence + literature, canonical BRCA SL pairs (HSP90AA1/AB1, HDAC1/2), observed-vs-expected co-occurrence. **Skill:** synthetic-lethality (ME + paralog/PPI priors). **omicos:** cancer_dependency_analyst (0.78 — missed canonical pairs). **Gen:** No. **aose:** No. **Add:** cancer-dependency / synthetic-lethality skill.

---

## 4. Appendix

**AutOmicScience (aose) current skills:** `omics-shared` (scverse foundations), `rna` (single-cell RNA-seq QC/integration/clustering/markers), `spatial` (spatial transcriptomics), `scatac-seq` (single-cell ATAC), `multi-omics` (single-cell multiome RNA+ATAC). All single-cell/spatial.

**omicos specialist roster (20):** bulk_rna_analyst, single_cell_preprocessor, single_cell_annotator_pro, cellchat_rust_h5ad_runner, spatial_omics_orchestrator, metabolomics_analyst_pro, proteomics_analyst_pro, microbiome_analyst_pro, variant_analyst, tabular_genomics_analyst, statistical_genetics_analyst, phase_separation_analyst, bulk_epigenomics_analyst, single_cell_epigenomics_analyst, chromatin_3d_analyst, cancer_dependency_analyst, immune_repertoire_analyst_pro, phylogenomics_analyst, clinical_translator_pro, scientific_writer.

**omicos gpt-5.5 routing frequency (parsed):** tabular_genomics_analyst ~11 · bulk_rna_analyst ~8 · proteomics_analyst_pro 4 · cancer_dependency_analyst 4 · single_cell_preprocessor 2 · phase_separation_analyst 2 · bulk_epigenomics_analyst 2 · metabolomics_analyst_pro / immune_repertoire_analyst_pro / cellchat / statistical_genetics_analyst 1 each · (remainder generalist/unrouted).
