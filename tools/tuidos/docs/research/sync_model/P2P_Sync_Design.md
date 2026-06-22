# P2P sync design — discovery/relay nodes + mesh data plane

> Goal: every node can serve every other (no single data authority), with a few
> always-on nodes acting as a *discovery/relay* service. This is the
> Syncthing/libp2p/Tailscale pattern. It evolves the earlier "git-style hub"
> (a hub is the degenerate single-node case) by separating rendezvous from data.

## The converged pattern (control plane ≠ data plane)

All three reference systems split a tiny, always-on **control plane** from a
meshed, end-to-end-encrypted **data plane**:

- **Control plane (discovery/coordination):** a small set of always-on nodes that
  help peers find each other (a peer-id → address directory), exchange keys, and
  relay introductions. It carries **metadata, not data** — an outage only delays
  rendezvous; it cannot corrupt or lose state.
- **Data plane (mesh):** every node holds a full copy; any node serves any other;
  traffic is end-to-end encrypted so relays can't read it. No single data
  authority.

Tailscale states it bluntly: *"Hold on, are we back to hub-and-spoke again? Not
exactly. The so-called 'control plane' is hub and spoke, but that doesn't matter
because it carries virtually no traffic. It just exchanges a few tiny encryption
keys and sets policies. The data plane is a mesh."* [ts-how] This is precisely
"run some nodes constantly as a discovery service."

## The three references

### Syncthing — closest functional analog (P2P folder sync)
- **Peer id = SHA-256 of the device's X.509 cert** (ECDSA keypair, generated at
  first start). Used for address resolution, auth, and the accept-allowlist.
  [st-deviceids]
- **Discovery:** *local* (mDNS/LAN broadcast) + *global* (HTTPS announce/query to
  a discovery server; the announcing device's id is *deduced from its TLS cert*,
  not sent in the payload; the discovery server is certificate-pinned).
  [st-globaldisco] [st-security]
- **Transport:** TCP, QUIC (built-in STUN), and **Relay** (a separate always-on
  `strelaysrv` fallback). The relay is oblivious to the still-TLS-encrypted BEP
  traffic — pure forwarder, no MITM. [st-relay]
- **BEP (Block Exchange Protocol):** pairwise — connect, exchange ClusterConfig +
  Index (file metadata + block hashes), request missing blocks. *"The union of
  all files in the local models, with files selected for highest change version,
  forms the global model"* — i.e. highest-version-wins, CRDT-flavored. [st-bep]
- **Security:** TLS 1.3, mutual, preshared cert fingerprints (Device IDs) as the
  allowlist. [st-bep] [st-security]

### libp2p — canonical P2P stack (has a JS/TS impl, relevant for Bun)
- **PeerId** from a keypair (Ed25519/RSA); addresses are **multiaddrs**.
- **Discovery:** `@libp2p/bootstrap` (well-known bootstrap peers on boot),
  `@libp2p/kad-dht` (Kademlia DHT — a self-query finds the closest peers),
  `@libp2p/mdns` (LAN), pubsub peer discovery. [lp-config] [lp-discovery-ex]
- **Circuit Relay v2** (`p2p-circuit`): a relay peer forwards traffic between two
  peers that can't connect directly (TURN-like); reservations + limits.
  [lp-circuit]
- **Secure channels:** Noise (`@chainsafe/libp2p-noise`) / TLS; stream muxers
  yamux/mplex; **gossipsub** for production pubsub. [lp-js]
- `@libp2p/*` packages exist for TS/JS — a Bun tool could adopt the stack rather
  than reimplement it. [lp-js]

### Tailscale — cleanest control/data split
- **Coordination server** = *"essentially a shared drop box for public keys"*:
  auth, device discovery, key distribution, ACL/policy, NAT-traversal
  coordination, DERP-region selection. **Carries virtually no traffic.**
  [ts-how] [ts-planes]
- **Data plane** = WireGuard mesh, end-to-end encrypted; **private keys never
  leave the node**, so relays can't decrypt. [ts-how]
- **DERP** (Designated Encrypted Relay for Packets): TURN-like fallback relay for
  when NAT traversal fails; forwards already-encrypted packets; client gets a
  DERP map from coordination, picks a low-latency "home" DERP, caches it so it
  survives coordination-server downtime. [ts-derp] [ts-derp-src]
- **NAT traversal:** STUN + a `disco` protocol + ICE-like probing; path priority
  Direct UDP → peer relay → DERP. [ts-endpoint]

## Mapped to tuidos

The CRDT **merge layer is unchanged** (160-bit ids, append-only `audit_log`,
`archived_at` tombstones, LWW, deterministic union-by-id) — P2P only changes the
*transport topology* (who serves whom, how peers rendezvous).

- **Peer identity & trust.** Each node gets a local Ed25519 keypair on first run
  (like Syncthing's device key / Tailscale's node key); the public key (or its
  hash) is the peer id. You sync only with peer ids you've **accepted**
  (allowlist). Discovery routes; it does not vouch for trust — same stance as
  Syncthing's accepted-devices / Tailscale's tailnet ACL. [st-security]
- **Control plane — discovery/relay nodes (the always-on service).** A few
  well-known nodes keep a peer-id → address directory (Syncthing global discovery
  / Tailscale coordination) and relay traffic when peers can't connect directly
  (Syncthing relay / libp2p circuit-relay / DERP). Carries **routing + keys, not
  data**. Peers cache the directory so a discovery outage only delays rendezvous.
- **Data plane — P2P mesh.** Every node holds the full log; any node serves events
  to any other (no data authority — the CRDT merge is symmetric). Sync is
  BEP-style pairwise pull (exchange log heads/seqs, pull missing events by id,
  merge locally); gossip/gossipsub is the scale/liveness upgrade. End-to-end
  encrypted; relays are oblivious.
- **Live DB stays local.** Node-local SQLite, WAL + `busy_timeout` +
  `BEGIN IMMEDIATE` for intra-node multi-writer (one tmux). The shared network
  `$HOME` is **not** the live DB (locks/WAL shared-memory unsafe there —
  `SQLite_Over_HPC_Filesystems.md`); it can be a dumb fallback store at most.

### HPC specifics (why this fits)
- **Login node = the always-on discovery/relay node.** Compute nodes usually
  can't accept inbound (firewall/no public IP), so they connect *outbound* to the
  login node and sync through it as a relay — exactly the relay fallback case.
- **Intra-node (tmux):** no network at all — local DB + WAL.
- **Cross-site:** a public discovery/relay node (self-hosted or shared) for
  rendezvous; sites sync direct or via relay.

### Relationship to the git-style hub
A single always-on node that is discovery + relay + the sole store *is* the
git-style "hub" — a valid minimal deployment. P2P **separates** rendezvous from
data so any peer serves, removing the single data SPOF. The hub and the shared
`$HOME` dumb store remain valid fallback transports; P2P is the generalization.

## Implementation options (TigerStyle: start minimal)

1. **Minimal Syncthing-style** (hand-built): Ed25519 keypair + peer-id allowlist;
   a discovery node as an HTTPS/peer-id directory; pairwise TCP+TLS pull of the
   log; an optional relay (oblivious TLS forwarder). Smallest dep surface; you
   own NAT traversal (STUN + relay fallback) and auth.
2. **Adopt libp2p** (`@libp2p/*`): PeerId, multiaddr, bootstrap/KadDHT discovery,
   circuit-relay-v2, Noise, gossipsub — batteries-included NAT traversal + relay
   + pubsub. Heavier dependency (many packages, crypto, muxing, DHT), but avoids
   reimplementing the hard parts (NAT traversal, secure channels).

Recommendation: design to the **minimal pattern**, and reach for libp2p only when
hand-rolled NAT traversal/auth outgrows simplicity. The merge layer and the
transport are decoupled, so the choice is reversible.

## Trade-offs (honest)

- **Complexity.** P2P + discovery + relay + NAT traversal + crypto is more
  machinery than a dumb hub — a real TigerStyle tension, mitigated by starting
  minimal and deferring libp2p.
- **Eventual consistency is unchanged.** LWW still discards a concurrent
  conflicting write to the same field; reads stay stale until sync. P2P changes
  *who serves whom*, not the merge semantics.
- **Relay sees metadata, not content.** End-to-end encryption means a relay learns
  *who* talks to *whom* and volume, but not the data. Run your own relay for
  privacy (Syncthing/Tailscale both allow self-hosted relays). [st-relay] [ts-derp]
- **Discovery is a soft SPOF for rendezvous only** (never for data) — mitigate
  with a few discovery nodes + peer-side directory caching. [ts-derp]
- **Trust is explicit.** Discovery doesn't authenticate peers for you; the
  allowlist of accepted peer ids does (mutual auth at connection, like Syncthing).
  [st-bep]

## Sources

- [st-deviceids] Syncthing docs, *Understanding Device IDs* (keypair; id = cert fingerprint; address/auth/allowlist) — https://docs.syncthing.net/dev/device-ids.html
- [st-globaldisco] Syncthing, *Global Discovery v3* (HTTPS announce/query; id deduced from TLS cert; cert pinning) — https://docs.syncthing.net/specs/globaldisco-v3.html
- [st-security] Syncthing, *Security* (TLS 1.3; fingerprint allowlist; discovery/relay privacy) — https://github.com/syncthing/syncthing/blob/main/man/syncthing-security.7
- [st-relay] Syncthing, *Relay Protocol v1* (oblivious forwarder; BEP-over-relay upgrades to TLS; forward secrecy) — https://docs.syncthing.net/specs/relay-v1.html
- [st-bep] Syncthing, *Block Exchange Protocol v1* (ClusterConfig + Index; highest-change-version union; mutual TLS) — https://docs.syncthing.net/specs/bep-v1
- [lp-js] libp2p/js-libp2p (PeerId, transports, Noise, yamux, bootstrap/kad-dht/mdns discovery, gossipsub, circuit-relay) — https://github.com/libp2p/js-libp2p
- [lp-config] js-libp2p CONFIGURATION (bootstrap, kad-dht, mdns, circuitRelayServer/transport, Noise, identify) — https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md
- [lp-discovery-ex] js-libp2p example, *Discovery Mechanisms* (bootstrap→DHT self-query; mDNS; pubsub discovery) — https://github.com/libp2p/js-libp2p-example-discovery-mechanisms
- [lp-circuit] libp2p, *Circuit Relay* (p2p-circuit; TURN-inspired; relay target reservation) — https://libp2p.io/docs/circuit-relay/
- [ts-how] Tailscale, *How Tailscale works* (coordination = public-key drop box; control plane hub-and-spoke carries no traffic; data plane mesh; private keys never leave node; DERP fallback) — https://tailscale.com/blog/how-tailscale-works
- [ts-planes] Tailscale docs, *Control and data planes* (coordination: discovery, key distribution, NAT traversal, DERP selection; data: WireGuard mesh) — https://tailscale.com/docs/concepts/control-data-planes
- [ts-derp] Tailscale docs, *DERP servers* (TURN-like fallback; relays encrypted packets, can't decrypt; clients cache DERP map) — https://tailscale.com/docs/reference/derp-servers
- [ts-derp-src] tailscale/tailscale `derp` (packets addressed by curve25519 keys; relays disco + encrypted WireGuard; regional mesh) — https://github.com/tailscale/tailscale/tree/main/derp
- [ts-endpoint] DeepWiki, *Endpoint Discovery and NAT Traversal* (STUN; disco protocol; path priority Direct → peer relay → DERP) — https://deepwiki.com/tailscale/tailscale/4.3-endpoint-discovery-and-nat-traversal
