# Reference — DNA Foundation Models

NT, DNABERT, HyenaDNA, Borzoi for DNA regulatory prediction, plus the CNN escape hatch.

## Nucleotide Transformer (NT)
6-mer tokenizer, transformer. For classification (promoter, splice, chromatin):
```python
from transformers import AutoTokenizer, AutoModelForSequenceClassification, Trainer, TrainingArguments
tok = AutoTokenizer.from_pretrained("InstaDeepAI/nucleotide-transformer-500m-1000g")
model = AutoModelForSequenceClassification.from_pretrained(
    "InstaDeepAI/nucleotide-transformer-500m-1000g", num_labels=n_classes)
# Tokenize, then Trainer.train()
```
Max ~1kb (6-mer → ~1000 tokens). Longer → HyenaDNA/Enformer.

## DNABERT-2
BPE tokenizer (variable-length). HuggingFace `zhihan1996/DNABERT-2-117M`. Good for promoter/enhancer classification.

## HyenaDNA
Single-nucleotide, long-context (up to 1M bp). Repo `HazyResearch/hyena-dna`. Use for long enhancer regions or whole loci.

## Borzoi / Enformer (seq → track)
Predict per-base epigenomic tracks (coverage) from long sequence. For **variant effect**: score ref vs alt.
```python
# Extract exact-length window centered on TSS/variant
# ref_pred - alt_pred = variant effect score
```
Window must be exact trained length, centered correctly (positional-encoding sensitive).

## Escape hatch: DeepSTARR CNN
For well-posed enhancer-activity regression on short fixed-length sequences with ample labels, a task CNN can beat the FM (documented: DeepSTARR 0.68 > NT 0.64). Minimal CNN:
```python
import torch.nn as nn
class DeepSTARR(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(4, 256, 7, padding=3), nn.ReLU(), nn.MaxPool1d(2),
            nn.Conv1d(256, 60, 3, padding=1), nn.ReLU(), nn.MaxPool1d(2))
        self.fc = nn.Sequential(nn.Flatten(), nn.LazyLinear(256), nn.ReLU(), nn.Linear(256, 1))
    def forward(self, x): return self.fc(self.conv(x))
```
One-hot encode (4 channels: A/C/G/T). Run this FIRST for short-sequence regression.

## Output contracts
- Classification: `(n_seq, n_classes)` logits → argmax, scored by MCC/F1
- Regression: `(n_seq,)` or `(n_seq, n_tracks)` → Pearson
- Per-base: `(seq_len, n_tracks)` coverage → Pearson-across-positions

## Pitfalls
- Wrong tokenizer for the model
- Sequence exceeds max length (truncation loses signal)
- Off-center window for Borzoi/Enformer (positional artifacts)
- Not reverse-complementing minus-strand features
- Jumping to FM when a CNN wins

## Grounding
`report`: model + version, tokenizer + max_length, output shape, validation metric (MCC/Pearson), baseline (CNN) comparison.
