# Global state

The canonical DDL is [`../../src/core/schema.ts`](../../src/core/schema.ts), and
canonical path derivation is defined in
[`../../src/core/paths.ts`](../../src/core/paths.ts).

## Rationale

- Presentation data is isolated from the core registry so display preferences
  can change or be lost without affecting project and topic identity.
- Projects and topics are soft-deleted rather than hard-deleted. Topic
  references cross database boundaries, so preserving archived topics keeps
  those references resolvable.

Identity and timestamp policy is defined by the universal invariants in
[`../../DESIGN.md`](../../DESIGN.md).
