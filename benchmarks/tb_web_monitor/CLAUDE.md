# tb_web_monitor

Rails 8 + Hotwire port of the TerminalBench 2.1 web monitor.

Follow canonical Rails guidance, consult docs first:
- https://guides.rubyonrails.org/
- https://api.rubyonrails.org/
- Getting Started: https://guides.rubyonrails.org/getting_started.html

## Versions

Use the latest stable release of every component. Before bumping any version, verify the current latest against official sources:

- Ruby: https://www.ruby-lang.org/en/downloads/
- Rails: https://rubyonrails.org/category/releases
- Mise: https://github.com/jdx/mise/releases

The toolchain is installed via Mise (user-level) per https://guides.rubyonrails.org/install_ruby_on_rails.html#install-ruby-on-ubuntu.

Pin the exact Ruby version in `.ruby-version` (currently `ruby-4.0.5`) and pin Ruby gems in `Gemfile.lock`.

## Environment (project-local, via Mise)

Everything project-local: Ruby, gems, bundler. No system gem writes, no sudo for gems.

    # 1. toolchain (Mise + Ruby 4.x + Rails) — idempotent, follows the official guide
    bash ../setup_rails.sh

    # 2. activate Mise in this shell (or: mise shell ruby@4.0.5)
    eval "$(~/.local/bin/mise activate bash)"

    # 3. install gems project-local (vendor/bundle — already pinned in .bundle/config)
    bundle install

    # 4. run
    bin/rails s -b 0.0.0.0 -p 8788

- `.ruby-version` pins `ruby-4.0.5`; `.bundle/config` pins `BUNDLE_PATH=vendor/bundle` (project-local gems) and `BUNDLE_WITHOUT` is unset (install all groups).
- `setup_rails.sh` follows https://guides.rubyonrails.org/install_ruby_on_rails.html#install-ruby-on-ubuntu (Mise, user-level; skips apt when build deps already present).
- For automation/agents: capture the Mise-activated env once (`eval "$(mise activate bash)" && ruby -v`) into a dotenv, then reuse it via `env=<path>` on subsequent shell/LSP calls — avoids re-activating per command.

## Testing

Do not write useless tests. Keep everything lean and logically verifiable. The end-to-end product — app boots, page renders, live updates reach the DOM — is the ultimate test.

- No tests for the sake of coverage. No mocking — mocking is mere mockery.
- A test earns its keep only if it guards a non-obvious path the end-to-end product cannot surface via a plain HTTP request (e.g. a WebSocket-only channel action, or the `Turbo::StreamsChannel` broadcasts the client `received` bridge renders).
- Prefer confirming the real product: boot the server, curl the page, exercise the live stream. Reserve tests for the narrow paths a browserless curl cannot reach.
