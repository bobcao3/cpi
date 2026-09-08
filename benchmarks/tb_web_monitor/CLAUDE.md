# tb_web_monitor

Rails 8 + Hotwire port of the TerminalBench 2.1 web monitor.

Follow canonical Rails guidance, consult docs first:

- https://guides.rubyonrails.org/
- https://api.rubyonrails.org/
- Getting Started: https://guides.rubyonrails.org/getting_started.html

## Versions

Use the latest stable release of every component. Before bumping any version,
verify the current latest against official sources:

- Ruby: https://www.ruby-lang.org/en/downloads/
- Rails: https://rubyonrails.org/category/releases
- Mise: https://github.com/jdx/mise/releases

The toolchain is installed via Mise (user-level) per
https://guides.rubyonrails.org/install_ruby_on_rails.html#install-ruby-on-ubuntu.

Pin the exact Ruby version in [`.ruby-version`](.ruby-version) and Ruby gems in
[`Gemfile.lock`](Gemfile.lock).

## Environment (project-local, via Mise)

Project-local Ruby, gems, and Bundler are required; do not write gems to system
locations or use sudo for gems.

- Setup procedure: [`../setup_rails.sh`](../setup_rails.sh).
- For automation/agents, use the repository
  [env-capture skill](../../skills/env-capture/SKILL.md) to capture an activated
  environment once and reuse it for subsequent commands.

## Testing

Do not write useless tests. Keep everything lean and logically verifiable. The
end-to-end product — app boots, page renders, live updates reach the DOM — is
the ultimate test.

- No tests for the sake of coverage. No mocking — mocking is mere mockery.
- A test earns its keep only if it guards a non-obvious path the end-to-end
  product cannot surface via a plain HTTP request (e.g. a WebSocket-only channel
  action, or the `Turbo::StreamsChannel` broadcasts the client `received` bridge
  renders).
- Prefer confirming the real product: boot the server, curl the page, exercise
  the live stream. Reserve tests for the narrow paths a browserless curl cannot
  reach.
