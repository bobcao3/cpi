"""Harbor agent: pi + cpi harness for TerminalBench 2.1.

Fresh implementation. Does not subclass the stale built-in harbor Pi agent
(which installs an outdated pi fork and ignores custom endpoints).

What this agent does:
  - installs current upstream pi (npm @earendil-works/pi-coding-agent),
  - git-clones the cpi package into $HOME/cpi and npm-installs its deps,
  - writes ~/.pi/agent/settings.json with packages:["../../cpi"] only
    (no pi-exa, so no web search) and ~/.pi/agent/models.json wiring a
    configurable OpenAI-compatible endpoint,
  - runs `pi --print --mode json --no-session` per task, teeing to pi.txt,
  - parses assistant message_end usage for token/cost accounting.

caveman-micro is on by default via cpi's shipped cpi-config.default.json.

Endpoint, model, provider, and cpi ref are CLI-driven (see
run_terminal_bench_2_1.py with --agent cpi).
"""
from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_OUTPUT_FILENAME = "pi.txt"
_NVM_BOOTSTRAP = ". ~/.nvm/nvm.sh"
_NVM_INSTALL = (
    "set -euo pipefail; "
    "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
    'export NVM_DIR="$HOME/.nvm" && '
    '\\. "$NVM_DIR/nvm.sh" && '
    "nvm install 22 && "
    "npm install -g @earendil-works/pi-coding-agent && "
    "pi --version"
)
_DEFAULT_CPI_REPO = "https://github.com/bobcao3/cpi.git"


class CpiPi(BaseInstalledAgent):
    """pi + cpi harness agent for TerminalBench."""

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
    ]

    def __init__(
        self,
        logs_dir: Path,
        *,
        provider: str = "tb21",
        api_base: str,
        api_key: str = "NO",
        context_window: int = 262144,
        max_output_tokens: int = 32768,
        reasoning: bool = True,
        cpi_ref: str | None = None,
        cpi_repo: str = _DEFAULT_CPI_REPO,
        **kwargs,
    ) -> None:
        super().__init__(logs_dir, **kwargs)
        self._provider = provider
        self._api_base = api_base
        self._api_key = api_key
        self._context_window = context_window
        self._max_output_tokens = max_output_tokens
        self._reasoning = reasoning
        self._cpi_ref = cpi_ref
        self._cpi_repo = cpi_repo

    @staticmethod
    @override
    def name() -> str:
        return "cpi-pi"

    @override
    def get_version_command(self) -> str | None:
        return f"{_NVM_BOOTSTRAP}; pi --version"

    @override
    def parse_version(self, stdout: str) -> str:
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if line:
                return line
        return ""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl git ca-certificates xz-utils",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(environment, command=_NVM_INSTALL)
        await self._clone_cpi(environment)
        await self._write_pi_config(environment)

    async def _clone_cpi(self, environment: BaseEnvironment) -> None:
        ref_clause = f" -b {shlex.quote(self._cpi_ref)}" if self._cpi_ref else " --depth 1"
        await self.exec_as_agent(
            environment,
            command=(
                f"{_NVM_BOOTSTRAP}; set -euo pipefail; "
                f'git clone{ref_clause} {shlex.quote(self._cpi_repo)} "$HOME/cpi" && '
                'cd "$HOME/cpi" && npm install --legacy-peer-deps --no-audit --no-fund'
            ),
        )

    async def _write_pi_config(self, environment: BaseEnvironment) -> None:
        model_id = self._model_id()
        models = {
            "providers": {
                self._provider: {
                    "baseUrl": self._api_base,
                    "api": "openai-completions",
                    "apiKey": self._api_key,
                    "models": [
                        {
                            "id": model_id,
                            "reasoning": self._reasoning,
                            "contextWindow": self._context_window,
                            "maxTokens": self._max_output_tokens,
                            "cost": {
                                "input": 0,
                                "output": 0,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                            },
                        }
                    ],
                }
            }
        }
        settings = {
            "packages": ["../../cpi"],
            "defaultProvider": self._provider,
            "defaultModel": model_id,
            "defaultProjectTrust": "always",
            "enableSkillCommands": True,
        }
        models_json = json.dumps(models, indent=2)
        settings_json = json.dumps(settings, indent=2)
        await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p "$HOME/.pi/agent" && '
                'cat > "$HOME/.pi/agent/models.json" <<\'__CPI_MODELS__\'\n'
                f"{models_json}\n"
                "__CPI_MODELS__\n"
                'cat > "$HOME/.pi/agent/settings.json" <<\'__CPI_SETTINGS__\'\n'
                f"{settings_json}\n"
                "__CPI_SETTINGS__\n"
            ),
        )

    def _model_id(self) -> str:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                f"model_name must be '<provider>/<model>', got {self.model_name!r}"
            )
        return self.model_name.split("/", 1)[1]

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context  # token accounting done in populate_context_post_run
        flags = self.build_cli_flags()
        cmd = f"{_NVM_BOOTSTRAP}; pi --print --mode json --no-session"
        if flags:
            cmd += f" {flags}"
        cmd += (
            f" {shlex.quote(instruction)} "
            f"2>&1 </dev/null | grep -v '\"type\":\"message_update\"' "
            f"| stdbuf -oL tee /logs/agent/{_OUTPUT_FILENAME}"
        )
        await self.exec_as_agent(environment, command=cmd)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / _OUTPUT_FILENAME
        if not output_file.exists():
            return
        n_in = n_out = n_cache_read = n_cache_write = 0
        cost = 0.0
        for line in output_file.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "message_end":
                message = event.get("message") or {}
                if message.get("role") != "assistant":
                    continue
                usage = message.get("usage") or {}
                n_in += usage.get("input", 0)
                n_out += usage.get("output", 0)
                n_cache_read += usage.get("cacheRead", 0)
                n_cache_write += usage.get("cacheWrite", 0)
                cost += (usage.get("cost") or {}).get("total", 0.0)
            elif event.get("type") == "tool_execution_end":
                details = (event.get("result") or {}).get("details") or {}
                usage = details.get("usage")
                if isinstance(usage, dict):
                    n_in += usage.get("input", 0)
                    n_out += usage.get("output", 0)
        context.n_input_tokens = n_in + n_cache_read
        context.n_output_tokens = n_out
        context.n_cache_tokens = n_cache_read
        context.cost_usd = cost if cost > 0 else None
