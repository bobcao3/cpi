# LibSQL, and the HPC shared-`$HOME` reality

> Two questions: (1) what does LibSQL do, and does it solve the
> SQLite-over-network-filesystem problem? (2) In an HPC cluster many nodes
> share a network-backed `$HOME` — so where does that leave tuidos's default
> state location?

## 1. What LibSQL is

**LibSQL is an open-source, open-contribution *fork* of SQLite, maintained by
Turso.** It is *not* a rewrite: it keeps SQLite's file format and C API (100%
backwards-compatible) and is production-ready. It was forked because SQLite is
open-source but not open-contribution. [libsql-repo] [libsql-docs]

Crucially, the LibSQL repo states plainly that it **"inherits SQLite's
fundamental limitations such as the single-writer model."** [libsql-repo] So
LibSQL does *not* give you concurrent multi-writer access to one file — that is
a separate, newer project (see below).

### What it adds on top of SQLite

- **Embedded replicas.** Your app holds a *local read replica* (a normal SQLite
  file on local disk) of a *remote primary*. **Reads are local** (microseconds);
  **writes are sent to the remote primary** and then reflected back to the local
  replica (read-your-writes by default). [emb-rep] [medium-emb]
- **`sqld` — a server mode.** SQLite dialect over HTTP/gRPC, in a
  single-primary / many-replica topology: the primary takes all writes and
  streams WAL frames to replicas; replicas serve reads locally and proxy writes
  to the primary. [sqld-design] [sqld-readme]
- **Pluggable "virtual WAL"** — the mechanism that lets WAL frames be captured
  on the primary and injected into replicas. [libsql-ext]
- Native HTTP/remote client, vector search, etc. (not relevant here).

### How replication actually works (and its limits)

- Topology is **single primary, many replicas**. The primary is the only writer.
  Replicas are read-only locally and forward writes. [sqld-design] [deepwiki]
- Replication is at the **WAL-frame (4 KB page) level** — "physical" page
  replication, not logical change-data-capture. Replicas poll the primary over
  gRPC for new frames and inject them. [deepwiki-emb]
- For higher write concurrency / HA, the primary can sit on a **mvSQLite
  (FoundationDB) backend**; otherwise it's a single-node libSQL file. [sqld-design]
- **Hard caveats** from the docs: *"Do not open the local database while the
  embedded replica is syncing. This can lead to data corruption."*; embedded
  replicas need a real filesystem (no FS ⇒ unusable, e.g. serverless). [emb-rep]
- The page-level design is acknowledged as a weakness: Turso's own post calls
  embedded replicas "plagued with issues… downstream of a single fact: there is
  no good way to have a logical stream of changes in SQLite," motivating their
  rewrite. [sync-blog]

### LibSQL vs "Turso Database" (don't confuse them)

Turso now maintains **two** projects [libsql-repo] [libsql-docs]:

| | **libSQL** | **Turso Database** |
| --- | --- | --- |
| What | Fork of SQLite | Ground-up Rust rewrite of SQLite |
| Maturity | Production-ready | Beta |
| Multi-writer | **No** (single-writer, like SQLite) | **Yes** (MVCC, concurrent writes) |
| Sync | Embedded replicas — page-level, writes to a remote primary | `push()`/`pull()` logical CDC, local-first writes, offline/bidirectional |
| Server needed for sync | Yes (sqld primary, or Turso Cloud) | No always-on server required |

The user asked about **LibSQL**, so the rest focuses on it — but note that the
*concurrent-write + serverless-sync* capability lives in the newer rewrite, not
in the LibSQL fork.

## 2. Does LibSQL solve the shared-file problem?

**No — not by making one file safe across hosts.** Opening one LibSQL file from
many hosts is still SQLite under the hood: same WAL/shared-memory constraint
(`wal.c`: "the wal-index is shared memory, SQLite does not support
journal_mode=WAL on a network filesystem"), same POSIX-lock + fsync assumptions.
[wal.c] See `SQLite_Over_HPC_Filesystems.md` for why that corrupts.

What LibSQL *does* is **change the topology** so no host opens a shared file for
writes: one **primary** (a `sqld` process, single writer, DB on *its* local
disk) + N **embedded replicas**, each a local file on *its own* host. Reads are
local; writes round-trip to the primary. That sidesteps the network-FS hazard
entirely — the cost is **a running server process** (the primary) reachable from
every node, plus gRPC/TLS plumbing and a different client SDK. [sqld-design]

So LibSQL's relevance to our problem is the *primary + local-replica* pattern,
not the library itself.

## 3. The HPC shared-`$HOME` reality (this changes the framing)

In an HPC cluster, `$HOME` is almost always a **shared network filesystem**
(Lustre / FSx, GPFS/Spectrum Scale, WekaFS, Panasas, or NFS) mounted identically
on every node. tuidos's default state dir is `~/.local/state/tuidos/` (XDG),
i.e. **under `$HOME` ⇒ already on the shared network FS**. You don't have to
"decide" to put the DB on shared storage — the default puts it there.

Consequence: **any two concurrent tuidos processes on different nodes open the
same SQLite file over the network** — the exact corruption-prone scenario from
`SQLite_Over_HPC_Filesystems.md`, hit *by default*. Even for one user, a session
on the login node plus a quick `clidos` on a compute node is a concurrent
access. (Reads alone are less catastrophic on Lustre/WEKA than on NFS, but the
library is still untested across the wire.) [useovernet]

## 4. Options for tuidos, ranked by fit with its principles

DESIGN.md already commits to *"generated locally — no coordination server,"*
offline-first, and the 160-bit merge-safe ids. That preselects the answer.

### (a) Merge model — best fit (and what the ids were built for)
Each site/node owns a **local** SQLite (on node-local storage, or a per-node
subdir under `$HOME` such as `…/tuidos/nodes/$HOST/`). The network is only a
**transport for merge payloads** — export a bundle, import/merge it elsewhere,
exactly like git objects. The 160-bit random ids make merges collision-free
without any server. **No shared mutable file, no server, fully offline.** This
is the architecture the id change already implies. Cost: sync is explicit/async
(a `sync`/`merge` command), not live.

### (b) Single-writer discipline on the shared file — pragmatic, fragile
Keep `state.sqlite` on `$HOME` (Lustre/WEKA with coherent flock), rollback
journal (never WAL — WAL can't cross hosts), and rely on "only one writer at a
time." For a *personal*, low-concurrency task tool the practical risk is small —
but this is precisely SQLite's "works where tested, fails where relied upon"
trap, and AGENTS.md forbids wiggle room in the data model. Acceptable as a
transition, not as the target.

### (c) LibSQL/sqld primary + embedded replicas — live shared state, heavy
Run `sqld` as the primary on one always-on node (login node, or a small service
node); each compute node runs tuidos against an embedded replica on node-local
storage. Gives local reads everywhere and serialized writes through the primary.
**Costs that conflict with current principles:** a running server (HPC schedules
make "always-on daemon on a node" awkward, and it's a single point of failure);
a new native dependency (the `@libsql/client` SDK, *not* `bun:sqlite` — and
native bindings may not ship prebuilt for old HPC kernels/architectures);
single-writer still. Choose this only if live multi-node shared state is a hard
requirement and a server is acceptable.

### (d) Detect shared-`$HOME` and act
At minimum, tuidos could detect that the resolved state dir is on a non-local
filesystem and either warn ("this is a shared mount; concurrent use across
nodes can corrupt the DB") or relocate the live DB to node-local storage. This
makes the hazard *visible* rather than silent — consistent with "no errors
dumped without remedy."

## Recommendation

The merge model (a) is both the safest and the closest fit to the existing
design: it reuses the 160-bit ids, needs no server, and keeps SQLite on a local
filesystem where its guarantees actually hold. If live cross-node state is ever
required, the principled upgrade is (c) LibSQL/sqld — accepting that it means
introducing a server and a new SDK — not (b) gambling on a shared mutable file.

## Sources

- [libsql-repo] tursodatabase/libsql README (fork of SQLite; **inherits single-writer**; embedded replicas; sqld; Turso-DB distinction) — https://github.com/tursodatabase/libsql
- [libsql-docs] Turso docs, *libSQL* (production-ready fork; same file format/API; vs Turso Database rewrite) — https://docs.turso.tech/libsql
- [emb-rep] Turso docs, *Embedded Replicas* (local read replica, writes to remote primary, read-your-writes; **don't open local DB while syncing**; needs filesystem) — https://docs.turso.tech/features/embedded-replicas/introduction
- [medium-emb] Glauber Costa, *Introducing Embedded Replicas* (source of truth is the remote DB; writes go remote, reads local) — https://medium.com/chiselstrike/introducing-embedded-relicas-deploy-turso-anywhere-2085aa0dc242
- [sqld-design] libSQL `docs/DESIGN.md` — `sqld` = client + primary + replicas (+ optional mvSQLite/FoundationDB); primary takes writes, replicas poll WAL frames over gRPC — https://github.com/tursodatabase/libsql/blob/main/docs/DESIGN.md
- [sqld-readme] libSQL `libsql-server/README.md` (sqld: SQLite over HTTP, read replicas, S3 bottomless replication) — https://github.com/tursodatabase/libsql/blob/main/libsql-server/README.md
- [deepwiki] DeepWiki, *Replication Architecture* (single-primary/multi-replica; WAL frames over gRPC; write proxy) — https://deepwiki.com/tursodatabase/libsql/2.5-replication-architecture
- [deepwiki-emb] DeepWiki, *Embedded Replication* (page-level WAL-frame pull + SqliteInjector; periodic sync) — https://deepwiki.com/tursodatabase/libsql/3.6-embedded-replication
- [libsql-ext] libSQL `libsql_extensions.md` (virtual/pluggable WAL) — https://github.com/tursodatabase/libsql/blob/main/libsql-sqlite3/doc/libsql_extensions.md
- [wal.c] libSQL `libsql-sqlite3/src/wal.c` ("wal-index is shared memory… SQLite does not support journal_mode=WAL on a network filesystem") — https://github.com/tursodatabase/libsql/blob/main/libsql-sqlite3/src/wal.c
- [sync-blog] Turso, *Turso Sync: a much better way to sync* (page-level embedded replicas "plagued with issues"; CDC rewrite motivation) — https://turso.tech/blog/sync-benchmark
- [useovernet] SQLite, *SQLite Over a Network* (not tested across a network; rely at your peril) — https://www.sqlite.org/useovernet.html
