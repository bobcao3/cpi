# DESIGN

Tuidos uses three state tiers.

1. **Global state.** Stored in `~/.local/state/tuidos/global.sqlite`. This holds the project registry; projects are named entries, not tied to folders.
2. **Per-project state.** Each project has its own SQLite at `~/.local/state/tuidos/projects/<project-id>/state.sqlite`. Tasks, kanban columns, and metadata live here.
3. **Client state.** Selections, filters, and UI focus live only in memory while a client runs.

Two clients access the same data:

- `clidos` — non-TTY CLI.
- `tuidos` — interactive SolidJS/OpenTUI front-end.

Both read from and write to the same SQLite files.

## Structural positioning

tuidos is structurally between Linear and Basecamp (the poles are characterized
in `docs/research/prior_art/Compare_Kanban.md`):

- **Linear** — the board is just a view over a flat graph; structure is derived
  from issue properties, not stored as a hierarchy.
- **Basecamp** — the board is the only structure: one Card Table per project,
  with no separate view layer.
- **tuidos** — a two-level structure, project -> topic -> tasks. Topics are a
  real structural level (a child of a project), so the model is not a flat
  graph; yet the board is still a view over that structure, not the structure
  itself.

The project->topic coupling is what lands tuidos halfway — structural like
Basecamp, view-based like Linear. Board rendering is deferred: it is not
designed yet. The presentation tables (`*_display`) keep display preferences
(color, ordering) apart from core, but how the board is drawn is TBD.

## SQLite vs LibSQL

Use SQLite via `bun:sqlite`. It is built into Bun, needs no extra dependency, supports WAL mode, and handles concurrent readers and one writer safely. LibSQL's remote sync routes every write through a `sqld` *primary* — a write-time coordination authority — plus a native client dependency. We sync P2P-style instead: local clones plus a mesh of peers bootstrapped by always-on discovery/relay nodes that never serialize writes (see *Sync model* below).

## Sync model (local-first, P2P)

State is **local-first**: each node holds a full copy (a "clone"), works
offline, and merges others' changes deterministically — Strong Eventual
Consistency, no write-time authority
(`docs/research/sync_model/Merge_Model_No_Coordination.md`). The transport is a **P2P
mesh**: every node can serve every other, bootstrapped by a few always-on
**discovery/relay** nodes — the Syncthing/libp2p/Tailscale pattern
(`docs/research/sync_model/P2P_Sync_Design.md`).

- **Peer identity & trust.** Each node has a local keypair (Ed25519); the public
  key is its peer id. You sync only with peer ids you've accepted (allowlist).
  Discovery routes; it does not vouch for trust.
- **Control plane — discovery/relay nodes (always-on).** A small set of
  well-known nodes act as a directory (peer id → addresses) and, when two peers
  can't connect directly (NAT/firewall), relay their already-encrypted traffic.
  Like Tailscale's coordination server this carries **keys and routing, not
  data** — an outage only delays rendezvous; it cannot corrupt or lose state.
  In HPC the login node naturally fills this role.
- **Data plane — P2P mesh.** Any node serves the append-only log to any other;
  there is no data authority (the merge is symmetric). Each writer appends
  id+timestamp-tagged events to its own log (the `audit_log`); sync = exchange
  log heads, pull missing events by id, then merge = union by id, sort by
  `(ts, id)`, apply into the local DB. Append-only creates dedupe by 160-bit id;
  mutable fields resolve last-write-wins by timestamp; deletes are tombstones
  (`archived_at`). Pairwise pull is the simple form; gossip for scale/liveness.
  End-to-end encrypted; a relay cannot read it.
- **Live DB stays local.** Writes go to a node-local SQLite in WAL mode
  (`busy_timeout` + `BEGIN IMMEDIATE` for intra-node multi-writer, e.g. one
  tmux). The shared network `$HOME` is **not** the live DB (SQLite locks and WAL
  shared-memory are unsafe there — `docs/research/sync_model/SQLite_Over_HPC_Filesystems.md`);
  it may serve only as a dumb fallback store.
- **Degenerate case.** A single always-on node that is discovery + relay + the
  only store is the git-style "hub" — a valid minimal deployment. P2P separates
  these roles so any peer serves data, removing the single data SPOF.
- **Trade-off.** No-coordination means last-write-wins can discard a concurrent
  conflicting write to the same field, and reads are stale until the next sync.
  P2P changes *who serves whom*, not the merge semantics. Accepted for a
  personal/small-team task tool.

## Schema

### Universal invariants

Rules that hold for every table in every database file.

1. **Timestamps are stored as UTC unix time.** Every timestamp is an integer
   count of milliseconds since the 1970-01-01 UTC epoch — never a local time,
   never an ISO 8601 string. Store UTC at write time; convert to a local or
   human-readable form only at display time, so values stay comparable and
   sortable across machines and timezones.

2. **Entities are identified by a 160-bit random id, never by name.** Every
   table's primary key and foreign key is a 32-char Crockford base32 id
   (`TEXT`), generated locally with no central id assignment — SHA-1-strength
   entropy so ids stay unique when state from independent sites is merged
   (git/jj-style collaboration; birthday bound ~2⁸⁰ ids). Names are mutable,
   human-readable labels — never keys in the data model or core: nothing there
   is selected, joined, or referenced by name. Rename a thing and its identity
   (id) is unchanged; only its label moves. The full id is the canonical,
   merge-safe key; locally it is shown and addressed by a short unique prefix
   (git-style abbreviation, re-checked for ambiguity at resolve time), and the
   CLI accepts names too — but both are boundary conveniences only: each is
   resolved to the full id before touching core, which never sees a name or a
   prefix as a key.
