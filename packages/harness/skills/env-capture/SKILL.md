---
name: env-capture
description: "Use when shell commands require venv / environment variable setup"
---

## Capture env

```sh
source .venv/bin/activate && env-capture
```

or in more complex scenarios:

```sh
eval $( pixi shell-hook );
cd /path/to/project && source activate;
env-capture
```

`env-capture` snapshots the current shell environment into a session-scoped
dotenv file.

## Using captured dotenv

Set the `env` argument of the shell tool, so that the shell command loads the
environment variables.

## Why

1. Most environment setup is costly, capturing the env saves lots of file reads.
2. Doing so avoids `source ... &&` patterns. Especially useful if multiplle
   layers of environments are used.
3. The shell, sh repeat, and lsp tools (when not using a persistent / PTY
   session) are otherwise stateless.

cpi harness implementation of env can be found here:
[`shell/tools.ts`](https://github.com/bobcao3/cpi/blob/main/packages/harness/src/shell/tools.ts).
