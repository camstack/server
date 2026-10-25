---
title: N100 VAAPI lease-download EIO (project_lease_download_leak_n100)
status: S1 live — S2 blocked on harvest (2026-10-02); S3–S4 open
date: 2026-10-02
covers:
  - packages/addon-pipeline/src/session-decode/decode-worker-child.ts
  - packages/addon-pipeline/src/session-decode/lease-activity-gate.ts
  - packages/addon-pipeline/src/session-decode/lease-download-rebuild-cap.ts
---

# N100 VAAPI lease-download EIO

## Why

On agent-a (Intel N100 VAAPI), the native-lease full-frame
`hwdownload` path fails with `Failed to add frame to filter` (`EIO` /
`EINVAL`, `hw=true`, mostly 4K). Live forensics in
`decode-worker-child:downloadToSoftware` already distinguish:

| Signature | Meaning |
| --- | --- |
| `filterUses=1` | create-time / first-use mismatch (device/format) |
| fails after many ok uses | poisoned / stale filtergraph (`hw_frames_ctx` drift) |
| EIO at arbitrary uses | load-shed under GPU pressure |

Closing the cached filter and retrying **per failing frame** OOMs the
agent: node-av reclaims VAAPI hw pools only on process exit (live
2026-07-16, ~6 GB RSS in minutes at ~25 rebuilds/s). The escalating
`LeaseActivityGate.disableFor` cooldown (60 s → 600 s) is the OOM
guard, not the cure — one rebuild per cooldown instead of one per
frame. Evidence: `docs/design/2026-08-13-native-lease-two-tier-redesign.md`
§1.3; latch→cooldown harvest 2026-08-08 (93–97% `nativeCropMisses` was
mostly the old latch).

Camera **111** (sala da pranzo) already has a **live**
`detectionStreamProfile=mid` patch (was `high` → `native:main`). That
cuts decode cost and lease pressure on this camera only; default remains
`high`. It is not a VAAPI fix.

## Why code is deferred tonight

Candidate "safe" mitigations are either already done, or not overnight-safe
without more evidence:

1. **Mid default for all 4K cameras** — product-wide quality regression
   (faces / plates / `keyFrame` resolution) with no fleet census of which
   cameras still need `high` for detection. 111 is patched; do not flip
   the schema default without that census.
2. **Prefer non-N100 for 4K lease** — decode is co-located with detection
   (`PlacementService`: detect ⇒ decode). "Prefer Mac/hub for 4K" is a
   placement preference rewrite, not a one-file lease change; it shifts
   load without fixing the GPU path on the node that still receives 4K.
3. **Cooldown retune** — base 60 s / max 600 s already encode the latch
   lesson. Changing them without a fresh `filterUses` / rebuild-count
   harvest on agent-a is guessing.

## Real fix (ordered slices)

Each slice must ship with a bound that a test or live metric can refuse.

### S1 — Bound filtergraph rebuilds in-process (the OOM unit) — SHIPPED

Today a failed download closes the filter and the next armed capture
rebuilds. Under sustained EIO that is still "rebuild once per cooldown".
Prove and enforce:

- **Hard cap** on lease-download filter creates per dial (and optionally
  per process lifetime), with a named refusal when the cap is hit
  (`lease-download-rebuild-cap`) so crops fall back without another
  `FilterAPI.create`.
- **Metric**: `leaseDownloadFilterCreates` next to existing
  `leaseDownloadFilterUses` / forensics line — so a harvest can say
  "rebuilds/h" without correlating stderr by hand.
- Spec: a fake that fails `processAllSync` twice must not create a third
  filter inside one cooldown window.

**Shipped** on `fix/n100-s1-filtergraph-cap`: `LeaseDownloadRebuildCap`
(2 creates/dial), wired in `ensureLeaseDownloadFilter` / forensics /
metrics; disarming spec in `lease-download-rebuild-cap.spec.ts`.

### S2 — Prefer leak-free software path when VAAPI download is sick

When S1's cap trips (or when forensics say `filterUses≥N` then poison),
degrade **native lease download only** to a CPU path that does not open
a new `scale_vaapi` graph — same class as the existing detection
software degrade, but scoped to the lease download so the detection
GPU crop+scale can stay up. Bound: no new VAAPI filter create after
degrade until re-dial / worker recycle.

#### S2 blocked 2026-10-02 (do not force without harvest)

S1 is live on agent-a (`leaseDownloadFilterCreates` on the
session-decode metrics line). A same-night harvest is **not** enough to
ship S2:

| Observation (agent-a, ~24 h / post-S1 window) | Meaning |
| --- | --- |
| Healthy dials report `leaseDownloadFilterCreates:1` | Metric works; cold create paid once |
| ~20 `native lease download failed` lines / 24 h | EIO still happens, mostly pre-S1 or first-create |
| **Zero** metrics samples with `creates:2` / no `lease-download-rebuild-cap` | Cap-trip path never exercised live yet |
| No transfer probe under a failing `processAllSync` | Unknown whether `hwframeTransferDataSync` works when VAAPI `hwdownload` is sick |

**Why code now is risky**

1. **Wrong whole-session degrade.** `degradeToSoftware()` aborts the dial and
   re-dials YUV420P for the *entire* session — that kills GPU detection
   crop+scale. S2 must stay lease-download-scoped; the correct primitive is
   `Frame.hwframeTransferDataSync` (already used in
   `addon-decoder-nodeav` `transferHwFrame`), not `degradeToSoftware()`.
2. **CPU cost without a live trigger rate.** After the create cap trips,
   every armed lease capture would pay a full-res CPU transfer. The
   activity gate still bounds *when* capture runs, but without a measured
   cap-trip / EIO rate we cannot say whether that is rare recovery or a
   sustained N100 memory-bandwidth burn (the failure class that forced
   `LeaseActivityGate` in the first place).
3. **Unproven under the failure mode.** If transfer fails whenever the
   filter fails, S2 is a no-op under EIO and still needs S3 (worker
   recycle). Shipping it before that probe papers over the open question.
4. **Poison threshold `filterUses≥N` is unmeasured.** N without a harvest
   is a guess; do not invent it.

**Unblock criteria (any one session can collect these)**

1. Distribution of `leaseDownloadFilterCreates` under multi-4K lease demand
   (include dials that hit EIO).
2. Count of `lease-download-rebuild-cap` refusals / hour (proves the S2
   trigger fires).
3. One controlled check: after a live `processAllSync` EIO on the lease
   filter, does `hwframeTransferDataSync` on the same surface succeed?

**When unblocked — implementation sketch (not code)**

- Latch `leaseDownloadDegraded` for the dial when
  `LEASE_DOWNLOAD_REBUILD_CAP_REASON` trips (and optionally after the
  second download failure that starts the cooldown).
- In degraded mode, `downloadToSoftware` uses a dedicated SW `Frame` +
  `hwframeTransferDataSync` (clone/copy into an owned frame for the lease
  store — the decoder's reusable transfer frame is not lease-safe).
- Never call `FilterAPI.create` / `ensureLeaseDownloadFilter` while
  degraded; reset the latch on dial start with the S1 cap.
- Do **not** call `degradeToSoftware()`.
- Disarming spec: after the degrade latch, a fake `createFilter` must not
  run again this dial.

### S3 — Worker recycle as the hw-pool reclaim

If node-av truly frees VAAPI pools only on process exit, a dial that
hits S1's cap should schedule a **bounded** worker recycle (one at a
time per node, not a stampede) instead of stacking closed-but-leaked
graphs. Pair with existing decode-budget admission so recycle cannot
admit more workers than the node can hold.

### S4 — Placement only after S1–S3 have numbers

If agent-a still burns rebuild budget on 4K after mid-profile
cameras are stable, then add an explicit placement preference:
"4K `high` detection prefers nodes whose lease-download error rate is
below X". Not before — otherwise we paper over the leak with sticky
affinity.

## Out of scope for this note

- Changing `detectionStreamProfile` default in
  `settings-ui-schemas.ts`.
- Retuning `LEASE_DOWNLOAD_COOLDOWN_*` without a new harvest.
- **Deploying S2+** until the §S2 unblock criteria are met (create-rate under
  EIO, rebuild-cap count/h, transfer-under-EIO probe). S1 metric is live;
  harvest is not yet.

## Acceptance for "project closed"

- agent-a agent RSS stable under multi-4K dials with lease demand
  (no multi-GB climb tied to `native lease download failed`).
- `leaseDownloadFilterCreates` stays within the dial cap under EIO
  injection and under live pressure.
- 1443 (and peers) recover native crops after transient EIO without
  waiting for a full re-dial, without re-entering per-frame rebuild.
