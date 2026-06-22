# Intra-site multi-writer coordination for SQLite

> Problem: within one site, many tuidos processes may write concurrently (e.g. a
> tmux session with many panes; or several nodes of one cluster). What is the
> simplest *distributed* approach — no central authority, leader election OK —
> that works on a low-latency network (<10 ms, or even a single node?

## TL;DR — the answer splits by regime

The right approach depends on **whether the writers share one machine or many**,
because that decides whether SQLite's *own* locking is usable:

1. **All writers on one node (the tmux case), DB on a LOCAL filesystem** →
   **SQLite does it for you.** WAL mode + `busy_timeout` + `BEGIN IMMEDIATE`.
   Zero distributed machinery, zero extra dependencies. This is the documented
   2024–2025 best practice and it directly solves "many tuidos in one tmux."
   [tenthousandmeters] [berthub] [sqlite-forum]
2. **Writers across nodes sharing one DB file (e.g. on the shared `$HOME`
   network FS)** → **a distributed lock around the shared file is a trap.** It
   cannot be made safe, because SQLite cannot enforce *fencing tokens* and the
   network-FS locks are unreliable. The only safe multi-writer SQLite is
   **one writer to a local file (+ replication)** — which is exactly what the
   distributed-SQLite systems (rqlite, dqlite, LiteFS, …) do. [kleppmann]
   [fencing] [systeminternals]

So: **never multi-write a shared SQLite file.** Funnel writes to a single
leader that owns a local file.

## Regime 1 — single node, local FS: just configure SQLite

WAL mode lets one writer proceed alongside many readers; writers serialize via
SQLite's own EXCLUSIVE lock, which **works correctly on a local filesystem**
(shared-memory wal-index is local). [wal] The remaining friction is
`SQLITE_BUSY`, handled by config:

- `PRAGMA journal_mode=WAL;` — readers don't block writers and vice-versa.
  (WAL needs shared memory, so this only works on a local FS — which is also
  why it does *not* work on the shared network `$HOME`. See
  `SQLite_Over_HPC_Filesystems.md`.) [wal] [tenthousandmeters]
- `PRAGMA busy_timeout=5000;` (5–10 s; production often 10–20 s) — **per
  connection**, retry transparently instead of returning BUSY. Below ~5 s,
  occasional "database is locked" errors still slip through under load.
  [tenthousandmeters] [sqlite-forum]
- `PRAGMA synchronous=NORMAL;` — the recommended WAL durability/perf balance.
- Use **`BEGIN IMMEDIATE`** for any transaction that will write. A plain `BEGIN`
  starts read-only and *upgrades* to write later; two upgraded readers deadlock
  and one gets `SQLITE_BUSY` **that `busy_timeout` cannot resolve** (it's a
  logical deadlock, not a wait). `BEGIN IMMEDIATE` takes the write lock up front.
  [isolation] [berthub] [sqlite-forum]
- Keep transactions short (ideally one statement = one transaction); open
  connections sequentially at startup (concurrent opens can BUSY during WAL
  recovery). [berthub]

This is the whole answer for the tmux case — **provided the DB is on local
(node-local) storage**, not the shared `$HOME`. tuidos's default
`~/.local/state/tuidos/` violates that precondition on an HPC cluster, so the
live DB should be relocated to node-local storage (see prior notes).

## Why "distributed lock + shared SQLite file" is unsafe (the fencing lesson)

If writers are on different nodes and the DB sits on the shared network FS, the
obvious idea is "elect a leader / take a distributed lock, then write the
file." The distributed-locking literature says this is **not safe for
correctness**:

- A lease/lock can expire *while the holder is paused* (GC pause, scheduling).
  The lock is re-granted to another node; the paused holder wakes up still
  believing it holds the lock. **Two nodes now write.** [kleppmann] [aws-leader]
- The standard fix is a **fencing token**: the lock service issues a
  monotonically increasing token per grant; the *resource* rejects any write
  whose token is ≤ the highest it has seen. Safety moves from the lock service
  to the resource. [kleppmann] [fencing] [systeminternals]
- **SQLite cannot enforce fencing tokens** — there is no hook for it to reject a
  "stale" writer. So a paused stale leader can still issue SQLite writes after
  its lease lapsed. On a network FS this is catastrophic because SQLite's own
  locks (the would-be backstop) are themselves unreliable there.
  [kleppmann] `SQLite_Over_HPC_Filesystems.md`

> Net: a distributed lock makes a shared SQLite file *no safer*. Redlock can't
> fence at all; etcd/ZooKeeper *can* mint tokens but the resource (SQLite)
> can't check them. [kleppmann] [systeminternals] Therefore multi-writer SQLite
> must be **one writer to a local file** — where local-FS locks *are* the fence —
> plus replication for availability.

This is also why every distributed-SQLite system below funnels writes through a
single leader operating on a local file, rather than sharing one file.

## Regime 2 — cross-node, live shared state: pick a distributed-SQLite system

If live multi-node shared state is a hard requirement, don't hand-roll it — use
a system that already implements Raft single-leader + replication (so all
writes serialize through one leader's local file). Compared on simplicity,
latency, and dependencies:

| System | Mechanism | Simplicity | Write latency | Deps / fit for Bun-TS |
| --- | --- | --- | --- | --- |
| **rqlite** | Raft; SQLite as engine; HTTP API | **Easiest ops** — single binary, seconds to cluster | Higher (HTTP + Raft log round-trips; writes through leader) | Separate process + HTTP client; not drop-in [rqlite-faq] |
| **dqlite** | C lib (libdqlite) + C-Raft; uses WAL as replication log; embedded | Medium | **Lowest** (in-process, no HTTP); closest to drop-in | C/Go integration; odd node count; heavy for TS [gcore] [aalto] |
| **LiteFS** | FUSE FS intercepting writes; Consul-lease leader election | Medium — needs FUSE + Consul | Low-ish | FUSE (needs root/CAP_SYS_ADMIN — often disallowed on HPC nodes); async, can lose data on primary crash [litefs-arch] |
| **mvSQLite** | SQLite storage on FoundationDB | Hardest — 3 moving parts + FDB | Low; true write scaling | FoundationDB cluster; heaviest [mvsqlite] |
| **libSQL / sqld** | single-writer primary + embedded read replicas | Medium — needs `sqld` primary | Local reads, writes round-trip to primary | `@libsql/client` (not `bun:sqlite`); single-writer (see `LibSQL_and_HPC_Shared_Home.md`) |

Notes:
- All are **single-writer at the core** (Raft elects one leader; only it
  writes its local file). "Multi-writer" is achieved by serializing through the
  leader, not by concurrent shared-file writes. [rqlite-faq] [aalto]
- **rqlite** is the simplest to *operate* (one binary, easy clustering, etcd-like
  HA) but adds a separate service and HTTP round-trips on every write.
  [rqlite-faq] [gcore]
- **dqlite** has the lowest latency and is embeddable (used by LXD/MicroK8s),
  replicating the WAL directly — but it's a C library, awkward to bind from
  Bun/TypeScript and needs an odd-numbered cluster. [gcore] [aalto]
- **LiteFS** is transparent (your app sees a normal file) but FUSE is usually
  unavailable on locked-down HPC compute nodes, and its async replication can
  drop committed transactions on a primary crash. [litefs-arch]
- None is a clean, dependency-light fit for a Bun/TS tool — they're all
  C/Go/FUSE/server. That cost is the price of *correct* multi-writer SQLite.

## Recommendation for tuidos (tiered, simplest-first)

1. **Intra-node (tmux) — the common case:** WAL + `busy_timeout` (5–10 s) +
   `synchronous=NORMAL` + `BEGIN IMMEDIATE`, on **node-local storage**. Zero
   new deps, zero distributed code. This is the direct fix for "many tuidos in
   one tmux." (Precondition: live DB not on the shared network `$HOME`.)
2. **Cross-node within a site, live state needed:** adopt **rqlite** (simplest
   operations: single binary, Raft leader election, no central authority) as the
   store and talk to it over HTTP — accepting a separate process and write
   round-trips. Pick **dqlite** instead only if write latency is critical and you
   can stomach C/Go integration. **Do not** build a custom distributed lock
   around a shared SQLite file — it is unsafe (fencing impossible).
3. **Cross-node within a site, liveness NOT required:** the **merge model**
   (per-node local DB + export/import, enabled by the 160-bit ids) — no server,
   no live coordination, safe. Often this is enough; reserve rqlite/dqlite for
   the case where two people must see live mutual edits on different nodes.

The through-line: **safe multi-writer SQLite is always "one writer to a local
file (+ replication)," never "N writers to one shared file."** SQLite's own locks
handle the local-file case for free (Regime 1); the distributed systems exist to
extend that single-writer-local-file model across nodes with leader election +
replication (Regime 2).

## Sources

- [wal] SQLite, *Write-Ahead Logging* (readers/writers don't block; WAL needs shared memory → local FS only) — https://sqlite.org/wal.html
- [isolation] SQLite, *Isolation In SQLite* (WAL snapshot isolation; `BEGIN IMMEDIATE` avoids upgrade deadlock) — https://www.sqlite.org/isolation.html
- [lockingv3] SQLite, *File Locking And Concurrency v3* (SHARED/RESERVED/PENDING/EXCLUSIVE; single writer) — https://www.sqlite.org/lockingv3.html
- [tenthousandmeters] V. Skvortsov, *SQLite concurrent writes and "database is locked" errors* (WAL + busy_timeout=5000 + synchronous=NORMAL + BEGIN IMMEDIATE + app-level locking) — https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/
- [berthub] Bert Hubert, *What to do about SQLITE_BUSY errors despite setting a timeout* (BEGIN IMMEDIATE; open connections sequentially; WAL recovery wart) — https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/
- [sqlite-forum] SQLite forum, *Help avoiding 'database is locked' errors* (read→write upgrade is a deadlock busy_timeout can't fix) — https://sqlite.org/forum/forumpost/74b5a4ddb
- [kleppmann] M. Kleppmann, *How to do distributed locking* (leases expire under pauses; fencing tokens required; Redlock can't fence) — https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- [fencing] Primitives, *Fencing Tokens and Lock Safety* (resource must reject stale tokens; safety shifts to the resource) — https://primitives.pub/distributed-systems/monographs/fencing-tokens
- [systeminternals] *Distributed Lock — Redlock, ZooKeeper, etcd, fencing tokens* (etcd mod_revision / ZK zxid as fencing token; lease+token+resource-check) — https://systeminternals.dev/system-design/distributed-lock/
- [aws-leader] Amazon Builders' Library, *Leader election in distributed systems* (leases most common; GC pause between lock-check and work is the hard part) — https://aws.amazon.com/builders-library/leader-election-in-distributed-systems/
- [rqlite-faq] rqlite FAQ (Raft; single leader; writes through leader; easy single-binary ops; not a drop-in) — https://rqlite.io/docs/faq/
- [gcore] Gcore, *Comparing Litestream, rqlite, dqlite* (dqlite lowest latency/embedded C-Raft; rqlite HTTP adds latency) — https://gcore.com/learning/comparing-litestream-rqlite-dqlite
- [aalto] Aalto thesis, *Adapting SQLite to the Distributed Edge* (dqlite uses WAL as Raft log, strongest consistency; LiteFS lacks sync replication) — https://aaltodoc.aalto.fi/server/api/core/bitstreams/e3df40d2-a6e3-4a6a-8341-d10837b2f834/content
- [litefs-arch] LiteFS ARCHITECTURE.md (FUSE; Consul-lease leader election; async replication can lose data on primary crash; not for strong sync) — https://github.com/superfly/litefs/blob/main/docs/ARCHITECTURE.md
- [mvsqlite] losfair, *Turning SQLite into a distributed database* (FDB-backed; decouples storage; external consistency; 3 moving parts) — https://su3.io/posts/mvsqlite
