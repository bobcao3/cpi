#!/usr/bin/env bash
#
# uninstall.sh — Remove cpi from pi's settings.json.
#
# Removes the cpi glob entries from settings.json and cleans up any
# remaining symlinks from the old install method.
#
set -euo pipefail

CPI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
PI_SETTINGS="${PI_AGENT_DIR}/settings.json"
PI_EXT_DIR="${PI_AGENT_DIR}/extensions"
PI_SKILLS_DIR="${PI_AGENT_DIR}/skills"

log()  { printf '  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

ensure_jq() {
    command -v jq >/dev/null 2>&1 || die "jq is required but not found on PATH."
}

# Remove old per-file symlinks pointing into cpi
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
        log "removed $removed symlink(s) from $(basename "$dir")/"
    fi
}

# Remove cpi glob entries (and any old per-file entries) from settings.json
clean_settings() {
    [[ -f "$PI_SETTINGS" ]] || return 0

    # Build list of old per-file entries to also strip
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
      --arg cpi           "$CPI_DIR/" \
    '
      .extensions = ((.extensions // [])
        | map(select(IN($ext_old[]) | not))
        | map(select(startswith($cpi) | not)))
      | .skills = ((.skills // [])
        | map(select(IN($skill_old[]) | not))
        | map(select(startswith($cpi) | not)))
      | if (.extensions | length) == 0 then del(.extensions) else . end
      | if (.skills    | length) == 0 then del(.skills)    else . end
    ' "$PI_SETTINGS" > "$tmp" && mv "$tmp" "$PI_SETTINGS"

    log "settings.json cleaned"
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
    printf 'cpi uninstall → %s\n' "$PI_AGENT_DIR"
    ensure_jq

    log "removing cpi entries from settings.json…"
    clean_settings

    log "cleaning old symlinks…"
    purge_old_symlinks "$PI_EXT_DIR"
    purge_old_symlinks "$PI_SKILLS_DIR"

    printf '\n  ✓ Done — cpi removed from pi config.\n'
}

main "$@"
