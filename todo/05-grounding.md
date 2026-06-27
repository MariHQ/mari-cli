# Limpid — Grounding & facts feature

The capability that takes Limpid beyond style: **does the prose actually match the truth?**
The user supplies ground-truth facts; Limpid flags claims in the text that are **unsupported
by** or **contradict** those facts (the highest-signal kind of AI slop — confident
hallucination). Local-first, no API key. Sources: dedicated grounding research this round
(cited inline) + [04-ml-layer.md](04-ml-layer.md).

## The user-facts surface

A new context file, **`FACTS.md`** — the project's ground truth, hand-edited or built up via CLI:

```bash
npx limpid facts add "Limpid was created in 2026."
npx limpid facts add "The CLI command is 'npx limpid detect', not 'limpid scan'."
npx limpid facts list
npx limpid facts remove <id>
npx limpid facts import notes.md        # bulk-import a source doc as facts
```

`FACTS.md` is plain markdown — one fact per line/bullet, optionally grouped under headings,
optionally with a source link. It's read by the grounding layer and by the `factcheck`
command. It joins PRODUCT.md (voice) and STYLE.md (house style) as the third context file.
Like the others, it's optional: no `FACTS.md` → grounding checks simply don't run.

Two modes of truth:
- **Closed-world facts** (`FACTS.md` present): a claim that contradicts a fact → `error`;
  a checkable claim with no support → `advisory` (absence isn't disproof unless the user
  marks `FACTS.md` as exhaustive via `facts.exhaustive: true`).
- **Source-grounded** (`--source <file>`): check the text against a specific source document
  it was supposedly written from (e.g. "summarize these notes") — stricter; unsupported = `warn`.

## Detection layers (cheap → heavy; ship the cheap ones first)

### Tier 0 — Deterministic typed-span check (no model, highest precision, fully explainable)
Extract **numbers, dates, quantities, money, percentages, and named entities** from both the
text and `FACTS.md`, align them, and flag value mismatches. This catches wrong-number /
wrong-date / wrong-name hallucinations — the most damaging and most traceable — with zero ML.
- Tools (Python): `quantulum3` (units), `dateparser`, spaCy NER (CARDINAL/MONEY/PERCENT/DATE/
  PERSON/ORG/GPE). JS: `chrono-node`, `@microsoft/recognizers-text`, `wink-nlp`/`compromise`.
- Example finding: text says "released in 2025", `FACTS.md` says 2026 → `error: contradicts-fact`.

### Tier 1 — Retrieve relevant facts (tiny embeddings or BM25)
For each claim, pull the most relevant `FACTS.md` entries.
- Embeddings (CPU sub-second): `sentence-transformers/all-MiniLM-L6-v2` (22.7M, Apache-2.0;
  ONNX `Xenova/all-MiniLM-L6-v2`) or `BAAI/bge-small-en-v1.5` (MIT).
- No-model fallback: **BM25** (`rank-bm25` / MiniSearch / Lunr) — zero downloads, strong on
  exact term/number overlap. Default when ML is off.

### Tier 2 — Claim extraction
- Cheap default: sentence segmentation (`syntok`/spaCy — MIT) → each sentence is a candidate claim.
- Better: atomic-claim decomposition via a small local instruct LLM (Qwen3-0.6B / SmolLM2) —
  "split into self-contained, decontextualized, single-fact claims, resolving pronouns."
  (FActScore [arXiv:2305.14251], SAFE [arXiv:2403.18802].) Note decomposition quality varies
  ([arXiv:2411.02400]) — keep it opt-in.
- Entity-level: GLiNER v2.1 (Apache-2.0) for the entities Tier 0 aligns on.

### Tier 3 — NLI entailment labeling (Supported / Refuted / Unsupported)
Per claim vs retrieved facts (premise = fact, hypothesis = claim): entailment→**Supported**,
contradiction→**Refuted/contradicts-fact**, neutral→**Unsupported**.
- Python (CPU-fine): `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` (184M, MIT, true 3-way) —
  the main pick. Or `vectara/hallucination_evaluation_model` (HHEM-2.1-Open, flan-t5-base,
  ~0.1B, Apache-2.0, reference-free groundedness; Python-only). MiniCheck-Flan-T5-Large
  (770M, MIT, [arXiv:2404.10774]) for binary grounding checks.
- JS/Node: ONNX DeBERTa NLI via transformers.js `zero-shot-classification`
  (`Xenova/nli-deberta-v3-xsmall` smallest, `Xenova/DeBERTa-v3-base-mnli-fever-anli`).
- This is the practical backbone — runs locally, CPU, no key, and matches the deterministic
  spirit (a labeled verdict, not a vibe).

### Tier 4 — Attention grounding (the "Qwen attention extraction" idea), advanced opt-in
Only applicable when the AI text was generated **locally with `FACTS.md` in context** — it
measures whether the model actually attended to the facts.
- **Method: Lookback Lens** (Chuang et al., EMNLP 2024, [arXiv:2407.07071]). Per decode step,
  the **lookback ratio** = attention mass on context (the facts) ÷ (context + already-generated)
  tokens, concatenated across all layers×heads, averaged over a span, fed to a **logistic-
  regression probe**. Low ratio ⇒ the span isn't grounded in the facts ⇒ likely hallucination.
  The linear probe transfers across model sizes; cheap to train and run.
- **Model:** use **`Qwen/Qwen3-0.6B`** (Apache-2.0, standard `Qwen3ForCausalLM`, 28 layers ×
  16 heads), loaded with `attn_implementation="eager"` so attention tensors are exposed.
  ⚠️ The user-named **`Qwen3.5-0.8B` exists** (Apache-2.0) **but is multimodal with hybrid
  linear/gated-attention + MoE** — it doesn't emit conventional softmax attention matrices, so
  it's a **poor fit for Lookback Lens**. Qwen3-0.6B (or Qwen2.5-0.5B-Instruct) is the right tool;
  reserve Qwen3.5-0.8B for any future multimodal/long-context generation use.
- **Constraint:** attention maps require **Python eager attention** — `transformers.js` cannot
  export per-step decoder attention today ([transformers.js#799]). So Tier 4 runs in an optional
  **Python sidecar**, not the default JS build. Related internal-state probes (SAPLMA
  [arXiv:2304.13734] hidden-state probe at middle-upper layers; ITI [arXiv:2306.03341] truthful
  attention heads; INSIDE/EigenScore [arXiv:2402.03744]) are documented as alternatives.

## Pipeline (default = CPU, no API key)

```
text ──▶ claim extraction (sentences; opt. atomic via small LLM)
            │
            ▼
     retrieve facts (MiniLM embeddings by default, CPU; BM25 under --no-models)
            │
   ┌────────┴────────┐
   ▼                 ▼
Tier 0:           Tier 3:
typed-span        NLI entailment            (Tier 4 attention grounding:
number/date/      Supported/Refuted/         opt-in Python sidecar, only for
entity match      Unsupported                locally-generated-with-context text)
   │                 │
   └───────┬─────────┘
           ▼
  grounding findings  →  contradicts-fact (error) | unsupported-claim (advisory/warn) | vague-attribution
```

## Grounding rule family (Family G)

| id | tier | sev | what it flags |
|----|------|-----|---------------|
| `contradicts-fact` | 0/3 | error | A claim whose number/date/entity or NLI verdict contradicts `FACTS.md`. |
| `unsupported-claim` | 3 | advisory* | A checkable factual claim with no support in `FACTS.md`/source. *`warn` in `--source` mode or when `facts.exhaustive`. |
| `number-date-mismatch` | 0 | error | Deterministic typed-span mismatch (the wrong-number tell). |
| `ungrounded-span` | 4 | advisory | Low lookback-ratio span (attention sidecar) — opt-in. |
| `fabricated-citation` | 0 | warn | A citation/URL/DOI/quote in the text not present in `FACTS.md`/source (ties to the Family-F citation rules in 06). |
| `stale-fact` | 0 | advisory | Text asserts a value that an updated `FACTS.md` entry supersedes. |

These integrate with the existing slop rule `vague-attribution` (Family A #9): "studies show"
with no citation is a *style* tell; a concrete claim that contradicts `FACTS.md` is a
*grounding* error. Both fire; different severities.

## Commands & config

- **`/limpid factcheck [target]`** (new skill command, Fix category) — extract claims, check
  against `FACTS.md`/`--source`, report Supported/Refuted/Unsupported with the evidence line.
  Tiers 0–3 (typed-span + retrieval + NLI) run by default on CPU; add `--ground=attention` for the
  opt-in generative Tier 4. Surfaced as `mari factcheck <file> [--source <file>] [--ground=attention]`.
- **`/mari facts`** management (add/list/remove/import) — wraps the CLI above.
- `config` → `facts.path` (default `FACTS.md`), `facts.exhaustive`, `grounding.retriever`
  (`embeddings|bm25`), `grounding.nli` (model id), `grounding.attention` (off by default — the only
  generative-tier switch).
- The hook does **not** run grounding by default (latency + needs FACTS.md); `factcheck` /
  `audit` invoke it explicitly.

## Honesty caveats (same discipline as the classifier)
- "Unsupported" ≠ "false" — it means *not in your facts*. Default to advisory unless the user
  declares the fact base exhaustive or supplies an explicit source.
- NLI models err on long/compound claims — that's why Tier 2 decomposition helps and why
  findings cite the exact evidence line for the user to judge.
- Tier 0 (numbers/dates/entities) is the trustworthy floor; everything above it is assistive.

## Build notes
- Default JS build ships Tiers 0–3 (BM25 + ONNX NLI via transformers.js + typed-span matcher).
- Tier 4 attention grounding is a separate optional **Python sidecar** (`limpid-grounding`),
  documented but not in the default install; needs `transformers` + `torch` + eager attention.
- `FACTS.md` parsing + `facts` CLI are deterministic and ship in M5 with the rest of grounding.
