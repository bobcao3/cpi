# Adding a VCS adapter

Implement the application-owned [provider contract](src/vcs/types.ts), then add
the provider to the selection list in [the coordinator](src/vcs/index.ts).
[The JJ adapter](src/vcs/jj.ts) demonstrates command-backed queries through the
bounded [repository implementation](src/vcs/command-repository.ts).

The coordinator owns selection policy. The host SDK's public `VcsSource` and
`VcsSourceFactory` exports supply status and lifecycle notifications. Resolve
these from the installed `@earendil-works/pi-coding-agent` package; keep backend
detection and precedence out of Pi.

The application must supply the factory before interactive mode constructs its
footer. An extension startup callback cannot guarantee the first frame. Pi owns
the borrowed Git implementation and its watchers; an application adapter must
not dispose those resources.

Run the real-repository checks from this package:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/vcs.test.ts test/footer-project.test.ts
```
