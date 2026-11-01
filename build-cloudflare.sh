#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Pages build image (Linux x86_64).
tools_dir="$(mktemp -d)"
trap 'rm -rf "$tools_dir"' EXIT

if ! command -v uv >/dev/null 2>&1; then
  curl -fsSL https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="$tools_dir" sh
  export PATH="$tools_dir:$PATH"
fi

zine_version="$(sed -n 's/^[[:space:]]*\.zine_version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' zine.ziggy)"
: "${zine_version:?Missing .zine_version in zine.ziggy}"
mkdir "$tools_dir/zine"
curl -fsSL "https://github.com/kristoff-it/zine/releases/download/v${zine_version}/x86_64-linux-musl.tar.xz" -o "$tools_dir/zine.tar.xz"
tar -xJf "$tools_dir/zine.tar.xz" -C "$tools_dir/zine"
export PATH="$tools_dir/zine:$PATH"

uv run scripts/cards.py

# PR #6 adds a Zig-based Markdown publisher. Use it when present.
if [[ -f build.zig ]]; then
  zig_version="0.17.0"
  curl -fsSL "https://ziglang.org/download/${zig_version}/zig-x86_64-linux-${zig_version}.tar.xz" -o "$tools_dir/zig.tar.xz"
  tar -xJf "$tools_dir/zig.tar.xz" -C "$tools_dir"
  export PATH="$tools_dir/zig-x86_64-linux-${zig_version}:$PATH"
  zig build test
  zig build publish
fi

zine release

if [[ -f build.zig ]]; then
  zig build verify
fi

# GitHub Pages uses CNAME, but Cloudflare Pages handles custom domains itself.
rm -f public/CNAME
