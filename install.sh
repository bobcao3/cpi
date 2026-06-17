#!/usr/bin/env bash
#
# install.sh — One-time setup: point pi at the cpi source directories.
#
# pi's `extensions` / `skills` settings arrays work like this:
#
#   * A *plain* entry (a file or directory path) is DISCOVERED — pi collects
#     the extension/skill files under it.
#   * An entry containing a glob metachar (`*`, `?`) or starting with
#     `!` / `+` / `-` is a *filter PATTERN* applied to the discovered set —
#     it does NOT itself discover any files.
#
# So a bare glob like ".../extensions/*.ts" with no plain path discovers
# NOTHING (the pattern is applied to an empty set).  The correct entry is the
# source DIRECTORY, which pi reads from on every session start:
#
#   {
#     "extensions": ["/home/you/cpi/extensions"],
#     "skills":     ["/home/you/cpi/skills"]
#   }
#
# This is a live link — no symlinks, no bundling.  Adding/removing/editing
# files under extensions/ or skills/ is picked up on the next pi session.
#
# To exclude a specific extension, add a "!<path>" filter PATTERN alongside
# the directory entry (the directory still discovers, the pattern filters):
#
#   "extensions": [
#     "/home/you/cpi/extensions",
#     "!/home/you/cpi/extensions/disable-bash.ts"
#   ]
#
# Re-running is safe (idempotent).
#
set -euo pipefail

CPI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
PI_SETTINGS="${PI_AGENT_DIR}/settings.json"
PI_EXT_DIR="${PI_AGENT_DIR}/extensions"
PI_SKILLS_DIR="${PI_AGENT_DIR}/skills"

EXT_PATH="${CPI_DIR}/extensions"
SKILL_PATH="${CPI_DIR}/skills"

log()  { printf '  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

ensure_jq() {
    command -v jq >/dev/null 2>&1 || die "jq is required but not found on PATH."
}

# ── migration: remove old per-file symlinks ──────────────────────────────────
# Early versions created individual symlinks for each extension and skill.
# pi reads directly from the source dir now, so these are obsolete.
purge_old_symlinks() {
    local dir="$1" removed=0
    [[ -d "$dir" ]] || return 0
    for link in "$dir"/*; do
        [[ -L "$link" ]] || continue
        local target; target=$(readlink -f "$link" 2>/dev/null || true)
        if [[ "$target" == "$CPI_DIR"/* ]]; then
            rm "$link"
            removed=$((removed + 1))
        fi
    done
    if [[ $removed -gt 0 ]]; then
        log "removed $removed old symlink(s) from $(basename "$dir")/"
    fi
}

# ── patch settings.json ──────────────────────────────────────────────────────
# For each resource type (extensions, skills):
#   1. Drop old per-file entries (./extensions/<name>.ts, ./skills/<name>).
#   2. Drop any prior cpi *plain* entries — the broken "<cpi>/.../*.ts" glob
#      AND a previously-added directory entry (so re-runs are idempotent).
#      Plain == does not start with a filter prefix (! + -), so user-authored
#      "!<cpi>/..." exclusion patterns are PRESERVED.
#   3. Append the live directory entry.
patch_settings() {
    [[ -f "$PI_SETTINGS" ]] || die "settings.json not found at ${PI_SETTINGS}."

    # Old per-file entry strings to strip (from the original symlink-era install).
    local ext_old skill_old
    ext_old=$(
        for f in "$CPI_DIR"/extensions/*.ts; do
            [[ -f "$f" ]] || continue
            printf '"./extensions/%s"\n' "$(basename "$f")"
        done | jq -s '.'
    )
    skill_old=$(
        for d in "$CPI_DIR"/skills/*/; do
            [[ -d "$d" ]] || continue
            printf '"./skills/%s"\n' "$(basename "$d")"
        done | jq -s '.'
    )

    local tmp; tmp=$(mktemp)
    jq \
      --argjson ext_old   "$ext_old" \
      --argjson skill_old "$skill_old" \
      --arg ext_path      "$EXT_PATH" \
      --arg skill_path    "$SKILL_PATH" \
      --arg cpi           "$CPI_DIR/" \
    '
      # A filter entry starts with one of these prefixes; anything else is plain.
      def is_filter: (startswith("!") or startswith("+") or startswith("-"));
      # Drop plain entries pointing into the cpi repo (broken glob / prior dir).
      def drop_cpi_plain: map(select((startswith($cpi) and (is_filter | not)) | not));

      .extensions = ((
        (.extensions // [])
          | map(select(IN($ext_old[]) | not))   # drop old ./extensions/<name>.ts
          | drop_cpi_plain                        # drop broken glob / prior dir entry
          | . + [$ext_path]                       # add live directory
      ) | unique)
      | .skills = ((
        (.skills // [])
          | map(select(IN($skill_old[]) | not))
          | drop_cpi_plain
          | . + [$skill_path]
      ) | unique)
    ' "$PI_SETTINGS" > "$tmp" && mv "$tmp" "$PI_SETTINGS"

    local n_ext n_skill
    n_ext=$(jq '.extensions | length' "$PI_SETTINGS")
    n_skill=$(jq '.skills | length' "$PI_SETTINGS")
    log "extensions: ${n_ext} entry(ies) — dir: ${EXT_PATH}"
    log "skills:     ${n_skill} entry(ies) — dir: ${SKILL_PATH}"
}

# ── verify ────────────────────────────────────────────────────────────────────
# Invoke pi non-interactively and confirm cpi resources actually loaded:
#   - the custom `sh`/`alarm` tools (shell.ts / alarm.ts) appear in the tool list
#   - provider-fallback.ts writes /tmp/provider-fallback-debug.log under PF_DEBUG
verify() {
    command -v pi >/dev/null 2>&1 || { log "pi not on PATH — skipping live verify"; return 0; }

    local out dbg ok=1
    out=$(mktemp)
    dbg=/tmp/provider-fallback-debug.log
    rm -f "$dbg"

    PF_DEBUG=1 timeout 60 pi \
        --offline --no-session \
        -p "List the exact names of every tool you have, one per line, nothing else." \
        >"$out" 2>&1 || true

    if grep -qx 'sh' "$out"; then
        log "verify: ✓ custom 'sh' tool registered (shell.ts loaded)"
    else
        log "verify: ⚠ 'sh' tool not found in pi output"; ok=0
    fi
    if grep -qx 'alarm' "$out"; then
        log "verify: ✓ 'alarm' tool registered (alarm.ts loaded)"
    else
        log "verify: ⚠ 'alarm' tool not found in pi output"; ok=0
    fi
    if grep -qiv 'bash' "$out" && ! grep -qx 'bash' "$out"; then
        log "verify: ✓ builtin 'bash' stripped (disable-bash.ts loaded)"
    fi
    if grep -qi 'registered provider' "$dbg" 2>/dev/null; then
        log "verify: ✓ provider-fallback.ts registered providers"
    else
        log "verify: ⚠ provider-fallback debug log not written"; ok=0
    fi

    rm -f "$out"
    [[ $ok -eq 1 ]] || log "verify: some checks failed — inspect 'pi --offline -p ...' output"
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
    printf 'cpi install → %s\n' "$PI_AGENT_DIR"
    ensure_jq

    log "cleaning old per-file symlinks…"
    purge_old_symlinks "$PI_EXT_DIR"
    purge_old_symlinks "$PI_SKILLS_DIR"

    log "patching settings.json with live directory entries…"
    patch_settings

    log "verifying via pi CLI…"
    verify

    cat <<EOF

  ✓ Done — pi now reads directly from ${CPI_DIR}

    Add a .ts to extensions/   → live on next pi session
    Remove a file              → gone on next pi session
    Edit a file                → already live (pi reads from disk)

    Exclude an extension:
      Add "!${CPI_DIR}/extensions/<name>.ts"
      to the extensions array in settings.json

    Re-run anytime — it's idempotent.
EOF
}

main "$@"
