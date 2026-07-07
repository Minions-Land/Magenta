# Reference — TSS Annotation & Genomic Feature Classification

Annotating peaks to genes and classifying them by genomic feature (promoter/exon/intron/intergenic) with a precedence rule.

## TSS extraction from GTF

The TSS is the transcript start — strand-dependent:

```python
import gtfparse
gtf = gtfparse.read_gtf("genes.gtf")
tx = gtf[gtf.feature == "transcript"].copy()
# + strand: TSS = start; - strand: TSS = end
tx["tss"] = tx.apply(lambda r: r.start if r.strand == "+" else r.end, axis=1)
```

## Nearest-gene annotation with signed distance

```python
import pyranges as pr
tss_gr = pr.PyRanges(chromosomes=tx.seqname, starts=tx.tss, ends=tx.tss+1,
                     strands=tx.strand)
tss_gr.gene_name = tx.gene_name.values

# Nearest TSS to each peak (signed distance respects strand)
annotated = peaks.nearest(tss_gr, how=None, suffix="_tss")
# Distance: negative = upstream of TSS, positive = downstream (relative to gene strand)
```

## Feature precedence rule

A peak may overlap multiple feature types. Standard precedence (ChIPseeker convention):

```
Promoter (TSS ±3kb) > 5'UTR > 3'UTR > Exon > Intron > Downstream > Distal Intergenic
```

```python
def classify_feature(peak, distance_to_tss, overlaps):
    if abs(distance_to_tss) <= 3000:
        return "Promoter"
    if overlaps.exon:
        return "Exon"
    if overlaps.intron:
        return "Intron"
    if abs(distance_to_tss) <= 10000:
        return "Proximal"
    return "Distal Intergenic"
```

Apply the **highest-priority** matching category, not all matches.

## ChIPseeker (R, gold standard)

```python
# Via rpy2: ChIPseeker::annotatePeak(peaks, TxDb=..., tssRegion=c(-3000, 3000))
# Returns per-peak annotation + feature distribution + distance-to-TSS plot
```

ChIPseeker's `annotatePeak` handles the precedence and gives publication-standard feature pie charts.

## Enrichment test (gained peaks in promoters)

Test whether differential peaks are enriched in a feature vs the background of all tested peaks:

```python
from scipy.stats import fisher_exact
# 2x2: (gained ∩ promoter, gained ∩ non-promoter, unchanged ∩ promoter, unchanged ∩ non-promoter)
table = [[gained_prom, gained_nonprom], [unchanged_prom, unchanged_nonprom]]
odds, p = fisher_exact(table, alternative="greater")
```

**Background universe = all tested peaks**, NOT the whole genome. Using the genome inflates enrichment.

## Distance bands

Report the full distribution, not just nearest:

```python
bands = pd.cut(annotated.distance_to_tss.abs(),
               bins=[0, 3000, 10000, 100000, np.inf],
               labels=["promoter", "proximal", "distal", "gene-desert"])
print(bands.value_counts())
```

## Pitfalls

- **Strand-unaware TSS** — using gene start for both strands mislabels − strand genes
- **All-matches instead of precedence** — a peak counted as both promoter AND intron
- **Whole-genome enrichment background** — inflates promoter enrichment; use tested peaks
- **Unsigned distance** — loses upstream vs downstream information
- **GTF 1-based vs BED 0-based** — coordinate systems differ; convert consistently

## Grounding

`report`: annotation method (ChIPseeker/pyranges), tssRegion definition, per-peak nearest gene + signed distance + feature class, feature distribution, enrichment test (Fisher, background = tested peaks) with odds + p.
