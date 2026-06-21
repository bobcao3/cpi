#!/usr/bin/env bash
# Installs Ruby + Rails for first-time developers, following the official
# Rails install guide (Ubuntu / Mise, user-level):
#   https://guides.rubyonrails.org/install_ruby_on_rails.html#install-ruby-on-ubuntu
#
# Uses the Mise version manager (no system gem writes, no sudo for gems).
# Latest stable versions, verified against official sources:
#   Ruby  https://www.ruby-lang.org/en/downloads/
#   Rails https://rubyonrails.org/category/releases
#   Mise  https://github.com/jdx/mise/releases   (curl https://mise.run | sh = latest)
#
# This script ONLY installs the toolchain. It does NOT generate the app —
# that source lives in benchmarks/tb_web_monitor/ and is tracked. After this:
#   cd benchmarks/tb_web_monitor && bundle install && bin/rails s -b 0.0.0.0 -p 8788
#
# Idempotent: safe to re-run.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

echo "==> [1/4] Install build deps (apt) — per Rails install guide"
if ! command -v rustc >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential rustc libssl-dev libyaml-dev zlib1g-dev libgmp-dev git
fi

echo "==> [2/4] Install Mise version manager (user-level, latest)"
if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | sh
fi
# Persist activation for interactive shells (idempotent).
grep -q 'mise activate bash' ~/.bashrc 2>/dev/null || \
  echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
# Activate for this script.
eval "$(mise activate bash)"

echo "==> [3/4] Install Ruby (latest 4.x via Mise, precompiled)"
# Precompiled builds are faster and equivalent; becomes the mise default in 2026.8.0.
mise settings ruby.compile=false 2>/dev/null || true
mise use -g ruby@4
echo "ruby:  $(ruby -v)"

echo "==> [4/4] Install Rails (latest, per guide)"
if ! command -v rails >/dev/null 2>&1; then
  gem install rails
fi
echo "rails: $(rails -v)"

echo
echo "==> Done. Toolchain ready."
echo "    Next: cd benchmarks/tb_web_monitor && bundle install && bin/rails s -b 0.0.0.0 -p 8788"
