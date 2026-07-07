# Reference — Foundation Models & Escape Hatches

When to use single-cell foundation models (scGPT, Geneformer) vs when a mature simpler method beats them. The documented pattern: **baselines often win on well-posed tasks.**

## The escape-hatch pattern (documented)

Across NatureBench single-cell tasks, simpler methods repeatedly matched or beat the "SOTA" foundation/bespoke model:

| Task | SOTA method | Baseline that matched/beat it |
|------|-------------|-------------------------------|
| Multimodal clustering (s43588-024-00689-2) | meK-means | **scVI-KMeans beat it on 2/4 instances** |
| Label transfer (s41592-023-02035-2) | scPoli | **scANVI beat it on lung** |
| Cell annotation (s42256-022-00534-z) | scBERT (0.99) | SingleR (0.987) — near-tie, lightweight classifier competitive |
| DNA regulatory (s41592-024-02523-z) | Nucleotide Transformer | **DeepSTARR CNN beat it** |

**The lesson:** foundation models justify their compute cost only in specific conditions. For well-posed integration/annotation/clustering, run the mature baseline **first**.

## Decision tree

```
Task = integration / annotation / clustering?
├── YES → Run scVI / scANVI / scArches FIRST.
│         Does it clear the target metric?
│         ├── YES → Done. Ship the baseline. (You saved days of GPU.)
│         └── NO  → Is it a few-shot task (<100 labeled cells)?
│                   ├── YES → Try scGPT/Geneformer fine-tune
│                   └── NO  → Diagnose why baseline failed (batch? hyperparams?) before escalating
│
└── Cross-species without orthologs? → SATURN (see saturn_cross_species.md)
└── Novel task the baseline can't express? → foundation model may be warranted
```

## When foundation models DO justify the cost

1. **Few-shot learning** — very few labeled cells (<100); the pretrained representation transfers
2. **Cross-species without orthologs** — no shared gene space for scVI
3. **Zero-shot annotation** — no reference to train scANVI on
4. **Novel emergent capability** — the task needs the FM's specific pretrained knowledge

Outside these, the baseline is usually competitive and far cheaper.

## scGPT (fine-tune or zero-shot)

```bash
# Clone scGPT repo, download pretrained checkpoint
git clone https://github.com/bowang-lab/scGPT.git
```

```python
# Zero-shot embedding (no training)
from scgpt.tasks import embed_data
embedded = embed_data(adata, model_dir="scGPT_human", gene_col="gene_name")
adata.obsm["X_scgpt"] = embedded.obsm["X_scGPT"]

# Then cluster/annotate on the embedding as usual
```

GPU: 24–40 GB. Wall-clock: hours for fine-tuning, minutes for zero-shot embedding.

## Geneformer (alternative FM)

```python
# Geneformer via HuggingFace
from geneformer import EmbExtractor
embex = EmbExtractor(model_type="Pretrained", num_classes=0)
embs = embex.extract_embs("Geneformer", "tokenized_data.dataset", "output/", "emb")
```

Requires tokenizing the data into Geneformer's rank-value format first. Use as an alternative to scGPT when few-shot is genuinely needed.

## Baseline-first recipe (the discipline)

```python
# 1. ALWAYS run the baseline first
import scvi
scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="batch")
m = scvi.model.SCVI(adata); m.train(max_epochs=400)
adata.obsm["X_scvi"] = m.get_latent_representation()
# cluster + score
baseline_score = evaluate(adata, "X_scvi")

# 2. Only if baseline_score < target: escalate to FM
if baseline_score < target_metric:
    # ... scGPT / Geneformer path
    pass
else:
    print(f"Baseline scVI cleared the bar ({baseline_score:.3f}) — no FM needed")
```

Document the baseline score in the `report` — it justifies (or obviates) the FM.

## Pitfalls

- **Jumping to the FM first** — wastes GPU-days when scVI would clear the bar
- **Not recording the baseline** — you can't justify the FM without the comparison
- **Assuming SOTA = best for your data** — benchmark SOTA often loses on specific instances
- **Ignoring compute reality** — an FM that needs 40 GB / 2 days may be infeasible in a bounded run
- **Tokenization mismatch** — scGPT/Geneformer need specific input formats; a wrong tokenization silently degrades results

## Grounding

`report`: baseline method + score (always run first), decision (FM used or not) + justification, if FM used its version/checkpoint + final score + baseline comparison.
