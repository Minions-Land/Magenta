# Reference — Histone Mark Interpretation

Biological meaning of common histone modifications and how to interpret differential ChIP-seq signal.

## The core marks

| Mark | Location | Meaning | Peak shape |
|------|----------|---------|------------|
| **H3K4me3** | Promoters (TSS) | Active/poised promoter | Narrow, sharp |
| **H3K4me1** | Enhancers | Enhancer (primed) | Broad-ish |
| **H3K27ac** | Active enhancers + promoters | Active regulatory element | Narrow |
| **H3K27me3** | Polycomb domains | Repressed (developmental) | Broad domains |
| **H3K9me3** | Heterochromatin | Constitutive repression | Broad domains |
| **H3K36me3** | Gene bodies | Active transcription (elongation) | Broad over gene |

## Combinatorial logic (chromatin states)

Marks combine to define regulatory states (ChromHMM-style):

- **Active promoter**: H3K4me3 + H3K27ac
- **Active enhancer**: H3K4me1 + H3K27ac
- **Primed/poised enhancer**: H3K4me1 alone (no H3K27ac)
- **Bivalent promoter**: H3K4me3 + H3K27me3 (poised developmental genes)
- **Repressed**: H3K27me3 (Polycomb) or H3K9me3 (heterochromatin)
- **Transcribed gene body**: H3K36me3

## Interpreting differential signal

- **↑ H3K4me3 at a promoter** → gene activation
- **↓ H3K27ac at an enhancer** → enhancer decommissioning (e.g., after differentiation or drug)
- **↑ H3K27me3 over a locus** → Polycomb-mediated silencing
- **Gain of bivalency** → poising for later activation/repression

Always interpret in the mark's biological context — the same log2FC means opposite things for an activating (H3K27ac) vs repressive (H3K27me3) mark.

## Peak-calling mode by mark

- **Narrow** (MACS2 default): H3K4me3, H3K27ac, TF ChIP, ATAC
- **Broad** (MACS2 --broad): H3K27me3, H3K9me3, H3K36me3

Broad marks form domains, not sharp peaks; narrow-mode calling fragments them.

## ATAC-seq accessibility

ATAC-seq measures open chromatin (all regulatory elements at once), not a specific mark:
- Peaks at promoters (constitutive) + enhancers (cell-type-specific)
- Differential accessibility = regulatory activity change
- Combine with H3K27ac to distinguish active enhancers from merely-open regions

## QC by mark

- **H3K4me3**: sharp TSS enrichment; check the TSS enrichment score
- **H3K27me3/H3K9me3**: broad; low FRiP is expected (signal spread over domains)
- **H3K27ac**: should overlap H3K4me1 at enhancers

## Pitfalls

- **Treating H3K27me3 as active** — it's repressive; ↑ = silencing
- **Wrong peak mode** — broad marks called narrow gives fragmented, incorrect peaks
- **Ignoring combinatorics** — H3K4me1 alone ≠ active; needs H3K27ac
- **Comparing marks on the same scale** — activating and repressive marks have opposite semantics
- **ATAC ≠ a specific mark** — it's global accessibility; pair with ChIP for element identity

## Grounding

`report`: mark identity, biological interpretation of the direction of change, peak mode used, relevant combinatorial context (co-marks checked), TSS enrichment / FRiP QC.
