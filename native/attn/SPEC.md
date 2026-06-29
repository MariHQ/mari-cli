# Attention Extractor Spec

## What
Local attention tool. Show what model looks at.

Intended input: source context + markdown query docs.
Output: `heatmap.tar.gz` containing `heatmap.json`. View with `web/explorer.html`.

Not search. Not proof. Model attention, made visible.

Image mode input: one raster image + one prompt, using a llama.cpp multimodal
projector. Output uses the same `heatmap.tar.gz` container, but includes an
embedded image and a patch-grid heatmap that the viewer renders as an overlay.

## Inputs
Required:
- `--model`: GGUF file.
- `--context` or `--context-tree`: source context.
- `--query` or `--query-tree`: markdown docs.

`--query-tree` implies `--per-file`. The legacy single-window path reads `--query` as one file and is only kept for small single-query inputs.

Knobs:
- `--context-glob`, `--query-glob`: file extension filter.
- `--prompt` / `--query-prompt`: override the default task instruction inserted in a `<TASK>` block before `<CONTEXT>`. Passing an empty string disables the task block.
- `--strip-context`, `--strip-query`: cleanup mode.
- `--dump-inputs` / `--dump-llm-inputs`: write the raw text sequences passed to the model into a directory, one `.txt` file per LLM input. In per-file mode this is one file per context window and query/source item pair.
- `--query-segment` / `--source-segment`: query/source mode, `paragraph` (default), `sentence`, `phrase`, or `document-tokens`.
- `--context-segment`: context output chunking mode, `token` (default) or `phrase`.
- `--phrase-tokens`: target model tokens per phrase chunk for `--query-segment phrase` and `--context-segment phrase`. Default 12.
- `--query-phrases` / `--source-phrases` / `--query-phrase-level` / `--source-phrase-level`: aliases for `--query-segment phrase`.
- `--query-document-tokens` / `--source-document-tokens` / `--query-token-level` / `--source-token-level`: aliases for `--query-segment document-tokens`.
- `--layers`: explicit layer list, e.g. `14-20,22`.
- `--layer-fraction-start`, `--layer-fraction-end`: layer band by fraction. Default 0.60-0.88.
- `--no-sink-normalization`: disable sink mask.
- `--per-file`: per-file scan. This is the intended mode for markdown query items.
- `--write-every-docs`: in per-file mode, write the partial `.tar.gz` after every N processed context documents. Default 1. Use 0 to write only at the end. Decode failures still write the current partial output before exiting.
- `--ubatch`: micro-batch size.
- `--llm-batch-size`: in per-file mode, number of query-item sequences to decode together after each shared context window. Default 1. Aliases: `--batch-size`, `--query-batch-size`.
- `--ctx-size` / `--ctx`: token context size. In `--per-file` mode, default is automatic and capped at 16384 to avoid oversized Metal KV/cache allocations. In legacy mode, default is the full composed sequence length plus 8.
- `--gpu-layers`: number of model layers to offload. Default 99.
- `--prune-top-k`: JSON score pruning. For each query row, keeps the top K context tokens plus every token on the surrounding +/-5 context lines around each retained token. It also keeps the top K context lines by total attention mass so distributed line-level hits are not pruned away.
- `--prune`: alias for `--prune-top-k`.
- `--no-prune`: disable JSON score pruning.
- `--output`: output path. Default `web/heatmap.tar.gz`.
- `--json`: unsupported; use `--output FILE.tar.gz`.
- `--cache-dir`: token cache. Default `cpp/cache`.
- `--reasoning-steps`: parsed and accepted, but currently reserved and has no effect.

Image mode:
- `--model`: multimodal text model GGUF.
- `--mmproj`: matching llama.cpp multimodal projector GGUF.
- `--image`: input image path. Use a raster file such as PNG/JPEG; rasterize SVGs first.
- `--svg` / `--image-svg`: optional source SVG path. Image mode inserts this
  SVG source after the image marker and before the prompt, then captures
  prompt-to-SVG-token and SVG-token-to-image-patch attention for the explorer.
- `--svg-before-image` / `--image-attention-order svg-image-prompt`: experimental
  SVG-before-image order. This captures image-patch-to-SVG-token attention in
  `svg.image_query_scores`, which the explorer uses when selecting an image
  pixel.
- `--prompt`: prompt text to attend from. If it does not contain llama.cpp's
  default media marker, the tool prepends the marker before tokenization.
  Image mode matches the tokenized prompt inside the post-image text chunk and
  captures only those prompt rows, excluding the model's image-end/template
  tokens when possible.
- `--image-query-segment prompt|line|token`: output one prompt-level heatmap
  row, one row per non-empty prompt line, or one row per captured prompt token.
  Default `prompt`. Passing `--query-segment document-tokens` in image mode also
  selects `token`.
- `--image-output-grid N|WxH` / `--image-pool N|WxH`: pool the native image
  patch grid into a smaller output grid before writing JSON. For example, `5x5`
  keeps model-side attention at native resolution but writes only 25 image cells.
- `--image-min-tokens`, `--image-max-tokens`: optional dynamic-resolution token
  controls forwarded to the projector.
- `--check-context` / `--context-check`: image mode preflight. Load the model
  and projector, tokenize the image prompt, verify the planned sequence fits the
  requested and trained context windows, then exit before context init/decode.
- `--no-mmproj-offload`: run the projector on CPU.

Example:
```sh
./build/attn_extract \
  --model models/qwen3-vl-2b-instruct/Qwen3VL-2B-Instruct-Q4_K_M.gguf \
  --mmproj models/qwen3-vl-2b-instruct/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf \
  --image web/jammy-dj-white-centered.png \
  --prompt "Describe the DJ and the headphones." \
  --image-query-segment token \
  --output web/heatmap.tar.gz
```

Defaults:
- `--context-glob .ts`
- `--query-glob .mdx`
- `--ubatch 256`
- `--llm-batch-size 1`
- `--gpu-layers 99`
- `--prune-top-k 80`
- `--prompt "Find implementation evidence in the code for each specification item. Prefer exact implementing functions, branches, data structures, and output fields. Focus on semantic matches, not shared words."`

For C++ context and Markdown query docs, pass `--context-glob .cpp --query-glob .md`.

Strip modes:
- `none` / empty: no change.
- `whitespace`: trim outer whitespace, remove trailing spaces before newlines, and collapse 3+ newlines to 2.
- `python`: remove Python triple-quoted strings and `#` line comments, then apply `whitespace`. This is heuristic cleanup, not a Python parser.

## Units
Context is always model-token level.

With `--per-file`, query rows are markdown items:
- Bullet lines, numbered lines, blockquote lines, fenced code blocks, and text paragraphs each become one query row.
- With `--query-segment sentence`, query/source paragraphs and list-like lines are split into sentence rows instead. Fenced code blocks stay whole.
- With `--query-segment phrase`, each query/source document is passed whole, and phrase chunks become query rows.
- With `--query-segment document-tokens`, each query/source document is passed whole, and each source token becomes one query row.
- `--prompt` text is included above `<CONTEXT>` as a `<TASK>` block, but it is outside the query body and does not become a query row.
- Heading hierarchy is retained in the prompt for extra context.
- Parent list items are retained in the prompt for nested items.
- Only the active item's tokens are captured and aggregated into that row.
- Query docs are concatenated into displayed `query_text` with a synthetic `## === path ===` header before each doc. The synthetic header is display structure; it is not itself a query row.

Query chunk labels use `path:item_000000`. Context chunk labels use `path:tok_000000`.
If tokenization produces no token chunks for non-empty text, the fallback label is `path:file`.

Without `--per-file`, the legacy single-window scan still exists for small inputs and uses token-level query rows rather than markdown item rows. Legacy query token labels use `query:tok_000000`.

## Prompt Layout
The decoded sequence is causal, so context must appear before query tokens. With the default prompt, each scan is shaped like:

```xml
<TASK>
Find implementation evidence in the code for each specification item. Prefer exact implementing functions, branches, data structures, and output fields. Focus on semantic matches, not shared words.
</TASK>

<CONTEXT>
...
</CONTEXT>
<QUERY>
...
</QUERY>
```

The task block is decoded before context and query, but `context_text` and `query_text` in JSON contain only displayed corpora, not wrapper tags or task text. The effective task prompt is recorded in `metadata.input_prompt`.

## Flow
With `--per-file`:
1. Build markdown query items once.
2. Tokenize each query-item prompt. The prompt contains heading/list hierarchy plus the active item.
3. Split each context file into token-budgeted windows when needed.
4. For each context window, decode `<TASK>` if present, `<CONTEXT>`, the window contents, `</CONTEXT>`, and `<QUERY>` to fill KV cache.
5. For each batch of markdown query items, copy the shared context-prefix KV into independent sequence IDs, decode those item prompts together, and capture `kq_soft_max-<layer>` for selected layers.
6. Map active item tokens to one query row and context tokens to context columns.
7. Average selected layers and heads.
8. Sink-mask context columns with outlier high column-median unless disabled.
9. In per-file mode, keep absolute context-attention mass per window; do not row-normalize across only that window.
10. Append window columns to global JSON state. Write partial output after each processed context file, then write final output.

Query token `i` reads attention from row `i - 1`. Causal next-token shift.

## Score Contract
Per-file markdown mode:
```text
scores[query_item][context_token]
```

`scores.length == query_chunks.length`.
`scores[i].length == context_chunks.length`.

Legacy single-window mode:
```text
scores[query_token][context_token]
```

High = looked more. Zero = no captured or mapped attention.

Per-file scores are not globally row-normalized after each window; this preserves absolute mass so sparse windows do not become 100%. Legacy single-window scores are row-normalized, then adjusted by an attention prior across rows.

## JSON Contract
`heatmap.json`:
- `context_text`, `query_text`: displayed corpora.
- `context_chunks`: context token chunks.
- `query_chunks`: markdown item chunks in per-file mode; token chunks in legacy single-window mode.
- `scores`: matrix.
- `head_scores`, `layer_scores`: currently empty arrays.
- `metadata`: backend, model path, mode flags, selected layers, and mode-specific fields.

Per-file metadata includes `per_file`, `query_items_count`, `query_chunks_count`, `query_chunk_mode`, `query_segment`, `context_segment`, `phrase_tokens`, `llm_batch_size`, `files_total`, `files_done`, `write_every_docs`, `dump_inputs_dir`, `dumped_inputs`, `score_prune_top_k`, `input_prompt`, and `layers`.
Legacy metadata includes `score_prune_top_k`, `sink_normalization`, `flash_attn`, `input_prompt`, and `layers`.

Image mode metadata includes `mode: "image"`, `mmproj`, `prompt_rows`,
`prompt_capture_strategy`, `captured_prompt_text`, `prompt_text_tokens`,
`post_image_text_tokens`, prompt match offsets, `image_key_columns`,
`image_query_segment`, `image_heatmap_aggregation`, `sink_normalization`,
`sink_normalization_requested`, and `layers`. Image mode only applies sink
normalization when at least three prompt rows are captured. The top-level
`image` object includes `path`, raster dimensions, patch-grid dimensions,
embedded `data_url`, and `heatmap[grid_y][grid_x]`.

Context chunk:
```json
{ "label": "path:tok_000000", "start": 0, "end": 10, "text": "..." }
```
With `--context-segment phrase`, context chunk labels use `path:phrase_000000` and contain multiple model tokens. Attention is still captured at token level internally, then aggregated into phrase chunks for output.

Query chunk:
```json
{ "label": "path:item_000000", "start": 0, "end": 20, "text": "- requirement" }
```

Legacy query token chunk:
```json
{ "label": "query:tok_000000", "start": 0, "end": 10, "text": "..." }
```

Offsets are char offsets in displayed text.

Displayed `query_text` in per-file mode includes synthetic markdown doc headers. Displayed `context_text` includes synthetic `// === path ===` headers, and split context windows are labeled with `window N/M` in those headers. Wrapper tags and the task prompt are not included in displayed text.

## Scan Mode
Per-file is the intended mode for markdown query items: each context file is split into token-budgeted windows and scanned against all markdown query items. Lower memory. A partial `heatmap.tar.gz` is written after each context file with at least one processed window.

Large context windows can be skipped if they still do not fit beside the largest query-item prompt. Empty context files are skipped.

On Metal, out-of-memory failures usually mean the context size or offload is too high for the selected model and query set. Retry with a smaller context, smaller micro-batch, or partial CPU offload, for example `--ctx-size 8192 --ubatch 128 --gpu-layers 40`.

## Token Cache
Per-content SHA-256 key. Binary file: magic `TOKN`, version, n, tokens, char_start, char_end. Speed only for the same model/tokenizer. The cache key does not include model identity; clear or separate `--cache-dir` when changing models.

## Viewer
`web/explorer.html` loads `web/heatmap.tar.gz` by default. Drop or pick another `.tar.gz`.

Shows query docs first, then source tree. On load it selects the first query doc. Query docs render as full markdown with line numbers and highlighted query items. Source files render token heat with line numbers. Clicking a highlighted query item opens an inline results pane with ranked source spans by summed attention mass. Clicking a highlighted source token shows contributing query chunks.

## Code Map
All in `main.cpp`:
- Markdown query items: `build_markdown_query_set`, `MarkdownQueryItem`, `MarkdownQuerySet`.
- Context token chunks: `token_chunks_from_offsets`.
- Token cache: `tokenize_with_cache`, `load_token_cache`, `save_token_cache`.
- Capture: `eval_callback`.
- Aggregation: `aggregate_captured`.
- Per-file scan: `run_per_file_scan`.
