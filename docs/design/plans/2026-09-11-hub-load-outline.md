---
title: Run-down — the hub load, what remains and in what order
---

# Run-down: the hub load

> **Origin.** The session of 2026-09-10/11, opened on "tracks break apart" and
> ended on "why is the hub loaded". Every entry below carries the measurement that
> justifies it: without a number it does not make the list.
>
> **The distinction that organises everything**, and that cost an hour to learn:
> **churn and retention are different economies.** Removing traffic lowers GC and
> not the live set; removing retention does the opposite. And **bytes and messages** are
> themselves two things: bytes feed GC and copies, messages feed
> envelopes and round trips. Each entry declares which of the three it buys.

## State at 2026-09-11, 11:00

```
host          load 22.66 on 20 cores
CamStack      522 % CPU (5.2 cores)   17.9 GiB / 32
  of which    319 %  two decode-worker-child   ← the 61 %
              81 %   hub-main
plugin catalog      ~142 % (1.4 cores)

hub-main      353 MB/min over UDS (was ~470 before D450)
              responses 284 MB  ·  requests 53  ·  events 16
live set      714 MB post-GC, slope zero (was 2,491 when the process died)
loopP99       22 ms (was 593)
```

---

## In progress

| | scope | model |
| --- | --- | --- |
| **D451** | timelapse that declares coverage · hour seal · timeline verification | Opus |
| **D452** | synchronous fork of `native-metrics` · sqlite levers · pass over the leftovers | Sonnet |
| **D453** | remove the park · zygote for the decode workers | Opus |

## Ready in `main`, waiting for a published `@camstack/server`

D437 shell identity · D446 queue measurement · D447 download pump ·
**D448 raw-forward** · D449 flag removal.

Raw-forward **cannot be measured on the hub without shipping**: locally it gave
−57 % of parent CPU per relay and −89 % of GC time. The way out of a bad
release is `rollbackServerUpdate`, which preserves `previousVersion`.

---

## To do, in order

### ~~1. A settings read rebuilds the whole scope~~ — **WITHDRAWN (D454)**

**It was wrong on all three points, and two of them already were when I wrote it.**

- **The mirror already exists**: `addon-post-analysis/.../store/settings-raw-mirror.ts`
  (`RawGlobalStoreMirror` / `RawDeviceBlobMirror`) — single-flight,
  serve-and-revalidate, invalidated in-process by every writer, a declared window plus
  cooldown. **All eight** families of per-device settings
  go through there. There was nothing to build.
- **The bytes are not settings**: 56 consecutive `[mem]` windows measured —
  `sqlite-settings` answers with **9.7-16.9 MB/min**, an average of 2.2 kB per response.
  The settings plane is **~3 %**, not 55 %.
- **The figure came from a 2026-08-29 plan**, where it was *true*. Then the
  keyset walk of `loadPrefixed` and the raw mirror landed. I carried it
  forward thirteen days without re-measuring it, and it pointed at a fix **already
  shipped**. It is exactly the error this document warns against,
  committed in the document itself.

The only true thing in the item was that `device.settings-updated` has neither
emitters nor listeners — and nobody needs it.

### 1bis. Who originates 30-240 MB/min towards `pipeline-analytics` — **the real open item**

hub-main writes **15-376 MB/min** to `pipeline-analytics` (median ~140, ~38 %
of the plane). They are **responses, few and enormous**: 1,523 res for 15 MB in one
window, 1,588 res for 72 MB in another — flat count, bytes ×25.

And in three windows **hub-main's total rx is lower than what it sent to that
single peer**: those bytes cannot be relayed from a child, **hub-main
originates** them. Unproven hypothesis: ~30-260 fleet dumps per minute
would be enough (`deviceManager.listAll` 1.58 MB, `deviceState.getAllSnapshots`
907 kB, `snapshot.getSnapshot` 346-907 kB).

**The tool exists now (D456)**: `socketActions=` +
`socketTopActions=<peer>!<cap>.<method>:<kB>/<calls>:r<raw>/d<decoded>`.
Not yet run on the hub: it will name the method, this record does not name it.

**But two tools that were already there answer half the question.** Of the
2,141 calls/min of analytics, **2,091 (97.7 %) are `(unresolved:
parent-routed)`** — served by hub-main's in-process providers — against 47 that
reach a sibling. A parent-routed call is `decoded` by
construction: raw-forward exists only sibling→sibling. **So of those
144 MB/min practically nothing is opaque: hub-main encodes every byte itself.**
On the cluster the graph (30,588 sibling / 5,387 parent) confirms
`socketFwd=30349/5051` at 1 %.

Hypothesis still a hypothesis: `deviceState` (939/min, parent-routed) carries ~140 of the
144 MB if `settings-store` answers at an average of 2.2 kB — that is ~150 kB of
average response. *Buys: bytes.*

### 1ter. The cost of hub-main is not on the UDS plane — **new, measured (D456)**

50 s profile + `/proc/7/task/*/stat`, 2026-09-11 15:07-15:11:

```
hub-main 135.7 % CPU        main thread 39.6 %  ·  4 V8Worker 95.4 %  ·  libuv 0.6 %
main thread busy 34.8 %     (idle 33 s out of 50)
  20.8 %  Moleculer TCP Parser._write — Buffer.concat + Buffer.from per chunk
  16.3 %  GC (the share on the main thread)
   7.1 %  resolveChildId — linear scan over 39 children for every cap-call-out
   5.9 %  msgpack TOTAL (was 27+6 % in D441: **D448 did what it said**)
```

**70 % of hub-main's CPU is not JS**: it is the concurrent GC marking on
four V8 workers. And the first cost on the main thread is the **cross-node
mesh**, not UDS: the `Parser` re-copies the whole rest of the packet at every
partial chunk — quadratic in the number of chunks of a large message. Neither
of the two is touched by any entry of this run-down.

`resolveChildId` is the next real win on the UDS plane, with the number
next to it: 7.1 %, today larger than all the msgpack put together.

### 2. `stream-broker → audio-codec`: 8,379 calls/min
`pushEncodedFrame` per RTP packet plus `pullPcm` every 40 ms. After D450 the bytes
are small, **the count is not**. D441 option 1: `audio-codec` as an in-process
provider of the stream-broker — no boundary to cross, −223 req/s.

*Buys: messages.* Risk: `addon-pipeline` is the big bundle.

### 2bis. Source bytes on the audio plane — **DONE (D455), not deployed**

D450 had moved the plane to the SOURCE rate and left the FORMAT: the broker
still expanded one G.711 byte into four f32le **before** transport.
Now `AudioRtpDecoder` buffers the ENCODED payload (`format: 'pcmu'|'pcma'`)
and whoever needs floats expands next to itself.

Safe by construction: `subscribeAudioChunks` takes `accept`, and the plane serves
an encoded window **only** to whoever declared that format — absent
means f32le, that is, today's bytes. No deploy order breaks anything.

Measured (`scripts/bench-audio-g711-expand.mts`): the expansion costs 11.57 µs per
one-second window against the 12.31 µs the broker pays today — **moved,
not added**, 15 ms/min of one core for 22 cameras.

**Worth ~45 MB/min out of the 311** (projection, not measurement): it covers only the two legs
**before** the relay. *Buys: bytes.*

### 3. The relay leg: `pipeline-orchestrator → stream-broker`, 6,720/min
PCM crosses hub-main **twice** because the `AudioWindowAccumulator` lives
in the orchestrator, which neither produces nor consumes the audio: it **only
buffers** (chunks of 21–500 ms → windows of ~1 s for the classifier). It stayed there
when the `pipeline` group was dissolved; nobody moved it.

Moving it next to the analyzer removes two legs out of four.

**Re-priced after D455, and the bet was reversed.** The hypothesis was: *if the
source bytes reduce enough, the relay might be worth less than its
risk.* They do not reduce those legs. D455 expands at flush **in the orchestrator**,
so legs three and four still carry f32le: **~98 MB/min, intact** —
more than D455 itself removed.

And the relay is not just the largest remaining item: it is **the reason** the
expansion must happen there. With the accumulator moved into `audio-analyzer`, the
subscriber is the decoder, the `accept` negotiation no longer has a third party
in the middle, and the two surviving legs stay encoded end to end.
Composed: **~196 → ~25 MB/min.**

*Buys: messages **and** bytes.*

### 4. `recorder → settings-store`: 2,234/min
D446 had already measured `loadConfigLastKnownGood` at 29/s with a **36 % miss rate**.
A cache in the caller. It is an addon: it deploys without a release.

*Buys: messages.* Probably absorbed by item 1 if the mirror is shared.

### 6. Binary instead of base64 on the mesh — **new**

The image fields of the caps are declared as **string**, and base64 travels
inside them:

```
frameJpeg:  z.string().optional()      cropJpeg: z.string().optional()
jpeg:       z.string()                 embedding: z.string().optional()  // base64 float32
```

But the mesh serializer is **MsgPack**, and a comment in
`trpc-links.ts:260` already says so: *"Il serializzatore MsgPack gestisce il
binario nativamente — nessun workaround per TypedArray necessario."* [The MsgPack
serializer handles binary natively — no TypedArray workaround needed.]
**We are encoding in base64 to cross a transport that carries binary
natively.** A 2.1 MB JPEG takes 2.8 on the wire; a full-resolution key frame
measured on this hub is **2,824,077 bytes in base64**.

It is worth **~25 % of the bytes** on every cross-node image. **Correction to a figure
cited earlier**: the "~44 % of the copies" held against the *quadratic* parser;
now that D457 has made it linear the saving is simply proportional.
**D457 reduced the value of this item** — it remains right, it is no longer
urgent.

It also applies to **embeddings**, which cross the boundary at every
enrichment.

**Two dependencies, both declared:**
1. it is a **wire-contract change**, on a surface just shipped
   (D455): it must be coordinated, not slipped in;
2. **the size distribution on the mesh is not instrumented.** D457
   names two senders (`getNativeCrop{encodeJpeg}`,
   `runStatelessStep{frameJpeg}`) but says explicitly that it is an
   *enumeration, not a measurement*. D456's per-action census would answer,
   and it is not live yet.

**Do it after the release**, when the census will say whether the senders are two or
whether there is a third that nobody has named.

*Buys: bytes.*

### 7. G.711 is decoded 4 times too quietly — **correctness, not performance**

```
shipped formula:   ((2m + 33) << e) - 33          extremes  ±0.2451
ITU-T:            (((m << 3) + 132) << e) - 132   extremes  ±0.98
```

**Every native G.711 camera has been measured ~12 dB below the true value** since
the native decoder was shipped, and **every audio threshold is calibrated against
that value**. D455 carried it over **verbatim** and pinned the values in a test:
fixing it is a fleet re-calibration, not a side effect of a
job on bytes.

**Operator's decision**, and it has two faces: fix the formula and
recalibrate the thresholds together, or leave it and **write down that this scale
is not real dBFS**. The second is legitimate; silence is not.

### 8. Remove the seeding image entirely — **operator's decision**

Today the shell (docker image, electron app) carries a **seed baked in**:
a `@camstack/server` closure frozen at build time. `applyServerUpdate`
updates the code but **never touches the image**, so the seed drifts —
measured on 2026-09-11: code `1.2.270`, seed `1.2.200`, `imageContract:
behind-patch`. Starter, entrypoint and boot fallback remain the old ones, and
if the container fell back to the seed it would start with the frozen version.

**The decision, verbatim:** *"vorrei veramente eliminassimo completamente
l'immagine di seeding. I wrapper devono scaricare l'ultima versione disponibile
in ogni caso, a limite possiamo mantenere una versione minima/massima di
supporto a quella specifica versione del wrapper, rimuovendo il link tra server
e wrapper. Così come rimuovere i seed version dalla UI e fallback."* [I would
really like us to eliminate the seeding image completely. The wrappers must
download the latest available version in any case; at most we can keep a
minimum/maximum version supported by that specific wrapper version, removing the
link between server and wrapper. Likewise remove the seed versions from the UI
and fallback.]

That is: **the shell stops carrying the server.** It carries a launcher and a
compatibility range (`minServer` / `maxServer`), and at boot it **downloads**.
`seedVersion` disappears as a concept: from the UI, from the boot fallback, and
from the `imageContract` that exists only to measure the drift between the two.

**Two clarifications from the operator, in order.** The first: *"nelle immagini
wrapper includiamo durante la creazione l'ultima versione disponibile in quel
momento, poi aggiorna automaticamente al primo start... ma questa non deve
essere un fallback seed."* [in the wrapper images we include, at creation, the
latest version available at that moment, then it updates automatically on first
start... but this must not be a seed fallback.] The second, which revises it:
*"magari possiamo tenere il seed come fallback in momenti di crisi, baked con
l'immagine come ora. **Ma non deve figurare da alcuna parte**, soprattutto
quando si parla e si menziona che il seed e' troppo vecchio etc e che si deve
aggiornare."* [maybe we can keep the seed as a fallback in moments of crisis,
baked with the image as now. **But it must not appear anywhere**, especially
when talking about and mentioning that the seed is too old etc. and must be
updated.]

**Final position: the seed STAYS as a mechanism, DISAPPEARS as a topic.**

| | stays | disappears |
| --- | --- | --- |
| the closure baked into the image | yes, unchanged | — |
| last-resort boot in a crisis | yes | — |
| `seedVersion` in the UI (Cluster page) | — | yes |
| `imageContract` and its `behind-patch` / `behind-series` verdicts | — | **all of it** |
| the HA sensor `imageContractState` | — | yes |
| the `root-update-service` warning about drift | — | yes |
| *"ricrea il container per convergere"* [recreate the container to converge] | — | yes |

`imageContract` exists **only** to measure the drift between seed and release: it is
exactly the topic that must stop existing, so it goes away
entirely, not silenced.

**The shell-server link breaks at the level of the CONTRACT**: no longer "il tuo seme e' vecchio" [your
seed is old], but `minServer` / `maxServer` — a compatibility range declared by
the shell, which must **refuse, declaring it,** if the server is out of range, never
start and hope.

**One thing NOT to lose in the silence.** Invisible means *do not nag*,
not *do not say*. If the system **really starts from the seed**, that is a
rare and serious event and must be said loudly: `CLAUDE.md` says that a branch that drops work
silently is a defect, and running on a frozen closure without anyone
knowing is the same thing. So: **zero lines about drift, one
loud line about booting from the seed.**

**Still to resolve:** who declares and who verifies `minServer`/`maxServer`, and
what an out-of-range shell does. And the four surfaces above must be removed
**together** — removing just one would leave a leftover that reads as
verification, and four were found in this session.

**It also applies to electron**, which has the same seed and in addition an auto-updater
of its own (GH Releases, `autoDownload` + `autoInstallOnAppQuit`).

## Open without an owner

- **~750 MB of unattributed live set** on hub-main, and the common owner of the
  63 MB/min of ArrayBuffer (episodic: 17:26→18:31 at +20 MB/min, 22:20→23:32 at
  60–85 MB/min up to 4,968 MB, released between two probes). D444's census
  now arms itself at a sustained 512 MB: **the next episode names
  itself.**
- **What started at 07:25** on 09-11: first slow `set` of the day,
  no job in the logs.
- **`sqlite-settings` restarted twice** (01:32, 05:33) without anyone
  having looked at why.
- **`3219` / `3216`** ("Terminal"): `resolvePipeline` gives `steps: []` — correct,
  the pipeline is disabled on purpose — but the status declares them
  `armed:on-motion`. Cosmetic inconsistency: **zero dispatches out of 410 in an hour**,
  no waste.
- **Viewer**: the app must **close** the subscriptions when going to the background,
  not just stop reading (client side of D444; the keepAlive now
  disconnects it in ~40 s). And `EventsScreen.tsx:200` `EMPTY_CLASSES` is a fallback
  by now inert after D449.

## Verifications pending

- ~~Pinch~~ **verified by the operator on 2026-09-11: it works.** The
  **tablet layout** remains: a rotation is enough, the `theater:layout` report arrives
  by itself on Loki.
- **Raw-forward on the hub**: requires the release.
- **Clean audio before/after**: the "before" of 08:40 fell out of the window
  of the docker log. To be redone on `socketTx` with ten clean minutes.

---

## Two lessons of method, worth more than half of the entries above

**The instrumentation is almost always already there: seven times out of seven in a
session.** `heap-watch` emitted the memory breakdown every 2 s —
10,764 samples already in the log. `query-profiler` had been printing the sqlite stalls for 48
hours. The viewer logs had always reached the hub. The tablet layout
report was there, with that same evening's numbers. And the measurement that overturned
the work on the zygote was **a comment in the file itself** (D282: the park is
net-negative by 25×). **Search before building.**

**A short window does not prove a stable condition.** `logs.query` is a ring of ~25 minutes;
the docker log rotates by size (~10–13 h) and **does not
cover the life of the process**. Two numbers repeated for hours in this session —
"20 % of the windows are starved" and "GC is at 29.5 %" — were transients of
storms already repaired. Seven elegant hypotheses were burned on insufficient
evidence, five of them the coordinator's.

## A rule of orchestration, paid for on 2026-09-11

**Whoever works in a worktree commits. The coordinator merges into `main` and
deploys from there.**

Three agents deployed `addon-pipeline` each from their own worktree:
each shipped its *own* view of the package and **silently undid**
the work merged after it branched off. D450 stayed out of
production for three hours while the coordinator reported it as active.
No error, no warning: the package is simply rewritten
backwards.

**And a conflict on a SOURCE is read, not resolved with `--theirs`.**
That habit comes from generated files, where it is harmless. On
`local-child-registry.ts` it deleted D456 from a merge of D457, and only the
typecheck revealed it: the two sides were **complementary, not alternative**.
