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
Any request may come back as {"error":"..."}.
"""
import os, sys, json, math, warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

NLI_MODEL = os.environ.get("MARI_NLI_MODEL", "cross-encoder/nli-deberta-v3-xsmall")
PPL_MODEL = os.environ.get("MARI_PPL_MODEL", "Qwen/Qwen3.5-0.8B")
GLINER_MODEL = os.environ.get("MARI_GLINER_MODEL", "urchade/gliner_small-v2.1")

_state = {}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def _torch():
    import torch
    return torch


def get_nli():
    if "nli" not in _state:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        log(f"[mari-ml] loading NLI {NLI_MODEL} ...")
        tok = AutoTokenizer.from_pretrained(NLI_MODEL)
        model = AutoModelForSequenceClassification.from_pretrained(NLI_MODEL)
        model.eval()
        _state["nli"] = (tok, model, model.config.id2label)
    return _state["nli"]


def get_lm():
    if "lm" not in _state:
        from transformers import AutoTokenizer, AutoModelForCausalLM
        torch = _torch()
        log(f"[mari-ml] loading LM {PPL_MODEL} (first run downloads weights) ...")
        tok = AutoTokenizer.from_pretrained(PPL_MODEL, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            PPL_MODEL, torch_dtype=torch.float32, trust_remote_code=True)
        model.eval()
        _state["lm"] = (tok, model)
    return _state["lm"]


def get_gliner():
    if "gliner" not in _state:
        from gliner import GLiNER
        log(f"[mari-ml] loading GLiNER {GLINER_MODEL} ...")
        _state["gliner"] = GLiNER.from_pretrained(GLINER_MODEL)
    return _state["gliner"]


def do_nli(req):
    torch = _torch()
    tok, model, id2label = get_nli()
    inputs = tok(req["premise"], req["hypothesis"], return_tensors="pt", truncation=True, max_length=256)
    with torch.no_grad():
        logits = model(**inputs).logits[0]
    probs = torch.softmax(logits, dim=-1).tolist()
    scores = {str(id2label[i]).lower(): round(float(p), 4) for i, p in enumerate(probs)}
    label = max(scores, key=scores.get)
    return {"label": label, "scores": scores}


def do_perplexity(req):
    torch = _torch()
    tok, model = get_lm()
    ids = tok(req["text"], return_tensors="pt", truncation=True, max_length=512).input_ids
    if ids.shape[1] < 2:
        return {"ppl": None}
    with torch.no_grad():
        loss = model(ids, labels=ids).loss
    return {"ppl": round(float(math.exp(loss.item())), 3)}


def do_spans(req):
    model = get_gliner()
    labels = req.get("labels") or ["marketing buzzword", "hedge", "filler phrase", "cliche", "vague jargon"]
    thr = float(req.get("threshold", 0.3))
    ents = model.predict_entities(req["text"], labels, threshold=thr)
    spans = [{"text": e["text"], "label": e["label"], "score": round(float(e["score"]), 4),
              "start": e["start"], "end": e["end"]} for e in ents]
    spans.sort(key=lambda s: -s["score"])
    return {"spans": spans}


HANDLERS = {"nli": do_nli, "perplexity": do_perplexity, "spans": do_spans}


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
                resp = {"ok": True, "models": {"nli": NLI_MODEL, "ppl": PPL_MODEL, "gliner": GLINER_MODEL}}
            elif task in HANDLERS:
                resp = HANDLERS[task](req)
            else:
                resp = {"error": f"unknown task: {task}"}
        except Exception as e:  # never die on one bad request
            resp = {"error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
