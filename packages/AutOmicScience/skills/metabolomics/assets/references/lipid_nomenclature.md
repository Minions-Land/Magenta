# Reference — Lipid-Class Nomenclature

Parse lipid shorthand: class + carbon:double-bond composition.

## Format
`CLASS C:DB` → e.g., `PC 34:2` = phosphatidylcholine, 34 carbons, 2 double bonds.

```python
import re
m = re.match(r"(\w+)\s+(\d+):(\d+)", "PC 34:2")
lipid_class, carbons, db = m.group(1), int(m.group(2)), int(m.group(3))
```

## Common classes
- **PC**: phosphatidylcholine
- **LPC**: lysophosphatidylcholine
- **TAG**: triacylglycerol
- **CE**: cholesteryl ester
- **AC/CAR**: acylcarnitine

## Chain notation
`PC 18:1_16:0` → two specific fatty-acid chains.

## Pitfalls
- Treating shorthand as an identifier (not queryable in databases as-is)
- Parsing without the regex (manual string split fails on variants)

## Grounding
`report`: n lipids parsed, per-class distribution, example full-chain annotations.
