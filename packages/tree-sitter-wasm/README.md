# Tree-sitter WASM

Reusable parsing and highlighting with bundled grammars, independent of Pi.

The source workspace exports TypeScript directly for editable Bun development.
Use the package's native build script when changing Zig or grammar inputs; its
compiler and dependency pins live in `build.zig.zon`.

To prepare a publishable package, run `scripts/package.mjs` with a signed WASM
file and a new output directory. It emits JavaScript, declarations, and a tarball
containing the verified asset and licenses. Publish the prepared tarball, not
the private source workspace. The release workflow's npm publication input is
explicitly opt-in.

Import parsing and highlighting from `@cpi/tree-sitter-wasm`. Asset selection
and trusted local-build overrides are defined in [resolve.ts](resolve.ts).
There is no runtime network provisioning or install-time build.

`artifact.test.mjs` uses npm and Bun to install real tarballs into isolated
consumers, then exercises parsing, highlighting, signature rejection, and missing
asset errors. Set `CPI_TREE_SITTER_TEST_ARTIFACT` to a directory containing the
signed WASM input. The compiler smoke test is
`scripts/tree-sitter-wasm.integration.mjs`.

License provenance accompanies the package in [licenses](licenses).
