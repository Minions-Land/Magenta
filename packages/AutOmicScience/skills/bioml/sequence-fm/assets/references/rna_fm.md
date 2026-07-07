# Reference — RNA Foundation Models

RNA-FM / RNAErnie for ncRNA classification and RNA secondary-structure prediction.

## RNA-FM (classification)
Pretrained RNA language model. For ncRNA family classification (macro-F1 contract):
```python
import fm  # RNA-FM package
model, alphabet = fm.pretrained.rna_fm_t12()
batch_converter = alphabet.get_batch_converter()
# Extract embeddings, then finetune a classification head
```

## RNA secondary structure
Predict base-pairing (contact map). Deep head on RNA-FM embeddings, or off-the-shelf UFold/MXfold2.

### .bpseq output format (1-indexed pairing table)
```python
# Each line: position, base, paired_position (0 if unpaired)
with open(f"{name}.bpseq", "w") as f:
    for i, (base, pair) in enumerate(zip(sequence, pairings), start=1):
        f.write(f"{i} {base} {pair}\n")   # pair = 1-indexed partner or 0
```
Scored by base-pair F1 (predicted pairs vs true pairs).

## Escape hatch: UFold / MXfold2
For the structure task, off-the-shelf UFold (0.81–0.85 F1) is a strong baseline before training a custom head. Run it first.

## Output contracts
- Classification: `predictions.csv` (ncRNA class) → macro-F1
- Structure: `{name}.bpseq` per sequence (1-indexed) → base-pair F1

## Pitfalls
- .bpseq 0-indexed instead of 1-indexed
- Symmetric pairing not enforced (i pairs j ⟹ j pairs i)
- Pseudoknots (RNA-FM/UFold may not predict them)
- Sequence length limits

## Grounding
`report`: model + version, task (classification/structure), output format verified, macro-F1 or base-pair-F1 on validation, baseline (UFold) comparison for structure.
