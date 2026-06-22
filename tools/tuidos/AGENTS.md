# Tui-Do(s)

- `clidos` is the CLI interface
- `tuidos` is the TUI interface

Interfaces no matter TUI and CLI should be clean and beautiful.

There's no equal attention. Some information is more important than others, and design should conform this matter of life.

Interface should be opinionated, and user should feel guided. No errors shall be dumped to the user without suggestions of remedy, even though some suggestions could be "programming error, report to developer"

Even for CLI without TTY, interface should still be beautiful: Use `*EMPHASIS*`, use `# section`, use `> note`.

Even for CLI with programmatic audiences, beauty is still useful: No raw logs, no minified JSON, program parsable is beautify, crazy escape sequences and unclear formatting is ugly.

Data model must be clean and simple.

Data model must be designed with a different mind set from interface: it's not here being helpful, it needs to define truth.

Data model should either always work or fail loudly, no opinions, no wiggle rooms.

Evolution is the only constant, reduce coupling in data model to allow for evolution of this project.
