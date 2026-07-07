# Reference — HMDB / LIPID MAPS Annotation

Annotate metabolite/lipid IDs to pathways/names via REST APIs (optional).

## HMDB API
```python
import requests
def hmdb_lookup(hmdb_id):
    url = f"https://hmdb.ca/metabolites/{hmdb_id}.json"
    r = requests.get(url, timeout=10)
    return r.json() if r.ok else None
```

HMDB IDs: 5-digit (legacy) or 7-digit (new). Normalize before lookup.

## LIPID MAPS API
```python
url = f"https://www.lipidmaps.org/rest/compound/lm_id/{lmid}/all/json"
r = requests.get(url, timeout=10)
```

## Network-optional with offline fallback
API calls are optional. If network unavailable or rate-limited, proceed with IDs only (don't block the analysis).

## Pitfalls
- Blocking analysis on network call
- Legacy vs new HMDB ID mismatch
- Treating API responses as trusted (validate structure)

## Grounding
`report`: annotation source (HMDB / LIPID MAPS + version or "offline"), n features annotated, top pathway enrichments.
