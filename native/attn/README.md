# native/attn — Mari's attention coverage extractor

A vendored copy of the attention extractor (github.com/henneberger/attention), with a Mari
entry point added. Builds two binaries against a local llama.cpp checkout:

- `attn_extract` — the original generic tool (heatmap.tar.gz + web explorer).
- `mari_attn` — Mari's entry point (`mari_attn.cpp`): forces `--mari-coverage`, which puts the
  SOURCE as context and the TRANSLATION as query, sums attention each source span receives, and
  emits Mari findings JSON (flagged low-coverage source spans the translation likely dropped).
  No heatmap reparsing — the coverage is computed in C++ and printed as findings.

## Shipping

Users do NOT compile this. A relocatable, ad-hoc-signed bundle is committed under
`dist/<platform>/` (the binary plus its dylibs, rpaths rewritten to `@loader_path`), and the
Mari CLI runs `dist/${process.platform}-${process.arch}/mari_attn` directly. Only a multilingual
GGUF model is supplied at runtime via `MARI_ATTN_MODEL` (models are too large to vendor).

To (re)build the bundle for a platform (needs a built llama.cpp at the CMake `LLAMA_DIR`):

    cmake -S . -B build && cmake --build build --target mari_attn
    ./bundle.sh        # → dist/<platform>/

`mari i18n coverage <source.md> <translation.md>` then drives the shipped `mari_attn`.
