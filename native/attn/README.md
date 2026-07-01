# native/attn — Mari's attention coverage extractor

A vendored copy of the attention extractor (github.com/henneberger/attention), with a Mari
entry point added. Builds two binaries against a local llama.cpp checkout:

- `attn_extract` — the original generic tool (heatmap.tar.gz + web explorer).
- `mari_attn` — Mari's entry point (`mari_attn.cpp`): the same core, forwarding arguments
  verbatim. The Mari CLI invokes it with `--mari-coverage` (SOURCE as context, TRANSLATION as
  query; flags low-coverage source spans the translation likely dropped) or `--mari-grounding`
  (flags query rows that barely attend to the context). Either mode emits Mari findings JSON —
  no heatmap reparsing; the aggregation is computed in C++ and printed as findings.

## Shipping

Users do NOT compile this. A relocatable, ad-hoc-signed bundle is committed under
`dist/<platform>/` (the binary plus its dylibs, rpaths rewritten to `@loader_path`), and the
Mari CLI runs `dist/${process.platform}-${process.arch}/mari_attn` directly. Only a multilingual
GGUF model is supplied at runtime via `MARI_ATTN_MODEL` (models are too large to vendor).

To (re)build the bundle for a platform (needs a built llama.cpp checkout; point `LLAMA_CPP_DIR`
at it via `-DLLAMA_CPP_DIR=...` or the environment — defaults to `~/llama.cpp`):

    cmake -S . -B build -DLLAMA_CPP_DIR=/path/to/llama.cpp && cmake --build build --target mari_attn
    ./bundle.sh        # → dist/<platform>/

`mari i18n coverage <source.md> <translation.md>` then drives the shipped `mari_attn`.
