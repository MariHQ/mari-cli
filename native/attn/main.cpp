#include "llama.h"
#include "ggml.h"
#include "ggml-backend.h"
#include "mtmd.h"
#include "mtmd-helper.h"
#include <omp.h>

#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <zlib.h>

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdarg>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <numeric>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

// -----------------------------------------------------------------------------
// Types and constants

struct Chunk {
    std::string label;
    int start;
    int end;
    std::string text;
};

struct CapturedAttention {
    int layer;
    int n_heads;
    int n_query;
    int n_context;
    std::vector<float> weights; // shape [n_heads, n_query, n_context], row-major
};

struct CaptureTarget {
    int seq_id = 0;
    std::vector<int> query_token_positions;   // causal-shifted, full-sequence positions
    std::unordered_map<int, CapturedAttention> per_layer;
};

struct CaptureContext {
    std::vector<int> context_token_positions; // positions in full sequence
    std::vector<int> query_token_positions;   // causal-shifted, full-sequence positions
    int batch_query_pos_start = 0;            // start position (in full sequence) of current batch
    int batch_query_pos_end = 0;              // exclusive
    std::vector<int> batch_query_positions;   // optional explicit positions for multi-sequence batches
    std::vector<int> batch_query_seq_ids;      // optional explicit seq ids for multi-sequence batches
    std::set<int> selected_layers;
    std::vector<CaptureTarget> * active_targets = nullptr;
    // accumulation: per-layer captured attention (filled across batches)
    std::unordered_map<int, CapturedAttention> per_layer;
};

static const char * kContextOpen = "<CONTEXT>\n";
static const char * kMiddle = "\n</CONTEXT>\n<QUERY>\n";
static const char * kQueryClose = "\n</QUERY>";
static const char * kDefaultInputPrompt =
    "Find implementation evidence in the code for each specification item. "
    "Prefer exact implementing functions, branches, data structures, and output fields. "
    "Focus on semantic matches, not shared words.";

static std::string make_prefix_text(const std::string & input_prompt) {
    if (input_prompt.empty()) return kContextOpen;
    std::string out = "<TASK>\n";
    out += input_prompt;
    if (out.back() != '\n') out += '\n';
    out += "</TASK>\n\n";
    out += kContextOpen;
    return out;
}

struct TokenizedDoc {
    std::vector<llama_token> tokens;
    std::vector<int> char_start;
    std::vector<int> char_end;
};
static TokenizedDoc tokenize_with_offsets(const llama_vocab * vocab, const std::string & text);

static std::string token_piece(const llama_vocab * vocab, llama_token token) {
    char buf[256];
    int n = llama_token_to_piece(vocab, token, buf, sizeof(buf), 0, false);
    if (n >= 0) return std::string(buf, n);
    std::vector<char> big(1024);
    n = llama_token_to_piece(vocab, token, big.data(), (int32_t) big.size(), 0, false);
    if (n >= 0) return std::string(big.data(), n);
    return "";
}

static std::string trim_ascii_whitespace(const std::string & s) {
    size_t b = 0;
    size_t e = s.size();
    while (b < e && std::isspace((unsigned char) s[b])) b++;
    while (e > b && std::isspace((unsigned char) s[e - 1])) e--;
    return s.substr(b, e - b);
}

static std::vector<llama_token> tokenize_plain_tokens(const llama_vocab * vocab, const std::string & text) {
    if (text.empty()) return {};
    std::vector<llama_token> tokens(text.size() + 16);
    int n = llama_tokenize(
        vocab,
        text.data(), (int32_t) text.size(),
        tokens.data(), (int32_t) tokens.size(),
        /*add_special=*/false,
        /*parse_special=*/false
    );
    if (n < 0) {
        tokens.resize((size_t) -n);
        n = llama_tokenize(
            vocab,
            text.data(), (int32_t) text.size(),
            tokens.data(), (int32_t) tokens.size(),
            false, false
        );
    }
    if (n < 0) return {};
    tokens.resize((size_t) n);
    return tokens;
}

static int find_last_token_subsequence(
    const llama_token * haystack,
    size_t haystack_size,
    const std::vector<llama_token> & needle
) {
    if (needle.empty() || haystack_size < needle.size()) return -1;
    for (size_t start_plus_one = haystack_size - needle.size() + 1; start_plus_one > 0; start_plus_one--) {
        size_t start = start_plus_one - 1;
        bool ok = true;
        for (size_t i = 0; i < needle.size(); i++) {
            if (haystack[start + i] != needle[i]) {
                ok = false;
                break;
            }
        }
        if (ok) return (int) start;
    }
    return -1;
}

// -----------------------------------------------------------------------------
// Logging

static void log_line(const char * fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::fprintf(stderr, "[attn-extract] ");
    std::vfprintf(stderr, fmt, ap);
    std::fprintf(stderr, "\n");
    va_end(ap);
}

// -----------------------------------------------------------------------------
// File I/O

static std::string read_file(const std::string & path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        std::fprintf(stderr, "failed to open %s\n", path.c_str());
        std::exit(1);
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static void write_file(const std::string & path, const std::string & content) {
    std::ofstream out(path, std::ios::binary);
    out << content;
}

static bool path_ends_with(const std::string & s, const std::string & suffix) {
    if (suffix.size() > s.size()) return false;
    return std::equal(suffix.rbegin(), suffix.rend(), s.rbegin());
}

static void append_tar_octal(char * dst, size_t width, uint64_t value) {
    std::snprintf(dst, width, "%0*llo", (int) width - 1, (unsigned long long) value);
}

static void write_tar_gz_json(const std::string & path, const std::string & json) {
    gzFile gz = gzopen(path.c_str(), "wb9");
    if (!gz) {
        log_line("failed to open gzip output %s", path.c_str());
        std::exit(1);
    }

    char header[512];
    std::memset(header, 0, sizeof(header));
    const char * name = "heatmap.json";
    std::memcpy(header, name, std::strlen(name));
    append_tar_octal(header + 100, 8, 0644);
    append_tar_octal(header + 108, 8, 0);
    append_tar_octal(header + 116, 8, 0);
    append_tar_octal(header + 124, 12, (uint64_t) json.size());
    append_tar_octal(header + 136, 12, 0);
    std::memset(header + 148, ' ', 8);
    header[156] = '0';
    std::memcpy(header + 257, "ustar", 5);
    std::memcpy(header + 263, "00", 2);

    unsigned int checksum = 0;
    for (unsigned char c : header) checksum += c;
    std::snprintf(header + 148, 8, "%06o", checksum);
    header[154] = '\0';
    header[155] = ' ';

    if (gzwrite(gz, header, sizeof(header)) != (int) sizeof(header)) {
        log_line("failed to write tar header to %s", path.c_str());
        gzclose(gz);
        std::exit(1);
    }
    if (!json.empty() && gzwrite(gz, json.data(), (unsigned int) json.size()) != (int) json.size()) {
        log_line("failed to write json payload to %s", path.c_str());
        gzclose(gz);
        std::exit(1);
    }

    size_t padding = (512 - (json.size() % 512)) % 512;
    if (padding > 0) {
        char zeros[512] = {0};
        if (gzwrite(gz, zeros, (unsigned int) padding) != (int) padding) {
            log_line("failed to write tar padding to %s", path.c_str());
            gzclose(gz);
            std::exit(1);
        }
    }
    char end_blocks[1024] = {0};
    if (gzwrite(gz, end_blocks, sizeof(end_blocks)) != (int) sizeof(end_blocks)) {
        log_line("failed to write tar footer to %s", path.c_str());
        gzclose(gz);
        std::exit(1);
    }
    if (gzclose(gz) != Z_OK) {
        log_line("failed to close gzip output %s", path.c_str());
        std::exit(1);
    }
}

static void write_heatmap_output(const std::string & path, const std::string & json) {
    if (path_ends_with(path, ".tar.gz") || path_ends_with(path, ".tgz")) {
        write_tar_gz_json(path, json);
        return;
    }
    log_line("output path must end in .tar.gz or .tgz: %s", path.c_str());
    std::exit(1);
}

static std::string lowercase(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
        return (char) std::tolower(c);
    });
    return s;
}

static std::string mime_type_for_path(const std::string & path) {
    std::string p = lowercase(path);
    if (path_ends_with(p, ".jpg") || path_ends_with(p, ".jpeg")) return "image/jpeg";
    if (path_ends_with(p, ".png")) return "image/png";
    if (path_ends_with(p, ".gif")) return "image/gif";
    if (path_ends_with(p, ".bmp")) return "image/bmp";
    if (path_ends_with(p, ".webp")) return "image/webp";
    return "application/octet-stream";
}

static std::string base64_encode(const std::string & bytes) {
    static const char table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        uint32_t v = (uint32_t) (unsigned char) bytes[i] << 16;
        bool have_b = i + 1 < bytes.size();
        bool have_c = i + 2 < bytes.size();
        if (have_b) v |= (uint32_t) (unsigned char) bytes[i + 1] << 8;
        if (have_c) v |= (uint32_t) (unsigned char) bytes[i + 2];
        out.push_back(table[(v >> 18) & 63]);
        out.push_back(table[(v >> 12) & 63]);
        out.push_back(have_b ? table[(v >> 6) & 63] : '=');
        out.push_back(have_c ? table[v & 63] : '=');
    }
    return out;
}

// -----------------------------------------------------------------------------
// Text preprocessing

static std::string collapse_whitespace(const std::string & text) {
    std::string s = std::regex_replace(text, std::regex("[ \\t]+\\n"), "\n");
    s = std::regex_replace(s, std::regex("\\n{3,}"), "\n\n");
    // trim
    size_t start = s.find_first_not_of(" \t\n\r");
    if (start == std::string::npos) return "\n";
    size_t end = s.find_last_not_of(" \t\n\r");
    return s.substr(start, end - start + 1) + "\n";
}

static std::string strip_python(const std::string & text) {
    // Triple-quoted strings (greedy across newlines).
    std::string s = std::regex_replace(text, std::regex("\"\"\"[\\s\\S]*?\"\"\""), "");
    s = std::regex_replace(s, std::regex("'''[\\s\\S]*?'''"), "");
    // Line comments. Naive — strips `#` inside string literals too, acceptable for attribution.
    s = std::regex_replace(s, std::regex("(?:^|[\\t ])#.*$", std::regex::multiline), "");
    return collapse_whitespace(s);
}

static std::string strip_text(const std::string & text, const std::string & mode) {
    if (mode == "none" || mode.empty()) return text;
    if (mode == "whitespace") return collapse_whitespace(text);
    if (mode == "python") return strip_python(text);
    log_line("unknown strip mode: %s", mode.c_str());
    std::exit(1);
}

// -----------------------------------------------------------------------------
// SHA-256, directory walking, token cache

static std::string sha256_hex(const std::string & data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.data(), (CC_LONG) data.size(), digest);
    char buf[CC_SHA256_DIGEST_LENGTH * 2 + 1];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        snprintf(buf + i * 2, 3, "%02x", digest[i]);
    }
    return std::string(buf, CC_SHA256_DIGEST_LENGTH * 2);
}

static bool ends_with(const std::string & s, const std::string & suffix) {
    if (suffix.size() > s.size()) return false;
    return std::equal(suffix.rbegin(), suffix.rend(), s.rbegin());
}

static void walk_directory(
    const std::string & root,
    const std::string & extension,
    std::vector<std::string> & out
) {
    DIR * d = opendir(root.c_str());
    if (!d) return;
    struct dirent * entry;
    std::vector<std::string> subdirs;
    while ((entry = readdir(d))) {
        std::string name = entry->d_name;
        if (name == "." || name == "..") continue;
        std::string path = root + "/" + name;
        struct stat st;
        if (stat(path.c_str(), &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            // Skip common large/uninteresting dirs.
            if (name == "node_modules" || name == ".git" || name == "dist" || name == "build") continue;
            subdirs.push_back(path);
        } else if (S_ISREG(st.st_mode) && ends_with(name, extension)) {
            out.push_back(path);
        }
    }
    closedir(d);
    std::sort(subdirs.begin(), subdirs.end());
    for (auto & sd : subdirs) walk_directory(sd, extension, out);
}

static std::string ensure_dir(const std::string & path) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0) {
        mkdir(path.c_str(), 0755);
    }
    return path;
}

static std::string safe_filename_part(const std::string & raw) {
    std::string out;
    out.reserve(raw.size());
    for (unsigned char c : raw) {
        if (std::isalnum(c) || c == '.' || c == '-' || c == '_') out.push_back((char) c);
        else out.push_back('_');
    }
    while (!out.empty() && out.front() == '_') out.erase(out.begin());
    while (!out.empty() && out.back() == '_') out.pop_back();
    if (out.empty()) out = "item";
    if (out.size() > 120) out.resize(120);
    return out;
}

static std::string dump_input_filename(
    const std::string & dir,
    size_t index,
    const std::string & context_label,
    size_t window_index,
    const std::string & query_label
) {
    char prefix[64];
    std::snprintf(prefix, sizeof(prefix), "%06zu__", index);
    char win[32];
    std::snprintf(win, sizeof(win), "__w%04zu__", window_index + 1);
    return dir + "/" + prefix + safe_filename_part(context_label) + win + safe_filename_part(query_label) + ".txt";
}

// On-disk format for cached file tokens:
//   magic "TOKN" (4) | version (u32) | n_tokens (u32) |
//   tokens (i32 * n_tokens) | char_start (i32 * n_tokens) | char_end (i32 * n_tokens)
static constexpr uint32_t kTokenCacheMagic = 0x544f4b4eU;
static constexpr uint32_t kTokenCacheVersion = 1;

struct CachedTokens {
    std::vector<llama_token> tokens;
    std::vector<int> char_start;
    std::vector<int> char_end;
};

static std::vector<Chunk> token_chunks_from_offsets(
    const std::string & text,
    const CachedTokens & ct,
    const std::string & prefix
) {
    std::vector<Chunk> chunks;
    chunks.reserve(ct.tokens.size());
    for (size_t i = 0; i < ct.tokens.size(); i++) {
        int start = ct.char_start[i];
        int end = ct.char_end[i];
        if (start < 0) start = 0;
        if (end < start) end = start;
        if (start > (int) text.size()) start = (int) text.size();
        if (end > (int) text.size()) end = (int) text.size();
        if (end <= start) continue;
        std::string token_text = text.substr(start, end - start);
        if (token_text.empty()) continue;
        char label[64];
        std::snprintf(label, sizeof(label), ":tok_%06zu", chunks.size());
        chunks.push_back({prefix + label, start, end, token_text});
    }
    return chunks;
}

static bool phrase_boundary_text(const std::string & token_text) {
    for (unsigned char c : token_text) {
        if (c == '\n' || c == '.' || c == ',' || c == ';' || c == ':' || c == '!' || c == '?' || c == ')' || c == ']') {
            return true;
        }
    }
    return false;
}

static std::vector<Chunk> phrase_chunks_from_offsets(
    const std::string & text,
    const CachedTokens & ct,
    const std::string & prefix,
    int target_tokens
) {
    std::vector<Chunk> chunks;
    target_tokens = std::max(1, target_tokens);

    int chunk_start = -1;
    int chunk_end = -1;
    int n_tokens = 0;
    for (size_t i = 0; i < ct.tokens.size(); i++) {
        int start = ct.char_start[i];
        int end = ct.char_end[i];
        if (start < 0) start = 0;
        if (end < start) end = start;
        if (start > (int) text.size()) start = (int) text.size();
        if (end > (int) text.size()) end = (int) text.size();
        if (end <= start) continue;

        std::string token_text = text.substr(start, end - start);
        if (token_text.empty()) continue;
        if (chunk_start < 0) chunk_start = start;
        chunk_end = end;
        n_tokens++;

        bool should_flush = n_tokens >= target_tokens && phrase_boundary_text(token_text);
        should_flush = should_flush || n_tokens >= target_tokens * 2;
        if (!should_flush) continue;

        char label[64];
        std::snprintf(label, sizeof(label), ":phrase_%06zu", chunks.size());
        chunks.push_back({prefix + label, chunk_start, chunk_end, text.substr(chunk_start, chunk_end - chunk_start)});
        chunk_start = -1;
        chunk_end = -1;
        n_tokens = 0;
    }

    if (chunk_start >= 0 && chunk_end > chunk_start) {
        char label[64];
        std::snprintf(label, sizeof(label), ":phrase_%06zu", chunks.size());
        chunks.push_back({prefix + label, chunk_start, chunk_end, text.substr(chunk_start, chunk_end - chunk_start)});
    }
    return chunks;
}

struct MarkdownQueryItem {
    std::string rel_path;
    std::string label;
    std::string prompt_text;
    std::string text;
    int active_start;  // char offsets in prompt_text
    int active_end;
    int display_start; // char offsets in displayed query_text
    int display_end;
    int query_chunk_start = 0;
    int query_chunk_count = 1;
    CachedTokens ct;   // prompt_text + kQueryClose
};

struct MarkdownQuerySet {
    std::string text;
    std::vector<Chunk> chunks;
    std::vector<MarkdownQueryItem> items;
};

static int markdown_indent_width(const std::string & line) {
    int n = 0;
    for (char c : line) {
        if (c == ' ') n++;
        else if (c == '\t') n += 4;
        else break;
    }
    return n;
}

static bool markdown_fence_line(const std::string & line) {
    size_t i = 0;
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) i++;
    return line.compare(i, 3, "```") == 0 || line.compare(i, 3, "~~~") == 0;
}

static bool ascii_space(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static bool sentence_closer_byte(unsigned char c) {
    return c == '"' || c == '\'' || c == ')' || c == ']' || c == '}';
}

static std::vector<std::pair<size_t, size_t>> sentence_ranges(const std::string & text) {
    std::vector<std::pair<size_t, size_t>> ranges;
    size_t start = 0;
    while (start < text.size() && ascii_space((unsigned char) text[start])) start++;

    for (size_t i = start; i < text.size(); i++) {
        unsigned char c = (unsigned char) text[i];
        if (c != '.' && c != '!' && c != '?') continue;

        size_t end = i + 1;
        while (end < text.size()) {
            unsigned char ec = (unsigned char) text[end];
            if (sentence_closer_byte(ec)) {
                end++;
                continue;
            }
            // UTF-8 curly quotes and similar punctuation are non-ASCII bytes.
            if (ec >= 0x80) {
                end++;
                continue;
            }
            break;
        }

        if (end < text.size() && !ascii_space((unsigned char) text[end])) continue;

        size_t trimmed_end = end;
        while (trimmed_end > start && ascii_space((unsigned char) text[trimmed_end - 1])) trimmed_end--;
        if (trimmed_end > start) ranges.push_back({start, trimmed_end});

        start = end;
        while (start < text.size() && ascii_space((unsigned char) text[start])) start++;
        i = start > 0 ? start - 1 : 0;
    }

    size_t trimmed_end = text.size();
    while (trimmed_end > start && ascii_space((unsigned char) text[trimmed_end - 1])) trimmed_end--;
    if (trimmed_end > start) ranges.push_back({start, trimmed_end});
    if (ranges.empty() && !text.empty()) ranges.push_back({0, text.size()});
    return ranges;
}

static void append_active_token_chunks(
    MarkdownQuerySet & query_set,
    MarkdownQueryItem & item,
    int phrase_tokens = 1
) {
    item.query_chunk_start = (int) query_set.chunks.size();
    item.query_chunk_count = 0;
    int chunk_start = -1;
    int chunk_end = -1;
    int n_tokens = 0;

    auto flush_phrase = [&]() {
        if (chunk_start < 0 || chunk_end <= chunk_start) return;
        int local_start = chunk_start - item.active_start;
        int local_end = chunk_end - item.active_start;
        if (local_start < 0) local_start = 0;
        if (local_end > (int) item.text.size()) local_end = (int) item.text.size();
        if (local_end <= local_start) return;

        char suffix[64];
        const char * kind = phrase_tokens > 1 ? "phrase" : "tok";
        std::snprintf(suffix, sizeof(suffix), ":%s_%06zu", kind, query_set.chunks.size());
        Chunk chunk;
        chunk.label = item.rel_path + suffix;
        chunk.start = item.display_start + local_start;
        chunk.end = item.display_start + local_end;
        chunk.text = item.text.substr(local_start, local_end - local_start);
        query_set.chunks.push_back(std::move(chunk));
        item.query_chunk_count++;
    };

    phrase_tokens = std::max(1, phrase_tokens);
    for (size_t i = 0; i < item.ct.tokens.size(); i++) {
        int start = item.ct.char_start[i];
        int end = item.ct.char_end[i];
        if (end <= item.active_start || start >= item.active_end) continue;
        start = std::max(start, item.active_start);
        end = std::min(end, item.active_end);
        if (end <= start) continue;

        std::string token_text = item.prompt_text.substr(start, end - start);
        if (chunk_start < 0) chunk_start = start;
        chunk_end = end;
        n_tokens++;

        bool should_flush = phrase_tokens == 1;
        should_flush = should_flush || (n_tokens >= phrase_tokens && phrase_boundary_text(token_text));
        should_flush = should_flush || n_tokens >= phrase_tokens * 2;
        if (!should_flush) continue;
        flush_phrase();
        chunk_start = -1;
        chunk_end = -1;
        n_tokens = 0;
    }
    flush_phrase();
}

static MarkdownQuerySet build_markdown_query_set(
    const std::vector<std::string> & paths,
    const std::string & root,
    const std::string & strip_mode,
    const std::string & segment_mode
) {
    MarkdownQuerySet out;
    std::regex heading_re(R"(^\s{0,3}(#{1,6})\s+(.+)$)");
    std::regex list_item_re(R"(^(\s*)(?:[-*+]\s+|\d+[.)]\s+).+\S.*$)");
    std::regex block_item_re(R"(^\s{0,3}>\s*\S.*$)");

    struct Ancestor {
        int indent;
        std::string line;
    };

    for (auto & p : paths) {
        std::string rel = root.empty()
            ? p
            : p.substr(root.size() + (root.back() == '/' ? 0 : 1));
        std::string content = strip_text(read_file(p), strip_mode);
        if (content.empty() || content == "\n") continue;

        std::string header = "\n## === " + rel + " ===\n";
        out.text += header;
        int doc_offset = (int) out.text.size();
        out.text += content;

        if (segment_mode == "document_tokens" || segment_mode == "phrase") {
            MarkdownQueryItem item;
            item.rel_path = rel;
            item.label = rel + ":document";
            item.prompt_text = content;
            if (!item.prompt_text.empty() && item.prompt_text.back() != '\n') item.prompt_text += '\n';
            item.text = content;
            item.active_start = 0;
            item.active_end = (int) content.size();
            item.display_start = doc_offset;
            item.display_end = doc_offset + (int) content.size();
            item.query_chunk_start = (int) out.chunks.size();
            item.query_chunk_count = 0;
            out.items.push_back(std::move(item));
            continue;
        }

        std::vector<std::string> headings;
        std::vector<Ancestor> list_stack;
        auto is_blank = [](const std::string & s) {
            return s.find_first_not_of(" \t\r") == std::string::npos;
        };
        auto emit_item = [&](const std::string & text, size_t item_start, size_t item_end) {
            std::vector<std::string> prompt_lines;
            prompt_lines.insert(prompt_lines.end(), headings.begin(), headings.end());
            for (auto & a : list_stack) prompt_lines.push_back(a.line);
            int active_start = 0;
            for (auto & pl : prompt_lines) active_start += (int) pl.size() + 1;

            std::string prompt;
            for (auto & pl : prompt_lines) {
                prompt += pl;
                prompt += '\n';
            }
            prompt += text;
            prompt += '\n';

            char suffix[32];
            std::snprintf(suffix, sizeof(suffix), ":item_%06zu", out.items.size());
            std::string label = rel + suffix;
            int display_start = doc_offset + (int) item_start;
            int display_end = doc_offset + (int) item_end;

            MarkdownQueryItem item;
            item.rel_path = rel;
            item.label = label;
            item.prompt_text = prompt;
            item.text = text;
            item.active_start = active_start;
            item.active_end = active_start + (int) text.size();
            item.display_start = display_start;
            item.display_end = display_end;
            item.query_chunk_start = (int) out.chunks.size();
            item.query_chunk_count = 1;
            out.items.push_back(std::move(item));
            out.chunks.push_back({label, display_start, display_end, text});
        };
        auto emit_segmented_item = [&](const std::string & text, size_t item_start, size_t item_end) {
            if (segment_mode != "sentence") {
                emit_item(text, item_start, item_end);
                return;
            }
            for (auto & r : sentence_ranges(text)) {
                emit_item(text.substr(r.first, r.second - r.first),
                          item_start + r.first,
                          item_start + r.second);
            }
        };

        size_t cursor = 0;
        while (cursor < content.size()) {
            size_t line_start = cursor;
            size_t line_end = content.find('\n', cursor);
            if (line_end == std::string::npos) line_end = content.size();
            else line_end += 1;
            size_t content_end = line_end;
            while (content_end > line_start && (content[content_end - 1] == '\n' || content[content_end - 1] == '\r')) {
                content_end--;
            }

            std::string line = content.substr(line_start, content_end - line_start);
            if (markdown_fence_line(line)) {
                size_t block_start = line_start;
                size_t block_content_end = content_end;
                size_t next = line_end;
                while (next < content.size()) {
                    size_t inner_start = next;
                    size_t inner_end = content.find('\n', next);
                    if (inner_end == std::string::npos) inner_end = content.size();
                    else inner_end += 1;
                    size_t inner_content_end = inner_end;
                    while (inner_content_end > inner_start &&
                           (content[inner_content_end - 1] == '\n' || content[inner_content_end - 1] == '\r')) {
                        inner_content_end--;
                    }
                    std::string inner_line = content.substr(inner_start, inner_content_end - inner_start);
                    block_content_end = inner_content_end;
                    next = inner_end;
                    if (markdown_fence_line(inner_line)) break;
                }
                emit_item(content.substr(block_start, block_content_end - block_start),
                          block_start, block_content_end);
                cursor = next;
                continue;
            }
            if (is_blank(line)) {
                list_stack.clear();
                cursor = line_end;
                continue;
            }

            std::smatch m;
            if (std::regex_match(line, m, heading_re)) {
                int level = (int) m[1].str().size();
                if ((int) headings.size() >= level) headings.resize(level - 1);
                headings.push_back(line);
                list_stack.clear();
                cursor = line_end;
                continue;
            }

            bool is_list_item = std::regex_match(line, m, list_item_re);
            bool is_block_item = std::regex_match(line, block_item_re);
            if (is_list_item || is_block_item) {
                int indent = is_list_item ? markdown_indent_width(m[1].str()) : 0;
                while (!list_stack.empty() && list_stack.back().indent >= indent) {
                    list_stack.pop_back();
                }

                emit_segmented_item(line, line_start, content_end);
                list_stack.push_back({indent, line});
                cursor = line_end;
                continue;
            }

            size_t paragraph_start = line_start;
            size_t paragraph_content_end = content_end;
            size_t next = line_end;
            while (next < content.size()) {
                size_t para_line_start = next;
                size_t para_line_end = content.find('\n', next);
                if (para_line_end == std::string::npos) para_line_end = content.size();
                else para_line_end += 1;
                size_t para_content_end = para_line_end;
                while (para_content_end > para_line_start &&
                       (content[para_content_end - 1] == '\n' || content[para_content_end - 1] == '\r')) {
                    para_content_end--;
                }
                std::string para_line = content.substr(para_line_start, para_content_end - para_line_start);
                std::smatch para_match;
                if (is_blank(para_line) ||
                    markdown_fence_line(para_line) ||
                    std::regex_match(para_line, para_match, heading_re) ||
                    std::regex_match(para_line, para_match, list_item_re) ||
                    std::regex_match(para_line, para_match, block_item_re)) {
                    break;
                }
                paragraph_content_end = para_content_end;
                next = para_line_end;
            }

            emit_segmented_item(content.substr(paragraph_start, paragraph_content_end - paragraph_start),
                                paragraph_start, paragraph_content_end);
            list_stack.clear();
            cursor = next;
        }
    }

    return out;
}

static bool load_token_cache(const std::string & path, CachedTokens & out) {
    FILE * f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    uint32_t magic = 0, version = 0, n = 0;
    if (std::fread(&magic, 4, 1, f) != 1 || magic != kTokenCacheMagic) { std::fclose(f); return false; }
    if (std::fread(&version, 4, 1, f) != 1 || version != kTokenCacheVersion) { std::fclose(f); return false; }
    if (std::fread(&n, 4, 1, f) != 1) { std::fclose(f); return false; }
    out.tokens.assign(n, 0);
    out.char_start.assign(n, 0);
    out.char_end.assign(n, 0);
    if (std::fread(out.tokens.data(), sizeof(llama_token), n, f) != n) { std::fclose(f); return false; }
    if (std::fread(out.char_start.data(), sizeof(int), n, f) != n) { std::fclose(f); return false; }
    if (std::fread(out.char_end.data(), sizeof(int), n, f) != n) { std::fclose(f); return false; }
    std::fclose(f);
    return true;
}

static void save_token_cache(const std::string & path, const CachedTokens & ct) {
    FILE * f = std::fopen(path.c_str(), "wb");
    if (!f) { log_line("warning: cannot write cache %s", path.c_str()); return; }
    uint32_t magic = kTokenCacheMagic, version = kTokenCacheVersion;
    uint32_t n = (uint32_t) ct.tokens.size();
    std::fwrite(&magic, 4, 1, f);
    std::fwrite(&version, 4, 1, f);
    std::fwrite(&n, 4, 1, f);
    std::fwrite(ct.tokens.data(), sizeof(llama_token), n, f);
    std::fwrite(ct.char_start.data(), sizeof(int), n, f);
    std::fwrite(ct.char_end.data(), sizeof(int), n, f);
    std::fclose(f);
}

static CachedTokens tokenize_with_cache(
    const llama_vocab * vocab,
    const std::string & text,
    const std::string & cache_path
) {
    CachedTokens ct;
    if (!cache_path.empty() && load_token_cache(cache_path, ct)) {
        return ct;
    }
    auto doc = tokenize_with_offsets(vocab, text);
    ct.tokens = doc.tokens;
    ct.char_start = doc.char_start;
    ct.char_end = doc.char_end;
    if (!cache_path.empty()) save_token_cache(cache_path, ct);
    return ct;
}

// -----------------------------------------------------------------------------
// Multi-file corpus composer
//
// Concatenates many source files into one "context corpus" inside the same
// <CONTEXT>...</CONTEXT><QUERY>...</QUERY> wrapper. Each file's tokens come
// from the per-file cache (so adding/removing files only re-tokenizes deltas).
// Chunks are computed per-file and shifted into corpus coordinates.

struct ContextFile {
    std::string path;
    std::string rel_path;   // relative to source tree root, used for chunk labels
    std::string content;
    int corpus_offset;      // char position of this file's content in corpus
    std::vector<Chunk> chunks; // file-local, will be shifted to corpus coords on aggregation
};

struct ComposedInput {
    std::vector<llama_token> tokens;
    std::vector<int> char_start; // per token, absolute in composed text
    std::vector<int> char_end;
    int context_body_start;
    int context_body_end;
    int query_body_start;
    int query_body_end;
    std::vector<Chunk> context_chunks_corpus; // chunks in corpus coordinates
};

static std::string make_file_header(const std::string & rel_path) {
    return "\n// === " + rel_path + " ===\n";
}

// -----------------------------------------------------------------------------
// Tokenization with char offsets

static TokenizedDoc tokenize_with_offsets(
    const llama_vocab * vocab,
    const std::string & text
) {
    TokenizedDoc out;

    // First, tokenize without special tokens. add_special=false, parse_special=false.
    std::vector<llama_token> tokens(text.size() + 16);
    int n = llama_tokenize(
        vocab,
        text.data(), (int32_t) text.size(),
        tokens.data(), (int32_t) tokens.size(),
        /*add_special=*/false,
        /*parse_special=*/false
    );
    if (n < 0) {
        tokens.resize(-n);
        n = llama_tokenize(
            vocab,
            text.data(), (int32_t) text.size(),
            tokens.data(), (int32_t) tokens.size(),
            false, false
        );
    }
    tokens.resize(n);
    out.tokens = tokens;
    out.char_start.reserve(n);
    out.char_end.reserve(n);

    size_t cursor = 0;
    for (auto token : tokens) {
        char buf[256];
        int piece_n = llama_token_to_piece(vocab, token, buf, sizeof(buf), 0, false);
        if (piece_n < 0) {
            // try larger buffer
            std::vector<char> big(1024);
            piece_n = llama_token_to_piece(vocab, token, big.data(), (int32_t) big.size(), 0, false);
            if (piece_n < 0) {
                out.char_start.push_back((int) cursor);
                out.char_end.push_back((int) cursor);
                continue;
            }
            std::string piece(big.data(), piece_n);
            size_t pos = text.find(piece, cursor);
            if (pos == std::string::npos) pos = cursor;
            out.char_start.push_back((int) pos);
            out.char_end.push_back((int) (pos + piece.size()));
            cursor = pos + piece.size();
            continue;
        }
        std::string piece(buf, piece_n);
        size_t pos = text.find(piece, cursor);
        if (pos == std::string::npos) {
            // Mismatch (e.g., special-token piece). Best-effort: keep cursor.
            out.char_start.push_back((int) cursor);
            out.char_end.push_back((int) cursor);
            continue;
        }
        out.char_start.push_back((int) pos);
        out.char_end.push_back((int) (pos + piece.size()));
        cursor = pos + piece.size();
    }

    return out;
}

// -----------------------------------------------------------------------------
// Chunk → token-index map

static std::vector<int> token_indices_for_range(
    const TokenizedDoc & doc,
    int region_start,
    int region_end
) {
    std::vector<int> out;
    for (int i = 0; i < (int) doc.tokens.size(); i++) {
        int ts = doc.char_start[i];
        int te = doc.char_end[i];
        if (ts == te) continue;
        if (te > region_start && ts < region_end) out.push_back(i);
    }
    return out;
}

static std::vector<int> token_to_chunk_map(
    const TokenizedDoc & doc,
    const std::vector<Chunk> & chunks
) {
    // For each token, the index of the chunk that contains it, or -1.
    std::vector<int> mapping(doc.tokens.size(), -1);

    // Build a sorted index by chunk.start.
    std::vector<int> order(chunks.size());
    std::iota(order.begin(), order.end(), 0);
    std::sort(order.begin(), order.end(), [&](int a, int b) {
        return chunks[a].start < chunks[b].start;
    });

    size_t cursor = 0; // index into order
    for (size_t i = 0; i < doc.tokens.size(); i++) {
        int ts = doc.char_start[i];
        int te = doc.char_end[i];
        if (ts == te) continue;
        while (cursor < order.size() && chunks[order[cursor]].end <= ts) cursor++;
        if (cursor >= order.size()) break;
        const auto & c = chunks[order[cursor]];
        if (c.start < te && c.end > ts) {
            mapping[i] = order[cursor];
        }
    }
    return mapping;
}

// -----------------------------------------------------------------------------
// Attention capture callback

struct CallbackUserData {
    CaptureContext * cap;
};

static bool eval_callback(struct ggml_tensor * t, bool ask, void * user_data) {
    auto * ud = static_cast<CallbackUserData *>(user_data);
    auto & cap = *ud->cap;

    const char * name = t->name;
    if (!name) return false;

    // Filter `kq_soft_max-<il>`.
    static const std::regex re("^kq_soft_max-(\\d+)$");
    std::cmatch m;
    if (!std::regex_match(name, m, re)) return false;

    int layer = std::atoi(m[1].first);
    if (cap.selected_layers.count(layer) == 0) return false;

    if (ask) return true;

    // Tensor shape: ne0 = n_kv (context size in cache), ne1 = n_tokens (this batch),
    // ne2 = n_head, ne3 = 1. Memory: ne0 fastest-varying.
    int64_t n_kv = t->ne[0];
    int64_t n_tokens = t->ne[1];
    int64_t n_heads = t->ne[2];

    size_t bytes = ggml_nbytes(t);
    std::vector<float> host(bytes / sizeof(float));
    ggml_backend_tensor_get(t, host.data(), 0, bytes);

    if (t->type != GGML_TYPE_F32) {
        // We pass F32 prec on softmax; assume F32. If not, would need a conversion.
        log_line("warning: tensor %s is not f32 (type=%d)", name, t->type);
    }

    // For this batch, the global token positions of the rows are
    // [batch_query_pos_start .. batch_query_pos_end).
    // We need rows corresponding to causal-shifted query positions in
    // cap.query_token_positions whose value is in [batch_query_pos_start, batch_query_pos_end).
    // Columns: keep only the context positions in cap.context_token_positions
    // (these are <= cache extent so always present in n_kv).

    // Map context token positions → column indices in this tensor.
    // Cols correspond to positions [0, n_kv). cap.context_token_positions are
    // all < cap.batch_query_pos_start (since context precedes query).
    // For each context pos, col = position.
    std::vector<int> ctx_cols;
    ctx_cols.reserve(cap.context_token_positions.size());
    for (int p : cap.context_token_positions) {
        if (p >= 0 && p < n_kv) ctx_cols.push_back(p);
        else ctx_cols.push_back(-1); // shouldn't happen for context
    }

    auto capture_rows = [&](CaptureTarget & target, int64_t q_local, int row_out) {
        auto & per_layer = target.per_layer[layer];
        if (per_layer.layer == 0 && per_layer.weights.empty()) {
            // Initialize.
            per_layer.layer = layer;
            per_layer.n_heads = (int) n_heads;
            per_layer.n_query = (int) target.query_token_positions.size();
            per_layer.n_context = (int) cap.context_token_positions.size();
            per_layer.weights.assign((size_t) n_heads * per_layer.n_query * per_layer.n_context, 0.0f);
        }
        for (int h = 0; h < (int) n_heads; h++) {
            // offset in host: h * n_tokens * n_kv + q_local * n_kv + ...
            size_t base = (size_t) h * n_tokens * n_kv + (size_t) q_local * n_kv;
            float * row_data = host.data() + base;
            for (int c = 0; c < (int) ctx_cols.size(); c++) {
                int col = ctx_cols[c];
                if (col < 0) continue;
                size_t out_idx = (size_t) h * per_layer.n_query * per_layer.n_context
                                + (size_t) row_out * per_layer.n_context + c;
                per_layer.weights[out_idx] = row_data[col];
            }
        }
    };

    if (cap.active_targets) {
        std::unordered_map<int, int> target_by_seq;
        target_by_seq.reserve(cap.active_targets->size());
        std::vector<std::unordered_map<int, int>> qpos_to_local(cap.active_targets->size());
        for (int ti = 0; ti < (int) cap.active_targets->size(); ti++) {
            auto & target = (*cap.active_targets)[ti];
            target_by_seq[target.seq_id] = ti;
            auto & m_local = qpos_to_local[ti];
            m_local.reserve(target.query_token_positions.size());
            for (int i = 0; i < (int) target.query_token_positions.size(); i++) {
                m_local[target.query_token_positions[i]] = i;
            }
        }

        for (int64_t q_local = 0; q_local < n_tokens; q_local++) {
            if (q_local >= (int64_t) cap.batch_query_positions.size() ||
                q_local >= (int64_t) cap.batch_query_seq_ids.size()) {
                continue;
            }
            int seq_id = cap.batch_query_seq_ids[(size_t) q_local];
            auto tit = target_by_seq.find(seq_id);
            if (tit == target_by_seq.end()) continue;
            int target_idx = tit->second;
            int global_pos = cap.batch_query_positions[(size_t) q_local];
            auto qit = qpos_to_local[target_idx].find(global_pos);
            if (qit == qpos_to_local[target_idx].end()) continue;
            capture_rows((*cap.active_targets)[target_idx], q_local, qit->second);
        }
        return true;
    }

    CaptureTarget single;
    single.seq_id = 0;
    single.query_token_positions = cap.query_token_positions;
    single.per_layer.swap(cap.per_layer);

    // For each row of this batch (q_local in [0, n_tokens)), its global position
    // is cap.batch_query_pos_start + q_local. If that global position is in our
    // query_token_positions, store.
    std::unordered_map<int, int> qpos_to_local;
    qpos_to_local.reserve(single.query_token_positions.size());
    for (int i = 0; i < (int) single.query_token_positions.size(); i++) {
        qpos_to_local[single.query_token_positions[i]] = i;
    }

    for (int64_t q_local = 0; q_local < n_tokens; q_local++) {
        int global_pos = q_local < (int64_t) cap.batch_query_positions.size()
            ? cap.batch_query_positions[(size_t) q_local]
            : cap.batch_query_pos_start + (int) q_local;
        auto it = qpos_to_local.find(global_pos);
        if (it == qpos_to_local.end()) continue;
        capture_rows(single, q_local, it->second);
    }
    cap.per_layer.swap(single.per_layer);

    return true;
}

// -----------------------------------------------------------------------------
// Aggregation

static void normalize_row(std::vector<float> & row) {
    double sum = 0.0;
    for (float v : row) sum += v;
    if (sum <= 0) {
        std::fill(row.begin(), row.end(), 0.0f);
        return;
    }
    for (auto & v : row) v = (float)(v / sum);
}

static std::vector<std::vector<float>> apply_sink_norm(
    const std::vector<std::vector<float>> & matrix
) {
    // Mask context-key columns with unusually high column-median attention.
    // Preserve absolute mass; windowed scans should not inflate the remaining
    // visible context columns into a full probability distribution.
    if (matrix.empty()) return matrix;
    size_t rows = matrix.size();
    size_t cols = matrix[0].size();
    if (cols == 0) return matrix;

    std::vector<float> col_median(cols, 0.0f);
    for (size_t c = 0; c < cols; c++) {
        std::vector<float> column(rows);
        for (size_t r = 0; r < rows; r++) column[r] = matrix[r][c];
        std::sort(column.begin(), column.end());
        col_median[c] = column[rows / 2];
    }
    double min_positive = 1e-12;
    for (float v : col_median) if (v > 0 && v < min_positive) min_positive = v;
    std::vector<float> logs(cols);
    for (size_t c = 0; c < cols; c++) logs[c] = std::log(col_median[c] + (float)(min_positive / 2.0 + 1e-12));
    double mean = 0;
    for (float v : logs) mean += v;
    mean /= cols;
    double var = 0;
    for (float v : logs) { double d = v - mean; var += d * d; }
    var /= cols;
    double threshold = mean + 3.0 * std::sqrt(var);
    std::vector<bool> sink(cols, false);
    bool any = false;
    for (size_t c = 0; c < cols; c++) if (logs[c] > threshold) { sink[c] = true; any = true; }
    if (!any) return matrix;
    std::vector<std::vector<float>> out(rows, std::vector<float>(cols, 0.0f));
    for (size_t r = 0; r < rows; r++) {
        for (size_t c = 0; c < cols; c++) out[r][c] = sink[c] ? 0.0f : matrix[r][c];
    }
    return out;
}

static std::vector<std::vector<float>> prior_normalize(
    const std::vector<std::vector<float>> & scores,
    double power = 0.75,
    int min_rows = 3
) {
    if ((int) scores.size() < min_rows) return scores;
    size_t cols = 0;
    for (auto & row : scores) cols = std::max(cols, row.size());
    if (cols == 0) return scores;
    std::vector<double> priors(cols, 0.0);
    std::vector<int> counts(cols, 0);
    for (auto & row : scores) {
        for (size_t c = 0; c < row.size(); c++) {
            float v = row[c];
            if (std::isfinite(v) && v > 0) {
                priors[c] += v;
                counts[c] += 1;
            }
        }
    }
    for (size_t c = 0; c < cols; c++) priors[c] = counts[c] > 0 ? priors[c] / counts[c] : 0.0;

    std::vector<std::vector<float>> out(scores.size(), std::vector<float>(cols, 0.0f));
    for (size_t r = 0; r < scores.size(); r++) {
        std::vector<float> adjusted(cols, 0.0f);
        for (size_t c = 0; c < scores[r].size(); c++) {
            float v = scores[r][c];
            if (std::isfinite(v) && v > 0 && c < cols && priors[c] > 0) {
                adjusted[c] = (float)(v / std::pow(priors[c], power));
            }
        }
        normalize_row(adjusted);
        out[r] = adjusted;
    }
    return out;
}

static std::vector<std::vector<float>> aggregate_captured(
    const std::vector<CapturedAttention> & per_layer_captures,
    const std::vector<int> & query_local_to_chunk,
    const std::vector<int> & context_local_to_chunk,
    int num_query_chunks,
    int num_context_chunks,
    bool sink_normalization,
    bool global_normalize = true
) {
    // Average all selected layers + heads first.
    if (per_layer_captures.empty()) {
        return std::vector<std::vector<float>>(num_query_chunks, std::vector<float>(num_context_chunks, 0.0f));
    }
    int n_q = per_layer_captures[0].n_query;
    int n_c = per_layer_captures[0].n_context;
    int n_heads = per_layer_captures[0].n_heads;
    std::vector<float> avg((size_t) n_q * n_c, 0.0f);
    double denom = (double) per_layer_captures.size() * n_heads;
    // Parallelize over query rows — each thread owns its slice of `avg`.
    #pragma omp parallel for schedule(static)
    for (int q = 0; q < n_q; q++) {
        size_t out_base = (size_t) q * n_c;
        for (auto & cap : per_layer_captures) {
            for (int h = 0; h < n_heads; h++) {
                size_t in_base = (size_t) h * n_q * n_c + (size_t) q * n_c;
                for (int c = 0; c < n_c; c++) {
                    avg[out_base + c] += cap.weights[in_base + c];
                }
            }
        }
        float inv = (float)(1.0 / denom);
        for (int c = 0; c < n_c; c++) avg[out_base + c] *= inv;
    }

    // Per query chunk: select its rows, sink-norm, mean down to per-token,
    // then scatter total attention mass to context chunks. Do not renormalize
    // over only the visible context columns here; per-window scans need the
    // absolute context-attention mass so sparse windows do not become 100%.
    std::vector<std::vector<float>> result(num_query_chunks, std::vector<float>(num_context_chunks, 0.0f));

    #pragma omp parallel for schedule(dynamic)
    for (int q_chunk = 0; q_chunk < num_query_chunks; q_chunk++) {
        // collect local query row indices
        std::vector<int> rows;
        for (int i = 0; i < (int) query_local_to_chunk.size(); i++) {
            if (query_local_to_chunk[i] == q_chunk) rows.push_back(i);
        }
        if (rows.empty()) continue;

        std::vector<std::vector<float>> sub(rows.size(), std::vector<float>(n_c, 0.0f));
        for (size_t i = 0; i < rows.size(); i++) {
            size_t base = (size_t) rows[i] * n_c;
            for (int c = 0; c < n_c; c++) sub[i][c] = avg[base + c];
        }

        if (sink_normalization) sub = apply_sink_norm(sub);

        // mean over rows -> per-context-token vector
        std::vector<float> ctx_scores(n_c, 0.0f);
        for (auto & r : sub) {
            for (int c = 0; c < n_c; c++) ctx_scores[c] += r[c];
        }
        if (!sub.empty()) {
            float inv_rows = (float)(1.0 / (double) sub.size());
            for (auto & v : ctx_scores) v *= inv_rows;
        }
        // Scatter to chunks: per chunk, sum per-token scores assigned to it.
        std::vector<float> chunk_sum(num_context_chunks, 0.0f);
        std::vector<int> chunk_count(num_context_chunks, 0);
        for (int c = 0; c < n_c; c++) {
            int ch = context_local_to_chunk[c];
            if (ch < 0) continue;
            chunk_sum[ch] += ctx_scores[c];
            chunk_count[ch] += 1;
        }
        std::vector<float> row(num_context_chunks, 0.0f);
        double sum = 0;
        for (int c = 0; c < num_context_chunks; c++) {
            row[c] = chunk_count[c] > 0 ? chunk_sum[c] : 0.0f;
            sum += row[c];
        }
        if (global_normalize && sum > 0) for (auto & v : row) v = (float)(v / sum);
        result[q_chunk] = row;
    }

    if (global_normalize) return prior_normalize(result);
    return result;
}

// -----------------------------------------------------------------------------
// JSON writer (minimal)

struct JsonOut {
    std::ostringstream s;

    void escape(const std::string & str) {
        s << '"';
        for (char c : str) {
            switch (c) {
                case '"':  s << "\\\""; break;
                case '\\': s << "\\\\"; break;
                case '\n': s << "\\n"; break;
                case '\r': s << "\\r"; break;
                case '\t': s << "\\t"; break;
                default:
                    if ((unsigned char) c < 0x20) {
                        char buf[8];
                        snprintf(buf, sizeof(buf), "\\u%04x", c);
                        s << buf;
                    } else s << c;
            }
        }
        s << '"';
    }

    void num(double v) {
        if (std::isnan(v) || std::isinf(v)) s << "0";
        else {
            char buf[32];
            snprintf(buf, sizeof(buf), "%.6g", v);
            s << buf;
        }
    }

    void chunks(const std::vector<Chunk> & cs) {
        s << '[';
        for (size_t i = 0; i < cs.size(); i++) {
            if (i) s << ',';
            s << '{';
            s << "\"label\":"; escape(cs[i].label);
            s << ",\"start\":" << cs[i].start;
            s << ",\"end\":" << cs[i].end;
            s << ",\"text\":"; escape(cs[i].text);
            s << '}';
        }
        s << ']';
    }

    void matrix(
        const std::vector<std::vector<float>> & m,
        const std::vector<Chunk> & column_chunks,
        const std::string & column_text,
        int prune_top_k = 0,
        int retain_line_radius = 5
    ) {
        std::vector<int> line_starts;
        line_starts.push_back(0);
        for (size_t i = 0; i < column_text.size(); i++) {
            if (column_text[i] == '\n') line_starts.push_back((int) i + 1);
        }

        auto line_for_offset = [&](int offset) -> int {
            if (line_starts.empty()) return 0;
            int clamped = std::max(0, std::min(offset, (int) column_text.size()));
            auto it = std::upper_bound(line_starts.begin(), line_starts.end(), clamped);
            if (it == line_starts.begin()) return 0;
            return (int) (it - line_starts.begin() - 1);
        };

        std::vector<int> column_lines(column_chunks.size(), 0);
        int max_line = 0;
        for (size_t i = 0; i < column_chunks.size(); i++) {
            column_lines[i] = line_for_offset(column_chunks[i].start);
            max_line = std::max(max_line, column_lines[i]);
        }
        std::vector<std::vector<size_t>> columns_by_line((size_t) max_line + 1);
        for (size_t i = 0; i < column_lines.size(); i++) {
            columns_by_line[(size_t) column_lines[i]].push_back(i);
        }

        s << '[';
        for (size_t i = 0; i < m.size(); i++) {
            if (i) s << ',';
            s << '[';
            std::set<size_t> keep;
            if (prune_top_k > 0 && prune_top_k < (int) m[i].size()) {
                std::vector<std::pair<float, size_t>> ranked;
                ranked.reserve(m[i].size());
                std::vector<double> line_mass((size_t) max_line + 1, 0.0);
                for (size_t j = 0; j < m[i].size(); j++) {
                    float v = m[i][j];
                    if (std::isfinite(v) && v > 0) {
                        ranked.push_back({v, j});
                        if (j < column_lines.size()) {
                            line_mass[(size_t) column_lines[j]] += v;
                        }
                    }
                }
                int k = std::min(prune_top_k, (int) ranked.size());
                std::partial_sort(
                    ranked.begin(),
                    ranked.begin() + k,
                    ranked.end(),
                    [](const auto & a, const auto & b) { return a.first > b.first; }
                );
                for (int r = 0; r < k; r++) {
                    size_t hot_col = ranked[r].second;
                    keep.insert(hot_col);
                    if (hot_col >= column_lines.size()) continue;
                    int hot_line = column_lines[hot_col];
                    int first_line = std::max(0, hot_line - retain_line_radius);
                    int last_line = std::min(max_line, hot_line + retain_line_radius);
                    for (int line = first_line; line <= last_line; line++) {
                        for (size_t col : columns_by_line[(size_t) line]) {
                            keep.insert(col);
                        }
                    }
                }

                // Also retain the highest total-mass lines. A line can be
                // important because many modest-token attentions add up, even
                // when no single token makes the top-token list above.
                std::vector<std::pair<double, int>> ranked_lines;
                ranked_lines.reserve(line_mass.size());
                for (int line = 0; line <= max_line; line++) {
                    if (line_mass[(size_t) line] > 0) ranked_lines.push_back({line_mass[(size_t) line], line});
                }
                int line_k = std::min(prune_top_k, (int) ranked_lines.size());
                if (line_k > 0) {
                    std::partial_sort(
                        ranked_lines.begin(),
                        ranked_lines.begin() + line_k,
                        ranked_lines.end(),
                        [](const auto & a, const auto & b) { return a.first > b.first; }
                    );
                    for (int r = 0; r < line_k; r++) {
                        int hot_line = ranked_lines[r].second;
                        for (size_t col : columns_by_line[(size_t) hot_line]) {
                            keep.insert(col);
                        }
                    }
                }
            }
            for (size_t j = 0; j < m[i].size(); j++) {
                if (j) s << ',';
                if (prune_top_k > 0 && prune_top_k < (int) m[i].size() && keep.count(j) == 0) {
                    s << '0';
                } else {
                    num(m[i][j]);
                }
            }
            s << ']';
        }
        s << ']';
    }
};

// -----------------------------------------------------------------------------
// Main

struct Args {
    std::string model;
    std::string context_path;       // single-file context
    std::string context_tree;       // directory containing many context files
    std::string context_glob = ".ts"; // file extension filter when scanning tree
    std::string cache_dir = "cpp/cache";
    std::string query_path;
    std::string query_tree;         // directory of multi-doc queries
    std::string query_glob = ".mdx"; // extension filter for query tree
    std::string query_segment = "paragraph"; // paragraph, sentence, document_tokens, or phrase
    std::string context_segment = "token";   // token or phrase
    std::string out_path = "web/heatmap.tar.gz";
    std::string input_prompt = kDefaultInputPrompt;
    std::string strip_context = "none";
    std::string strip_query = "none";
    std::string dump_inputs_dir;
    std::string image_path;         // multimodal image attention mode
    std::string svg_path;           // optional source SVG behind the raster image
    std::string mmproj_path;        // llama.cpp multimodal projector
    std::string image_query_segment = "prompt"; // prompt, line, or token
    std::string layers; // e.g. "14-20"; empty = default fractions
    double layer_fraction_start = 0.60;
    double layer_fraction_end = 0.88;
    bool sink_normalization = true;
    bool per_file = false;          // iterate context files individually (tiny windows)
    bool mari_coverage = false;     // Mari mode: emit low-coverage SOURCE spans as findings, not a heatmap
    double mari_threshold = 0.3;    // flag a source span below this fraction of peak coverage
    bool input_prompt_set = false;
    bool mmproj_use_gpu = true;
    bool check_context = false;     // image mode: plan/tokenize and exit before decode
    bool svg_before_image = false;  // experimental: SVG text before image so image rows can attend to SVG tokens
    int n_ubatch = 256;
    int llm_batch_size = 1;         // query-item sequences per llama_decode group in per-file mode
    int n_ctx = 0;                  // 0 = choose a bounded per-file context automatically
    int n_gpu_layers = 99;
    int prune_top_k = 80;           // keep top-K context hits plus nearby lines per query row in JSON
    int write_every_docs = 1;       // per-file partial output cadence; 0 = final output only
    int phrase_tokens = 12;         // target model tokens per phrase chunk
    int reasoning_steps = 0;        // generate N greedy continuation tokens and average their attention
    int image_min_tokens = -1;
    int image_max_tokens = -1;
    int image_output_grid_w = 0;    // 0 = native patch grid
    int image_output_grid_h = 0;
};

static std::vector<int> parse_layers(const std::string & raw) {
    std::vector<int> out;
    std::stringstream ss(raw);
    std::string part;
    while (std::getline(ss, part, ',')) {
        auto dash = part.find('-');
        if (dash != std::string::npos) {
            int a = std::atoi(part.substr(0, dash).c_str());
            int b = std::atoi(part.substr(dash + 1).c_str());
            if (b < a) std::swap(a, b);
            for (int i = a; i <= b; i++) out.push_back(i);
        } else if (!part.empty()) {
            out.push_back(std::atoi(part.c_str()));
        }
    }
    return out;
}

static Args parse_args(int argc, char ** argv) {
    Args a;
    for (int i = 1; i < argc; i++) {
        std::string k = argv[i];
        auto need = [&](const char * what) {
            if (++i >= argc) { log_line("missing value for %s", what); std::exit(1); }
            return std::string(argv[i]);
        };
        if (k == "--model") a.model = need("--model");
        else if (k == "--context") a.context_path = need("--context");
        else if (k == "--context-tree") a.context_tree = need("--context-tree");
        else if (k == "--context-glob") a.context_glob = need("--context-glob");
        else if (k == "--cache-dir") a.cache_dir = need("--cache-dir");
        else if (k == "--query") a.query_path = need("--query");
        else if (k == "--query-tree") a.query_tree = need("--query-tree");
        else if (k == "--query-glob") a.query_glob = need("--query-glob");
        else if (k == "--query-segment" || k == "--query-segmentation" ||
                 k == "--source-segment" || k == "--source-segmentation") {
            a.query_segment = need(k.c_str());
        }
        else if (k == "--query-document-tokens" || k == "--source-document-tokens" ||
                 k == "--query-token-level" || k == "--source-token-level") {
            a.query_segment = "document_tokens";
        }
        else if (k == "--query-phrases" || k == "--source-phrases" ||
                 k == "--query-phrase-level" || k == "--source-phrase-level") {
            a.query_segment = "phrase";
        }
        else if (k == "--context-segment" || k == "--context-segmentation") a.context_segment = need(k.c_str());
        else if (k == "--phrase-tokens" || k == "--phrase-size") a.phrase_tokens = std::atoi(need(k.c_str()).c_str());
        else if (k == "--prompt" || k == "--query-prompt" || k == "--image-prompt") {
            a.input_prompt = need(k.c_str());
            a.input_prompt_set = true;
        }
        else if (k == "--per-file") a.per_file = true;
        else if (k == "--mari-coverage") { a.mari_coverage = true; a.per_file = true; }
        else if (k == "--mari-threshold") a.mari_threshold = std::atof(need(k.c_str()).c_str());
        else if (k == "--image") a.image_path = need("--image");
        else if (k == "--svg" || k == "--image-svg") a.svg_path = need(k.c_str());
        else if (k == "--svg-before-image" || k == "--image-attend-svg") a.svg_before_image = true;
        else if (k == "--image-attention-order") {
            std::string v = need("--image-attention-order");
            if (v == "svg-image-prompt" || v == "svg_before_image") {
                a.svg_before_image = true;
            } else if (v == "image-svg-prompt" || v == "image_before_svg") {
                a.svg_before_image = false;
            } else {
                log_line("unknown image attention order: %s (expected image-svg-prompt or svg-image-prompt)", v.c_str());
                std::exit(1);
            }
        }
        else if (k == "--mmproj") a.mmproj_path = need("--mmproj");
        else if (k == "--no-mmproj-offload") a.mmproj_use_gpu = false;
        else if (k == "--check-context" || k == "--context-check") a.check_context = true;
        else if (k == "--image-query-segment" || k == "--image-query-chunks") a.image_query_segment = need(k.c_str());
        else if (k == "--image-min-tokens") a.image_min_tokens = std::atoi(need("--image-min-tokens").c_str());
        else if (k == "--image-max-tokens") a.image_max_tokens = std::atoi(need("--image-max-tokens").c_str());
        else if (k == "--image-output-grid" || k == "--image-pool") {
            std::string v = need(k.c_str());
            size_t x = v.find('x');
            if (x == std::string::npos) x = v.find('X');
            if (x == std::string::npos) {
                a.image_output_grid_w = std::atoi(v.c_str());
                a.image_output_grid_h = a.image_output_grid_w;
            } else {
                a.image_output_grid_w = std::atoi(v.substr(0, x).c_str());
                a.image_output_grid_h = std::atoi(v.substr(x + 1).c_str());
            }
        }
        else if (k == "--output") a.out_path = need("--output");
        else if (k == "--json") {
            log_line("plain JSON output is not supported; use --output FILE.tar.gz");
            std::exit(1);
        }
        else if (k == "--strip-context") a.strip_context = need("--strip-context");
        else if (k == "--strip-query") a.strip_query = need("--strip-query");
        else if (k == "--dump-inputs" || k == "--dump-llm-inputs") a.dump_inputs_dir = need(k.c_str());
        else if (k == "--layers") a.layers = need("--layers");
        else if (k == "--layer-fraction-start") a.layer_fraction_start = std::atof(need("--layer-fraction-start").c_str());
        else if (k == "--layer-fraction-end") a.layer_fraction_end = std::atof(need("--layer-fraction-end").c_str());
        else if (k == "--no-sink-normalization") a.sink_normalization = false;
        else if (k == "--ubatch") a.n_ubatch = std::atoi(need("--ubatch").c_str());
        else if (k == "--llm-batch-size" || k == "--batch-size" || k == "--query-batch-size") {
            a.llm_batch_size = std::atoi(need(k.c_str()).c_str());
        }
        else if (k == "--ctx-size" || k == "--ctx") a.n_ctx = std::atoi(need(k.c_str()).c_str());
        else if (k == "--gpu-layers") a.n_gpu_layers = std::atoi(need("--gpu-layers").c_str());
        else if (k == "--prune-top-k" || k == "--prune") a.prune_top_k = std::atoi(need(k.c_str()).c_str());
        else if (k == "--no-prune") a.prune_top_k = 0;
        else if (k == "--write-every-docs" || k == "--write-every-n-docs" ||
                 k == "--output-every-docs" || k == "--checkpoint-every-docs") {
            a.write_every_docs = std::atoi(need(k.c_str()).c_str());
        }
        else if (k == "--reasoning-steps") a.reasoning_steps = std::max(0, std::atoi(need("--reasoning-steps").c_str()));
        else { log_line("unknown arg: %s", k.c_str()); std::exit(1); }
    }
    if (a.image_query_segment == "tokens" || a.image_query_segment == "document_tokens") a.image_query_segment = "token";
    if (a.image_query_segment == "lines" || a.image_query_segment == "prompt-lines" ||
        a.image_query_segment == "prompt_line" || a.image_query_segment == "features") {
        a.image_query_segment = "line";
    }
    if (a.image_query_segment != "prompt" && a.image_query_segment != "line" && a.image_query_segment != "token") {
        log_line("unknown image query segment mode: %s (expected prompt, line, or token)", a.image_query_segment.c_str());
        std::exit(1);
    }
    bool image_mode = !a.image_path.empty();
    if (image_mode && a.image_query_segment == "prompt" && a.query_segment == "document_tokens") {
        a.image_query_segment = "token";
    }
    if (a.model.empty() ||
        (image_mode && (a.mmproj_path.empty() || !a.input_prompt_set)) ||
        (!image_mode && ((a.query_path.empty() && a.query_tree.empty()) || (a.context_path.empty() && a.context_tree.empty())))) {
        log_line("usage: text mode: --model FILE (--query FILE | --query-tree DIR) (--context FILE | --context-tree DIR) [--prompt TEXT] [--per-file] [--query-segment paragraph|sentence|phrase|document-tokens] [--context-segment token|phrase] [--phrase-tokens N] [--write-every-docs N] [--dump-inputs DIR] [--output web/heatmap.tar.gz] [--ctx-size N] [--gpu-layers N] [--prune-top-k N] [--reasoning-steps N] [opts]");
        log_line("usage: image mode: --model FILE --mmproj FILE --image FILE --prompt TEXT [--svg FILE] [--svg-before-image] [--image-query-segment prompt|line|token] [--image-output-grid N|WxH] [--output web/heatmap.tar.gz] [--ctx-size N] [--gpu-layers N] [--ubatch N] [--layers L] [--image-min-tokens N] [--image-max-tokens N] [--check-context]");
        std::exit(1);
    }
    if (a.image_output_grid_w < 0 || a.image_output_grid_h < 0) {
        log_line("--image-output-grid must be positive");
        std::exit(1);
    }
    if (!a.query_tree.empty() && !a.per_file) {
        a.per_file = true;
        log_line("--query-tree implies --per-file");
    }
    if (a.query_segment == "document-tokens") a.query_segment = "document_tokens";
    if (a.query_segment == "token" || a.query_segment == "tokens") a.query_segment = "document_tokens";
    if (a.query_segment == "phrases") a.query_segment = "phrase";
    if (a.query_segment != "paragraph" && a.query_segment != "sentence" &&
        a.query_segment != "document_tokens" && a.query_segment != "phrase") {
        log_line("unknown query segment mode: %s (expected paragraph, sentence, phrase, or document-tokens)", a.query_segment.c_str());
        std::exit(1);
    }
    if (a.context_segment != "token" && a.context_segment != "phrase") {
        log_line("unknown context segment mode: %s (expected token or phrase)", a.context_segment.c_str());
        std::exit(1);
    }
    if (a.phrase_tokens <= 0) {
        log_line("--phrase-tokens must be > 0");
        std::exit(1);
    }
    if (a.write_every_docs < 0) {
        log_line("--write-every-docs must be >= 0");
        std::exit(1);
    }
    if (a.llm_batch_size <= 0) {
        log_line("--llm-batch-size must be > 0");
        std::exit(1);
    }
    if (!path_ends_with(a.out_path, ".tar.gz") && !path_ends_with(a.out_path, ".tgz")) {
        log_line("output path must end in .tar.gz or .tgz: %s", a.out_path.c_str());
        std::exit(1);
    }
    return a;
}

// -----------------------------------------------------------------------------
// Image scan: decode one image plus a prompt, capture prompt attention to the
// image embedding tokens, and aggregate those token scores onto the vision patch
// grid exposed by llama.cpp's mtmd projector.

static int run_image_scan(const Args & args) {
    auto t_start = ggml_time_us();
    const std::string marker = mtmd_default_marker();
    std::string svg_source;
    if (!args.svg_path.empty()) {
        svg_source = read_file(args.svg_path);
    }
    const bool svg_before_image = args.svg_before_image && !svg_source.empty();
    std::string svg_block;
    std::string svg_section;
    if (!svg_source.empty()) {
        svg_block = "<SVG_SOURCE>\n" + svg_source + "\n</SVG_SOURCE>\n";
        svg_section = svg_before_image ? svg_block : svg_block + "<PROMPT>\n";
    }
    std::string mm_prompt = args.input_prompt;
    if (mm_prompt.find(marker) == std::string::npos) {
        if (svg_before_image) {
            mm_prompt = svg_block + marker + "\n<PROMPT>\n" + mm_prompt;
        } else {
            mm_prompt = marker + "\n" + svg_section + mm_prompt;
        }
    } else if (!svg_section.empty()) {
        size_t marker_pos = mm_prompt.find(marker);
        if (svg_before_image) {
            mm_prompt.insert(marker_pos, svg_block);
            size_t insert_pos = marker_pos + svg_block.size() + marker.size();
            mm_prompt.insert(insert_pos, "\n<PROMPT>\n");
        } else {
            size_t insert_pos = marker_pos + marker.size();
            mm_prompt.insert(insert_pos, "\n" + svg_section);
        }
    }

    llama_backend_init();
    ggml_backend_load_all();

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = args.n_gpu_layers;
    llama_model * model = llama_model_load_from_file(args.model.c_str(), mparams);
    if (!model) {
        log_line("failed to load model %s", args.model.c_str());
        llama_backend_free();
        return 1;
    }
    const llama_vocab * vocab = llama_model_get_vocab(model);

    const int n_layers = llama_model_n_layer(model);
    std::vector<int> selected_layers;
    if (!args.layers.empty()) {
        selected_layers = parse_layers(args.layers);
    } else {
        int s = std::max(0, std::min(n_layers - 1, (int)(n_layers * args.layer_fraction_start)));
        int e = std::max(s + 1, std::min(n_layers, (int)(n_layers * args.layer_fraction_end)));
        for (int i = s; i < e; i++) selected_layers.push_back(i);
    }
    log_line("image mode: layers=%d selected=%zu", n_layers, selected_layers.size());

    mtmd_context_params mmparams = mtmd_context_params_default();
    mmparams.use_gpu = args.mmproj_use_gpu;
    mmparams.print_timings = false;
    mmparams.n_threads = std::max(1, omp_get_max_threads());
    mmparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
    mmparams.warmup = false;
    mmparams.image_min_tokens = args.image_min_tokens;
    mmparams.image_max_tokens = args.image_max_tokens;
    mtmd_context * mmctx = mtmd_init_from_file(args.mmproj_path.c_str(), model, mmparams);
    if (!mmctx) {
        log_line("failed to load multimodal projector %s", args.mmproj_path.c_str());
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    if (!mtmd_support_vision(mmctx)) {
        log_line("projector does not support vision input: %s", args.mmproj_path.c_str());
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    mtmd_bitmap * bitmap = mtmd_helper_bitmap_init_from_file(mmctx, args.image_path.c_str());
    if (!bitmap) {
        log_line("failed to load image %s", args.image_path.c_str());
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    uint32_t image_width = mtmd_bitmap_get_nx(bitmap);
    uint32_t image_height = mtmd_bitmap_get_ny(bitmap);

    mtmd_input_text input_text;
    input_text.text = mm_prompt.c_str();
    input_text.add_special = true;
    input_text.parse_special = true;

    mtmd_input_chunks * chunks = mtmd_input_chunks_init();
    const mtmd_bitmap * bitmaps[] = { bitmap };
    int32_t tok_rc = mtmd_tokenize(mmctx, chunks, &input_text, bitmaps, 1);
    if (tok_rc != 0) {
        log_line("failed to tokenize image prompt with mtmd (rc=%d)", tok_rc);
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    std::string capture_prompt_text = args.input_prompt;
    size_t marker_pos = capture_prompt_text.rfind(marker);
    if (marker_pos != std::string::npos) {
        capture_prompt_text = capture_prompt_text.substr(marker_pos + marker.size());
    }
    capture_prompt_text = trim_ascii_whitespace(capture_prompt_text);
    if (capture_prompt_text.empty()) {
        log_line("image prompt has no text to capture after trimming whitespace");
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    struct PromptTokenVariant {
        std::string name;
        std::vector<llama_token> tokens;
        size_t capture_start = 0;
    };

    const std::vector<llama_token> prompt_plain_tokens = tokenize_plain_tokens(vocab, capture_prompt_text);
    std::vector<PromptTokenVariant> prompt_variants;
    auto add_prompt_variant = [&](const std::string & name, const std::string & text) {
        std::vector<llama_token> tokens = tokenize_plain_tokens(vocab, text);
        if (tokens.empty()) return;
        size_t capture_start = 0;
        if (!prompt_plain_tokens.empty() && tokens.size() > prompt_plain_tokens.size()) {
            capture_start = tokens.size() - prompt_plain_tokens.size();
        }
        for (const auto & existing : prompt_variants) {
            if (existing.tokens == tokens && existing.capture_start == capture_start) return;
        }
        prompt_variants.push_back({name, std::move(tokens), capture_start});
    };
    add_prompt_variant("prompt", capture_prompt_text);
    add_prompt_variant("newline_prefixed_prompt", "\n" + capture_prompt_text);
    add_prompt_variant("space_prefixed_prompt", " " + capture_prompt_text);
    if (prompt_variants.empty()) {
        log_line("failed to tokenize image prompt text");
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    TokenizedDoc svg_doc;
    TokenizedDoc svg_section_doc;
    std::vector<Chunk> svg_chunks;
    std::vector<int> svg_token_local_to_chunk;
    std::vector<int> svg_section_token_to_chunk;
    std::vector<PromptTokenVariant> svg_variants;
    if (!svg_source.empty()) {
        svg_doc = tokenize_with_offsets(vocab, svg_source);
        for (size_t i = 0; i < svg_doc.tokens.size(); i++) {
            int start = std::max(0, std::min(svg_doc.char_start[i], (int) svg_source.size()));
            int end = std::max(start, std::min(svg_doc.char_end[i], (int) svg_source.size()));
            if (end <= start) continue;
            char label[96];
            std::snprintf(label, sizeof(label), "svg:tok_%06zu", svg_chunks.size());
            svg_chunks.push_back({label, start, end, svg_source.substr(start, end - start)});
        }
        svg_section_doc = tokenize_with_offsets(vocab, svg_section);
        size_t svg_source_offset = svg_section.find(svg_source);
        std::vector<Chunk> svg_chunks_in_section;
        if (svg_source_offset != std::string::npos) {
            svg_chunks_in_section.reserve(svg_chunks.size());
            for (const auto & c : svg_chunks) {
                Chunk shifted = c;
                shifted.start += (int) svg_source_offset;
                shifted.end += (int) svg_source_offset;
                svg_chunks_in_section.push_back(std::move(shifted));
            }
        }
        svg_section_token_to_chunk = token_to_chunk_map(svg_section_doc, svg_chunks_in_section);
        auto add_svg_variant = [&](const std::string & name, const std::string & text) {
            std::vector<llama_token> tokens = tokenize_plain_tokens(vocab, text);
            if (tokens.empty()) return;
            size_t capture_start = 0;
            if (tokens.size() > svg_section_doc.tokens.size()) {
                capture_start = tokens.size() - svg_section_doc.tokens.size();
            }
            for (const auto & existing : svg_variants) {
                if (existing.tokens == tokens && existing.capture_start == capture_start) return;
            }
            svg_variants.push_back({name, std::move(tokens), capture_start});
        };
        add_svg_variant("svg_section", svg_section);
        add_svg_variant("newline_prefixed_svg_section", "\n" + svg_section);
    }

    struct ImagePlan {
        size_t chunk_index = 0;
        int start_col = 0;
        int n_tokens = 0;
        int grid_w = 0;
        int grid_h = 0;
        std::vector<int> token_to_cell;
    } image_plan;

    std::vector<int> image_key_columns;
    std::vector<int> prompt_row_positions;
    std::vector<llama_token> captured_prompt_tokens;
    std::vector<int> svg_token_positions;
    std::vector<int> fallback_prompt_row_positions;
    std::vector<llama_token> fallback_prompt_tokens;
    llama_pos planned_pos = 0;
    int planned_columns = 0;
    bool seen_image = false;
    bool prompt_rows_selected = false;
    bool svg_rows_selected = false;
    int image_chunks_seen = 0;
    size_t post_image_text_tokens = 0;
    std::string prompt_capture_strategy = "unmatched";
    std::string svg_capture_strategy = "none";
    int prompt_match_start = -1;
    int prompt_match_length = 0;
    int prompt_match_capture_start = 0;
    int svg_match_start = -1;
    int svg_match_length = 0;
    int svg_match_capture_start = 0;

    const size_t n_chunks = mtmd_input_chunks_size(chunks);
    for (size_t ci = 0; ci < n_chunks; ci++) {
        const mtmd_input_chunk * chunk = mtmd_input_chunks_get(chunks, ci);
        mtmd_input_chunk_type type = mtmd_input_chunk_get_type(chunk);
        if (type == MTMD_INPUT_CHUNK_TYPE_TEXT) {
            size_t n_tokens = 0;
            const llama_token * text_tokens = mtmd_input_chunk_get_tokens_text(chunk, &n_tokens);
            if (!svg_rows_selected && !svg_variants.empty()) {
                for (const auto & variant : svg_variants) {
                    int match_start = find_last_token_subsequence(text_tokens, n_tokens, variant.tokens);
                    if (match_start < 0) continue;
                    size_t capture_start = std::min(variant.capture_start, variant.tokens.size());
                    for (size_t i = capture_start; i < variant.tokens.size(); i++) {
                        size_t section_i = i - capture_start;
                        int svg_chunk = section_i < svg_section_token_to_chunk.size()
                            ? svg_section_token_to_chunk[section_i]
                            : -1;
                        if (svg_chunk < 0) continue;
                        svg_token_positions.push_back((int) planned_pos + match_start + (int) i);
                        svg_token_local_to_chunk.push_back(svg_chunk);
                    }
                    svg_rows_selected = true;
                    svg_capture_strategy = variant.name;
                    svg_match_start = (int) planned_pos + match_start;
                    svg_match_length = (int) variant.tokens.size();
                    svg_match_capture_start = (int) capture_start;
                    break;
                }
            }
            if (seen_image) {
                post_image_text_tokens += n_tokens;
                if (!prompt_rows_selected) {
                    for (const auto & variant : prompt_variants) {
                        int match_start = find_last_token_subsequence(text_tokens, n_tokens, variant.tokens);
                        if (match_start < 0) continue;
                        size_t capture_start = std::min(variant.capture_start, variant.tokens.size());
                        for (size_t i = capture_start; i < variant.tokens.size(); i++) {
                            prompt_row_positions.push_back((int) planned_pos + match_start + (int) i);
                            captured_prompt_tokens.push_back(variant.tokens[i]);
                        }
                        prompt_rows_selected = true;
                        prompt_capture_strategy = variant.name;
                        prompt_match_start = (int) planned_pos + match_start;
                        prompt_match_length = (int) variant.tokens.size();
                        prompt_match_capture_start = (int) capture_start;
                        break;
                    }
                    if (!prompt_rows_selected && n_tokens > 0) {
                        size_t want = prompt_plain_tokens.empty()
                            ? 1
                            : std::min(prompt_plain_tokens.size(), n_tokens);
                        size_t start = n_tokens - want;
                        fallback_prompt_row_positions.clear();
                        fallback_prompt_tokens.clear();
                        for (size_t i = start; i < n_tokens; i++) {
                            fallback_prompt_row_positions.push_back((int) planned_pos + (int) i);
                            fallback_prompt_tokens.push_back(text_tokens[i]);
                        }
                        prompt_match_start = (int) planned_pos + (int) start;
                        prompt_match_length = (int) want;
                        prompt_match_capture_start = 0;
                    }
                }
            }
            planned_pos += (llama_pos) n_tokens;
            planned_columns += (int) n_tokens;
        } else if (type == MTMD_INPUT_CHUNK_TYPE_IMAGE) {
            if (image_chunks_seen > 0) {
                log_line("image mode currently supports exactly one image marker");
                mtmd_input_chunks_free(chunks);
                mtmd_bitmap_free(bitmap);
                mtmd_free(mmctx);
                llama_model_free(model);
                llama_backend_free();
                return 1;
            }
            const mtmd_image_tokens * image_tokens = mtmd_input_chunk_get_tokens_image(chunk);
            size_t n_image_tokens = mtmd_image_tokens_get_n_tokens(image_tokens);
            int grid_w = (int) mtmd_image_tokens_get_nx(image_tokens);
            int grid_h = (int) mtmd_image_tokens_get_ny(image_tokens);
            int square_side = (int) std::llround(std::sqrt((double) n_image_tokens));
            if ((grid_w == 1 || grid_h == 1) &&
                square_side > 1 &&
                (size_t) square_side * (size_t) square_side == n_image_tokens &&
                image_width == image_height) {
                log_line("mtmd returned degenerate image grid %dx%d for %zu tokens; using inferred %dx%d square grid",
                    grid_w, grid_h, n_image_tokens, square_side, square_side);
                grid_w = square_side;
                grid_h = square_side;
            }
            if (grid_w <= 0 || grid_h <= 0 || n_image_tokens == 0) {
                log_line("mtmd returned an empty image token grid");
                mtmd_input_chunks_free(chunks);
                mtmd_bitmap_free(bitmap);
                mtmd_free(mmctx);
                llama_model_free(model);
                llama_backend_free();
                return 1;
            }

            image_plan.chunk_index = ci;
            image_plan.start_col = planned_columns;
            image_plan.n_tokens = (int) n_image_tokens;
            image_plan.grid_w = grid_w;
            image_plan.grid_h = grid_h;
            image_plan.token_to_cell.assign(n_image_tokens, -1);

            if ((int) n_image_tokens == grid_w * grid_h) {
                for (int i = 0; i < (int) n_image_tokens; i++) {
                    int x = i % grid_w;
                    int y = i / grid_w;
                    image_plan.token_to_cell[i] = y * grid_w + x;
                }
            } else if ((int) n_image_tokens == 1 + grid_h * (grid_w + 1) + 1) {
                // HunyuanVL-style layout: BOI, rows with a newline token, EOI.
                for (int i = 1; i < (int) n_image_tokens - 1; i++) {
                    int off = i - 1;
                    int y = off / (grid_w + 1);
                    int x = off % (grid_w + 1);
                    if (x < grid_w && y < grid_h) {
                        image_plan.token_to_cell[i] = y * grid_w + x;
                    }
                }
            } else {
                for (int i = 0; i < (int) n_image_tokens; i++) {
                    mtmd_decoder_pos p = mtmd_image_tokens_get_decoder_pos(image_tokens, 0, (size_t) i);
                    int x = -1;
                    int y = -1;
                    if (p.x < (uint32_t) grid_w && p.y < (uint32_t) grid_h) {
                        x = (int) p.x;
                        y = (int) p.y;
                    } else if (p.y < (uint32_t) grid_w && p.x < (uint32_t) grid_h) {
                        x = (int) p.y;
                        y = (int) p.x;
                    }
                    if (x >= 0 && y >= 0) image_plan.token_to_cell[i] = y * grid_w + x;
                }
            }

            image_key_columns.reserve(n_image_tokens);
            for (int i = 0; i < (int) n_image_tokens; i++) {
                image_key_columns.push_back(image_plan.start_col + i);
            }
            planned_pos += mtmd_input_chunk_get_n_pos(chunk);
            planned_columns += (int) n_image_tokens;
            seen_image = true;
            image_chunks_seen++;
        }
    }

    if (!prompt_rows_selected && !fallback_prompt_row_positions.empty()) {
        prompt_row_positions = fallback_prompt_row_positions;
        captured_prompt_tokens = fallback_prompt_tokens;
        prompt_rows_selected = true;
        prompt_capture_strategy = "fallback_tail";
    }

    if (image_chunks_seen == 0) {
        log_line("mtmd prompt did not produce an image chunk; prompt must contain %s or omit it and let the tool prepend it", marker.c_str());
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    if (prompt_row_positions.empty()) {
        log_line("no prompt text tokens after the image marker; pass --prompt with text after the image");
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    if (!svg_source.empty() && svg_token_positions.empty()) {
        log_line("failed to locate SVG source tokens in the multimodal prompt");
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    if (captured_prompt_tokens.size() != prompt_row_positions.size()) {
        captured_prompt_tokens.assign(prompt_row_positions.size(), 0);
    }

    int needed_ctx = std::max((int) planned_pos, planned_columns) + 8;
    int model_n_ctx_train = llama_model_n_ctx_train(model);
    if (model_n_ctx_train > 0 && needed_ctx > model_n_ctx_train) {
        log_line("image prompt needs %d context positions, but model training context is %d; shorten the prompt or reduce image tokens",
            needed_ctx, model_n_ctx_train);
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    int n_ctx = args.n_ctx > 0 ? args.n_ctx : std::max(4096, needed_ctx);
    if (model_n_ctx_train > 0 && args.n_ctx <= 0) {
        n_ctx = std::min(n_ctx, model_n_ctx_train);
    }
    if (n_ctx < needed_ctx) {
        log_line("ctx-size %d is too small for image prompt (%d positions / %d kv columns); use --ctx-size %d or more",
            n_ctx, (int) planned_pos, planned_columns, needed_ctx);
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    if (model_n_ctx_train > 0 && n_ctx > model_n_ctx_train) {
        log_line("ctx-size %d exceeds model training context %d; use --ctx-size %d or less",
            n_ctx, model_n_ctx_train, model_n_ctx_train);
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    int ctx_spare = n_ctx - needed_ctx;
    log_line("image context plan: needed=%d n_ctx=%d spare=%d model_n_ctx_train=%d",
        needed_ctx, n_ctx, ctx_spare, model_n_ctx_train);
    log_line("image context detail: image_tokens=%d svg_text_tokens=%zu svg_rows=%zu prompt_text_tokens=%zu post_image_text_tokens=%zu prompt_rows=%zu",
        image_plan.n_tokens, svg_doc.tokens.size(), svg_token_positions.size(),
        prompt_plain_tokens.size(), post_image_text_tokens, prompt_row_positions.size());
    if (args.check_context) {
        log_line("context check passed; exiting before context init/decode");
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 0;
    }

    std::vector<int> combined_context_positions;
    std::vector<int> combined_query_positions;
    if (svg_before_image) {
        combined_context_positions = svg_token_positions;
        combined_context_positions.insert(
            combined_context_positions.end(),
            image_key_columns.begin(),
            image_key_columns.end()
        );
        combined_query_positions = image_key_columns;
        combined_query_positions.insert(
            combined_query_positions.end(),
            prompt_row_positions.begin(),
            prompt_row_positions.end()
        );
    } else {
        combined_context_positions = image_key_columns;
        combined_context_positions.insert(
            combined_context_positions.end(),
            svg_token_positions.begin(),
            svg_token_positions.end()
        );
        combined_query_positions = svg_token_positions;
        combined_query_positions.insert(
            combined_query_positions.end(),
            prompt_row_positions.begin(),
            prompt_row_positions.end()
        );
    }

    CaptureContext cap;
    cap.context_token_positions = combined_context_positions;
    cap.query_token_positions = combined_query_positions;
    for (int l : selected_layers) cap.selected_layers.insert(l);
    CallbackUserData ud{ &cap };

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = (uint32_t) n_ctx;
    cparams.n_batch = (uint32_t) n_ctx;
    cparams.n_ubatch = (uint32_t) std::min(args.n_ubatch, n_ctx);
    cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
    cparams.cb_eval = eval_callback;
    cparams.cb_eval_user_data = &ud;
    cparams.no_perf = true;
    llama_context * ctx = llama_init_from_model(model, cparams);
    if (!ctx) {
        log_line("failed to init context");
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    std::vector<int32_t> skip_layers(selected_layers.begin(), selected_layers.end());
    llama_pos n_past = 0;
    int kv_columns = 0;
    bool runtime_seen_image = false;

    auto decode_text = [&](const llama_token * tokens, size_t n_tokens, bool capture_active) -> bool {
        for (size_t off = 0; off < n_tokens; off += args.n_ubatch) {
            int batch_n = (int) std::min((size_t) args.n_ubatch, n_tokens - off);
            llama_batch batch = llama_batch_init(batch_n, 0, 1);
            batch.n_tokens = batch_n;
            cap.batch_query_positions.clear();
            cap.batch_query_seq_ids.clear();
            for (int i = 0; i < batch_n; i++) {
                llama_pos pos = n_past + i;
                batch.token[i] = tokens[off + (size_t) i];
                batch.pos[i] = pos;
                batch.n_seq_id[i] = 1;
                batch.seq_id[i][0] = 0;
                batch.logits[i] = 0;
                if (capture_active) {
                    cap.batch_query_positions.push_back((int) pos);
                    cap.batch_query_seq_ids.push_back(0);
                }
            }
            cap.batch_query_pos_start = capture_active ? (int) n_past : -1;
            cap.batch_query_pos_end = capture_active ? (int) n_past + batch_n : -1;
            if (capture_active) {
                llama_set_flash_attn_skip(ctx, skip_layers.data(), (int32_t) skip_layers.size());
            } else {
                llama_set_flash_attn_skip(ctx, nullptr, 0);
            }
            int rc = llama_decode(ctx, batch);
            llama_batch_free(batch);
            if (rc != 0) {
                log_line("text decode failed at pos=%d rc=%d", (int) n_past, rc);
                return false;
            }
            n_past += batch_n;
            kv_columns += batch_n;
        }
        return true;
    };

    log_line("image: %ux%u, grid=%dx%d, image_tokens=%d, svg_rows=%zu, prompt_rows=%zu, n_ctx=%d",
        image_width, image_height, image_plan.grid_w, image_plan.grid_h,
        image_plan.n_tokens, svg_token_positions.size(), prompt_row_positions.size(), n_ctx);
    log_line("image prompt capture: strategy=%s, prompt_tokens=%zu, post_image_text_tokens=%zu",
        prompt_capture_strategy.c_str(), prompt_plain_tokens.size(), post_image_text_tokens);

    for (size_t ci = 0; ci < n_chunks; ci++) {
        const mtmd_input_chunk * chunk = mtmd_input_chunks_get(chunks, ci);
        mtmd_input_chunk_type type = mtmd_input_chunk_get_type(chunk);
        if (type == MTMD_INPUT_CHUNK_TYPE_TEXT) {
            size_t n_tokens = 0;
            const llama_token * tokens = mtmd_input_chunk_get_tokens_text(chunk, &n_tokens);
            if (!decode_text(tokens, n_tokens, runtime_seen_image)) {
                llama_free(ctx);
                mtmd_input_chunks_free(chunks);
                mtmd_bitmap_free(bitmap);
                mtmd_free(mmctx);
                llama_model_free(model);
                llama_backend_free();
                return 1;
            }
        } else if (type == MTMD_INPUT_CHUNK_TYPE_IMAGE) {
            const bool capture_image_rows = svg_before_image && !svg_token_positions.empty();
            if (capture_image_rows) {
                llama_set_flash_attn_skip(ctx, skip_layers.data(), (int32_t) skip_layers.size());
            } else {
                llama_set_flash_attn_skip(ctx, nullptr, 0);
            }
            cap.batch_query_positions.clear();
            cap.batch_query_seq_ids.clear();
            if (capture_image_rows) {
                cap.batch_query_positions.reserve(image_key_columns.size());
                cap.batch_query_seq_ids.reserve(image_key_columns.size());
                for (int pos : image_key_columns) {
                    cap.batch_query_positions.push_back(pos);
                    cap.batch_query_seq_ids.push_back(0);
                }
                cap.batch_query_pos_start = image_key_columns.empty() ? -1 : image_key_columns.front();
                cap.batch_query_pos_end = image_key_columns.empty() ? -1 : image_key_columns.back() + 1;
            } else {
                cap.batch_query_pos_start = -1;
                cap.batch_query_pos_end = -1;
            }
            if (mtmd_encode_chunk(mmctx, chunk) != 0) {
                log_line("failed to encode image chunk");
                llama_free(ctx);
                mtmd_input_chunks_free(chunks);
                mtmd_bitmap_free(bitmap);
                mtmd_free(mmctx);
                llama_model_free(model);
                llama_backend_free();
                return 1;
            }
            float * embd = mtmd_get_output_embd(mmctx);
            llama_pos new_n_past = n_past;
            int image_decode_batch = capture_image_rows
                ? std::max(1, image_plan.n_tokens)
                : args.n_ubatch;
            int rc = mtmd_helper_decode_image_chunk(
                mmctx, ctx, chunk, embd, n_past, 0, image_decode_batch, &new_n_past);
            if (rc != 0) {
                log_line("failed to decode image embeddings into text model (rc=%d)", rc);
                llama_free(ctx);
                mtmd_input_chunks_free(chunks);
                mtmd_bitmap_free(bitmap);
                mtmd_free(mmctx);
                llama_model_free(model);
                llama_backend_free();
                return 1;
            }
            n_past = new_n_past;
            kv_columns += (int) mtmd_input_chunk_get_n_tokens(chunk);
            runtime_seen_image = true;
        }
    }

    std::vector<CapturedAttention> captures_ordered;
    for (int l : selected_layers) {
        auto it = cap.per_layer.find(l);
        if (it != cap.per_layer.end()) captures_ordered.push_back(it->second);
    }
    if (captures_ordered.empty()) {
        log_line("no attention captures; selected layers may still be using flash attention");
        llama_free(ctx);
        mtmd_input_chunks_free(chunks);
        mtmd_bitmap_free(bitmap);
        mtmd_free(mmctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }

    std::string context_text;
    std::vector<Chunk> context_chunks;
    context_chunks.reserve((size_t) image_plan.grid_w * image_plan.grid_h);
    for (int y = 0; y < image_plan.grid_h; y++) {
        for (int x = 0; x < image_plan.grid_w; x++) {
            int start = (int) context_text.size();
            context_text += ".";
            char label[96];
            std::snprintf(label, sizeof(label), "image:patch_%04d_%04d", y, x);
            context_chunks.push_back({label, start, start + 1, "."});
        }
        context_text += "\n";
    }

    std::string query_text;
    std::vector<Chunk> query_chunks;
    std::vector<int> prompt_query_local_to_chunk(prompt_row_positions.size(), 0);
    if (args.image_query_segment == "token") {
        query_chunks.reserve(prompt_row_positions.size());
        for (size_t i = 0; i < prompt_row_positions.size(); i++) {
            std::string piece = captured_prompt_tokens[i] != 0
                ? token_piece(vocab, captured_prompt_tokens[i])
                : "";
            if (piece.empty()) {
                piece = "<tok:" + std::to_string((int) captured_prompt_tokens[i]) + ">";
            }
            int start = (int) query_text.size();
            query_text += piece;
            int end = (int) query_text.size();
            char label[96];
            std::snprintf(label, sizeof(label), "prompt:tok_%06zu", i);
            query_chunks.push_back({label, start, end, piece});
            prompt_query_local_to_chunk[i] = (int) i;
            if (i + 1 < prompt_row_positions.size()) query_text += "\n";
        }
    } else if (args.image_query_segment == "line") {
        query_text = capture_prompt_text;
        std::vector<int> source_line_to_chunk;
        int source_line = 0;
        size_t line_start = 0;
        while (line_start <= query_text.size()) {
            size_t line_end = query_text.find('\n', line_start);
            if (line_end == std::string::npos) line_end = query_text.size();
            std::string line_text = query_text.substr(line_start, line_end - line_start);
            if ((int) source_line_to_chunk.size() <= source_line) source_line_to_chunk.resize((size_t) source_line + 1, -1);
            if (!trim_ascii_whitespace(line_text).empty()) {
                char label[96];
                std::snprintf(label, sizeof(label), "prompt:line_%06d", (int) query_chunks.size());
                source_line_to_chunk[(size_t) source_line] = (int) query_chunks.size();
                query_chunks.push_back({label, (int) line_start, (int) line_end, line_text});
            }
            if (line_end == query_text.size()) break;
            line_start = line_end + 1;
            source_line++;
        }
        if (query_chunks.empty()) {
            query_chunks.push_back({"prompt:line_000000", 0, (int) query_text.size(), query_text});
        }

        int token_source_line = 0;
        int last_chunk = source_line_to_chunk.empty() ? 0 : std::max(0, source_line_to_chunk[0]);
        for (size_t i = 0; i < prompt_row_positions.size(); i++) {
            std::string piece = captured_prompt_tokens[i] != 0
                ? token_piece(vocab, captured_prompt_tokens[i])
                : "";
            bool has_content = false;
            for (char ch : piece) {
                if (ch != '\n' && !std::isspace((unsigned char) ch)) {
                    has_content = true;
                    break;
                }
            }
            int chunk = -1;
            if (token_source_line >= 0 && token_source_line < (int) source_line_to_chunk.size()) {
                chunk = source_line_to_chunk[(size_t) token_source_line];
            }
            if (chunk >= 0) {
                last_chunk = chunk;
            } else {
                chunk = last_chunk;
            }
            prompt_query_local_to_chunk[i] = std::max(0, std::min(chunk, (int) query_chunks.size() - 1));
            for (char ch : piece) {
                if (ch == '\n') {
                    token_source_line++;
                    while (token_source_line < (int) source_line_to_chunk.size() &&
                           source_line_to_chunk[(size_t) token_source_line] < 0) {
                        token_source_line++;
                    }
                    if (!has_content && token_source_line < (int) source_line_to_chunk.size() &&
                        source_line_to_chunk[(size_t) token_source_line] >= 0) {
                        last_chunk = source_line_to_chunk[(size_t) token_source_line];
                    }
                }
            }
        }
    } else {
        query_text = capture_prompt_text;
        query_chunks.push_back({"prompt:prompt_000000", 0, (int) query_text.size(), query_text});
    }
    const bool image_sink_normalization = args.sink_normalization && prompt_row_positions.size() >= 3;

    std::vector<int> combined_context_to_image;
    std::vector<int> combined_context_to_svg;
    std::vector<int> combined_prompt_query_to_chunk;
    std::vector<int> combined_svg_query_to_chunk;
    std::vector<int> combined_image_query_to_chunk;
    const size_t image_rows = image_key_columns.size();
    const size_t svg_rows = svg_token_positions.size();
    if (svg_before_image) {
        combined_context_to_svg.reserve(svg_rows + image_plan.token_to_cell.size());
        for (size_t i = 0; i < svg_rows; i++) {
            int chunk = i < svg_token_local_to_chunk.size() ? svg_token_local_to_chunk[i] : -1;
            combined_context_to_svg.push_back(chunk);
        }
        combined_context_to_svg.resize(svg_rows + image_plan.token_to_cell.size(), -1);

        combined_context_to_image.assign(svg_rows, -1);
        combined_context_to_image.insert(
            combined_context_to_image.end(),
            image_plan.token_to_cell.begin(),
            image_plan.token_to_cell.end()
        );

        combined_image_query_to_chunk = image_plan.token_to_cell;
        combined_image_query_to_chunk.resize(image_rows + prompt_row_positions.size(), -1);

        combined_prompt_query_to_chunk.assign(image_rows, -1);
        combined_prompt_query_to_chunk.insert(
            combined_prompt_query_to_chunk.end(),
            prompt_query_local_to_chunk.begin(),
            prompt_query_local_to_chunk.end()
        );

        combined_svg_query_to_chunk.assign(image_rows + prompt_row_positions.size(), -1);
    } else {
        combined_context_to_image.reserve(image_plan.token_to_cell.size() + svg_rows);
        combined_context_to_image.insert(
            combined_context_to_image.end(),
            image_plan.token_to_cell.begin(),
            image_plan.token_to_cell.end()
        );
        combined_context_to_image.resize(image_plan.token_to_cell.size() + svg_rows, -1);

        combined_context_to_svg.assign(image_plan.token_to_cell.size(), -1);
        for (size_t i = 0; i < svg_rows; i++) {
            int chunk = i < svg_token_local_to_chunk.size() ? svg_token_local_to_chunk[i] : -1;
            combined_context_to_svg.push_back(chunk);
        }

        combined_prompt_query_to_chunk.assign(svg_rows, -1);
        combined_prompt_query_to_chunk.insert(
            combined_prompt_query_to_chunk.end(),
            prompt_query_local_to_chunk.begin(),
            prompt_query_local_to_chunk.end()
        );

        combined_svg_query_to_chunk.reserve(svg_rows + prompt_row_positions.size());
        for (size_t i = 0; i < svg_rows; i++) {
            int chunk = i < svg_token_local_to_chunk.size() ? svg_token_local_to_chunk[i] : -1;
            combined_svg_query_to_chunk.push_back(chunk);
        }
        combined_svg_query_to_chunk.resize(svg_rows + prompt_row_positions.size(), -1);

        combined_image_query_to_chunk.assign(svg_rows + prompt_row_positions.size(), -1);
    }

    auto scores = aggregate_captured(
        captures_ordered,
        combined_prompt_query_to_chunk,
        combined_context_to_image,
        (int) query_chunks.size(),
        image_plan.grid_w * image_plan.grid_h,
        image_sink_normalization,
        /*global_normalize=*/true
    );
    auto prompt_svg_scores = aggregate_captured(
        captures_ordered,
        combined_prompt_query_to_chunk,
        combined_context_to_svg,
        (int) query_chunks.size(),
        (int) svg_chunks.size(),
        /*sink_normalization=*/false,
        /*global_normalize=*/true
    );
    std::vector<std::vector<float>> svg_image_scores(
        svg_chunks.size(),
        std::vector<float>((size_t) image_plan.grid_w * image_plan.grid_h, 0.0f)
    );
    std::vector<std::vector<float>> image_svg_scores(
        (size_t) image_plan.grid_w * image_plan.grid_h,
        std::vector<float>(svg_chunks.size(), 0.0f)
    );
    if (svg_before_image) {
        image_svg_scores = aggregate_captured(
            captures_ordered,
            combined_image_query_to_chunk,
            combined_context_to_svg,
            image_plan.grid_w * image_plan.grid_h,
            (int) svg_chunks.size(),
            /*sink_normalization=*/false,
            /*global_normalize=*/true
        );
    } else {
        svg_image_scores = aggregate_captured(
            captures_ordered,
            combined_svg_query_to_chunk,
            combined_context_to_image,
            (int) svg_chunks.size(),
            image_plan.grid_w * image_plan.grid_h,
            /*sink_normalization=*/false,
            /*global_normalize=*/true
        );
    }
    std::vector<float> flat_scores((size_t) image_plan.grid_w * image_plan.grid_h, 0.0f);
    for (const auto & row : scores) {
        for (size_t c = 0; c < flat_scores.size() && c < row.size(); c++) {
            flat_scores[c] = std::max(flat_scores[c], row[c]);
        }
    }

    std::vector<std::vector<float>> image_heatmap(
        image_plan.grid_h,
        std::vector<float>(image_plan.grid_w, 0.0f)
    );
    for (int y = 0; y < image_plan.grid_h; y++) {
        for (int x = 0; x < image_plan.grid_w; x++) {
            int idx = y * image_plan.grid_w + x;
            if (idx >= 0 && idx < (int) flat_scores.size()) {
                image_heatmap[y][x] = flat_scores[(size_t) idx];
            }
        }
    }

    int output_grid_w = args.image_output_grid_w > 0
        ? std::min(args.image_output_grid_w, image_plan.grid_w)
        : image_plan.grid_w;
    int output_grid_h = args.image_output_grid_h > 0
        ? std::min(args.image_output_grid_h, image_plan.grid_h)
        : image_plan.grid_h;
    output_grid_w = std::max(1, output_grid_w);
    output_grid_h = std::max(1, output_grid_h);

    std::vector<std::vector<float>> output_scores;
    if (output_grid_w == image_plan.grid_w && output_grid_h == image_plan.grid_h) {
        output_scores = scores;
    } else {
        output_scores.assign(
            scores.size(),
            std::vector<float>((size_t) output_grid_w * output_grid_h, 0.0f)
        );
        for (size_t r = 0; r < scores.size(); r++) {
            for (int y = 0; y < image_plan.grid_h; y++) {
                int oy = std::min(output_grid_h - 1, (y * output_grid_h) / image_plan.grid_h);
                for (int x = 0; x < image_plan.grid_w; x++) {
                    int ox = std::min(output_grid_w - 1, (x * output_grid_w) / image_plan.grid_w);
                    int src = y * image_plan.grid_w + x;
                    int dst = oy * output_grid_w + ox;
                    if (src >= 0 && src < (int) scores[r].size()) {
                        output_scores[r][(size_t) dst] += scores[r][(size_t) src];
                    }
                }
            }
        }
    }

    std::vector<std::vector<float>> output_svg_image_scores;
    if (output_grid_w == image_plan.grid_w && output_grid_h == image_plan.grid_h) {
        output_svg_image_scores = svg_image_scores;
    } else {
        output_svg_image_scores.assign(
            svg_image_scores.size(),
            std::vector<float>((size_t) output_grid_w * output_grid_h, 0.0f)
        );
        for (size_t r = 0; r < svg_image_scores.size(); r++) {
            for (int y = 0; y < image_plan.grid_h; y++) {
                int oy = std::min(output_grid_h - 1, (y * output_grid_h) / image_plan.grid_h);
                for (int x = 0; x < image_plan.grid_w; x++) {
                    int ox = std::min(output_grid_w - 1, (x * output_grid_w) / image_plan.grid_w);
                    int src = y * image_plan.grid_w + x;
                    int dst = oy * output_grid_w + ox;
                    if (src >= 0 && src < (int) svg_image_scores[r].size()) {
                        output_svg_image_scores[r][(size_t) dst] += svg_image_scores[r][(size_t) src];
                    }
                }
            }
        }
    }

    std::vector<std::vector<float>> output_image_svg_scores;
    if (output_grid_w == image_plan.grid_w && output_grid_h == image_plan.grid_h) {
        output_image_svg_scores = image_svg_scores;
    } else {
        output_image_svg_scores.assign(
            (size_t) output_grid_w * output_grid_h,
            std::vector<float>(svg_chunks.size(), 0.0f)
        );
        for (int y = 0; y < image_plan.grid_h; y++) {
            int oy = std::min(output_grid_h - 1, (y * output_grid_h) / image_plan.grid_h);
            for (int x = 0; x < image_plan.grid_w; x++) {
                int ox = std::min(output_grid_w - 1, (x * output_grid_w) / image_plan.grid_w);
                int src = y * image_plan.grid_w + x;
                int dst = oy * output_grid_w + ox;
                if (src < 0 || src >= (int) image_svg_scores.size()) continue;
                for (size_t c = 0; c < svg_chunks.size() && c < image_svg_scores[(size_t) src].size(); c++) {
                    output_image_svg_scores[(size_t) dst][c] += image_svg_scores[(size_t) src][c];
                }
            }
        }
        for (auto & row : output_image_svg_scores) normalize_row(row);
    }

    std::vector<float> output_flat_scores((size_t) output_grid_w * output_grid_h, 0.0f);
    for (const auto & row : output_scores) {
        for (size_t c = 0; c < output_flat_scores.size() && c < row.size(); c++) {
            output_flat_scores[c] = std::max(output_flat_scores[c], row[c]);
        }
    }
    std::vector<std::vector<float>> output_heatmap(
        output_grid_h,
        std::vector<float>(output_grid_w, 0.0f)
    );
    for (int y = 0; y < output_grid_h; y++) {
        for (int x = 0; x < output_grid_w; x++) {
            int idx = y * output_grid_w + x;
            output_heatmap[y][x] = output_flat_scores[(size_t) idx];
        }
    }

    context_text.clear();
    context_chunks.clear();
    context_chunks.reserve((size_t) output_grid_w * output_grid_h);
    for (int y = 0; y < output_grid_h; y++) {
        for (int x = 0; x < output_grid_w; x++) {
            int start = (int) context_text.size();
            context_text += ".";
            char label[96];
            std::snprintf(label, sizeof(label), "image:cell_%04d_%04d", y, x);
            context_chunks.push_back({label, start, start + 1, "."});
        }
        context_text += "\n";
    }

    std::string image_bytes = read_file(args.image_path);
    std::string data_url = "data:" + mime_type_for_path(args.image_path) + ";base64," + base64_encode(image_bytes);

    JsonOut j;
    j.s << "{";
    j.s << "\"context_text\":"; j.escape(context_text);
    j.s << ",\"query_text\":"; j.escape(query_text);
    j.s << ",\"context_chunks\":"; j.chunks(context_chunks);
    j.s << ",\"query_chunks\":"; j.chunks(query_chunks);
    j.s << ",\"scores\":"; j.matrix(output_scores, context_chunks, context_text, 0);
    j.s << ",\"head_scores\":[]";
    j.s << ",\"layer_scores\":[]";
    j.s << ",\"image\":{";
    j.s << "\"path\":"; j.escape(args.image_path);
    j.s << ",\"width\":" << image_width;
    j.s << ",\"height\":" << image_height;
    j.s << ",\"grid_width\":" << output_grid_w;
    j.s << ",\"grid_height\":" << output_grid_h;
    j.s << ",\"native_grid_width\":" << image_plan.grid_w;
    j.s << ",\"native_grid_height\":" << image_plan.grid_h;
    j.s << ",\"token_count\":" << image_plan.n_tokens;
    j.s << ",\"data_url\":"; j.escape(data_url);
    j.s << ",\"heatmap\":[";
    for (int y = 0; y < output_grid_h; y++) {
        if (y) j.s << ',';
        j.s << '[';
        for (int x = 0; x < output_grid_w; x++) {
            if (x) j.s << ',';
            j.num(output_heatmap[y][x]);
        }
        j.s << ']';
    }
    j.s << "]";
    j.s << "}";
    if (!svg_source.empty()) {
        j.s << ",\"svg\":{";
        j.s << "\"path\":"; j.escape(args.svg_path);
        j.s << ",\"source\":"; j.escape(svg_source);
        j.s << ",\"chunks\":"; j.chunks(svg_chunks);
        j.s << ",\"prompt_scores\":"; j.matrix(prompt_svg_scores, svg_chunks, svg_source, 0);
        j.s << ",\"image_scores\":"; j.matrix(output_svg_image_scores, context_chunks, context_text, 0);
        j.s << ",\"image_query_scores\":"; j.matrix(output_image_svg_scores, svg_chunks, svg_source, 0);
        j.s << ",\"attention_order\":"; j.escape(svg_before_image ? "svg-image-prompt" : "image-svg-prompt");
        j.s << ",\"capture_strategy\":"; j.escape(svg_capture_strategy);
        j.s << ",\"match_start\":" << svg_match_start;
        j.s << ",\"match_length\":" << svg_match_length;
        j.s << ",\"match_capture_start\":" << svg_match_capture_start;
        j.s << "}";
    }
    j.s << ",\"metadata\":{";
    j.s << "\"backend\":\"llama.cpp\"";
    j.s << ",\"mode\":\"image\"";
    j.s << ",\"model\":"; j.escape(args.model);
    j.s << ",\"mmproj\":"; j.escape(args.mmproj_path);
    j.s << ",\"offset_encoding\":\"utf8_bytes\"";
    j.s << ",\"prompt_marker\":"; j.escape(marker);
    j.s << ",\"prompt_rows\":" << prompt_row_positions.size();
    j.s << ",\"svg_rows\":" << svg_token_positions.size();
    j.s << ",\"svg_capture_strategy\":"; j.escape(svg_capture_strategy);
    j.s << ",\"prompt_capture_strategy\":"; j.escape(prompt_capture_strategy);
    j.s << ",\"image_attention_order\":"; j.escape(svg_before_image ? "svg-image-prompt" : "image-svg-prompt");
    j.s << ",\"captured_prompt_text\":"; j.escape(capture_prompt_text);
    j.s << ",\"prompt_text_tokens\":" << prompt_plain_tokens.size();
    j.s << ",\"post_image_text_tokens\":" << post_image_text_tokens;
    j.s << ",\"needed_context\":" << needed_ctx;
    j.s << ",\"context_size\":" << n_ctx;
    j.s << ",\"context_spare\":" << ctx_spare;
    j.s << ",\"model_context_train\":" << model_n_ctx_train;
    j.s << ",\"prompt_match_start\":" << prompt_match_start;
    j.s << ",\"prompt_match_length\":" << prompt_match_length;
    j.s << ",\"prompt_match_capture_start\":" << prompt_match_capture_start;
    j.s << ",\"image_query_segment\":"; j.escape(args.image_query_segment);
    j.s << ",\"image_heatmap_aggregation\":\"max_query_score\"";
    j.s << ",\"image_key_columns\":\"kv_order\"";
    j.s << ",\"sink_normalization\":" << (image_sink_normalization ? "true" : "false");
    j.s << ",\"sink_normalization_requested\":" << (args.sink_normalization ? "true" : "false");
    j.s << ",\"layers\":[";
    for (size_t i = 0; i < selected_layers.size(); i++) {
        if (i) j.s << ',';
        j.s << selected_layers[i];
    }
    j.s << "]";
    j.s << "}";
    j.s << "}";

    write_heatmap_output(args.out_path, j.s.str());
    log_line("wrote %s (image mode, %.2fs)", args.out_path.c_str(), (ggml_time_us() - t_start) / 1e6);

    llama_free(ctx);
    mtmd_input_chunks_free(chunks);
    mtmd_bitmap_free(bitmap);
    mtmd_free(mmctx);
    llama_model_free(model);
    llama_backend_free();
    return 0;
}

// -----------------------------------------------------------------------------
// Multi-doc scan: iterate context files one at a time against a single combined
// query corpus (concatenation of every doc under --query-tree). Each context
// file is its own tiny window — pass 1 stays small. KV cache is cleared between
// files. The output JSON contains every doc and every file in one document, so
// the explorer can group them in its existing tree views.

static int run_per_file_scan(const Args & args) {
    auto t_start = ggml_time_us();

    // 1. Walk markdown query docs.
    std::vector<std::string> qry_paths;
    if (!args.query_tree.empty()) {
        walk_directory(args.query_tree, args.query_glob, qry_paths);
    } else {
        qry_paths.push_back(args.query_path);
    }
    if (qry_paths.empty()) { log_line("no query docs found"); return 1; }
    std::sort(qry_paths.begin(), qry_paths.end());

    // 2. Walk context files.
    std::vector<std::string> ctx_paths;
    if (!args.context_tree.empty()) {
        walk_directory(args.context_tree, args.context_glob, ctx_paths);
    } else {
        ctx_paths.push_back(args.context_path);
    }
    if (ctx_paths.empty()) { log_line("no context files found"); return 1; }
    std::sort(ctx_paths.begin(), ctx_paths.end());
    log_line("context: %zu files matching '%s'", ctx_paths.size(), args.context_glob.c_str());

    // 3. Load model once, init context.
    llama_backend_init();
    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = args.n_gpu_layers;
    llama_model * model = llama_model_load_from_file(args.model.c_str(), mparams);
    if (!model) { log_line("failed to load model %s", args.model.c_str()); return 1; }
    const llama_vocab * vocab = llama_model_get_vocab(model);
    int n_layers = llama_model_n_layer(model);
    log_line("loaded model: layers=%d (%.2fs)", n_layers, (ggml_time_us() - t_start) / 1e6);

    std::vector<int> selected_layers;
    if (!args.layers.empty()) {
        selected_layers = parse_layers(args.layers);
    } else {
        int s = std::max(0, std::min(n_layers - 1, (int)(n_layers * args.layer_fraction_start)));
        int e = std::max(s + 1, std::min(n_layers, (int)(n_layers * args.layer_fraction_end)));
        for (int i = s; i < e; i++) selected_layers.push_back(i);
    }

    if (!args.cache_dir.empty()) ensure_dir(args.cache_dir);
    if (!args.dump_inputs_dir.empty()) ensure_dir(args.dump_inputs_dir);

    // 4. Build markdown query items. Each pass sees heading/list hierarchy,
    // while only the active item line maps to the output row.
    MarkdownQuerySet query_set = build_markdown_query_set(qry_paths, args.query_tree, args.strip_query, args.query_segment);
    if (query_set.items.empty()) { log_line("no markdown query items found"); return 1; }

    int total_query_tokens = 0;
    int max_doc_tokens = 0;
    for (auto & item : query_set.items) {
        std::string prompt_with_close = item.prompt_text + kQueryClose;
        std::string sha = sha256_hex(prompt_with_close);
        std::string cache_path = args.cache_dir.empty() ? "" : args.cache_dir + "/qryitem_" + sha + ".tok";
        item.ct = tokenize_with_cache(vocab, prompt_with_close, cache_path);
        int n = (int) item.ct.tokens.size();
        total_query_tokens += n;
        max_doc_tokens = std::max(max_doc_tokens, n);
        if (args.query_segment == "document_tokens" || args.query_segment == "phrase") {
            append_active_token_chunks(
                query_set,
                item,
                args.query_segment == "phrase" ? args.phrase_tokens : 1
            );
        }
    }
    log_line("query: %zu passes / %zu chunks / %zu chars / %d prompt tokens",
        query_set.items.size(), query_set.chunks.size(), query_set.text.size(), total_query_tokens);
    if (query_set.chunks.empty()) { log_line("no query chunks found"); return 1; }

    // 5. Init llama context. Keep the default bounded for Metal: KV cache and
    // attention capture memory scale with n_ctx even when each window is small.
    int query_batch_token_budget = max_doc_tokens * args.llm_batch_size;
    int n_ctx_budget = args.n_ctx > 0
        ? args.n_ctx
        : std::min(16384, std::max(4096, query_batch_token_budget + 8192 + 1024));
    if (n_ctx_budget < query_batch_token_budget + 1024) {
        log_line("ctx-size %d is too small for query batch budget (%d tokens); use --ctx-size %d or more or lower --llm-batch-size",
            n_ctx_budget, query_batch_token_budget, query_batch_token_budget + 1024);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    log_line("ctx: n_ctx=%d n_ubatch=%d llm_batch_size=%d gpu_layers=%d",
        n_ctx_budget, args.n_ubatch, args.llm_batch_size, args.n_gpu_layers);

    CaptureContext cap;
    for (int l : selected_layers) cap.selected_layers.insert(l);
    CallbackUserData ud{ &cap };

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = (uint32_t) n_ctx_budget;
    cparams.n_batch = (uint32_t) n_ctx_budget;
    cparams.n_ubatch = (uint32_t) args.n_ubatch;
    cparams.n_seq_max = (uint32_t) args.llm_batch_size + 1;
    cparams.kv_unified = true;
    cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
    cparams.cb_eval = eval_callback;
    cparams.cb_eval_user_data = &ud;
    cparams.no_perf = true;
    llama_context * ctx = llama_init_from_model(model, cparams);
    if (!ctx) { log_line("failed to init context"); return 1; }
    llama_memory_t mem = llama_get_memory(ctx);

    // 6. Iterate per file.
    std::string global_ctx_text;
    std::vector<Chunk> global_ctx_chunks;
    std::vector<std::vector<float>> global_scores(query_set.chunks.size(), std::vector<float>());

    auto t_scan_start = ggml_time_us();
    int written_files = 0;
    size_t dumped_inputs = 0;

    auto write_json_now = [&]() {
        if (args.mari_coverage) return;  // Mari mode emits findings once at the end, not a heatmap
        JsonOut j;
        j.s << "{";
        j.s << "\"context_text\":"; j.escape(global_ctx_text);
        j.s << ",\"query_text\":"; j.escape(query_set.text);
        j.s << ",\"context_chunks\":"; j.chunks(global_ctx_chunks);
        j.s << ",\"query_chunks\":"; j.chunks(query_set.chunks);
        j.s << ",\"scores\":"; j.matrix(global_scores, global_ctx_chunks, global_ctx_text, args.prune_top_k);
        j.s << ",\"head_scores\":[]";
        j.s << ",\"layer_scores\":[]";
        j.s << ",\"metadata\":{";
        j.s << "\"backend\":\"llama.cpp\"";
        j.s << ",\"model\":"; j.escape(args.model);
        j.s << ",\"offset_encoding\":\"utf8_bytes\"";
        j.s << ",\"per_file\":true";
        j.s << ",\"query_items_count\":" << query_set.items.size();
        j.s << ",\"query_chunks_count\":" << query_set.chunks.size();
        if (!args.input_prompt.empty()) {
            j.s << ",\"input_prompt\":"; j.escape(args.input_prompt);
        }
        if (!args.dump_inputs_dir.empty()) {
            j.s << ",\"dump_inputs_dir\":"; j.escape(args.dump_inputs_dir);
            j.s << ",\"dumped_inputs\":" << dumped_inputs;
        }
        j.s << ",\"query_chunk_mode\":";
        j.escape((args.query_segment == "document_tokens" || args.query_segment == "phrase") ? args.query_segment : "markdown_items");
        j.s << ",\"query_segment\":"; j.escape(args.query_segment);
        j.s << ",\"context_segment\":"; j.escape(args.context_segment);
        j.s << ",\"phrase_tokens\":" << args.phrase_tokens;
        j.s << ",\"llm_batch_size\":" << args.llm_batch_size;
        j.s << ",\"files_total\":" << ctx_paths.size();
        j.s << ",\"files_done\":" << written_files;
        j.s << ",\"write_every_docs\":" << args.write_every_docs;
        j.s << ",\"score_prune_top_k\":" << args.prune_top_k;
        j.s << ",\"layers\":[";
        for (size_t i = 0; i < selected_layers.size(); i++) {
            if (i) j.s << ',';
            j.s << selected_layers[i];
        }
        j.s << "]";
        j.s << "}";
        j.s << "}";
        write_heatmap_output(args.out_path, j.s.str());
    };

    // Mari coverage: coverage[c] = total attention source span c received from the translation
    // (sum over all query rows). Spans below `mari_threshold` of the peak are content the
    // translation likely avoided. Adjacent low spans merge into one region. Emit findings JSON
    // to stdout (no heatmap, no reparse).
    auto write_mari_coverage = [&]() {
        const size_t C = global_ctx_chunks.size();
        std::vector<double> cov(C, 0.0);
        for (const auto & row : global_scores)
            for (size_t c = 0; c < row.size() && c < C; c++) cov[c] += row[c];
        double peak = 1e-9;
        for (double v : cov) peak = std::max(peak, v);

        JsonOut j;
        j.s << "{\"mari_coverage\":true,\"source_spans\":" << C
            << ",\"threshold\":" << args.mari_threshold << ",\"flagged\":[";
        bool first = true, in_run = false;
        int run_start = 0; double run_min = 1.0;
        auto close_run = [&](int end_idx) {
            std::string text;
            for (int i = run_start; i <= end_idx; i++) text += global_ctx_chunks[i].text;
            if (text.size() >= 12) {
                if (!first) j.s << ",";
                first = false;
                j.s << "{\"score\":" << run_min
                    << ",\"offset\":" << global_ctx_chunks[run_start].start
                    << ",\"label\":"; j.escape(global_ctx_chunks[run_start].label);
                j.s << ",\"text\":"; j.escape(text.substr(0, 240));
                j.s << "}";
            }
        };
        for (size_t c = 0; c < C; c++) {
            double n = cov[c] / peak;
            if (n < args.mari_threshold) {
                if (!in_run) { in_run = true; run_start = (int) c; run_min = n; }
                else run_min = std::min(run_min, n);
            } else if (in_run) { close_run((int) c - 1); in_run = false; }
        }
        if (in_run) close_run((int) C - 1);
        j.s << "]}";
        std::printf("%s\n", j.s.str().c_str());
    };

    auto decode_token_run = [&](const std::vector<llama_token> & toks,
                                int abs_start_pos,
                                bool capture_active) -> bool {
        for (size_t pos = 0; pos < toks.size(); pos += args.n_ubatch) {
            int batch_n = (int) std::min((size_t) args.n_ubatch, toks.size() - pos);
            llama_batch batch = llama_batch_init(batch_n, 0, 1);
            batch.n_tokens = batch_n;
            for (int i = 0; i < batch_n; i++) {
                batch.token[i] = toks[pos + i];
                batch.pos[i] = abs_start_pos + (int) pos + i;
                batch.n_seq_id[i] = 1;
                batch.seq_id[i][0] = 0;
                batch.logits[i] = 0;
            }
            cap.batch_query_pos_start = capture_active ? (abs_start_pos + (int) pos) : -1;
            cap.batch_query_pos_end = capture_active ? (abs_start_pos + (int) pos + batch_n) : -1;
            int rc = llama_decode(ctx, batch);
            llama_batch_free(batch);
            if (rc != 0) {
                log_line("decode failed pos=%d rc=%d; try a smaller --ctx-size, smaller --ubatch, or fewer --gpu-layers",
                    abs_start_pos + (int) pos, rc);
                return false;
            }
        }
        return true;
    };

    int per_window_token_budget = (int) cparams.n_ctx - query_batch_token_budget - 1024; // safety
    if (per_window_token_budget < 1024) per_window_token_budget = 1024;

    for (size_t fi = 0; fi < ctx_paths.size(); fi++) {
        auto t_file_start = ggml_time_us();
        const std::string & path = ctx_paths[fi];
        std::string rel = args.context_tree.empty()
            ? path
            : path.substr(args.context_tree.size() + (args.context_tree.back() == '/' ? 0 : 1));

        std::string content = strip_text(read_file(path), args.strip_context);
        if (content.empty() || content == "\n") {
            log_line("[%zu/%zu] skip empty %s", fi + 1, ctx_paths.size(), rel.c_str());
            continue;
        }
        // ---- Tokenize file content once for window planning + caching.
        std::string content_sha = sha256_hex(content);
        std::string content_cache = args.cache_dir.empty() ? "" : args.cache_dir + "/" + content_sha + ".tok";
        CachedTokens full_ct = tokenize_with_cache(vocab, content, content_cache);

        auto file_chunks_local = args.context_segment == "phrase"
            ? phrase_chunks_from_offsets(content, full_ct, rel, args.phrase_tokens)
            : token_chunks_from_offsets(content, full_ct, rel);
        if (file_chunks_local.empty()) {
            file_chunks_local.push_back({rel + ":file", 0, (int) content.size(), content});
        }

        // Count tokens per chunk so we can pack windows by token budget.
        std::vector<int> per_chunk_tokens(file_chunks_local.size(), 0);
        {
            int cidx = 0;
            for (size_t ti = 0; ti < full_ct.tokens.size(); ti++) {
                int ts = full_ct.char_start[ti];
                while (cidx < (int) file_chunks_local.size() && file_chunks_local[cidx].end <= ts) cidx++;
                if (cidx < (int) file_chunks_local.size() &&
                    file_chunks_local[cidx].start <= ts && ts < file_chunks_local[cidx].end) {
                    per_chunk_tokens[cidx]++;
                }
            }
        }

        // Pack chunks into windows of ≤ per_window_token_budget tokens each.
        // Each chunk goes into the current window unless it would push the total
        // past the budget; in that case we open a new window. Oversize single
        // chunks land alone and may still exceed budget — those get skipped at
        // decode-time.
        std::vector<std::pair<int, int>> windows;
        {
            int wstart = 0, wtok = 0;
            for (int i = 0; i < (int) file_chunks_local.size(); i++) {
                if (wstart < i && wtok + per_chunk_tokens[i] > per_window_token_budget) {
                    windows.push_back({wstart, i});
                    wstart = i;
                    wtok = 0;
                }
                wtok += per_chunk_tokens[i];
            }
            if (wstart < (int) file_chunks_local.size()) {
                windows.push_back({wstart, (int) file_chunks_local.size()});
            }
        }
        if (windows.empty()) windows.push_back({0, (int) file_chunks_local.size()});

        // ---- Per-window pass 1 + per-doc pass 2.
        std::string prefix_text = make_prefix_text(args.input_prompt);
        std::string middle_text = kMiddle;
        std::vector<int32_t> skip(selected_layers.begin(), selected_layers.end());
        size_t total_chunks_emitted = 0;
        bool any_window_processed = false;

        for (size_t wi = 0; wi < windows.size(); wi++) {
            int wfirst = windows[wi].first;
            int wlast  = windows[wi].second;
            int win_start_char = file_chunks_local[wfirst].start;
            int win_end_char   = file_chunks_local[wlast - 1].end;
            std::string win_content = content.substr(win_start_char, win_end_char - win_start_char);

            std::vector<Chunk> win_chunks_local;
            win_chunks_local.reserve(wlast - wfirst);
            for (int i = wfirst; i < wlast; i++) {
                Chunk c = file_chunks_local[i];
                c.start -= win_start_char;
                c.end   -= win_start_char;
                win_chunks_local.push_back(c);
            }

            std::string window_tag;
            if (windows.size() > 1) {
                char buf[64];
                std::snprintf(buf, sizeof(buf), " (window %zu/%zu)", wi + 1, windows.size());
                window_tag = buf;
            }
            std::string file_header = "\n// === " + rel + window_tag + " ===\n";

            // ---- Build pass-1 token stream: prefix + file_header + win_content + middle.
            TokenizedDoc pre;
            int pre_cursor = 0;
            auto append_pre = [&](const std::vector<llama_token> & toks,
                                  const std::vector<int> & cs,
                                  const std::vector<int> & ce,
                                  int shift) {
                for (size_t i = 0; i < toks.size(); i++) {
                    pre.tokens.push_back(toks[i]);
                    pre.char_start.push_back(cs[i] + shift);
                    pre.char_end.push_back(ce[i] + shift);
                }
            };
            auto append_pre_inline = [&](const std::string & text) {
                int shift = pre_cursor;
                auto td = tokenize_with_offsets(vocab, text);
                append_pre(td.tokens, td.char_start, td.char_end, shift);
                pre_cursor += (int) text.size();
            };
            auto append_pre_cached = [&](const std::string & text, const std::string & cache_path) {
                int shift = pre_cursor;
                auto ct_inner = tokenize_with_cache(vocab, text, cache_path);
                append_pre(ct_inner.tokens, ct_inner.char_start, ct_inner.char_end, shift);
                pre_cursor += (int) text.size();
            };

            append_pre_inline(prefix_text);
            append_pre_inline(file_header);
            int ctx_body_char_start = pre_cursor;
            std::string win_sha = sha256_hex(win_content);
            std::string win_cache = args.cache_dir.empty() ? "" : args.cache_dir + "/" + win_sha + ".tok";
            append_pre_cached(win_content, win_cache);
            int ctx_body_char_end = pre_cursor;
            append_pre_inline(middle_text);
            int pass1_char_end = pre_cursor;
            std::string pre_text_for_dump;
            if (!args.dump_inputs_dir.empty()) {
                pre_text_for_dump = prefix_text + file_header + win_content + middle_text;
            }

            std::vector<Chunk> win_chunks_abs;
            win_chunks_abs.reserve(win_chunks_local.size());
            for (auto & c : win_chunks_local) {
                Chunk abs_chunk = c;
                abs_chunk.start = ctx_body_char_start + c.start;
                abs_chunk.end   = ctx_body_char_start + c.end;
                win_chunks_abs.push_back(abs_chunk);
            }

            std::vector<int> ctx_tok_indices = token_indices_for_range(pre, ctx_body_char_start, ctx_body_char_end);
            if (ctx_tok_indices.empty()) {
                log_line("[%zu/%zu] window %zu/%zu skip (no ctx tokens) %s",
                    fi + 1, ctx_paths.size(), wi + 1, windows.size(), rel.c_str());
                continue;
            }

            int pass1_token_count = (int) pre.tokens.size();
            if (pass1_token_count + query_batch_token_budget + 8 > (int) cparams.n_ctx) {
                log_line("[%zu/%zu] window %zu/%zu skip (too large: %d ctx + %d query-batch budget > %u) %s",
                    fi + 1, ctx_paths.size(), wi + 1, windows.size(),
                    pass1_token_count, query_batch_token_budget, cparams.n_ctx, rel.c_str());
                continue;
            }

            // Pass 1.
            llama_memory_clear(mem, false);
            llama_set_flash_attn_skip(ctx, nullptr, 0);
            if (!decode_token_run(pre.tokens, /*abs_start_pos=*/0, /*capture=*/false)) {
                write_json_now();
                llama_free(ctx);
                llama_model_free(model);
                llama_backend_free();
                return 1;
            }

            // Per-query/source pass 2.
            std::vector<std::vector<float>> file_scores(query_set.chunks.size(),
                                                         std::vector<float>(win_chunks_local.size(), 0.0f));

            struct QueryBatchWork {
                size_t qi = 0;
                int seq_id = 0;
                std::vector<int> qry_tok_indices;
                std::vector<int> query_local_to_chunk;
                std::vector<int> context_local_to_chunk;
            };

            auto build_query_work = [&](size_t qi, int seq_id, QueryBatchWork & work) -> bool {
                auto & item = query_set.items[qi];
                if (item.ct.tokens.empty()) return false;

                if (!args.dump_inputs_dir.empty()) {
                    std::string dump_path = dump_input_filename(
                        args.dump_inputs_dir,
                        dumped_inputs,
                        rel,
                        wi,
                        item.label
                    );
                    write_file(dump_path, pre_text_for_dump + item.prompt_text + kQueryClose);
                    dumped_inputs++;
                }

                int doc_char_start = pass1_char_end;

                TokenizedDoc synth = pre;
                for (size_t i = 0; i < item.ct.tokens.size(); i++) {
                    synth.tokens.push_back(item.ct.tokens[i]);
                    synth.char_start.push_back(doc_char_start + item.ct.char_start[i]);
                    synth.char_end.push_back(doc_char_start + item.ct.char_end[i]);
                }

                std::vector<int> ctx_token_to_chunk = token_to_chunk_map(synth, win_chunks_abs);
                std::vector<Chunk> qry_chunks_abs;
                qry_chunks_abs.reserve(item.query_chunk_count);
                for (int qci = 0; qci < item.query_chunk_count; qci++) {
                    const Chunk & qc = query_set.chunks[item.query_chunk_start + qci];
                    Chunk abs_chunk = qc;
                    abs_chunk.start = doc_char_start + item.active_start + (qc.start - item.display_start);
                    abs_chunk.end = doc_char_start + item.active_start + (qc.end - item.display_start);
                    qry_chunks_abs.push_back(abs_chunk);
                }
                std::vector<int> qry_token_to_chunk = token_to_chunk_map(synth, qry_chunks_abs);

                std::vector<int> qry_tok_indices_raw = token_indices_for_range(
                    synth,
                    doc_char_start + item.active_start,
                    doc_char_start + item.active_end
                );
                std::vector<int> qry_tok_indices;
                qry_tok_indices.reserve(qry_tok_indices_raw.size());
                for (int t : qry_tok_indices_raw) if (t - 1 >= 0) qry_tok_indices.push_back(t - 1);
                std::sort(qry_tok_indices.begin(), qry_tok_indices.end());
                qry_tok_indices.erase(std::unique(qry_tok_indices.begin(), qry_tok_indices.end()), qry_tok_indices.end());
                if (qry_tok_indices.empty()) return false;

                std::vector<int> query_local_to_chunk(qry_tok_indices.size(), -1);
                for (size_t i = 0; i < qry_tok_indices.size(); i++) {
                    int original_token = qry_tok_indices[i] + 1; // undo causal shift
                    if (original_token >= 0 && original_token < (int) qry_token_to_chunk.size()) {
                        query_local_to_chunk[i] = qry_token_to_chunk[original_token];
                    }
                }
                std::vector<int> context_local_to_chunk(ctx_tok_indices.size(), -1);
                for (size_t i = 0; i < ctx_tok_indices.size(); i++) {
                    int t = ctx_tok_indices[i];
                    if (t >= 0 && t < (int) ctx_token_to_chunk.size()) {
                        context_local_to_chunk[i] = ctx_token_to_chunk[t];
                    }
                }

                work.qi = qi;
                work.seq_id = seq_id;
                work.qry_tok_indices = std::move(qry_tok_indices);
                work.query_local_to_chunk = std::move(query_local_to_chunk);
                work.context_local_to_chunk = std::move(context_local_to_chunk);
                return true;
            };

            auto decode_query_batch = [&](const std::vector<QueryBatchWork> & works,
                                          std::vector<CaptureTarget> & targets) -> bool {
                if (works.empty()) return true;
                int doc_token_pos_start = pass1_token_count;
                int max_tokens = 0;
                for (auto & work : works) {
                    const auto & item = query_set.items[work.qi];
                    max_tokens = std::max(max_tokens, (int) item.ct.tokens.size());
                    llama_memory_seq_rm(mem, work.seq_id, -1, -1);
                    llama_memory_seq_cp(mem, 0, work.seq_id, 0, pass1_token_count);
                }

                int per_seq_step = std::max(1, args.n_ubatch / std::max(1, (int) works.size()));
                cap.context_token_positions = ctx_tok_indices;
                targets.clear();
                targets.reserve(works.size());
                for (auto & work : works) {
                    CaptureTarget target;
                    target.seq_id = work.seq_id;
                    target.query_token_positions = work.qry_tok_indices;
                    targets.push_back(std::move(target));
                }
                cap.active_targets = &targets;

                llama_set_flash_attn_skip(ctx, skip.data(), (int32_t) skip.size());
                bool ok = true;
                for (int offset = 0; ok && offset < max_tokens; offset += per_seq_step) {
                    int batch_n = 0;
                    for (auto & work : works) {
                        const auto & item = query_set.items[work.qi];
                        if (offset >= (int) item.ct.tokens.size()) continue;
                        batch_n += std::min(per_seq_step, (int) item.ct.tokens.size() - offset);
                    }
                    if (batch_n == 0) continue;

                    llama_batch batch = llama_batch_init(batch_n, 0, (int32_t) works.size());
                    batch.n_tokens = batch_n;
                    cap.batch_query_positions.clear();
                    cap.batch_query_seq_ids.clear();
                    cap.batch_query_positions.reserve(batch_n);
                    cap.batch_query_seq_ids.reserve(batch_n);

                    int row = 0;
                    for (auto & work : works) {
                        const auto & item = query_set.items[work.qi];
                        if (offset >= (int) item.ct.tokens.size()) continue;
                        int n = std::min(per_seq_step, (int) item.ct.tokens.size() - offset);
                        for (int j = 0; j < n; j++) {
                            int pos = doc_token_pos_start + offset + j;
                            batch.token[row] = item.ct.tokens[(size_t) offset + j];
                            batch.pos[row] = pos;
                            batch.n_seq_id[row] = 1;
                            batch.seq_id[row][0] = work.seq_id;
                            batch.logits[row] = 0;
                            cap.batch_query_positions.push_back(pos);
                            cap.batch_query_seq_ids.push_back(work.seq_id);
                            row++;
                        }
                    }

                    int rc = llama_decode(ctx, batch);
                    llama_batch_free(batch);
                    if (rc != 0) {
                        log_line("batched decode failed offset=%d rc=%d; try --llm-batch-size 1, a smaller --ubatch, smaller --ctx-size, or fewer --gpu-layers",
                            offset, rc);
                        ok = false;
                    }
                }

                for (auto & work : works) {
                    llama_memory_seq_rm(mem, work.seq_id, -1, -1);
                }
                cap.active_targets = nullptr;
                cap.batch_query_positions.clear();
                cap.batch_query_seq_ids.clear();
                return ok;
            };

            for (size_t base_qi = 0; base_qi < query_set.items.size(); ) {
                std::vector<QueryBatchWork> works;
                works.reserve(args.llm_batch_size);
                size_t qi = base_qi;
                for (; qi < query_set.items.size() && (int) works.size() < args.llm_batch_size; qi++) {
                    QueryBatchWork work;
                    int seq_id = (int) works.size() + 1;
                    if (build_query_work(qi, seq_id, work)) {
                        works.push_back(std::move(work));
                    }
                }
                base_qi = qi;
                if (works.empty()) continue;

                std::vector<CaptureTarget> targets;
                if (!decode_query_batch(works, targets)) {
                    write_json_now();
                    llama_free(ctx);
                    llama_model_free(model);
                    llama_backend_free();
                    return 1;
                }

                for (size_t wi_work = 0; wi_work < works.size(); wi_work++) {
                    const auto & work = works[wi_work];
                    const auto & item = query_set.items[work.qi];
                    const auto & target = targets[wi_work];

                    std::vector<CapturedAttention> captures_ordered;
                    for (int l : selected_layers) {
                        auto it = target.per_layer.find(l);
                        if (it != target.per_layer.end()) captures_ordered.push_back(it->second);
                    }
                    if (captures_ordered.empty()) continue;

                    auto doc_scores = aggregate_captured(
                        captures_ordered,
                        work.query_local_to_chunk,
                        work.context_local_to_chunk,
                        item.query_chunk_count,
                        (int) win_chunks_local.size(),
                        args.sink_normalization,
                        /*global_normalize=*/false
                    );

                    for (int qci = 0; qci < item.query_chunk_count; qci++) {
                        int global_q = item.query_chunk_start + qci;
                        for (size_t c = 0; c < win_chunks_local.size(); c++) {
                            file_scores[global_q][c] = doc_scores.empty() ? 0.0f : doc_scores[qci][c];
                        }
                    }
                }
            }

            // Append this window's chunks + per-token score columns to global state.
            int win_body_offset_in_global = (int) global_ctx_text.size() + (int) file_header.size();
            global_ctx_text += file_header;
            global_ctx_text += win_content;
            for (auto & c : win_chunks_local) {
                Chunk shifted = c;
                shifted.start = win_body_offset_in_global + c.start;
                shifted.end   = win_body_offset_in_global + c.end;
                global_ctx_chunks.push_back(shifted);
            }
            for (size_t q = 0; q < query_set.chunks.size(); q++) {
                for (size_t c = 0; c < win_chunks_local.size(); c++) {
                    global_scores[q].push_back(file_scores[q][c]);
                }
            }
            total_chunks_emitted += win_chunks_local.size();
            any_window_processed = true;
        }

        if (!any_window_processed) continue;

        written_files++;
        double elapsed = (ggml_time_us() - t_scan_start) / 1e6;
        double file_time = (ggml_time_us() - t_file_start) / 1e6;
        double per_file_avg = elapsed / written_files;
        double eta = per_file_avg * (ctx_paths.size() - (fi + 1));
        log_line("[%zu/%zu] %s (%zu chunks, %zu window%s, %.1fs, avg %.1fs, ETA %.0fs)",
            fi + 1, ctx_paths.size(), rel.c_str(),
            total_chunks_emitted, windows.size(), windows.size() == 1 ? "" : "s",
            file_time, per_file_avg, eta);

        if (args.write_every_docs > 0 && written_files % args.write_every_docs == 0) {
            write_json_now();
        }
    }
    write_json_now();
    if (args.mari_coverage) write_mari_coverage();

    log_line("scan complete: %d/%zu files in %.1fs",
        written_files, ctx_paths.size(), (ggml_time_us() - t_scan_start) / 1e6);
    if (!args.mari_coverage) log_line("wrote %s", args.out_path.c_str());

    llama_free(ctx);
    llama_model_free(model);
    llama_backend_free();
    return 0;
}

int main(int argc, char ** argv) {
    Args args = parse_args(argc, argv);

    if (!args.image_path.empty()) return run_image_scan(args);
    if (args.per_file) return run_per_file_scan(args);

    auto t_start = ggml_time_us();
    int64_t t_model_load_done = 0;
    int64_t t_tokenize_done = 0;
    int64_t t_context_init_done = 0;
    int64_t t_pass1_done = 0;
    int64_t t_pass2_done = 0;
    int64_t t_aggregate_done = 0;

    // 1. Read query.
    std::string qry_text_raw = read_file(args.query_path);
    std::string qry_text = strip_text(qry_text_raw, args.strip_query);

    // 2. Collect context files (either one file or a directory tree).
    std::vector<ContextFile> context_files;
    if (!args.context_tree.empty()) {
        std::vector<std::string> paths;
        walk_directory(args.context_tree, args.context_glob, paths);
        log_line("scanned %s: %zu files matching '%s'", args.context_tree.c_str(), paths.size(), args.context_glob.c_str());
        context_files.reserve(paths.size());
        for (auto & p : paths) {
            ContextFile cf;
            cf.path = p;
            cf.rel_path = p.substr(args.context_tree.size() + (args.context_tree.back() == '/' ? 0 : 1));
            cf.content = strip_text(read_file(p), args.strip_context);
            context_files.push_back(std::move(cf));
        }
    } else {
        ContextFile cf;
        cf.path = args.context_path;
        cf.rel_path = args.context_path;
        cf.content = strip_text(read_file(args.context_path), args.strip_context);
        context_files.push_back(std::move(cf));
    }
    size_t total_ctx_chars = 0;
    for (auto & cf : context_files) {
        total_ctx_chars += cf.content.size();
    }
    std::vector<Chunk> qry_chunks_local;
    log_line("context: %zu files / %zu chars", context_files.size(), total_ctx_chars);
    log_line("query: %zu chars", qry_text.size());

    // 3. Load model + create context.
    llama_backend_init();

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = args.n_gpu_layers;
    llama_model * model = llama_model_load_from_file(args.model.c_str(), mparams);
    if (!model) { log_line("failed to load model %s", args.model.c_str()); return 1; }
    const llama_vocab * vocab = llama_model_get_vocab(model);
    int n_layers = llama_model_n_layer(model);
    t_model_load_done = ggml_time_us();
    log_line("loaded model: layers=%d (model_load=%.2fs)", n_layers, (t_model_load_done - t_start) / 1e6);

    // Determine selected layers.
    std::vector<int> selected_layers;
    if (!args.layers.empty()) {
        selected_layers = parse_layers(args.layers);
    } else {
        int s = std::max(0, std::min(n_layers - 1, (int)(n_layers * args.layer_fraction_start)));
        int e = std::max(s + 1, std::min(n_layers, (int)(n_layers * args.layer_fraction_end)));
        for (int i = s; i < e; i++) selected_layers.push_back(i);
    }
    log_line("selected layers: count=%zu", selected_layers.size());

    // 5. Compose the token stream. Wrapper open + (file_header + file_body)* +
    //    middle + query body + suffix. File bodies come from per-file token cache.
    TokenizedDoc doc;
    int corpus_cursor = 0;

    if (!args.cache_dir.empty()) ensure_dir(args.cache_dir);

    for (auto & cf : context_files) {
        std::string sha = sha256_hex(cf.content);
        std::string cache_path = args.cache_dir.empty() ? "" : args.cache_dir + "/" + sha + ".tok";
        CachedTokens ct = tokenize_with_cache(vocab, cf.content, cache_path);
        cf.chunks = args.context_segment == "phrase"
            ? phrase_chunks_from_offsets(cf.content, ct, cf.rel_path, args.phrase_tokens)
            : token_chunks_from_offsets(cf.content, ct, cf.rel_path);
        if (cf.chunks.empty() && !cf.content.empty()) {
            cf.chunks.push_back({cf.rel_path + ":file", 0, (int) cf.content.size(), cf.content});
        }
    }
    {
        std::string sha = sha256_hex(qry_text);
        std::string cache_path = args.cache_dir.empty() ? "" : args.cache_dir + "/qrydoc_" + sha + ".tok";
        CachedTokens ct = tokenize_with_cache(vocab, qry_text, cache_path);
        qry_chunks_local = token_chunks_from_offsets(qry_text, ct, "query");
        if (qry_chunks_local.empty() && !qry_text.empty()) {
            qry_chunks_local.push_back({"query:file", 0, (int) qry_text.size(), qry_text});
        }
    }
    size_t total_ctx_chunks = 0;
    for (auto & cf : context_files) total_ctx_chunks += cf.chunks.size();
    log_line("effective chunks: context=%zu query=%zu", total_ctx_chunks, qry_chunks_local.size());
    if (!args.dump_inputs_dir.empty()) ensure_dir(args.dump_inputs_dir);
    std::string legacy_input_for_dump;

    auto append_chunk = [&](const std::vector<llama_token> & toks,
                            const std::vector<int> & cs,
                            const std::vector<int> & ce,
                            int char_shift) {
        for (size_t i = 0; i < toks.size(); i++) {
            doc.tokens.push_back(toks[i]);
            doc.char_start.push_back(cs[i] + char_shift);
            doc.char_end.push_back(ce[i] + char_shift);
        }
    };
    auto append_text_inline = [&](const std::string & text) {
        int shift = corpus_cursor;
        auto td = tokenize_with_offsets(vocab, text);
        append_chunk(td.tokens, td.char_start, td.char_end, shift);
        corpus_cursor += (int) text.size();
        if (!args.dump_inputs_dir.empty()) legacy_input_for_dump += text;
    };
    auto append_text_cached = [&](const std::string & text, const std::string & cache_path) {
        int shift = corpus_cursor;
        auto ct = tokenize_with_cache(vocab, text, cache_path);
        append_chunk(ct.tokens, ct.char_start, ct.char_end, shift);
        corpus_cursor += (int) text.size();
        if (!args.dump_inputs_dir.empty()) legacy_input_for_dump += text;
    };

    append_text_inline(make_prefix_text(args.input_prompt));
    int ctx_body_start_wrapped = corpus_cursor;
    int cache_hits = 0;
    std::string ctx_body_text;
    std::vector<Chunk> ctx_chunks_abs;
    std::vector<Chunk> ctx_chunks_local;
    for (auto & cf : context_files) {
        std::string header = make_file_header(cf.rel_path);
        int header_offset_body = (int) ctx_body_text.size();
        append_text_inline(header);
        ctx_body_text += header;

        int file_body_offset_wrapped = corpus_cursor;
        int file_body_offset_body = (int) ctx_body_text.size();
        std::string cache_path;
        if (!args.cache_dir.empty()) {
            std::string sha = sha256_hex(cf.content);
            cache_path = args.cache_dir + "/" + sha + ".tok";
            struct stat st;
            if (stat(cache_path.c_str(), &st) == 0) cache_hits++;
        }
        append_text_cached(cf.content, cache_path);
        ctx_body_text += cf.content;

        for (auto & c : cf.chunks) {
            Chunk abs_chunk = c;
            abs_chunk.start = file_body_offset_wrapped + c.start;
            abs_chunk.end   = file_body_offset_wrapped + c.end;
            ctx_chunks_abs.push_back(abs_chunk);

            Chunk for_json = c;
            for_json.start = file_body_offset_body + c.start;
            for_json.end   = file_body_offset_body + c.end;
            ctx_chunks_local.push_back(for_json);
        }
        (void) header_offset_body;
    }
    int ctx_body_end_wrapped = corpus_cursor;

    append_text_inline(kMiddle);
    int qry_body_start_wrapped = corpus_cursor;
    append_text_inline(qry_text);
    int qry_body_end_wrapped = corpus_cursor;
    append_text_inline(kQueryClose);
    if (!args.dump_inputs_dir.empty()) {
        write_file(
            dump_input_filename(args.dump_inputs_dir, 0, "legacy", 0, "query"),
            legacy_input_for_dump
        );
    }

    t_tokenize_done = ggml_time_us();
    log_line("tokenized: %zu tokens (tokenize=%.2fs, cache_hits=%d/%zu)",
        doc.tokens.size(), (t_tokenize_done - t_model_load_done) / 1e6,
        cache_hits, context_files.size());

    int ctx_base = ctx_body_start_wrapped;
    int ctx_end = ctx_body_end_wrapped;
    int qry_base = qry_body_start_wrapped;
    int qry_end = qry_body_end_wrapped;

    // qry_chunks_abs (wrapped coordinates) for token-index mapping.
    std::vector<Chunk> qry_chunks_abs;
    qry_chunks_abs.reserve(qry_chunks_local.size());
    for (auto & c : qry_chunks_local) {
        Chunk abs_chunk = c;
        abs_chunk.start = qry_base + c.start;
        abs_chunk.end   = qry_base + c.end;
        qry_chunks_abs.push_back(abs_chunk);
    }

    // 6. Compute context_token_positions (key columns) and query_token_positions
    //    (causal-shifted: token_position - 1 for each query body token).
    std::vector<int> ctx_tok_indices = token_indices_for_range(doc, ctx_base, ctx_end);
    std::vector<int> qry_tok_indices_raw = token_indices_for_range(doc, qry_base, qry_end);
    std::vector<int> qry_tok_indices;
    qry_tok_indices.reserve(qry_tok_indices_raw.size());
    for (int t : qry_tok_indices_raw) if (t - 1 >= 0) qry_tok_indices.push_back(t - 1);
    std::sort(qry_tok_indices.begin(), qry_tok_indices.end());
    qry_tok_indices.erase(std::unique(qry_tok_indices.begin(), qry_tok_indices.end()), qry_tok_indices.end());
    std::sort(ctx_tok_indices.begin(), ctx_tok_indices.end());
    ctx_tok_indices.erase(std::unique(ctx_tok_indices.begin(), ctx_tok_indices.end()), ctx_tok_indices.end());

    if (qry_tok_indices.empty()) { log_line("no query tokens"); return 1; }
    if (ctx_tok_indices.empty()) { log_line("no context tokens"); return 1; }
    int split = qry_tok_indices.front();
    log_line("split=%d context_tokens=%zu query_tokens=%zu",
        split, ctx_tok_indices.size(), qry_tok_indices.size());

    // 7. Token-to-chunk maps.
    std::vector<int> ctx_token_to_chunk = token_to_chunk_map(doc, ctx_chunks_abs);
    std::vector<int> qry_token_to_chunk = token_to_chunk_map(doc, qry_chunks_abs);

    std::vector<int> query_local_to_chunk(qry_tok_indices.size(), -1);
    for (size_t i = 0; i < qry_tok_indices.size(); i++) {
        int original_token = qry_tok_indices[i] + 1; // undo causal shift
        if (original_token >= 0 && original_token < (int) qry_token_to_chunk.size()) {
            query_local_to_chunk[i] = qry_token_to_chunk[original_token];
        }
    }
    std::vector<int> context_local_to_chunk(ctx_tok_indices.size(), -1);
    for (size_t i = 0; i < ctx_tok_indices.size(); i++) {
        int t = ctx_tok_indices[i];
        if (t >= 0 && t < (int) ctx_token_to_chunk.size()) {
            context_local_to_chunk[i] = ctx_token_to_chunk[t];
        }
    }

    // 8. Create llama_context with the eval callback.
    CaptureContext cap;
    cap.context_token_positions = ctx_tok_indices;
    cap.query_token_positions = qry_tok_indices;
    for (int l : selected_layers) cap.selected_layers.insert(l);
    CallbackUserData ud{ &cap };

    llama_context_params cparams = llama_context_default_params();
    int legacy_n_ctx = args.n_ctx > 0 ? args.n_ctx : (int) doc.tokens.size() + 8;
    if (legacy_n_ctx < (int) doc.tokens.size() + 8) {
        log_line("ctx-size %d is too small for %zu-token single-window scan; use --ctx-size %zu or more",
            legacy_n_ctx, doc.tokens.size(), doc.tokens.size() + 8);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    cparams.n_ctx = (uint32_t) legacy_n_ctx;
    cparams.n_batch = (uint32_t) legacy_n_ctx;
    cparams.n_ubatch = (uint32_t) std::min<uint32_t>(args.n_ubatch, (uint32_t) doc.tokens.size());
    cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
    cparams.cb_eval = eval_callback;
    cparams.cb_eval_user_data = &ud;
    cparams.no_perf = true;

    llama_context * ctx = llama_init_from_model(model, cparams);
    if (!ctx) { log_line("failed to init context"); return 1; }
    t_context_init_done = ggml_time_us();
    log_line("context init (ctx_init=%.2fs)", (t_context_init_done - t_tokenize_done) / 1e6);
    log_line("ctx: n_ctx=%d n_ubatch=%u gpu_layers=%d", legacy_n_ctx, cparams.n_ubatch, args.n_gpu_layers);

    // 9. Pass 1: feed context tokens [0, split) in ubatch-sized pieces.
    log_line("pass 1: %d context tokens", split);
    auto decode_range = [&](int from, int to_excl, bool capture_active) -> bool {
        for (int pos = from; pos < to_excl; pos += args.n_ubatch) {
            int batch_n = std::min(args.n_ubatch, to_excl - pos);
            llama_batch batch = llama_batch_init(batch_n, 0, 1);
            batch.n_tokens = batch_n;
            for (int i = 0; i < batch_n; i++) {
                batch.token[i] = doc.tokens[pos + i];
                batch.pos[i] = pos + i;
                batch.n_seq_id[i] = 1;
                batch.seq_id[i][0] = 0;
                batch.logits[i] = 0;
            }
            if (capture_active) {
                cap.batch_query_pos_start = pos;
                cap.batch_query_pos_end = pos + batch_n;
            } else {
                // sentinel: out of range, callback ignores
                cap.batch_query_pos_start = -1;
                cap.batch_query_pos_end = -1;
            }
            int rc = llama_decode(ctx, batch);
            llama_batch_free(batch);
            if (rc != 0) {
                log_line("llama_decode failed at pos=%d rc=%d; try a smaller input, smaller --ubatch, or fewer --gpu-layers",
                    pos, rc);
                return false;
            }
        }
        return true;
    };

    // Pass 1 uses flash attention on every layer (fast). No captures needed.
    llama_set_flash_attn_skip(ctx, nullptr, 0);
    if (!decode_range(0, split, /*capture_active=*/false)) {
        llama_free(ctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    t_pass1_done = ggml_time_us();
    log_line("pass 1 done (pass1=%.2fs)", (t_pass1_done - t_context_init_done) / 1e6);

    // Pass 2: enable the eager attention path for the selected layers so
    // kq_soft_max-<il> shows up in the graph and the callback can grab it.
    // All other layers stay on flash attention.
    std::vector<int32_t> skip_layers(selected_layers.begin(), selected_layers.end());
    llama_set_flash_attn_skip(ctx, skip_layers.data(), (int32_t) skip_layers.size());

    int qry_total = (int) doc.tokens.size() - split;
    log_line("pass 2: %d query tokens (flash-attn skipped on %zu layers)", qry_total, skip_layers.size());
    if (!decode_range(split, (int) doc.tokens.size(), /*capture_active=*/true)) {
        llama_free(ctx);
        llama_model_free(model);
        llama_backend_free();
        return 1;
    }
    t_pass2_done = ggml_time_us();
    log_line("pass 2 done; captured layers=%zu (pass2=%.2fs)", cap.per_layer.size(), (t_pass2_done - t_pass1_done) / 1e6);

    // 11. Aggregate.
    std::vector<CapturedAttention> captures_ordered;
    for (int l : selected_layers) {
        auto it = cap.per_layer.find(l);
        if (it != cap.per_layer.end()) captures_ordered.push_back(it->second);
    }
    if (captures_ordered.empty()) {
        log_line("no captures - did flash attention get disabled? aborting.");
        return 1;
    }
    auto scores = aggregate_captured(
        captures_ordered,
        query_local_to_chunk,
        context_local_to_chunk,
        (int) qry_chunks_local.size(),
        (int) ctx_chunks_local.size(),
        args.sink_normalization
    );
    t_aggregate_done = ggml_time_us();
    log_line("aggregation done (aggregate=%.2fs)", (t_aggregate_done - t_pass2_done) / 1e6);

    // 12. Write JSON.
    JsonOut j;
    j.s << "{";
    j.s << "\"context_text\":"; j.escape(ctx_body_text);
    j.s << ",\"query_text\":"; j.escape(qry_text);
    j.s << ",\"context_chunks\":"; j.chunks(ctx_chunks_local);
    j.s << ",\"query_chunks\":"; j.chunks(qry_chunks_local);
    j.s << ",\"scores\":"; j.matrix(scores, ctx_chunks_local, ctx_body_text, args.prune_top_k);
    j.s << ",\"head_scores\":[]";
    j.s << ",\"layer_scores\":[]";
    j.s << ",\"metadata\":{";
    j.s << "\"backend\":\"llama.cpp\"";
    j.s << ",\"model\":"; j.escape(args.model);
    j.s << ",\"offset_encoding\":\"utf8_bytes\"";
    j.s << ",\"context_segment\":"; j.escape(args.context_segment);
    j.s << ",\"phrase_tokens\":" << args.phrase_tokens;
    j.s << ",\"layers\":[";
    for (size_t i = 0; i < selected_layers.size(); i++) {
        if (i) j.s << ',';
        j.s << selected_layers[i];
    }
    j.s << "]";
    j.s << ",\"sink_normalization\":" << (args.sink_normalization ? "true" : "false");
    if (!args.input_prompt.empty()) {
        j.s << ",\"input_prompt\":"; j.escape(args.input_prompt);
    }
    if (!args.dump_inputs_dir.empty()) {
        j.s << ",\"dump_inputs_dir\":"; j.escape(args.dump_inputs_dir);
        j.s << ",\"dumped_inputs\":1";
    }
    j.s << ",\"score_prune_top_k\":" << args.prune_top_k;
    j.s << ",\"flash_attn\":\"disabled\"";
    j.s << "}";
    j.s << "}";
    write_heatmap_output(args.out_path, j.s.str());

    auto t_end = ggml_time_us();
    double total = (t_end - t_start) / 1e6;
    double model_load = (t_model_load_done - t_start) / 1e6;
    double after_load = (t_end - t_model_load_done) / 1e6;
    double pass1 = (t_pass1_done - t_context_init_done) / 1e6;
    double pass2 = (t_pass2_done - t_pass1_done) / 1e6;
    double ctx_init = (t_context_init_done - t_tokenize_done) / 1e6;
    double tokenize = (t_tokenize_done - t_model_load_done) / 1e6;
    double agg = (t_aggregate_done - t_pass2_done) / 1e6;
    double json_io = (t_end - t_aggregate_done) / 1e6;
    log_line("wrote %s", args.out_path.c_str());
    log_line("--- timing ---");
    log_line("  total:           %.2fs", total);
    log_line("  model_load:      %.2fs", model_load);
    log_line("  after-load:      %.2fs", after_load);
    log_line("    tokenize:      %.2fs", tokenize);
    log_line("    ctx_init:      %.2fs (Metal pipeline warmup)", ctx_init);
    log_line("    pass1 fwd:     %.2fs (%d ctx tokens)", pass1, split);
    log_line("    pass2 fwd:     %.2fs (%d qry tokens) [captures]", pass2, qry_total);
    log_line("    aggregate:     %.2fs", agg);
    log_line("    json+free:     %.2fs", json_io);

    llama_free(ctx);
    llama_model_free(model);
    llama_backend_free();
    return 0;
}
