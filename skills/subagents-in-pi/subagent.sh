#!/usr/bin/env bash
# Launch (or resume) a pi sub-agent in this repo.
#
#   stdout line 1 : "transcript: <path to the streaming markdown transcript>"
#   stdout rest   : the sub-agent's clean final message
#
# The transcript is written live by the transcript.ts extension (one block per
# message), so the orchestrator can tail it while the sub-agent is still working.
# Resume by re-running with the same -s <session-id> (pi restores prior context).
#
# Usage: subagent.sh [-p provider] [-s session-id] [task...]
#   Preferred: pass the task on stdin via a QUOTED heredoc so backticks, $, and
#   quotes in the prompt stay literal (no shell escaping):
#       subagent.sh -s my-task <<'TASK'
#       ...prompt with `backticks` and $vars, verbatim...
#       TASK
#   A positional task arg still works for short, escape-free prompts.
set -euo pipefail

main() {
    local provider="meshy-sglang-kimi" session_id="" proto md out err rc=0

    while getopts "p:s:" opt; do
        case "$opt" in
            p) provider="$OPTARG" ;;
            s) session_id="$OPTARG" ;;
            *) printf 'usage: subagent.sh [-p provider] [-s session-id] [task]   # or pipe the task on stdin\n' >&2; exit 2 ;;
        esac
    done
    shift "$((OPTIND - 1))"

    # Prefer positional args; otherwise read the task from stdin (heredoc/pipe).
    local task="$*"
    if [[ -z "$task" && ! -t 0 ]]; then
        task="$(cat)"
    fi
    if [[ -z "$task" ]]; then
        printf 'usage: subagent.sh [-p provider] [-s session-id] [task]   # or pipe the task on stdin\n' >&2
        exit 2
    fi
    [[ -n "$session_id" ]] || session_id="sub-$(date +%Y%m%d-%H%M%S)-$$"
    proto="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/output-protocol.md"
    md="${TMPDIR:-/tmp}/pi-transcript-${session_id}.md"

    # Announce the streaming transcript path first so it can be tailed live.
    printf 'transcript: %s\n' "$md"

    out="$(mktemp)"
    err="$(mktemp)"
    # shellcheck disable=SC2064
    trap "rm -f '$out' '$err'" EXIT

    # pi print-mode writes only the final assistant message to stdout; capture it.
    # PI_TRANSCRIPT_MD tells the transcript.ts extension where to stream markdown.
    PI_TRANSCRIPT_MD="$md" pi --provider "$provider" --session-id "$session_id" \
        --append-system-prompt "@$proto" \
        -p "$task" >"$out" 2>"$err" || rc=$?

    cat "$out"

    if [[ "$rc" -ne 0 ]]; then
        printf 'subagent exited %s:\n' "$rc" >&2
        cat "$err" >&2
    fi
    return "$rc"
}

main "$@"
