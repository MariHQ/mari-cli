# Limpid — ML layer design

The optional model layer that augments the deterministic core. **Local-first** (ONNX /
transformers.js, no API key), **lazy-loaded** (weights download on first `--ml` use), and
never required — the deterministic detector always runs without it. Sources: the round-1
detection-methods survey (folded in here) + [03-research.md](03-research.md).

## Why ML at all (now that it's unlocked)

The deterministic core nails the *explicit* tells (wordlists, phrase templates, formatting).
It cannot reach the *fuzzy* ones: paraphrased buzzwords, slop spans not on any list, tone,
sentence-level "this reads machine-generated," and grounding/factuality. ML covers those.

**Honesty principle (carried from research, non-negotiable):** an AI-text classifier is a
*soft signal, never a verdict*. Stanford (Liang et al., *Patterns* 2023,
[doi:10.1016/j.patter.2023.100779](https://doi.org/10.1016/j.patter.2023.100779)) found GPT
detectors flag ~61% of non-native-English (TOEFL) essays as AI vs ~5% for native writers.
Limpid never says "this is AI." It points at *spans worth rewriting* and emits a *style*
score with the caveat attached. Detection-of-authorship is explicitly a non-goal; fixing
slop is the goal.

## Components

### 1. GLiNER span extraction — the primary ML investment
GLiNER (Zaratiana et al., NAACL 2024, [arXiv:2311.08526](https://arxiv.org/abs/2311.08526))
is a generalist span extractor on a bidirectional DeBERTa-v3 encoder that takes **arbitrary
natural-language labels at inference**. We pass slop labels and get back spans to highlight:

```
labels = ["marketing_buzzword", "hedge_phrase", "filler_phrase",
          "vague_attribution", "puffery", "cliche"]
```

- **Why it fits:** it surfaces *fixable spans*, which is exactly what `deslop`/`audit` want —
  unlike a binary detector that just emits a contested score.
- **Strengths/limits:** great on entity-like spans (buzzwords, named clichés); weaker on
  abstract rhetorical categories (fine-tune on a few hundred labeled spans to fix). Ship
  zero-shot first; fine-tune later from our own fixtures.
- **Local JS:** `onnx-community/gliner_*` ONNX export + **GLiNER.js** + `onnxruntime-node`
  (native transformers.js support is partial — custom span head). Models `urchade/gliner_*`
  ~166M–459M; small ≈ 150MB int8.
- **Role:** produces `ml-span:<label>` findings that *merge with and de-dupe against* the
  deterministic Family-A hits (same span found both ways = high confidence).

### 2. AI-likelihood classifier — soft score only
- Best open model: `desklib/ai-text-detector-v1.01` (DeBERTa-v3-large, ~92.4% on RAID,
  ONNX ~440MB int8). Alternatives: `Hello-SimpleAI/chatgpt-detector-roberta`. The old
  `roberta-base-openai-detector` is GPT-2-era, skip.
- Runs via `@huggingface/transformers` text-classification pipeline (ONNX, local).
- **Output:** a 0–1 "reads-machine-generated" gauge surfaced with the ESL/technical-prose
  caveat. Gated behind `--ml=classifier`. Feeds the document-level slop score as one weak
  feature among many; never fires a per-line error.

### 3. Perplexity + burstiness — cheap, CPU-friendly
- Tiny local GPT-2 (`Xenova/gpt2` via `@huggingface/transformers`, ~125MB int8) computes
  per-chunk perplexity; combine with the pure-stat sentence-length **burstiness** (CV) already
  in the deterministic core (03-research.md §5).
- Low perplexity + low burstiness = "uniform, predictable rhythm." Advisory nudge feeding the
  `cadence` command. CPU-comfortable; the lightest ML option.
- Heavier zero-shot methods (DetectGPT, Fast-DetectGPT, Binoculars) are **out of scope** for
  the default install (multi-GB, GPU); document them as an advanced Python-sidecar opt-in only.

## How the layers combine (scoring)

```
finding sources:
  deterministic rules (Families A–F)        ← always on, high precision, explainable
  + GLiNER spans (ml-span:*)                ← --ml, recall on fuzzy spans
  + classifier score (document-level)       ← --ml=classifier, soft gauge w/ caveat
  + perplexity/burstiness (document-level)  ← --ml, advisory rhythm nudge

dedupe: ML span overlapping a deterministic hit → single finding, confidence boosted.
score:  document slop score = weighted blend; ML contributes, never dominates.
output: per-finding `source: rule|ml-span|ml-score`, so users see what came from a model.
```

## Local-first stack

```
@huggingface/transformers   // transformers.js v3+, ONNX pipelines, Node, no key
onnxruntime-node            // ONNX backend
gliner / GLiNER.js          // span extraction (custom slop labels), fine-tunable
```
Models (all local, lazy-downloaded, cached under `~/.limpid/models/`):
`onnx-community/gliner_small-v2.1` (spans) · `Xenova/gpt2` (perplexity) ·
`desklib/ai-text-detector-v1.01` (optional classifier).

## CLI / config surface

```
npx limpid detect --ml docs/            # deterministic + GLiNER spans + perplexity
npx limpid detect --ml=classifier .     # also run the AI-likelihood gauge
npx limpid detect --ml=off .            # force deterministic-only (default when no flag)
```
`.limpid/config.json` → `ml.enabled`, `ml.classifier`, `ml.modelDir`, `ml.maxChars`
(skip ML on huge files). The hook stays deterministic-only by default (latency); `--ml`
is opt-in for explicit `detect`/`audit` runs.

## Watermarking — still N/A
SynthID / Kirchenbauer watermarks need generator cooperation and a key; they can't detect
arbitrary third-party text. Out of scope (documented for completeness).

## Build notes
- ML is a separate lazy-loaded module (`engine/ml/`); core install has zero model deps.
- `@huggingface/transformers`, `onnxruntime-node`, `gliner` go in `optionalDependencies`
  (like impeccable's puppeteer) so `npx limpid detect` works without them.
- Fine-tune GLiNER on our fixture corpus once we have labeled slop spans (M4+).
