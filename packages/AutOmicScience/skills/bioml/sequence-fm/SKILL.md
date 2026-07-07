---
name: bioml-sequence-fm
disable-model-invocation: true
---

# BioML Sequence Foundation Models — DNA/RNA/Protein Transformers

> Subskill of `bioml`. Enter here from the parent skill when you need to train or apply a DNA, RNA, or protein sequence foundation model. Read `../SKILL.md` (parent) and `../../omics-shared/SKILL.md` first — their ML-engineering foundations and evidence rules apply here.

This subskill covers **sequence-based foundation models**: Nucleotide Transformer, DNABERT, HyenaDNA, Borzoi (DNA); RNA-FM (RNA); ESM-2, GPN (protein). These are orthogonal to `deep-models` (single-cell scVI/scGPT on count matrices); here the input is FASTA/raw sequences and the task is sequence classification, per-base prediction, or embedding.

---

## When to Use Sequence FMs

Use this path when:
- The task is **DNA regulatory prediction** (enhancer activity, chromatin state, splicing)
- The task is **RNA structure/function** from sequence alone (no expression matrix)
- The task is **protein function/structure** from AA sequence
- The deliverable is an **exact output file** (logits, embeddings, per-base scores) scored by an evaluator

**Escape hatch:** If the task has a lighter baseline (CNN, GRU, k-mer features + logistic regression), **try that first**. NatureBench documented cases where DeepSTARR CNN beat Nucleotide Transformer on one task. Foundation models justify their cost for transfer/few-shot or when simpler methods provably fall short.

---

## Model Menu

| Model | Modality | Use case | Package/Repo | Compute |
|-------|----------|----------|--------------|---------|
| **Nucleotide Transformer (NT)** | DNA | Regulatory prediction, genomic regions | HuggingFace `InstaDeepAI/nucleotide-transformer-*` | GPU (hours) |
| **DNABERT** | DNA | Promoter/enhancer classification | HuggingFace `zhihan1996/DNABERT-*` | GPU (hours) |
| **HyenaDNA** | DNA | Long-context DNA (1M bp) | Repo `HazyResearch/hyena-dna` | GPU (hours), large memory |
| **Borzoi** | DNA | Per-base epigenome prediction | Repo `calico/borzoi` | GPU (hours–days) |
| **RNA-FM** | RNA | RNA structure/function | Repo `ml4bio/RNA-FM` | GPU (hours) |
| **ESM-2** | Protein | Protein function/structure | HuggingFace `facebook/esm2_*` | GPU (hours) |
| **GPN** | Protein/genomic | Genomic PTM/variant effect | Repo (GPN) | GPU (hours) |

**First try:** If a lightweight baseline (CNN, k-mer BOW) exists in the literature for the same task, run that first. FMs escalate when the baseline misses the target metric.

---

## Task-Specific Reference Docs

| Task | Reference doc |
|------|---------------|
| DNA regulatory (enhancer, promoter, chromatin) | `assets/references/dna_fm.md` |
| RNA structure/function prediction | `assets/references/rna_fm.md` |
| Protein function/structure | `assets/references/protein_fm.md` |

---

## Common Workflow (DNA FM example)

### 1. Tokenize sequences

Most DNA FMs use k-mer tokenization (k=6 common):

```python
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained("InstaDeepAI/nucleotide-transformer-500m-1000g")
seq = "ATCGATCGTAGC..."
tokens = tokenizer(seq, return_tensors="pt", padding=True, truncation=True, max_length=512)
```

### 2. Load pretrained model

```python
from transformers import AutoModelForSequenceClassification
model = AutoModelForSequenceClassification.from_pretrained(
    "InstaDeepAI/nucleotide-transformer-500m-1000g", num_labels=2
)
```

### 3. Finetune (task-specific)

```python
from transformers import Trainer, TrainingArguments
trainer = Trainer(model=model, args=training_args, train_dataset=train_ds, eval_dataset=val_ds)
trainer.train()
```

### 4. Output contract

Verify the evaluator's expected format (logits, embeddings, per-base scores) and shape. Match exactly.

See `assets/references/dna_fm.md` for full recipes.

---

## Sequence-FM Best Practice (on top of bioml/omics-shared)

### 1. Tokenization must match the model

Each FM has a specific tokenizer (k-mer size, special tokens). Using the wrong tokenizer silently degrades results. Always use the model's paired tokenizer.

### 2. Sequence length limits

Transformers have max-length limits (512–4096 tokens typical). For longer sequences, use windowing or a long-context model (HyenaDNA 1M bp).

### 3. Escape-hatch baseline first

Run the simpler method first (documented in the task's baseline). If it clears the bar, the FM is unnecessary. If not, escalate.

### 4. Output shape verification

Evaluators expect exact shapes (e.g., `(n_samples, n_classes)` logits). Verify `.shape` before submitting.

### 5. Finetune vs zero-shot

- **Finetune**: when you have labeled data (100s+ examples)
- **Zero-shot embedding**: when you have no labels, or very few (embed + kNN/logistic)

Finetune is almost always better if data exists.

---

## Pitfalls

- **Wrong tokenizer** — using DNABERT tokenizer on NT model (silent failure)
- **Sequence length overflow** — truncating without windowing loses context
- **Output shape mismatch** — evaluator expects (n, 3), you return (n, 2)
- **Jumping to FM without baseline** — wastes GPU when a CNN would clear the bar
- **No validation on a holdout** — finetune overfits without proper eval
- **Reverse-complement not considered** — DNA is double-stranded; average fwd + revcomp predictions

---

## Evidence & Reporting

Every FM run emits:
- Model name + version (commit SHA for repos, HF model ID for HuggingFace)
- Tokenizer + max_length
- Hyperparams: learning rate, batch size, epochs, warmup
- Output shape + path
- Evaluation metrics (MCC, Pearson, AUPR, F1) on validation set
- Baseline comparison (and why the FM was chosen over the simpler path)

This is your audit trail.
