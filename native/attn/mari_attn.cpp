// Mari's own entry point into the attention extractor.
//
// It reuses the extractor core verbatim (main.cpp, textually included below) and forwards argv
// unchanged — it does NOT force any mode itself. The caller (the Mari CLI) selects the
// aggregation direction with a flag:
//   --mari-coverage   flag CONTEXT spans the query barely attends to (i18n: dropped content)
//   --mari-grounding  flag QUERY rows that barely attend to the context (factcheck: ungrounded)
// Either way the output is Mari findings JSON on stdout — no heatmap, nothing to reparse.
//
// Usage:
//   mari_attn --model <gguf> --context <ctx> --query <qry> (--mari-coverage|--mari-grounding) [--mari-threshold 0.3]
//
// NOTE: the `#define main` below textually renames EVERY `main` token in main.cpp for the
// duration of the include (not just the entry point). That is safe today because main.cpp uses
// the identifier `main` only for its entry function — keep it that way when updating main.cpp.

#define main attn_extract_entry
#include "main.cpp"
#undef main

int main(int argc, char ** argv) {
    return attn_extract_entry(argc, argv);
}
