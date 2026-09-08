# Per-project state

The canonical schema is defined in
[`../../src/core/schema.ts`](../../src/core/schema.ts). Path derivation is
defined in [`../../src/core/paths.ts`](../../src/core/paths.ts).

## Rationale

- Presentation preferences should evolve without changing core identity.
- Media is content-addressed so identical bytes deduplicate, remain
  integrity-checkable, and can be synchronized independently of database
  metadata.
- Topic references cross the database boundary. Global topics are never
  hard-deleted, so those references remain valid.

Universal policies are defined in [`../../DESIGN.md`](../../DESIGN.md).
