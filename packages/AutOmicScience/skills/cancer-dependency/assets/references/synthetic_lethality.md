# Reference — Synthetic Lethality Discovery

Synthetic lethality (SL): two genes where loss of either alone is tolerated, but loss of both is lethal. The basis for targeted therapies like PARP inhibitors in BRCA-mutant cancers.

## The concept

- Gene A alone knocked out → cell survives
- Gene B alone knocked out → cell survives
- Both A and B knocked out → cell dies

**Therapeutic exploitation:** if a tumor has lost gene A (mutation/deletion), drugging its SL partner B selectively kills the tumor while sparing normal cells (which retain A).

**Canonical example:** BRCA1/2-mutant tumors are dependent on PARP1 (DNA repair backup). PARP inhibitors (olaparib) exploit this.

## Detection strategy 1: mutual exclusivity

If A and B are SL partners, tumors rarely lose both (double loss is lethal) → their alterations are **mutually exclusive**:

```python
from scipy.stats import fisher_exact

def mutual_exclusivity(gene_a, gene_b, altered):
    a = altered[gene_a].astype(bool)
    b = altered[gene_b].astype(bool)
    both = (a & b).sum()
    only_a = (a & ~b).sum()
    only_b = (~a & b).sum()
    neither = (~a & ~b).sum()
    # One-sided: fewer double-altered than expected → exclusivity
    odds, p = fisher_exact([[both, only_a], [only_b, neither]], alternative="less")
    return {"pair": (gene_a, gene_b), "both": both, "odds": odds, "p": p}
```

**One-sided test** (`alternative="less"`): SL predicts *depletion* of the double-altered class. A two-sided test dilutes the directional signal.

## Detection strategy 2: dependency conditioned on genotype

Using DepMap: is gene B a stronger dependency in cell lines that have lost gene A?

```python
from scipy.stats import mannwhitneyu

def conditional_dependency(gene_b, gene_a_mutant_lines, gene_a_wt_lines):
    # gene B effect in A-mutant vs A-WT lines
    b_in_mut = gene_effect.loc[gene_b, gene_a_mutant_lines].dropna()
    b_in_wt = gene_effect.loc[gene_b, gene_a_wt_lines].dropna()
    # One-sided: B MORE dependent (lower effect) in A-mutant lines
    stat, p = mannwhitneyu(b_in_mut, b_in_wt, alternative="less")
    delta = b_in_mut.mean() - b_in_wt.mean()   # negative = B more essential in A-mutant
    return {"partner": gene_b, "delta": delta, "p": p}
```

This is the direct functional-genomics test for SL.

## Priors: paralogs

Paralogs (duplicated genes with redundant function) are enriched for SL — losing one is buffered by the other. Paralog SL pairs: they compensate for each other:

```python
# Ensembl BioMart paralog table, or use a curated list
# Filter to paralogs with high sequence identity (>30%)
paralog_pairs = pd.read_csv("ensembl_paralogs.csv")
paralog_pairs = paralog_pairs[paralog_pairs.identity > 0.3]

# Canonical paralog SL: MAGOH/MAGOHB, ARID1A/ARID1B, SMARCA2/SMARCA4, ...
```

## Priors: protein-protein interaction (STRING)

SL partners often function in the same complex/pathway. STRING PPI as a prior:

```python
import requests
# STRING API for interaction partners
def string_partners(gene, species=9606, min_score=700):
    r = requests.get(
        "https://string-db.org/api/tsv/interaction_partners",
        params={"identifiers": gene, "species": species, "required_score": min_score},
        timeout=30,
    )
    return [line.split("\t")[3] for line in r.text.strip().split("\n")[1:]]
```

High-confidence PPI (score > 700) partners of a mutated gene are SL candidates.

## Canonical SL pairs (curated)

Well-established SL relationships to check first:

```python
canonical_sl_pairs = {
    ("BRCA1", "PARP1"), ("BRCA2", "PARP1"),    # DNA repair (PARP inhibitors)
    ("SMARCA4", "SMARCA2"),                      # SWI/SNF paralogs
    ("ARID1A", "ARID1B"),                        # SWI/SNF paralogs
    ("VHL", "GLUT1"), ("VHL", "CDK6"),           # VHL-loss dependencies
    ("KRAS", "STK33"),                            # (historically claimed)
    ("MTAP", "PRMT5"),                            # MTAP-deletion → PRMT5 dependency
}
```

## Combining evidence

Rank SL candidates by combining:
1. Mutual-exclusivity p-value (patient tumor data)
2. Conditional-dependency p-value (DepMap functional data)
3. Paralog / PPI prior (mechanistic plausibility)

```python
candidates["is_canonical"] = candidates.pair.apply(
    lambda p: p in canonical_sl_pairs or p[::-1] in canonical_sl_pairs
)
candidates["is_paralog"] = candidates.pair.apply(lambda p: p in paralog_set)
# Prioritize: functional evidence + prior support
```

## Pitfalls

- **Two-sided test for exclusivity** — SL is directional (depletion of double-loss); use one-sided
- **Mutual exclusivity alone** — many exclusive pairs aren't SL (just different subtypes); confirm with functional dependency
- **Ignoring paralog buffering** — paralog pairs are the highest-yield SL class
- **No multiple-testing correction** — testing all pairs needs FDR
- **Confusing SL with co-dependency** — SL = loss of A makes B essential; co-dependency = both needed together

## Grounding

`report`: SL detection method(s), candidate pairs with mutual-exclusivity + conditional-dependency stats, prior support (paralog/PPI/canonical), FDR if many pairs tested.

## Sources
- Jerby-Arnon et al. (2014) — UNCOVER mutual-exclusivity algorithm
- Lord & Ashworth (2017) — PARP inhibitors / BRCA SL
- Dede et al. (2020) — paralog dependency in cancer
- STRING: string-db.org · Ensembl BioMart paralogs: ensembl.org/biomart
