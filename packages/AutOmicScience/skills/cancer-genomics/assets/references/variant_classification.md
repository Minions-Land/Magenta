# Reference — Variant Classification & Pathogenicity

Which somatic mutations count as "pathogenic" or "functional" vs benign/silent. Critical for gene recurrence, TMB, and association tests.

## The classification problem

A MAF contains all called variants: missense, nonsense, silent, intronic, UTR. Only a subset are cancer-relevant (driver-like). Classification rules filter to the functional set.

## Standard pathogenic classes

From `Variant_Classification` column (MAF):

| Class | Pathogenic? | Rationale |
|-------|-------------|-----------|
| **Nonsense_Mutation** | ✅ Yes | Premature stop → LoF |
| **Frame_Shift_Del** | ✅ Yes | Frameshift → LoF |
| **Frame_Shift_Ins** | ✅ Yes | Frameshift → LoF |
| **Splice_Site** | ✅ Yes | Disrupts splicing → LoF |
| **Missense_Mutation** | ⚠️ Conditional | Activating or LoF depending on gene + position |
| **In_Frame_Del** | ⚠️ Conditional | Functional if in known domain |
| **In_Frame_Ins** | ⚠️ Conditional | Functional if in known domain |
| **Silent** | ❌ No | Synonymous, no AA change |
| **Intron** | ❌ No | Non-coding (unless splice-site) |
| **3'UTR**, **5'UTR**, **IGR** | ❌ No | Regulatory (outside CDS) |
| **Translation_Start_Site** | ⚠️ Rare | LoF if gene is TSG |

**Baseline filter** (exclude silent/non-coding):
```python
pathogenic = maf[maf.Variant_Classification.isin([
    "Missense_Mutation", "Nonsense_Mutation", "Frame_Shift_Del", 
    "Frame_Shift_Ins", "Splice_Site", "In_Frame_Del", "In_Frame_Ins"
])]
```

## Cancer Gene Census (CGC) tiers

For **missense** and **in-frame indels**, apply gene-context rules:

| Gene role | Pathogenic rule | Example |
|-----------|-----------------|---------|
| **Oncogene** (CGC Tier 1, dominant) | Activating missense in known hotspot | KRAS p.G12*, BRAF p.V600E, PIK3CA p.E545K/H1047R |
| **Tumor suppressor** (CGC Tier 1, recessive) | Any LoF (nonsense/frameshift/splice); missense if known inactivating | TP53 any LoF or DNA-binding-domain missense; NF1 any LoF |
| **Fusion** (CGC Tier 1) | Translocation/in-frame fusion | ALK, RET, NTRK — requires SV data, not SNV MAF |
| **CGC Tier 2** | Known cancer gene, weaker evidence | Treat as Tier 1 if mutated |

**Recipe:**
```python
cgc_oncogenes = ["KRAS", "BRAF", "PIK3CA", "EGFR", "ERBB2", "MYC", "HRAS", "NRAS", ...]
cgc_tsg = ["TP53", "PTEN", "RB1", "APC", "NF1", "CDKN2A", "VHL", "STK11", ...]

def is_pathogenic(row):
    gene = row.Hugo_Symbol
    vc = row.Variant_Classification
    # LoF classes are always pathogenic if gene is in CGC
    if vc in ["Nonsense_Mutation", "Frame_Shift_Del", "Frame_Shift_Ins", "Splice_Site"]:
        return gene in (cgc_oncogenes + cgc_tsg)
    # Missense: check hotspot or TSG
    if vc == "Missense_Mutation":
        if gene in cgc_tsg:
            return True  # any missense in TSG can be inactivating
        if gene in cgc_oncogenes:
            # only hotspot missense (check COSMIC or protein position)
            return is_hotspot(gene, row.Protein_position)
    # In-frame indels: functional if in known domain
    if vc in ["In_Frame_Del", "In_Frame_Ins"]:
        return gene in (cgc_oncogenes + cgc_tsg)
    return False

maf["pathogenic"] = maf.apply(is_pathogenic, axis=1)
```

## Hotspot identification (for oncogenes)

A hotspot = recurrent protein position. KRAS p.G12 (any substitution), BRAF p.V600E, PIK3CA p.E545K/H1047R are classic.

**Simple heuristic:**
```python
# Extract integer position from HGVSp_Short (e.g., "p.G12V" → 12)
maf["aa_pos"] = maf.HGVSp_Short.str.extract(r"p\.[A-Z](\d+)").astype(float)

# Hotspot = position mutated in ≥3 samples
hotspots = maf.groupby(["Hugo_Symbol", "aa_pos"]).size()
hotspots = hotspots[hotspots >= 3]
```

Or use **COSMIC hotspot catalog** (download from COSMIC, filter to count ≥10).

## Protein-domain filtering

Some tasks (e.g., da-18-7 ESR1 LBD) restrict to a specific domain:

```python
# ESR1 ligand-binding domain: AA 300–550
esr1_lbd_mut = maf[
    (maf.Hugo_Symbol == "ESR1") &
    (maf.aa_pos >= 300) &
    (maf.aa_pos <= 550)
]
```

Document which domain + coordinates (from UniProt or literature).

## When things go wrong

- **All missense counted** → inflates recurrence for oncogenes (only hotspots are functional)
- **LoF in oncogene treated as driver** → oncogene LoF is usually passenger; only hotspot missense matters
- **Silent mutations in TMB** → TMB should count only pathogenic variants
- **No minimum recurrence for hotspot** → singleton positions are noise; use ≥3 samples

## Sources
- Cancer Gene Census: cancer.sanger.ac.uk/census
- COSMIC hotspots: cancer.sanger.ac.uk/cosmic
- ClinVar: ncbi.nlm.nih.gov/clinvar
