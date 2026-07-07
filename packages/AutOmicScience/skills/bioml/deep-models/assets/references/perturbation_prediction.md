# Reference — Perturbation Outcome Prediction (Perturb-seq)

Predicting differential gene expression (DEG) outcomes from genetic perturbations — the Perturb-seq multi-task prediction problem.

## The task (NatureBench s43588-024-00698-1)

**Input:** Perturb-seq data with genetic perturbations (gene knockouts/CRISPRi) + pre-computed scGPT/ontology embeddings.

**Output:** `predictions.npz` with 3 levels:
- **level1**: per-gene DEG score (binary: is this gene differentially expressed?)
- **level2**: DEG direction (up/down/unchanged)
- **level3**: log fold-change magnitude

**Evaluation:** ROC-AUC on level1 (DEG detection). SOTA: scGPT+STAMP (0.78–0.92), baseline GEARS (0.51–0.62).

## Method: Multi-task head over embeddings

The embeddings (scGPT perturbation representations + gene ontology) are **pre-supplied**. Your job: build a multi-task head.

```python
import torch
import torch.nn as nn

class PerturbationPredictor(nn.Module):
    def __init__(self, embed_dim=512, n_genes=5000):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(embed_dim, 256), nn.ReLU(), nn.Dropout(0.2),
            nn.Linear(256, 128), nn.ReLU()
        )
        # Three task-specific heads
        self.deg_score = nn.Linear(128, n_genes)       # level1: binary DEG score
        self.deg_direction = nn.Linear(128, n_genes*3) # level2: up/down/unchanged (3-class per gene)
        self.deg_fc = nn.Linear(128, n_genes)          # level3: log2FC magnitude
        
    def forward(self, embed):
        h = self.shared(embed)
        return {
            "level1": torch.sigmoid(self.deg_score(h)),
            "level2": self.deg_direction(h).view(-1, self.n_genes, 3),
            "level3": self.deg_fc(h)
        }
```

## Training with DEG-masked loss

Not all genes are DEG for every perturbation. Mask the loss to predicted-DEG genes:

```python
# Loss for level1 (binary DEG)
loss_deg = F.binary_cross_entropy(pred["level1"], target_deg_binary)

# Loss for level2/3: only on genes where level1 predicts DEG
deg_mask = (pred["level1"] > 0.5).float()
loss_direction = F.cross_entropy(pred["level2"], target_direction, reduction='none') * deg_mask
loss_fc = F.mse_loss(pred["level3"], target_fc, reduction='none') * deg_mask

total_loss = loss_deg + loss_direction.mean() + loss_fc.mean()
```

## Flattening the output for evaluation

The evaluator expects a specific `.npz` schema. Verify the exact key names and shapes:

```python
np.savez("predictions.npz",
         level1=pred_level1.cpu().numpy(),  # (n_perturbations, n_genes)
         level2=pred_level2.argmax(-1).cpu().numpy(),
         level3=pred_level3.cpu().numpy())
```

## Baseline: GEARS (graph-based)

GEARS models perturbation effects via a gene regulatory network graph. It scores 0.51–0.62 (weak). The scGPT+STAMP approach (0.78–0.92) uses the pretrained scGPT perturbation embeddings, which capture richer context.

## Escape hatch: When the embeddings fail

If the pre-supplied embeddings are insufficient, the fallback is:
1. Fine-tune scGPT on the perturbation dataset (if allowed)
2. Use a simpler model: perturbation one-hot + gene expression baseline → MLP

But the task supplies embeddings for a reason — use them first.

## Pitfalls

- **Not masking level2/3 loss** — training on non-DEG genes adds noise
- **Output schema mismatch** — evaluator expects exact keys/shapes
- **Ignoring class imbalance** — most genes are not DEG; weight the loss
- **Overfitting on small datasets** — Perturb-seq data is often <1000 perturbations; use dropout + early stopping
- **Confusing perturbation embeddings with gene embeddings** — the input is a perturbation (context), output is per-gene predictions

## Grounding

`report`: embedding source (scGPT version, ontology type), multi-task head architecture, loss masking applied, DEG class balance, validation AUC (level1) + direction accuracy (level2) + FC correlation (level3), output schema verified.
