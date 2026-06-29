#!/usr/bin/env bash
# Produce a relocatable, shippable bundle of mari_attn: the binary plus its non-system dylibs,
# rpath-rewritten to @loader_path and ad-hoc re-signed. Run after building mari_attn. The result
# (dist/<platform>/) is what Mari ships and runs — users never compile.
set -euo pipefail
cd "$(dirname "$0")"

BIN=build/mari_attn
[ -x "$BIN" ] || { echo "build mari_attn first: cmake -S . -B build && cmake --build build --target mari_attn"; exit 1; }

PLAT="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
DIST="dist/$PLAT"
rm -rf "$DIST"; mkdir -p "$DIST"
cp "$BIN" "$DIST/"

# Collect the transitive closure of @rpath/* and Homebrew (libomp) dylibs.
LB="$(otool -l "$BIN" | awk '/LC_RPATH/{f=1} f&&/path/{print $2; f=0}' | head -1)"
collect() {
  otool -L "$1" | awk 'NR>1{print $1}' | while read -r dep; do
    case "$dep" in
      @rpath/*) name="${dep#@rpath/}"; src="$LB/$name" ;;
      /opt/homebrew/*) name="$(basename "$dep")"; src="$dep" ;;
      *) continue ;;
    esac
    [ -f "$DIST/$name" ] && continue
    cp "$src" "$DIST/$name"
    collect "$DIST/$name"
  done
}
collect "$BIN"

# Rewrite every Mach-O: id → @rpath/<name>, Homebrew deps → @rpath, add @loader_path rpath.
for f in "$DIST"/*; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  [ "$base" = mari_attn ] || install_name_tool -id "@rpath/$base" "$f" 2>/dev/null || true
  otool -L "$f" | awk 'NR>1{print $1}' | while read -r dep; do
    case "$dep" in
      /opt/homebrew/*) install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$f" 2>/dev/null || true ;;
    esac
  done
  install_name_tool -add_rpath @loader_path "$f" 2>/dev/null || true
  [ "$base" = mari_attn ] && install_name_tool -delete_rpath "$LB" "$f" 2>/dev/null || true
done

# install_name_tool invalidates the signature on arm64 — ad-hoc re-sign.
for f in "$DIST"/*; do codesign -f -s - "$f" >/dev/null 2>&1 || true; done

echo "bundled → $DIST ($(du -sh "$DIST" | cut -f1))"
ls -la "$DIST"
