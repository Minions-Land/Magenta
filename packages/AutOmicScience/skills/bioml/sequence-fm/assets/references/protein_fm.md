# Reference — Protein Foundation Models

ESM-2 / ESM1b for protein function, variant effect, and structure; GPN for genomic variant effect.

## ESM-2 embeddings
```python
import torch, esm
model, alphabet = esm.pretrained.esm2_t33_650M_UR50D()
batch_converter = alphabet.get_batch_converter()
data = [("protein1", "MKTAYIAKQR...")]
_, _, tokens = batch_converter(data)
with torch.no_grad():
    results = model(tokens, repr_layers=[33])
emb = results["representations"][33].mean(1)  # mean-pool (mask pad tokens!)
```

## Zero-shot variant scoring (PLLR)
Pseudo-log-likelihood ratio: score mutation without training.
```python
# PLLR = log P(mut_aa | context) - log P(wt_aa | context)
# Masked-marginal scoring: mask the position, compare wt vs mut logit
```
Negative PLLR → deleterious. A strong zero-shot baseline for pathogenicity.

## Siamese / MLP pathogenicity head
For disease-specific VEP with labels: embed wt + mut, feed the difference to an MLP.
```python
# features = esm_embed(mut) - esm_embed(wt)
# MLP head → pathogenic probability
# Scored by AUPR
```

## Two-step transfer
Pretrain the head on general variant data, then finetune on disease-specific labels. Improves AUPR when disease labels are scarce.

## GPN (genomic)
Genomic pretrained network for DNA-side variant effect prediction. Use for non-coding/regulatory variants.

## Output contracts
- Variant effect: `predictions.npy` pathogenicity scores → AUPR
- Function classification: logits → AUC/F1

## Pitfalls
- Padding leaking into mean-pooled embeddings (mask pad tokens)
- Confusing zero-shot PLLR with a trained head (different recipes)
- wt/mut sequence misalignment (mutation at wrong position)
- Sequence length limits (ESM-2 caps ~1024 residues)
- Mean-pool vs CLS-token vs per-residue — match the task

## Grounding
`report`: model + version, approach (zero-shot PLLR vs trained head), output shape, AUPR/AUC on validation, wt/mut alignment verified.
