# Mari — Models design (default local models + opt-in generative)

**Reframe (important):** the dividing line is **model size**, not "rules vs. AI." GLiNER and
BERT/DeBERTa are *small encoder models* — one forward pass, CPU, milliseconds, no GPU, no API.
They run **by default** as part of the detector (weights auto-cached on first run). The only
genuinely heavy thing — and therefore the only opt-in — is a **generative** model (Qwen) used
for attention-based grounding and claim decomposition (see [05-grounding.md](05-grounding.md)).
A `--no-models` mode runs the pure-deterministic tier alone for offline/locked-down use.
Local-first throughout (no API key). Source: round-1 detection survey + [03-research.md](03-research.md).

| Component | Tier | Default? |
|-----------|------|:---:|
| GLiNER slop-span extraction | small encoder | ✅ |
| Small NLI / fact-checker (grounding Tier 3) | small encoder | ✅ |
| AI-likelihood gauge (soft score) | small encoder | ✅ |
| Perplexity + burstiness | tiny LM + pure stat | ✅ |
| Qwen attention grounding + LLM claim split | generative LLM | opt-in |

## Why models at all

The deterministic rules nail the *explicit* tells (wordlists, phrase templates, formatting).
They cannot reach the *fuzzy* ones: paraphrased buzzwords, slop spans not on any list, tone,
sentence-level "this reads machine-generated," and grounding/factuality. The small default
models cover those at no meaningful cost; the generative tier covers attention-grounding.

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
  caveat. Runs by default (it's a small encoder); feeds the document-level slop score as one weak
  feature among many; never fires a per-line error, never a verdict. `--no-models` disables it.

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
  + GLiNER spans (model-span:*)             ← DEFAULT (small encoder), recall on fuzzy spans
  + classifier score (document-level)       ← DEFAULT, soft gauge w/ ESL caveat
  + perplexity/burstiness (document-level)  ← DEFAULT, advisory rhythm nudge
  + Qwen attention grounding                ← OPT-IN (generative), Family G Tier 4

dedupe: model span overlapping a deterministic hit → single finding, confidence boosted.
score:  document slop score = weighted blend; model signals contribute, never dominate.
output: per-finding `source: rule|model-span|model-score`, so users see what came from a model.
```

## Local models (the candidate set — all run on CPU)

Default (small encoders, auto-cached on first run): a GLiNER span model (slop labels), a small
GPT-2-class LM for perplexity, a small DeBERTa AI-likelihood classifier, and the DeBERTa NLI /
fact-checker used by grounding. Opt-in (generative): a small Qwen (e.g. Qwen3-0.6B) for
attention grounding + claim decomposition. Concrete model ids/sizes/licenses live in 03/05;
all candidates are Apache-2.0 / MIT and run without a GPU or API key.

## CLI / config surface

```
mari detect docs/             # deterministic + default local models (GLiNER, classifier, perplexity)
mari detect --no-models .     # pure-deterministic, no download (offline/locked-down)
mari factcheck draft.md       # adds grounding (default NLI); --ground=attention for the Qwen tier
```
`config` → `models.enabled` (default true), `models.dir`, `models.maxChars` (skip models on huge
files), `grounding.attention` (the only opt-in/generative switch). The hook runs the deterministic
tier only by default (latency); explicit `detect`/`audit`/`factcheck` runs use the default models.

## Watermarking — still N/A
SynthID / Kirchenbauer watermarks need generator cooperation and a key; they can't detect
arbitrary third-party text. Out of scope (documented for completeness).

## Build notes
- Small models load lazily but are part of the default experience; only the generative tier is gated.
- A `--no-models` path keeps the pure-deterministic detector fully functional with zero downloads.
- Fine-tune GLiNER on our fixture corpus once we have labeled slop spans.
