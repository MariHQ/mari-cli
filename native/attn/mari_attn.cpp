// Mari's own entry point into the attention extractor.
//
// It reuses the extractor core verbatim (main.cpp, included with its `main` renamed) and forces
// `--mari-coverage`: the SOURCE doc is the context, the TRANSLATION is the query, and the tool
// sums how much attention each source span receives from the translation. Source spans with low
// coverage are content the translation likely avoided / never carried over. Output is Mari
// findings JSON on stdout — no heatmap, nothing to reparse.
//
// Usage (driven by `mari i18n coverage`):
//   mari_attn --model <gguf> --context <source.md> --query-tree <dir-with-translation> [--mari-threshold 0.3]

#define main attn_extract_entry
#include "main.cpp"
#undef main

int main(int argc, char ** argv) {
    std::vector<char *> av(argv, argv + argc);
    static char force_coverage[] = "--mari-coverage";
    av.push_back(force_coverage);
    return attn_extract_entry((int) av.size(), av.data());
}
