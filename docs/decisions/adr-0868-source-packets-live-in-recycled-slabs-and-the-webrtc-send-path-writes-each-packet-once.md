---
id: D868
title: Source packets live in recycled slabs, and the WebRTC send path writes each packet once
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/slab-pool.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/owned-buffer.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/output-arena.ts
  - patches/werift+0.22.9.patch
---

## Context

Passive analysis of the hub's `stream-broker` runner (RssAnon 835-984 MB with
no viewer open; the agents' brokers sit near 200 MB) found two allocation
patterns, not a leak.

1. **`copyOwned` allocated per packet.** D-era work made every source packet
   OWNED (one copy instead of two) with `Buffer.allocUnsafeSlow` per packet:
   12.2k allocations/s of ~1.2 KB, 14.6 MB/s of fresh external memory
   (`copiedPackets` 446 GB since boot). V8 starts a mark-compact whenever
   external memory grows 64 MB, so one ran every ~4 s (`gc=maj75-96 @300s`,
   22-30 % of a core), and the 12k mallocs/s, a fraction retained ~60 s by the
   rings and keyframe caches, fragmented the glibc brk arena (`fragMb`
   104 -> 257 in a day).
2. **Each WebRTC session built three to five buffers per outgoing packet:**
   `RtpHeader.serialize` (`Buffer.alloc`), `Buffer.concat([hdr, enc, tag])` in
   werift's SRTP ciphers, and the repacketizer's `Buffer.from([...])` FU
   headers plus `Buffer.concat` per fragment. werift keeps the last 4096
   (`RTP_HISTORY_SIZE`, patched) outputs of a sender for NACK, so each pinned a
   shared 8 KiB pool slab and the short-lived buffers beside it (~+230 MB brk
   per session).

Raising `initialOldSpaceMb` or tuning malloc would only hide both
("memory ceilings are patches"). The allocations are the cause.

## Decision

**A. Source packets are cut into per-stream slabs and the slab is recycled when
the broker's retaining structures let go of it.** Each `StreamBroker` owns a
`PacketSlabPool` (`stream-broker/slab-pool.ts`). The readers cut each packet
into the pool's active 64 KiB slab (`packetAllocator`, default `copyOwned` for
standalone use) and hand out a `Buffer` view; a packet above 16 KiB gets its
own buffer. The refcount lives on the slab and its owners are the structures
that RETAIN a packet: the source-RTP ring (`captureRtpForPreBuffer` /
trim / reset) and the restreamer's keyframe cache call `holdPacket` /
`releasePacket`, and a WebRTC session holds the last 4096 packets it forwarded
(`HeldPacketWindow`, mirroring werift's NACK history). A sealed slab with no
holds waits `SLAB_QUARANTINE_MS` (2 s: it covers a paced join replay and a
join snapshot taken from the ring before the ring lets go), then its backing
store is MOVED into a fresh ArrayBuffer (`ArrayBuffer.prototype.transfer`,
zero-copy) and the old ArrayBuffer is DETACHED: a view kept past the quarantine
reads empty, never another packet. Anything that must outlive the quarantine
calls `holdPacket`. The ring caps keep charging payload bytes
(`backingStoreBytes` = the view's length, slabs being densely packed); the
diagnostic `BackingTally` sums the distinct ArrayBuffers (`pinnedBackingBytes`),
so a slab pinned by one packet still shows as a whole slab.

**C. The WebRTC send path writes each packet once.** `patches/werift+0.22.9.patch`
makes the SRTP ciphers serialize the RTP header straight into their output and
write header, ciphertext and tag into one slice of a 256 KiB arena (no
`Buffer.alloc`, no `Buffer.concat`); `H264Repacketizer` builds each fragment,
STAP-A and defragmented NAL with one write into an `OutputArena` slice. An
arena is never reused (a full one is left to the GC and lives as long as the
last view), so unlike the slabs it needs no hold protocol. Wire bytes are
unchanged (see Enforcement).

**B is deliberately not done:** `initialOldSpaceMb: 512` in
`packages/addon-pipeline/package.json` stays until production shows the major
GC rate and the pooled-page count after A and C. Removing it is the next step,
decided on that measurement.

## Measured (fixtures, not a live node)

`npx tsx scripts/bench-slab-packets.mts`: 1 000 000 RTP packets (~1.2 KB), 70
streams, ring of 350 packets per stream, read out of a socket chunk exactly as
the readers do:

| | backing stores allocated | major GCs during the run |
| --- | --- | --- |
| `copyOwned` per packet | 1 000 000 | 12-13 |
| 64 KiB slabs | 980 (flat: 200 000 packets also allocate 980) | 0-1 |

Slab size 32 / 64 / 128 / 256 KiB / 1 MiB allocated 1932 / 980 / 553 / 322 / 140
buffers and held about 60 / 61 / 70 / 80 / 140 MB of slabs in service for the
70-stream fixture (quarantine + ring dominate, not the slab slack); 64 KiB keeps
the idle-stream baseline small. `scripts/bench-webrtc-send-path.mts`, JS-level
`Buffer` calls per packet, published werift 0.22.9 and the previous repacketizer
against this change: repacketizer 4.96 -> 0.05, SRTP GCM 2.00 -> 0.00, SRTP
CTR 4.00 -> 2.00 (two 16- and 4-byte on-heap `Buffer.alloc` in the counter and
HMAC helpers, not worth patching). The cipher's own native allocations
(`createCipheriv`, `update()` output, `getAuthTag`) are unchanged: Node has no
output-buffer form of them, which is why this reduces, and does not abolish, the
per-packet allocations of a session.

## Consequences

- **The rule: ANY consumer that keeps a packet view past the synchronous call
  must HOLD it (`holdPacket` / `releasePacket`, `HeldPacketWindow`,
  `writeHeld`) or COPY it.** The detach fence only turns a violation into an
  empty view for JS readers. Native code that already took a pointer still reads
  the recycled memory: a `socket.write` Node queued behind a full kernel buffer
  (seconds, normal for a recorder or a LAN decoder; nothing drops before 2 MiB)
  sends a header promising N bytes followed by recycled bytes, and Node's
  bookkeeping goes wrong too - `Writable.clearBuffer` subtracts `chunk.length`
  as it is when the chunk is dequeued, so a detached chunk (length 0) leaves
  `writableLength` inflated for good (repro in `held-write.spec.ts`: two views
  of one ArrayBuffer, `transfer()`, drain: `writableLength` ends at the second
  chunk's original length). This was found in review of the first commit and
  fixed.
- Holders: the source-RTP ring and the restreamer keyframe cache; the WebRTC
  session's last 4096 forwarded packets (`HeldPacketWindow`); every socket write
  of a packet (`writeHeld`, enforced by `scripts/check-slab-writes-held.ts`).
  Copiers: codec parameter sets in the H.264/H.265 repacketizers, the
  audio-codec session's payload (read after an await), the G.711 fan-out
  payload, and any general retainer (`detachFromPool` copies a slab view: a slab
  view is deliberately NOT "owned" - `EncodedRingBuffer` and friends copy it).
  The 2 s quarantine remains only for the short asynchronous tails (paced join
  replay, jitter buffer), not as a substitute for a hold.
- Slabs in service cost roughly `rate x (ring window + 2 s)` per stream, the
  quarantine being the new term (29 MB hub-wide at 14.6 MB/s).
- The werift patch changes `lib/rtp/src/rtp/rtp.js`, the two ciphers and the
  ESM bundle; a werift upgrade has to re-derive it (`patch-reach.json` markers
  fail closed).
- `[broker-mem]` gains `slabs=<in service>/<free>` and `slabAllocs=<delta>`; the GC census flags field is the one D867 added (`gcFlags=`).

## Passive verification on the hub (no load test)

After deploying, over a quiet period and then a viewer session:

- `[mem] gc=majN` at most 2 per minute (was 12-16);
- pooled pages `v8PageMaps - v8TotalHeapMb/0.25` below ~200;
- `fragMb` flat across viewer sessions;
- RssAnon back to its pre-session value (+/- 20 MB) after a viewer closes;
- `copiedPackets` rate unchanged (the copy still happens) while `slabAllocs`
  per line is about the number of rings (a warm stream allocates none).

Only then is B (dropping `initialOldSpaceMb`) worth trying.

## Enforcement

`slab-pool.spec.ts` (held slabs are never reused under churn; quarantine; a
stale view is detached, not aliased; steady state allocates nothing;
`HeldPacketWindow`), `broker-rtp-ring-slabs.spec.ts` (the broker's ring is
slab-backed, a held snapshot survives 300 s of churn and fails without the
hold), `reader-packets-on-slabs.spec.ts` (the real RFC 4571 reader),
`held-write.spec.ts` (a stalled peer receives every byte, `writableLength` returns to 0; a plain write fails), `slab-view-retainers-copy.spec.ts`, `scripts/check-slab-writes-held.ts`, `srtp-output-golden.spec.ts` and `h264-repacketizer-golden.spec.ts` (digests
recorded from the code before this change: the wire is byte-identical, and the
patched SRTP path makes no `Buffer.alloc` / `Buffer.concat`), and
`scripts/check-patches-reach-production.ts` for the patch markers.
