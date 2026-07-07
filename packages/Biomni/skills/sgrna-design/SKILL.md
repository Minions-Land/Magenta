---
name: sgrna-design
description: >
  Comprehensive guide for CRISPR sgRNA design using a three-tiered approach:
  validated sequences (300+ from Addgene), CRISPick computational designs, or
  de novo design tools. Covers Cas9, Cas12a, and other CRISPR systems with
  experimental validation data and citation guidelines.
tags:
- CRISPR
- sgRNA
- gene-editing
- Cas9
- Cas12a
source: Biomni
license: CC-BY-4.0
metadata:
  display-name: sgRNA Design Guide
  authors: Biomni Team (Stanford SNAP Lab)
  version: "1.0"
  last-updated: "2025-11"
  commercial-use: allowed
---

# sgRNA Design Guide: Three-Tiered Approach

A comprehensive guide for finding or designing sgRNAs using validated sequences, CRISPick datasets, or de novo design tools.

## Overview

This guide provides a three-tiered approach to sgRNA design, prioritizing validated sequences before moving to computational predictions. Always start with Option 1 and proceed to subsequent options only if needed.

## Three-Tier Strategy

### Tier 1: Validated sgRNA Sequences (Recommended First)

**Database**: 300+ experimentally validated sgRNA sequences from Addgene

**When to use**:
- Gene has been targeted before in published studies
- You need high confidence in sgRNA efficacy
- Experimental validation is available

**Method**:
1. Search Biomni's curated database: `biomni/know_how/resource/addgene_grna_sequences.csv`
2. Search Addgene directly: https://www.addgene.org/crispr/reference/grna-sequence/
3. Filter by:
   - Target gene
   - CRISPR system (SpCas9, SaCas9, Cas12a)
   - Species
   - Experimental evidence

**Citation**: Always cite the original publication (PubMed ID provided in database)

### Tier 2: CRISPick Computational Designs

**Tool**: CRISPick from Broad Institute GPP

**When to use**:
- No validated sgRNAs available for your gene
- Need multiple sgRNA options
- Want predicted efficacy scores

**Method**:
1. Visit: https://portals.broadinstitute.org/gppx/crispick/public
2. Enter:
   - Gene symbol or Ensembl ID
   - Species
   - CRISPR system (SpCas9, SaCas9, AsCas12a, enAsCas12a)
3. Review predictions:
   - On-target score (efficacy)
   - Off-target score (specificity)
   - Pick rank (combined score)

**Citations**:
- **Cas9**: Sanson KR, et al. Nat Commun. 2018;9(1):5416. PMID: 30575746
- **Cas12a**: DeWeirdt PC, et al. Nat Biotechnol. 2021;39(1):94-104. PMID: 32661438

**Acknowledgment**: "Guide designs provided by the CRISPick web tool of the GPP at the Broad Institute"

### Tier 3: De Novo Design Tools

**When to use**:
- Gene not in CRISPick database
- Need custom PAM sequences
- Want alternative design algorithms

**Tools**:
1. **CHOPCHOP** (https://chopchop.cbu.uib.no/)
   - Multiple organisms
   - Various CRISPR systems
   - Off-target analysis

2. **Benchling CRISPR Tool** (https://www.benchling.com/crispr)
   - Integrated with sequence design
   - Collaborative features
   - Free academic use

3. **CCTop** (https://crispr.cos.uni-heidelberg.de/)
   - Focus on off-target prediction
   - Multiple genomes
   - Batch design

4. **sgRNA Scorer 2.0**
   - Machine learning predictions
   - Azimuth algorithm
   - High accuracy

## Key Design Principles

### 1. Target Selection
- **Location**: Exons near 5' end for knockout
- **PAM sequence**: NGG for SpCas9, TTTV for Cas12a
- **GC content**: 40-60% optimal
- **Avoid**: Poly-T tracts (4+ Ts), repetitive sequences

### 2. Specificity
- **Off-targets**: < 3 mismatches to other genomic sites
- **Seed region**: Especially important (12 bp adjacent to PAM)
- **Check**: Whole genome alignment

### 3. Efficiency
- **Activity scores**: Use CRISPick or Azimuth predictions
- **Validation**: Test 3-4 sgRNAs per target
- **Controls**: Non-targeting sgRNA, validated positive control

## Experimental Validation

### Essential Tests
1. **Editing efficiency**: T7E1 or Sanger sequencing
2. **Off-target effects**: Targeted deep sequencing of predicted sites
3. **Functional validation**: Protein knockout by Western blot

### Recommended Controls
- Non-targeting sgRNA (scrambled sequence)
- Positive control (known effective sgRNA)
- Mock transfection (no sgRNA)

## Common CRISPR Systems

| System | PAM | Targeting Range | Notes |
|--------|-----|-----------------|-------|
| SpCas9 | NGG | 20 bp | Most common, extensive data |
| SaCas9 | NNGRRT | 21 bp | Smaller size, AAV compatible |
| AsCas12a | TTTV | 23 bp | T-rich PAM, 5' overhang |
| enAsCas12a | TTTV | 23 bp | Enhanced activity vs AsCas12a |

## Resources

### Databases
- **Addgene**: https://www.addgene.org/crispr/
- **CRISPick**: https://portals.broadinstitute.org/gppx/crispick/
- **Biomni curated**: `biomni/know_how/resource/addgene_grna_sequences.csv`

### Design Tools
- **CHOPCHOP**: https://chopchop.cbu.uib.no/
- **Benchling**: https://www.benchling.com/crispr
- **CCTop**: https://crispr.cos.uni-heidelberg.de/

### Guidelines
- **Broad GPP**: https://portals.broadinstitute.org/gpp/public/
- **Addgene protocols**: https://www.addgene.org/protocols/

## Citation Guidelines

### Using Validated sgRNAs
- Cite original publication (check PubMed ID in database)
- Acknowledge: "Validated sgRNA sequences obtained from Addgene"

### Using CRISPick
- Cite appropriate paper (see Tier 2 above)
- Acknowledge: "Guide designs provided by CRISPick"

### Using Biomni
- Cite: Biomni paper (bioRxiv 2025.05.30.656746v1)
- License: CC BY 4.0

## Tips for Success

1. **Start with validated**: Always check Tier 1 first
2. **Design multiple**: Test 3-4 sgRNAs per target
3. **Check off-targets**: Use genome-wide analysis
4. **Validate experimentally**: Don't rely solely on predictions
5. **Document thoroughly**: Record all design choices
6. **Share results**: Contribute validated sgRNAs to community

## Troubleshooting

**Low editing efficiency**:
- Try different sgRNAs (target different sites)
- Optimize transfection/transduction
- Check Cas protein expression
- Verify PAM sequence

**High off-target effects**:
- Use higher specificity sgRNAs (better scores)
- Consider paired nickases or dCas9-FokI
- Reduce Cas9 expression time
- Use truncated sgRNAs (17-18 bp)

**No suitable sgRNAs**:
- Try different CRISPR systems (different PAMs)
- Consider base editors or prime editors
- Target alternative exons
- Use homology-directed repair for precision

## See Also

- [Biomni single-cell-annotation](../single-cell-annotation/SKILL.md) - For post-editing analysis
- [Biomni molecular biology tools](../../tools/molecular-biology/) - For cloning sgRNA vectors
- Addgene CRISPR guide: https://www.addgene.org/crispr/guide/
