# Reference — Druggability Annotation (Pharos / TTD)

Annotating dependency targets with druggability tiers to prioritize actionable vulnerabilities.

## Pharos target-development levels (TDL)

Pharos (pharos.nih.gov, from the IDG program) classifies every protein into a development tier:

| Tier | Meaning | Actionability |
|------|---------|---------------|
| **Tclin** | Has approved drugs (known mechanism) | Highest — repurposing-ready |
| **Tchem** | Has potent small-molecule ligands (not yet approved) | High — chemical matter exists |
| **Tbio** | Biology known, no drug/ligand yet | Medium — needs discovery |
| **Tdark** | Understudied ("dark") protein | Low — no tools |

**Prioritization:** Tclin + Tchem = "druggable now" (T1/T2); Tbio = "druggable with effort"; Tdark = "not currently actionable."

## Fetching from Pharos (GraphQL API)

Pharos has a GraphQL endpoint:

```python
import requests

def pharos_tdl(gene_symbol):
    query = """
    query targetTDL($sym: String!) {
      target(q: {sym: $sym}) {
        sym
        tdl
      }
    }
    """
    r = requests.post(
        "https://pharos-api.ncats.io/graphql",
        json={"query": query, "variables": {"sym": gene_symbol}},
        timeout=30,
    )
    data = r.json()
    return data["data"]["target"]["tdl"] if data.get("data", {}).get("target") else None
```

**Batch note:** for many genes, download the bulk TCRD (Target Central Resource Database) dump rather than per-gene API calls. Magenta's network layer auto-probes proxies, but respect rate limits.

## TTD (Therapeutic Target Database)

TTD (db.idrblab.net/ttd) provides target-drug relationships:

```python
# Download the target-drug mapping file, then:
ttd = pd.read_csv("ttd_target_drug.txt", sep="\t")
# Columns: Target_ID, Gene, Drug_Name, Highest_Status (Approved/Clinical Trial/...)
druggable_targets = set(ttd[ttd.Highest_Status == "Approved"].Gene)
```

## Combining dependency + druggability

The therapeutic-window prioritization:

```python
# 1. Selective dependencies (from dependency_analysis.md)
selective_deps = [...]

# 2. Annotate with Pharos tier
tdl_map = {g: pharos_tdl(g) for g in selective_deps}

# 3. Prioritize
actionable = pd.DataFrame({
    "gene": selective_deps,
    "dependency_freq": [dep_freq[g] for g in selective_deps],
    "tdl": [tdl_map[g] for g in selective_deps],
})
# Tier 1: Tclin/Tchem + selectively dependent
priority = actionable[
    actionable.tdl.isin(["Tclin", "Tchem"])
].sort_values("dependency_freq", ascending=False)
```

## Interpreting the priority list

A gene that is:
- **Selectively dependent** (essential in this cancer) AND
- **Tclin** (has an approved drug)

→ is a **drug-repurposing candidate** (existing drug, new indication). This is the highest-value finding.

A **Tdark** selective dependency is a novel biology lead but not immediately actionable.

## Pitfalls

- **Ignoring the tier** — a strong dependency in a Tdark gene isn't immediately druggable
- **Treating Tbio as druggable** — biology is known but no chemical matter yet
- **Per-gene API for 1000s of genes** — use the bulk TCRD download; respect rate limits
- **Stale TTD status** — drug approval status changes; note the download date
- **Not distinguishing "has drug" from "drug hits this cancer"** — an approved drug for target X may not be indicated for this tumor type

## Grounding

`report`: druggability source (Pharos TDL version / TTD date), tier distribution of candidates, prioritized list with gene + dependency frequency + tier + (if any) approved drug.

## Sources
- Pharos: pharos.nih.gov (IDG program)
- TCRD bulk download: juniper.health.unm.edu/tcrd
- TTD: db.idrblab.net/ttd
- DrugBank: go.drugbank.com (license required for bulk)
