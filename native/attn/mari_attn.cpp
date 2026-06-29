// Mari's own entry point into the attention extractor.
//
// It reuses the extractor core verbatim (main.cpp, included with its `main` renamed) and forces
// `--mari-coverage`: the SOURCE doc is the context, the TRANSLATION is the query, and the tool
// sums how much attention each source span receives from the translation. Source spans with low
// coverage are content the translation likely avoided / never carried over. Output is Mari
// findings JSON on stdout — no heatmap, nothing to reparse.
//
// The Mari CLI selects the aggregation direction with a flag:
//   --mari-coverage   flag CONTEXT spans the query barely attends to (i18n: dropped content)
//   --mari-grounding  flag QUERY rows that barely attend to the context (factcheck: ungrounded)
// Either way the output is Mari findings JSON on stdout — no heatmap, nothing to reparse.
//
// Usage:
//   mari_attn --model <gguf> --context <ctx> --query <qry> (--mari-coverage|--mari-grounding) [--mari-threshold 0.3]

#define main attn_extract_entry
#include "main.cpp"
#undef main

int main(int argc, char ** argv) {
    return attn_extract_entry(argc, argv);
}
