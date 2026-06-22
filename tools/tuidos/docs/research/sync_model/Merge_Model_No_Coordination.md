# Does the merge model really need no server? (coordination vs. transport)

> Challenge: "Git needs a central server (origin/upstream), so how can a
> 'no-coordination-server' merge model actually work?" This note separates the
> two things being conflated and shows where the claim is — and isn't — honest.

## The one distinction that resolves it

A **coordination authority** and a **transport/relay** are different things:

- **Coordination authority**: an always-on component that *serializes and/or
  validates every write at write time* — it decides the single linear order of
  operations and rejects conflicting ones. The writer blocks on it. Examples:
  a DB primary, `sqld`, etcd, Raft leader. This is what DESIGN.md's *"no
  coordination server"* principle rejects. [rahul-comm-coord]
- **Transport / relay**: a dumb bucket that moves bytes between sites. It does
  not serialize, order, or validate writes; it just stores and forwards. The
  writer never blocks on it. A shared directory, an S3 object, a `git remote`,
  an emailed patch, a USB stick.

**Git's `origin`/upstream is a transport, not a coordination authority.** That is
the whole answer. The merge model needs a transport; it does not need a
coordination authority. So "no coordination server" is honest even when a hub is
used — because a hub that only stores/forwards is not coordinating anything.

## Git is genuinely peer-to-peer; `origin` is convention

- *"Most operations in Git need only local files and resources to operate —
  generally no information is needed from another computer… you have the entire
  history of the project right there on your local disk."* You commit offline;
  sync is a separate, asynchronous step. [git-what-is-git]
- *"Every developer possesses a complete, autonomous repository… There is no
  technical distinction between 'server' and 'client' repositories — each clone
  is equally authoritative."* Git explicitly supports a peer-to-peer topology:
  *"No central authority — direct developer-to-developer communication — pull
  changes directly from teammate repositories."* The hub is a *convention*:
  *"Technical Reality: While Git is distributed, most teams designate one
  repository as the 'official' hub."* [gitcheatsheet]
- Wikipedia: DVCS *"uses a peer-to-peer approach… There is no single central
  version of the codebase."* The central upstream is a *social* recentralization,
  not a technical necessity. [wiki-dvcs]
- Git's own Protocols chapter frames a shared repo as *convenience/reliability*,
  not requirement, and supports serverless transports: local file path (a shared
  mount!), `git bundle` (offline, incremental), email patches, `git daemon`.
  [git-protocols] [so-p2p]

Crucially, **the merge/conflict-resolution happens locally, on the client** — the
server never decides how your branches combine. `origin` enforces some DAG
integrity (it rejects non-fast-forwards), but it does not serialize your writes
into a single order or resolve conflicts for you. It is not a coordination
authority in the sense that matters here.

## Coordination-free convergence is mathematically real (not hand-waving)

The merge model rests on **Strong Eventual Consistency (SEC)**, proven for
Conflict-free Replicated Data Types (CRDTs):

- *"Provably, replicas of any CRDT converge to a common state… As a CRDT
  requires no synchronisation, an update executes immediately, unaffected by
  network latency, faults, or disconnection."* — Shapiro et al., the founding
  CRDT paper. [shapiro]
- Merge is **associative, commutative, idempotent** (a join-semilattice); ACID
  2.0 is *necessary and sufficient* for SEC. [calm] Any replica can
  *"execute the write, merge, and query operations immediately upon request
  without consulting any other replica, while guaranteeing consistency"* —
  that is the formal definition of coordination-free. [calm]
- Bailis's **I-confluence** is *"necessary and sufficient for safe,
  coordination-free, available, and convergent execution."* If it holds, a
  coordination-free strategy exists; if not, none does. [bailis]
- The **Coordination Criterion**: a spec admits a coordination-free
  implementation *iff* its observable outcomes are monotone under history
  extension. [coord-criterion]

So "merge without a coordination server" is a theorem, not a slogan — *provided
the data model's merge is monotone/commutative/idempotent.* Append-only logs
unioned by unique id satisfy this trivially; mutable fields need a CRDT register.

## What you genuinely cannot avoid: a transport

Coordination-free ≠ communication-free. You still need *some* channel to move
bytes. But it can be **dumb, passive, async, lossy**:
- Writes are **local and instant** (append to your own log); no write blocks on
  the network. Dissemination happens whenever.
- Re-sends are **idempotent** (dedupe by unique id); lossy channels are fine.
- The relay needs **no ordering, no validation, no availability SLA** — because
  CRDT merge is order-independent, there is no "bad push" to reject. The hub is
  strictly dumber than git's `origin`.

For tuidos:
- **Intra-site (HPC):** the shared `$HOME` is a free dumb transport — each
  writer appends to its *own* per-writer log file in a shared dir. Different
  files ⇒ **no concurrent-write-to-one-file contention at all**, which also
  sidesteps the entire SQLite-over-network-FS hazard (see
  `SQLite_Over_HPC_Filesystems.md`). Merge reads everyone's log files
  (read-only, safe) and materializes locally.
- **Cross-site:** any dumb channel — `rsync` the log dir, an S3 bucket, a
  `git bundle`, peer-to-peer SSH. None is a coordination server.

## The price of no-coordination (state it plainly)

SEC trades away two things, and both must be accepted deliberately:

1. **LWW loses concurrent conflicting writes.** A mutable field resolved
   last-write-wins keeps only the highest-timestamp write; concurrent updates to
   the *same* field silently discard the losers. *"LWW-Register is a formally
   valid CRDT but discards concurrent updates… clock skew can reverse the 'real'
   order."* [crdt-db] [hld] For two sites that rename the same topic
   differently, one rename is lost. Acceptable for low-stakes fields; if losing a
   concurrent write matters, use an **MV-Register** (keep both as siblings) or
   an **OR-Set**, or fall back to git-style manual 3-way merge — still no server.
2. **Clock skew** can make LWW pick the "wrong" winner → assume NTP-synced
   clocks; use a hybrid-logical-clock if skew is a real concern. [hld]
3. **Tombstone growth:** soft-deletes (tombstones) must be retained, so state
   grows; GC of tombstones needs coordination (knowing all replicas saw a
   state) — but that's a *performance* concern, not a correctness one. [shapiro]
   [crdt-db]

Instant global consistency and zero lost concurrent writes are the things you
give up. Availability, offline operation, and convergence without any authority
are what you get.

## tuidos already has the coordination-free building blocks

- **160-bit random ids** → globally unique with no central id assignment;
  append-only creates dedupe by id (a G-Set — the simplest CRDT).
- **`audit_log`** is an append-only, id+timestamp-tagged event log → this *is*
  the CRDT op-log. Union of logs (by id) is commutative+associative+idempotent ⇒
  converges regardless of arrival order.
- **`archived_at`** (and any mutable field resolved by LWW on timestamp) → a
  tombstone / LWW-register CRDT. Converges.

So the merge model is literally: each site appends events to its local log;
**merge = union all logs, sort by `(ts, id)`, apply deterministically into a
local materialized DB.** No coordination authority; any dumb transport; writes
never block on the network.

## Verdict

- *"Git needs a central server"* — no: git is P2P; `origin` is a convention, and
  even when used it is a **transport**, not a coordination authority. [gitcheatsheet] [wiki-dvcs]
- The merge model needs a **transport** (unavoidable); it does **not** need a
  **coordination authority** (avoidable, by CRDT/SEC design). [shapiro] [calm]
- "No coordination server" is therefore an honest claim **for correctness**,
  given an append-only + LWW/tombstone data model — which tuidos already has.
- What it honestly foregoes: instant global consistency, and zero loss of
  concurrent conflicting writes (LWW). That is the deliberate trade.

## Sources

- [git-what-is-git] Pro Git, *What is Git?* (local ops; full history on disk; offline commits) — https://git-scm.com/book/en/v2/Getting-Started/What-is-Git%3F
- [gitcheatsheet] *Git's Collaboration Model* (every clone equally authoritative; P2P topology; hub is convention) — https://gitcheatsheet.dev/docs/concepts/collaboration/
- [wiki-dvcs] Wikipedia, *Distributed version control* (peer-to-peer; no single central codebase; upstream is social recentralization) — https://en.wikipedia.org/wiki/Distributed_version_control
- [git-protocols] Pro Git, *Git on the Server — The Protocols* (shared repo is convenience; local-path/bundle/daemon transports) — https://git-scm.com/book/en/v2/Git-on-the-Server-The-Protocols
- [so-p2p] SO, *How to set up Peer-to-Peer collaboration with Git?* (patches, git bundle, daemon) — https://stackoverflow.com/questions/24475081/
- [shapiro] Shapiro et al., *A comprehensive study of Convergent and Commutative Replicated Data Types* (CRDTs converge with no synchronisation; updates execute immediately) — https://asc.di.fct.unl.pt/~nmp/pubs/tr-inria-2011.pdf
- [calm] arXiv, *A Preliminary Model of Coordination-free Consistency* (coordination vs. computation; ACID 2.0 necessary & sufficient for SEC) — https://arxiv.org/html/2504.01141
- [bailis] P. Bailis, *When Does Consistency Require Coordination?* (I-confluence necessary & sufficient for coordination-free convergent execution) — https://www.bailis.org/blog/when-does-consistency-require-coordination/
- [coord-criterion] arXiv, *The Coordination Criterion* (coordination-free iff monotone under history extension) — https://arxiv.org/html/2602.09435v1
- [crdt-db] Primitives, *CRDTs in Databases* (mathematically guaranteed convergence; LWW discards concurrent writes; delta-state; tombstone GC needs coordination) — https://primitives.pub/databases/monographs/crdts-in-databases
- [hld] *CRDTs — The HLD Handbook* (SEC definition; LWW-Register "eats your data"; clock skew; tombstone growth) — https://hld.handbook.academy/curriculum/distributed-systems-theory/crdts/
- [rahul-comm-coord] R. Suryawanshi, *Communication and Coordination in Distributed Systems* (communication is transport; coordination is agreement; distinct) — https://rahulsuryawanshi.com/distributed-systems/communication-coordination/
