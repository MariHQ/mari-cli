# native/attn — Mari's attention coverage extractor

A vendored copy of the attention extractor (github.com/henneberger/attention), with a Mari
entry point added. Builds two binaries against a local llama.cpp checkout:

- `attn_extract` — the original generic tool (heatmap.tar.gz + web explorer).
- `mari_attn` — Mari's entry point (`mari_attn.cpp`): forces `--mari-coverage`, which puts the
  SOURCE as context and the TRANSLATION as query, sums attention each source span receives, and
  emits Mari findings JSON (flagged low-coverage source spans the translation likely dropped).
  No heatmap reparsing — the coverage is computed in C++ and printed as findings.

Build (needs a built llama.cpp at the CMake `LLAMA_DIR`):
    cmake -S . -B build && cmake --build build -j
Then: `mari i18n coverage <source.md> <translation.md>` drives `mari_attn`.
