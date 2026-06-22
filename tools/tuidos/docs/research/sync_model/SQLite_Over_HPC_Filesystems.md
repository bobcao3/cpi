# SQLite consistency over HPC parallel filesystems (Lustre / FSx, WekaFS)

> Question: can SQLite maintain consistency when its database files live on an
> HPC shared filesystem (WekaFS, or Lustre / Amazon FSx for Lustre) that may
> itself have weak consistency? Verdict first, then the evidence.

## TL;DR

- **SQLite was not designed to be driven across hosts over *any* network
  filesystem**, including the HPC parallel ones. The SQLite maintainers'
  standing advice is "your best defense is to not use SQLite for files on a
  network filesystem," and the library is explicitly **not tested across a
  network**. [useovernet] [howtocorrupt] [lockingv3]
- **WAL mode is a hard no across hosts**: it coordinates via a shared-memory
  *wal-index* (an mmap'd file in the DB directory) and all processes must be on
  the same machine. [wal] So a multi-machine shared DB is restricted to
  **rollback (DELETE) journal** = single writer, no concurrent readers+writer.
- **Lustre / FSx for Lustre and WekaFS are NOT NFS.** They ship kernel POSIX
  clients with real, cluster-coherent distributed locking and full cache
  coherency — *stronger* than NFS's close-to-open model. SQLite's two
  dependencies (byte-range locks + fsync durability) are *supported* here in a
  way they are not on plain NFS. [lustre-faq] [fsx] [weka-wp]
- **Supported ≠ safe.** The locks exist, but SQLite makes subtle local-FS
  assumptions (fsync write ordering, directory-fsync, lock-on-crash release)
  that no distributed FS fully guarantees. Real-world reports show
  `SQLITE_IOERR_LOCK` / "disk I/O error" even on Lustre. [so-lustre]
- **For tuidos specifically**: the merge-safe 160-bit ids we already adopted
  imply the *correct* architecture — each site owns a local SQLite and changes
  are **imported/merged** (git/jj-style), not written live into one shared file.
  That sidesteps the entire problem. See *Recommendations*.

## What SQLite actually needs from the filesystem

SQLite's ACID guarantees rest on two filesystem primitives, and it **assumes
they work as documented** — if they lie, the database can corrupt (not merely
return a stale read). [lockingv3] [howtocorrupt]

1. **Byte-range advisory locks** (`fcntl` POSIX locks on Unix). SQLite uses them
   to serialize writers and to keep readers out during a commit. POSIX advisory
   locking has known quirks (a `close()` on one fd silently drops *all* locks
   held by the process on that file) — SQLite 3.51.0 (2025-11-04) added extra
   defenses against this. [howtocorrupt] [vfs]
2. **Robust `fsync()`** — writes must be durably ordered (journal synced before
   the directory entry is synced, before the main DB is overwritten). Network
   filesystems sometimes relax fsync for performance; if so, a crash can leave a
   half-applied journal → corruption. [useovernet]

WAL adds a third requirement — **shared memory** — which is why it can't cross
hosts at all: the wal-index is an mmap'd file that all readers/writers must map
on one machine. [wal]

## Per-filesystem assessment

### Lustre / Amazon FSx for Lustre — *plausible, fragile*

- **POSIX-compliant and fully cache-coherent** across clients via the Lustre
  Distributed Lock Manager (LDLM); caches are flushed before locks are released.
  Unlike NFS there is no close-to-open caveat. [lustre-faq]
- **POSIX advisory (`fcntl`) locks and `flock` are coherent cluster-wide** when
  mounted with `-o flock`. This is **on by default since Lustre 2.12.3**; older
  releases needed the mount option explicitly. `-o localflock` is per-node-only
  and **unsafe** for a DB shared across nodes; `-o noflock` disables locking.
  [lustre-discuss] [so-lustre] [fsx]
- **Amazon FSx for Lustre** confirms: "POSIX-compliant… provides read-after-write
  consistency and supports file locking," with a `flock` mount option. [fsx]
- **Maintainer signal is mixed but real.** A Lustre engineer (Nicolas Williams)
  flatly answers "Yes" to "can sqlite databases be safely read/written" on
  Lustre. But Andreas Dilger (then Sun/Lustre) cautions that cross-node access
  "might result in file corruption by SQLite itself, regardless of the locking
  by Lustre," and insists all clients must use `-o flock`. [lustre-discuss]
- **Known failure modes on Lustre:**
  - `SQLITE_IOERR_LOCK` / "disk I/O error" under multiple clients — usually tied
    to old client versions (<2.12.3, no default flock) or `O_DIRECT` alignment,
    but they occur in practice. [so-lustre]
  - **Crashed-client lock retention.** POSIX says `fcntl` locks release
    immediately when the owning process exits; no distributed FS can fully honor
    this. Lustre's lock release "may be delayed if the client crashes" — so a
    dead node can leave a writer-lock stranded, stalling everyone else. [gcp-lustre]
  - **Multi-writer performance is *worse* than single-writer**: Lustre's default
    lock expansion serializes contending writers on a shared file (the
    "Lockahead" paper's motivation). Consistency holds, but throughput craters.
    [lockahead]

### WekaFS (WekaIO) — *plausible, with one critical mount caveat*

- **Kernel VFS driver, not NFS/FUSE.** Marketed as "full POSIX semantics… same
  runtime semantics as a local Linux filesystem (Ext4, XFS)," with "byte-range
  locks," explicitly to run apps that "could not run on NFS shared storage
  because of POSIX locking requirements, MMAP files." [weka-wp] [hitachi]
- **Cache coherency via Linux page cache**: the WEKA client monitors access and
  **invalidates a client's cache when another server touches the same data**,
  so readers/writers across hosts stay coherent. Read-cache and write-back
  cache mount modes. [weka-mount]
- **⚠️ Critical caveat — metadata (dentry) cache is *not* strongly consistent
  across WEKA clients.** WEKA's own docs: "the Dentry cache is not strongly
  consistent across WEKA clients. For applications prioritizing metadata
  consistency, it is possible to configure metadata for strong consistency by
  **mounting without a Dentry cache**." [weka-mount] This matters acutely for
  SQLite: rollback-journal crash recovery depends on the *directory* seeing the
  journal file appear/disappear consistently (SQLite even fsyncs the directory).
  A stale dentry cache can make one client believe a journal exists (or not)
  differently from the writer → botched recovery or corruption. **For SQLite,
  mount WEKA with strong metadata consistency (no dentry cache).**
- **Write-back default**: writes are acknowledged while still in the kernel cache
  and flushed to resilient storage in the background. fsync() should still drain
  it, but a *WEKA client* crash (not the app) can lose acknowledged writes — a
  durability gap local FS doesn't have. [weka-mount]

### Plain NFS (for contrast) — *avoid for shared writes*

- POSIX advisory locking is "known to be buggy or even unimplemented on many NFS
  implementations." Close-to-open (not strict) coherency; timestamp-based
  change detection too coarse (≈1s on Linux servers). `SQLITE_ENABLE_LOCKING_STYLE`
  can silently let mismatched clients use *different* lock types (dotfile vs
  fcntl) → corruption. Read-only mounts skip locking entirely yet see a corrupted
  view when another client writes. [lockingv3] [narkive-nfs] [redhat]

## Why "the locks exist" is not enough

Lustre and WekaFS genuinely provide the byte-range locks SQLite uses — that's
*necessary*. It is not *sufficient*, because SQLite additionally assumes:

- **Strict fsync ordering** (journal-before-DB, dir-fsync) that network stacks
  may relax. [useovernet]
- **Immediate lock release on process exit**, which distributed locking can't
  guarantee (crashed-client stranded locks). [gcp-lustre]
- **Directory-metadata consistency** for journal recovery (the WekaFS dentry
  gap). [weka-mount]
- **Single-machine shared memory** for WAL — unattainable across hosts. [wal]

SQLite's own docs are blunt that these assumptions hold "where an application
is tested" but may not "where it is relied upon," and that the library is not
tested across a network "nor is that reasonably possible." [useovernet]

## Recommendations for tuidos

Our data model is small, local SQLite files: `global.sqlite` (projects +
topics + audit_log) and one `state.sqlite` per project. Two collaboration
models are possible:

1. **Merge model (recommended; matches what we built).** Each machine/site owns
   its local SQLite. Changes are *exported and imported/merged* — the 160-bit
   random ids exist precisely so independently-generated rows never collide on
   merge (git/jj-style). **No live shared mutable file across hosts → none of
   the above hazards apply.** SQLite stays on a local filesystem; the network is
   only a transport for merge payloads, exactly like git objects.
2. **Live shared mutable file across hosts (not recommended).** If some
   deployment truly needs concurrent multi-machine read/write of *one* DB on
   Lustre/WEKA:
   - Use **rollback (`DELETE`) journal**, never WAL (WAL can't cross hosts).
   - Lustre: ensure **`-o flock` on every client** (default on 2.12.3+, but
     verify) and a recent client; expect stranded-lock stalls if a node crashes.
   - WekaFS: mount with **strong metadata consistency (no dentry cache)** and
     treat write-back-cache durability as best-effort.
   - Accept **single-writer serialization** and worse-than-single-writer
     throughput under contention; budget for `SQLITE_BUSY` retries.
   - Treat it as "at your peril": SQLite is untested here and corruption reports
     exist even on Lustre. Prefer the merge model, or a client/server DB
     (Postgres) / a local proxy on the DB host for the shared state. [useovernet]

The merge model is both safer and a better fit for the offline-first,
multi-site identity scheme already in the data model.

## Sources

- [useovernet] SQLite, *SQLite Over a Network, Caveats and Considerations* — https://www.sqlite.org/useovernet.html
- [howtocorrupt] SQLite, *How To Corrupt An SQLite Database File* (§2.1 broken locks; §3.4 close()-lock defenses; WAL more forgiving of out-of-order writes) — https://sqlite.org/howtocorrupt.html
- [lockingv3] SQLite, *File Locking And Concurrency In SQLite Version 3* (POSIX advisory locks; "do not use SQLite on a network filesystem") — https://www.sqlite.org/lockingv3.html
- [wal] SQLite, *Write-Ahead Logging* ("WAL does not work over a network filesystem"; shared-memory wal-index) — https://sqlite.org/wal.html
- [vfs] SQLite, *The SQLite OS Interface / VFS* (unix-dotfile, unix-excl, etc.) — https://www.sqlite.org/vfs.html
- [lustre-faq] Lustre Wiki, *Frequently Asked Questions* (full cache coherence; flock coherent via LDLM, default 2.12.3+; `-o localflock`/`noflock`) — https://wiki.lustre.org/Frequently_Asked_Questions
- [fsx] AWS, *What is Amazon FSx for Lustre?* (POSIX-compliant, read-after-write, file locking, `flock` mount option) — https://docs.aws.amazon.com/fsx/latest/LustreGuide/what-is.html
- [lustre-discuss] lustre-discuss, *Lustre & SQLite* (Andreas Dilger / Oleg Drokin: `-o flock` on all clients; cross-node still risky) — http://lists.lustre.org/pipermail/lustre-discuss-lustre.org/2009-February/004091.html
- [so-lustre] SO, *SQLite "disk I/O error" with multiple readers on Lustre* (use 2.12.3+; fully cache-coherent; IOERR causes) — https://stackoverflow.com/questions/58842374
- [gcp-lustre] Google Cloud, *Managed Lustre POSIX compliance* (fcntl nearly-POSIX; lock release delayed on client crash) — https://docs.cloud.google.com/managed-lustre/docs/posix-compliance
- [lockahead] CUG 2017, *Lustre Lockahead* (default lock expansion serializes shared-file writers; worse than single-writer) — https://cug.org/proceedings/cug2017_proceedings/includes/files/pap141s2-file1.pdf
- [weka-wp] WekaIO, *Architecture White Paper* (kernel VFS POSIX client, byte-range locks, full POSIX semantics, not NFS) — https://www.weka.io/wp-content/uploads/resources/2023/03/weka-architecture-white-paper.pdf
- [weka-mount] WekaIO docs, *WEKA client and mount modes* (page-cache coherence; **dentry cache not strongly consistent**; mount without dentry cache for strong metadata consistency; write-back default) — https://docs.weka.io/5.0/weka-system-overview/weka-client-and-mount-modes.md
- [hitachi] Hitachi Vantara, *Content Software for File (WEKA)* (POSIX VFS driver, byte-range locks, same semantics as ext4/XFS) — https://www.hitachivantara.com/content/dam/hvac/pdfs/white-paper/hitachi-content-software-for-file.pdf
- [narkive-nfs] sqlite-users, *SQLite on NFS cache coherency* (NFSv3 timestamp granularity; LOCKING_STYLE lock-type mismatch; read-only-mount hazard) — https://sqlite-users.sqlite.narkive.com/goWeCaDi/
- [redhat] Red Hat, *Can SQLite and TDB databases be used with NFS?* (no, for locking-based DBs) — https://access.redhat.com/solutions/120733
