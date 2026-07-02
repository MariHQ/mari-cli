#!/usr/bin/env python3
"""Mari ML sidecar — real local models, driven by the Node CLI over a JSON-lines protocol.

Protocol: read one JSON request per line on stdin, write one JSON response per line on stdout.
Models load lazily on first use and stay resident, so a long-lived process amortizes load cost.
Only JSON goes to stdout; all model/download chatter is forced to stderr.

Requests:
  {"task":"ping"}                                        -> {"ok":true,"models":{...}}
  {"task":"nli","premise":..,"hypothesis":..}            -> {"label":..,"scores":{...}}
  {"task":"perplexity","text":..}                        -> {"ppl":float}
  {"task":"spans","text":..,"labels":[..],"threshold":n} -> {"spans":[{text,label,score,start,end}]}
  {"task":"lookback","context":..,"candidate":..,
   "spans":[[start,end],...]?,"threshold":n?}            -> {"spans":[{start,end,lookback,grounded}],
                                                             "threshold":n,"n_ctx_tokens":i,"n_cand_tokens":i}
Any request may come back as {"error":"..."}.
"""
import os, sys, json, math, time, warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

NLI_MODEL = os.environ.get("MARI_NLI_MODEL", "cross-encoder/nli-deberta-v3-xsmall")
PPL_MODEL = os.environ.get("MARI_PPL_MODEL", "Qwen/Qwen3.5-0.8B")
# Embeddings for `mari assoc` use the SAME Qwen3.5-0.8B we standardized on for perplexity and
# attention — one model for the whole tier (one download, one resident copy). It's a decoder, so
# do_embed uses last-token pooling (auto-selected by the "qwen" name). Override MARI_EMBED_MODEL.
EMBED_MODEL = os.environ.get("MARI_EMBED_MODEL", "Qwen/Qwen3.5-0.8B")
# gliner_multi (mDeBERTa base) is used over gliner_small: on abstract stylistic labels the
# small model's zero-shot scores are noise (a clean "Flink" outscores real buzzwords), while
# multi cleanly separates slop (~0.2-0.3) from clean prose (<0.12). It's also multilingual,
# which matters for localized docs.
GLINER_MODEL = os.environ.get("MARI_GLINER_MODEL", "urchade/gliner_multi-v2.1")
# Concrete, noun-phrase-shaped labels score far higher on GLiNER than abstract ones like
# "hedge" — the model is an NER model, so labels that read like entity types work best.
SLOP_LABELS = ["marketing buzzword", "hype phrase", "vague corporate jargon",
               "empty filler phrase", "overused cliche"]
# Generative grounding tier (opt-in, heavier): Tier 4 Lookback-Lens attention grounding (needs
# eager attention to read the matrices). Tier 2 atomic-claim decomposition is not here at all —
# Claude does it in-session via the mari skill (the CLI ships no decomposer), so a tiny instruct
# LM never has to do a job the orchestrating model already does far better.
LOOKBACK_MODEL = os.environ.get("MARI_LOOKBACK_MODEL", "Qwen/Qwen3-0.6B")

_state = {}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _torch():
    import torch
    return torch


def _device():
    """mps > cuda > cpu (override with MARI_DEVICE). fp32-on-CPU was the old default and is
    5-20x slower than fp16 on an Apple-Silicon GPU for the causal LMs."""
    if "device" not in _state:
        torch = _torch()
        dev = os.environ.get("MARI_DEVICE")
        if not dev:
            if torch.backends.mps.is_available():
                dev = "mps"
            elif torch.cuda.is_available():
                dev = "cuda"
            else:
                dev = "cpu"
        _state["device"] = dev
        log(f"[mari-ml] device={dev}")
    return _state["device"]


def _lm_dtype():
    torch = _torch()
    return torch.float16 if _device() in ("mps", "cuda") else torch.float32


def _cached(key, loader):
    """Load a model once and reuse it. Crucially, a FAILED load is cached too: an unloadable
    model (unrecognized architecture, missing weights) otherwise re-attempts its multi-second
    load on every request, which reads as a hang. Cache the exception → fast, clear repeat error."""
    if key in _state:
        v = _state[key]
        if isinstance(v, Exception):
            raise v
        return v
    try:
        v = loader()
    except Exception as e:
        _state[key] = e
        raise
    _state[key] = v
    return v


def _load_causal(model_id, eager=False):
    from transformers import AutoTokenizer, AutoModelForCausalLM
    log(f"[mari-ml] loading LM {model_id} (first run downloads weights) ...")
    tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    kw = {"torch_dtype": _lm_dtype(), "trust_remote_code": True}
    if eager:
        kw["attn_implementation"] = "eager"
    model = AutoModelForCausalLM.from_pretrained(model_id, **kw)
    model.eval()
    model.to(_device())
    return (tok, model)


def get_nli():
    def _load():
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        log(f"[mari-ml] loading NLI {NLI_MODEL} ...")
        tok = AutoTokenizer.from_pretrained(NLI_MODEL)
        model = AutoModelForSequenceClassification.from_pretrained(NLI_MODEL)
        model.eval()
        model.to(_device())
        return (tok, model, model.config.id2label)
    return _cached("nli", _load)


def get_lm():
    return _cached("lm", lambda: _load_causal(PPL_MODEL))


def get_gliner():
    def _load():
        from gliner import GLiNER
        log(f"[mari-ml] loading GLiNER {GLINER_MODEL} ...")
        return GLiNER.from_pretrained(GLINER_MODEL)
    return _cached("gliner", _load)


def get_embed():
    def _load():
        from transformers import AutoTokenizer, AutoModel
        log(f"[mari-ml] loading embeddings {EMBED_MODEL} ...")
        # trust_remote_code so code-aware models with custom modeling (e.g. jina-v2-code) load
        tok = AutoTokenizer.from_pretrained(EMBED_MODEL, trust_remote_code=True)
        model = AutoModel.from_pretrained(EMBED_MODEL, trust_remote_code=True)
        model.eval()
        model.to(_device())
        return (tok, model)
    return _cached("embed", _load)


def get_lookback():
    return _cached("lookback", lambda: _load_causal(LOOKBACK_MODEL, eager=True))


def do_nli(req):
    torch = _torch()
    tok, model, id2label = get_nli()
    inputs = tok(req["premise"], req["hypothesis"], return_tensors="pt", truncation=True, max_length=256)
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        logits = model(**inputs).logits[0].float()
    probs = torch.softmax(logits, dim=-1).tolist()
    scores = {str(id2label[i]).lower(): round(float(p), 4) for i, p in enumerate(probs)}
    label = max(scores, key=scores.get)
    return {"label": label, "scores": scores}


def _embed_pooling():
    # BERT-style encoders (MiniLM, bge) → mean pool; decoder embedders (Qwen3-Embedding, or a
    # Qwen base LM coerced into an embedder) → last-token pool. Auto by name, override MARI_EMBED_POOLING.
    p = os.environ.get("MARI_EMBED_POOLING")
    if p:
        return p
    return "last" if "qwen" in EMBED_MODEL.lower() else "mean"


def do_embed(req):
    torch = _torch()
    tok, model = get_embed()
    texts = req.get("texts") or ([req["text"]] if req.get("text") else [])
    if not texts:
        return {"vectors": []}
    pooling = _embed_pooling()
    # Optional instruction prefix (Qwen embedders expect "Instruct: <task>\nQuery: <text>" on the
    # query side; documents stay raw). Caller passes req["instruct"] for the query batch only.
    instruct = req.get("instruct")
    if instruct:
        texts = [f"Instruct: {instruct}\nQuery: {t}" for t in texts]
    max_len = int(os.environ.get("MARI_EMBED_MAXLEN", "512"))
    batch = int(os.environ.get("MARI_EMBED_BATCH", "32"))
    out = []
    with torch.no_grad():
        for i in range(0, len(texts), batch):
            chunk = texts[i:i + batch]
            enc = tok(chunk, return_tensors="pt", padding=True, truncation=True, max_length=max_len)
            enc = {k: v.to(_device()) for k, v in enc.items()}
            hidden = model(**enc).last_hidden_state          # (B, T, H)
            mask = enc["attention_mask"]
            if pooling == "last":
                # last non-pad token per row (works regardless of padding side)
                idx = mask.sum(1) - 1                          # (B,)
                pooled = hidden[torch.arange(hidden.shape[0]), idx]
            else:
                m = mask.unsqueeze(-1).float()
                pooled = (hidden * m).sum(1) / m.sum(1).clamp(min=1e-9)
            pooled = torch.nn.functional.normalize(pooled.float(), p=2, dim=1)  # L2 unit vectors
            out.extend(pooled.cpu().tolist())
    return {"vectors": [[round(x, 6) for x in v] for v in out]}


def do_perplexity(req):
    torch = _torch()
    tok, model = get_lm()
    # A single 512-token window would score only the intro of a long doc. Score up to
    # MARI_PPL_WINDOWS windows spread across the text and average the loss token-weighted.
    all_ids = tok(req["text"], return_tensors="pt").input_ids[0]
    if all_ids.shape[0] < 2:
        return {"ppl": None}
    win, max_windows = 512, int(os.environ.get("MARI_PPL_WINDOWS", "4"))
    n = all_ids.shape[0]
    if n <= win:
        starts = [0]
    else:
        k = min(max_windows, max(2, (n + win - 1) // win))
        starts = [round(i * (n - win) / (k - 1)) for i in range(k)]
    tot_loss, tot_toks = 0.0, 0
    with torch.no_grad():
        for s in starts:
            ids = all_ids[s:s + win].unsqueeze(0).to(_device())
            loss = model(ids, labels=ids).loss
            tot_loss += float(loss.item()) * (ids.shape[1] - 1)
            tot_toks += ids.shape[1] - 1
    # clamp: exp(>709) overflows to OverflowError on gibberish; cap at a very-high-ppl sentinel
    return {"ppl": round(float(math.exp(min(tot_loss / max(tot_toks, 1), 700.0))), 3)}


def _chunks(text, size=1000):
    """Yield (offset, chunk) one chunk PER paragraph — never merging paragraphs.

    GLiNER's zero-shot slop scores are strongly context-dependent: a buzzword phrase
    scores ~0.19 in an isolated marketing paragraph but ~0.07 when a clean technical
    paragraph is scored alongside it in the same window. Scoring each paragraph on its
    own preserves that separation. Over-long paragraphs (rare in docs) are hard-split so
    GLiNER's internal truncation never silently drops the tail."""
    parts = []
    pos = 0
    for para in text.split("\n\n"):
        stripped = para.strip()
        # skip non-prose blocks: markdown headings, fenced code, tables, list-only markup
        if stripped and not (stripped[0] == "#" or stripped.startswith("```") or stripped[0] == "|"):
            base = pos + para.index(stripped[0])
            if len(stripped) <= size:
                parts.append((base, stripped))
            else:
                for i in range(0, len(stripped), size):
                    parts.append((base + i, stripped[i:i + size]))
        pos += len(para) + 2
    return parts or [(0, text)]


def do_spans(req):
    model = get_gliner()
    labels = req.get("labels") or SLOP_LABELS
    thr = float(req.get("threshold", 0.15))
    spans = []
    for off, chunk in _chunks(req["text"]):
        for e in model.predict_entities(chunk, labels, threshold=thr):
            spans.append({"text": e["text"], "label": e["label"], "score": round(float(e["score"]), 4),
                          "start": off + e["start"], "end": off + e["end"]})
    spans.sort(key=lambda s: -s["score"])
    return {"spans": spans}


# --- Tier 4: Lookback-Lens attention grounding ----------------------------------------------
def do_lookback(req):
    torch = _torch()
    tok, model = get_lookback()
    context = req["context"]
    candidate = req["candidate"]
    spans = req.get("spans")  # [[start,end],...] char offsets into candidate; optional
    thr = float(req.get("threshold", 0.10))

    ctx_ids = tok(context, return_tensors="pt", truncation=True, max_length=1024).input_ids
    sep_ids = tok("\n\n", return_tensors="pt", add_special_tokens=False).input_ids
    cand_enc = tok(candidate, return_tensors="pt", add_special_tokens=False,
                   return_offsets_mapping=True, truncation=True, max_length=1024)
    cand_ids = cand_enc.input_ids
    offsets = cand_enc["offset_mapping"][0].tolist()
    input_ids = torch.cat([ctx_ids, sep_ids, cand_ids], dim=1).to(_device())
    n_ctx = ctx_ids.shape[1] + sep_ids.shape[1]
    n_cand = cand_ids.shape[1]

    with torch.no_grad():
        out = model(input_ids, output_attentions=True, use_cache=False)
    atts = out.attentions
    if not atts or atts[0] is None:
        return {"error": "model does not expose attentions (use an eager-attention model)"}

    # per-candidate-token lookback = mean over all layers & heads of attention mass on the context
    lb = [0.0] * n_cand
    L = len(atts)
    for layer in atts:
        a = layer[0]                              # (H, T, T)
        ctx_mass = a[:, :, :n_ctx].sum(dim=-1)    # (H, T)
        total = a.sum(dim=-1).clamp(min=1e-9)     # (H, T) ~1
        ratio = (ctx_mass / total).mean(dim=0)    # (T,)
        for j in range(n_cand):
            lb[j] += float(ratio[n_ctx + j])
    lb = [v / L for v in lb]

    if not spans:
        spans = [[0, len(candidate)]]
    results = []
    for cs, ce in spans:
        toks = [lb[j] for j, (a, b) in enumerate(offsets) if b > cs and a < ce and b > a]
        if not toks:
            continue
        score = sum(toks) / len(toks)
        results.append({"start": cs, "end": ce, "lookback": round(score, 4), "grounded": score >= thr})
    return {"spans": results, "threshold": thr, "n_ctx_tokens": n_ctx, "n_cand_tokens": n_cand}


HANDLERS = {"nli": do_nli, "perplexity": do_perplexity, "spans": do_spans,
            "lookback": do_lookback, "embed": do_embed}


def main():
    log("[mari-ml] ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            task = req.get("task")
            if task == "ping":
                resp = {"ok": True, "models": {"nli": NLI_MODEL, "ppl": PPL_MODEL, "gliner": GLINER_MODEL,
                                               "lookback": LOOKBACK_MODEL, "embed": EMBED_MODEL}}
            elif task in HANDLERS:
                t0 = time.time()
                resp = HANDLERS[task](req)
                dt = time.time() - t0
                if dt > 0.5:
                    log(f"[mari-ml] {task}: {dt:.1f}s")
            else:
                resp = {"error": f"unknown task: {task}"}
        except Exception as e:  # never die on one bad request
            resp = {"error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
