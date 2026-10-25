/**
 * Decode-worker CHILD — the worker class. Its process entry (instantiation,
 * signal and IPC wiring) is `decode-worker-main.ts`, the file that is forked;
 * the class lives here, free of process side effects, so a test can construct
 * it (D652). Epic C P1, Task 2.
 *
 * This is the whole program run by a per-session `child_process.fork`
 * that the pipeline-runner's session-decode coordinator (Task 3) spawns and
 * tears down on session end, so the OS reclaims the VAAPI/GPU decode pool by
 * process exit (Task 0 live-validated that reclaim-by-exit works — node-av
 * does not release the hw_frames_ctx pool on `dispose()` alone). It decodes
 * with node-av in-process and hands decoded frames to its parent as a
 * request/response PULL over its own dedicated fork IPC channel. Frames
 * NEVER touch `/dev/shm` — no shm sink is ever constructed here.
 *
 * ‼ SANCTIONED RAW IPC — READ BEFORE "FIXING" THIS FILE ‼
 * CLAUDE.md rule #8 forbids `process.send`/`process.on('message')` for
 * BUSINESS LOGIC — that rule governs cross-ADDON traffic, which must travel
 * over the UDS cap/event channel (`LocalChildRegistry`/`LocalChildClient`)
 * instead of raw IPC. This file is NOT a second addon: it is a private
 * worker directly forked by the pipeline-runner addon, exactly like the
 * Python inference pool's own subprocess. The Epic C P1 plan's Global
 * Constraints explicitly carve this out — "a directly-forked worker child
 * talks to its parent over its own IPC channel (this is NOT a cap call and
 * NOT `$process`)". Raw `process.on('message')` / `process.send` are the
 * correct, sanctioned mechanism for this specific file only.
 */

import type { HwAccelBackend } from '@camstack/types'
import { hostExternalEntryUrls } from '../shared/host-external-import.js'
import { getSharp, type SharpFactory } from '../shared/lazy-sharp.js'
import {
  colorConvertFilterOptions,
  colorProvenanceLine,
  type DecodeScalePath,
  type ResolvedSourceColor,
  resolveSourceColor,
  sourceColorKey,
} from './color-conversion.js'
import {
  isFullFrameRegion,
  type ResizeTarget,
  type ResolvedNativeCrop,
  type ResolvedRegion,
  resolveCropRegion,
  resolveNativeCropGeometry,
  resolveResizeTarget,
} from './crop-geometry.js'
import { FrameSlot, type FrameSlotReply } from './frame-slot.js'
import { LeaseActivityGate } from './lease-activity-gate.js'
import { LeaseAdmissionLedger } from './lease-admission-ledger.js'
import { PendingMarkHold } from './pending-mark-hold.js'
import {
  LEASE_DOWNLOAD_REBUILD_CAP_REASON,
  LeaseDownloadRebuildCap,
} from './lease-download-rebuild-cap.js'
import { type DialMediaClock, mediaClockForDial, mediaWallClockOf, ptsToMs } from './media-clock.js'
import { NativeFrameRing } from './native-frame-ring.js'
import { formatNativeLeaseKnobs, type WorkerLeaseKnobs } from './native-lease-knobs.js'
import { type SessionHwaccelOffer, sessionDecodeCandidates } from './session-hwaccel.js'
import { type LeasedNativeFrame, NativeLeaseStore } from './native-lease-store.js'
import { NATIVE_TILE_PADDING_RATIO, resolveNativeTileRegion } from './native-tile-geometry.js'
import { type NativeTile, NativeTileStore } from './native-tile-store.js'
import { attemptTileServe, PendingCuts, type PendingCutWait } from './pending-cuts.js'
import {
  buildLeaseDownloadDescription,
  leaseDownloadFilterKey,
  nativeCropScalerKey,
  resolveRgbCropSource,
  retainedFrameBytes,
} from './pinned-rgb-crop.js'
import {
  type NativeCropSourceFormat,
  type PlanarCropKind,
  resolvePlanarCropSource,
  softwareRoiKind,
} from './planar-crop-source.js'
import { PreRollBurst, planPreRollWithinHold } from './pre-roll-burst.js'
import { PreRollSettleTracker, type PreRollSettleOutcome } from './pre-roll-hold-ledger.js'
import { OutboundSendTracker } from './bounded-exit.js'
import { NativeDisposer } from './native-disposer.js'
import { inputCloseAfterLoop, releaseFrameAfterStop } from './decode-loop-policy.js'
import { openPullDemuxer } from './pull-demuxer-open.js'
import { partitionSceneTile, planFrameCuts, selectRetainedTile } from './scene-tile.js'
import { cutSubjectTiles, type RawSubjectTile } from './subject-tile-cut.js'
import { describeToBufferMiss } from './to-buffer-miss.js'
import type {
  FrameImageOptions,
  VideoFrameGenOptions,
  VideoFrameSource,
} from './video-frame-generator.js'
import {
  isWorkerRequest,
  logLevelForLine,
  type NormalizedBbox,
  type WorkerDialTiming,
  type WorkerLogLevel,
  type WorkerReply,
  type WorkerRequest,
} from './worker-protocol.js'

// Lazy-load node-av: mirrors decoder-nodeav's convention (avoid a hard
// dependency at import time / bundler hazards with the native binding).
type NodeAvModule = typeof import('node-av')
type NodeAvConstants = typeof import('node-av/constants')
// Frame has a public constructor, so InstanceType names it directly.
// Demuxer/Decoder/HardwareContext have PRIVATE constructors behind static
// factories — InstanceType can't name those; derive from the factory's
// return type instead (same trick as nodeav-decoder-session.ts).
type NavFrame = InstanceType<NodeAvModule['Frame']>
type NavDemuxer = Awaited<ReturnType<NodeAvModule['Demuxer']['open']>>
type NavDecoder = Awaited<ReturnType<NodeAvModule['Decoder']['create']>>
type NavHardwareContext = NonNullable<ReturnType<NodeAvModule['HardwareContext']['create']>>
type NavScaler = InstanceType<NodeAvModule['SoftwareScaleContext']>
// FilterAPI has a PRIVATE constructor behind `create()` — derive the instance
// type from the factory return (same trick as NavDemuxer/NavDecoder above).
type NavFilterApi = ReturnType<NodeAvModule['FilterAPI']['create']>
type NavPixFmt = NodeAvConstants['AV_PIX_FMT_RGB24']

/**
 * A native frame retained in the RAM {@link NativeLeaseStore}: a SOFTWARE
 * (system-memory) YUV420P node-av frame plus its resident byte estimate. HW
 * frames are downloaded to this shape before leasing (see
 * {@link DecodeWorkerChild.captureNativeFrame}); software frames are leased
 * directly. Cropped with the leak-free {@link DecodeWorkerChild.nativeScaleCropToBuffer}.
 */
interface LeasedNavFrame extends LeasedNativeFrame {
  readonly frame: NavFrame
}

/** Wrap a software YUV420P frame as a lease entry (byte size ≈ w×h×1.5). */
function toLeasedNavFrame(frame: NavFrame): LeasedNavFrame {
  return {
    frame,
    byteLength: retainedFrameBytes(frame.width, frame.height, false),
    free: (): void => frame.free(),
  }
}

/**
 * Wrap a software RGB24 frame as a lease entry (byte size = w×h×3) — the
 * `pinnedRgbCrop` path. Kept separate from {@link toLeasedNavFrame} so the
 * flag-off YUV420P wrap is untouched.
 */
function toLeasedRgbNavFrame(frame: NavFrame): LeasedNavFrame {
  return {
    frame,
    byteLength: retainedFrameBytes(frame.width, frame.height, true),
    free: (): void => frame.free(),
  }
}

/** Re-dial backoff on a transient dial error/EOF (mirrors the decoder's PULL_REDIAL_MS). */
/**
 * RSS at which a decode worker is reported anomalous.
 *
 * Chosen from the incident rather than from theory: on 2026-08-05 the healthy
 * fleet sat at 1.1-1.3 GB per worker while the one that broke the host reached
 * 4.9 GB. 2 GB is clear of the normal band and well below the point where it
 * costs anyone anything.
 */
/**
 * Slice threads per filter GRAPH.
 *
 * libavfilter sizes its own pool to the core count, independently of the codec
 * threads, and a worker builds two to six graphs (`hwFilter`,
 * `nativeCropHwFilter`, the native-lease download, the full-frame download).
 * On this 20-core hub that was ~15 threads EACH — measured 2026-09-18 — for
 * graphs whose output is a 320x180-class view after `scale_vaapi`/`hwdownload`.
 * They did nothing a measurement could see, and the container's pid cgroup
 * counts every one against a 2048 ceiling it was actively refusing at.
 */
const FILTER_THREADS = 1

/**
 * Codec threads on the SOFTWARE decode fallback.
 *
 * Not 1: without hardware a 4K stream genuinely is a parallel job, and this
 * path is what runs when VAAPI is unavailable in the runner. Four is enough to
 * keep up at the rates this fleet decodes at while staying two orders below the
 * per-core default that made the worker the largest variable thread holder in
 * the container.
 */
const SOFTWARE_DECODE_THREADS = 4

const WORKER_RSS_WARN_MB = 2048

const REDIAL_MS = 3000

/** How often the worker emits its `framesDecoded/framesSkipped/deliveredFps` line. */
const METRICS_INTERVAL_MS = 10_000

/**
 * Wall-clock ceiling on one pre-roll catch-up burst.
 *
 * A burst is a race against the live edge it is trying to get ahead of. Two
 * seconds in, the decoder has either caught up (the burst ended on its own) or
 * something is wrong — a cold GPU, a node under load, a camera whose GOP is
 * longer than its history — and continuing to spend inference on footage that
 * is now three or four seconds stale buys an operator nothing while a live
 * frame waits. The frame budget bounds the WORK; this bounds the WINDOW in
 * which that work is still worth doing.
 */
const PRE_ROLL_BURST_MAX_WALL_MS = 2_000

/**
 * Hard cap on the native-frame retention ring (native-res crop feature). Kept
 * DELIBERATELY TINY — its only job is to cover the detection→crop latency
 * (typically 1-4 frames), NOT the full shm ring depth. On the HW path every
 * retained slot pins a GPU/VAAPI surface out of the decoder pool (the historic
 * leak site), so the cap MUST stay small; a miss is free (caller falls back to
 * today's detection-frame crop). Override with `CAMSTACK_SESSION_NATIVE_CROP_RING`
 * (0 disables retention entirely); clamped to [0,4], default 2.
 *
 * **Deliberately NOT an operator setting** (unlike the three lease knobs, which
 * became cluster-wide `pipeline-orchestrator` settings on 2026-08-07). Every
 * slot here pins a GPU/VAAPI surface out of the decoder's own pool, and this is
 * the historic leak site — a value large enough to look useful in a settings UI
 * is a value large enough to starve the decoder, and the failure shows up as a
 * camera at 0 fps rather than as memory pressure anyone would trace back to a
 * slider. The ring is also only reachable at all when the lease is DISABLED
 * (budget 0), so exposing it would offer a knob that does nothing in every
 * default configuration. It stays an env-var escape hatch for the person
 * debugging the lease itself.
 */
const NATIVE_RING_CAP = (() => {
  const raw = Number(process.env['CAMSTACK_SESSION_NATIVE_CROP_RING'])
  if (!Number.isFinite(raw)) return 2
  return Math.min(4, Math.max(0, Math.floor(raw)))
})()

/**
 * The native-lease knobs — hold depth, hold RAM ceiling, demand window,
 * admission mode, subject-tile budget, scene-tile budget — ARRIVE ON `start`
 * (`WorkerRequest.lease`, D453). They are **operator settings** living on
 * `pipeline-orchestrator`'s cluster-wide globals; the pipeline-runner reads
 * them and resolves `setting > env > default` in ITS process
 * (`native-lease-config.ts`), and this worker builds its stores from the
 * resolved values in {@link DecodeWorkerChild.handleStart}, before the first
 * packet. Until then it retains nothing ({@link UNSTARTED_LEASE_KNOBS}).
 *
 * Nothing here reads the environment for them any more. The child used to,
 * from `*_SETTING` vars the parent wrote at fork — which needed the Zod schemas
 * (the whole `@camstack/types` index) inside this bundle and cost every fork
 * ~130 ms and ~140 MB, measured; and it bound a worker to the knobs it was
 * FORKED with, which a pre-forked worker (`decode-worker-pool.ts`) cannot be.
 * The values AND their sources are logged once per session at `start`.
 *
 * What each knob means, in the store it sizes:
 * - `budgetMb` — hard RAM ceiling (bytes) for the native-frame HOLD store, the
 *   OOM ceiling and since 2026-08-13 nothing else; `holdFrames` is what decides
 *   how much is held. `0` DISABLES the hold and falls back to the
 *   {@link NATIVE_RING_CAP} GPU ring.
 * - `holdFrames` — how many delivered frames are HELD at once, each waiting for
 *   its own detection result. The ordinary exit is `cutTiles` /
 *   `releaseNativeLease`; this bound only stops a runner that stopped answering
 *   from pinning RAM, and every frame it drops is counted (`holdOverflow`).
 * - `tileBudgetMb` — the SUBJECT TILE store, what survives a frame. `0` turns
 *   tiles off and restores the pre-2026-08-13 miss profile.
 * - `sceneBudgetMb` — the SCENE TILE store, one JPEG of the whole native frame
 *   per detection-bearing frame, the only thing that can answer a FULL-FRAME
 *   request after the hold ends. Separate from the subject budget so a key
 *   frame can never evict a face tile. `0` disables the rung.
 * - `activityMs` — the {@link LeaseActivityGate} demand window: eager per-frame
 *   native downloads run only within it. `0` disables the GATE (always-on eager
 *   capture) — it does not disable retention.
 */
const MB = 1024 * 1024

/**
 * What a worker holds BEFORE a session claims it: nothing. Hold off (`budgetMb`
 * 0 routes to the GPU ring, whose cap is env-only), tiles off, scenes off, the
 * gate open only because there is nothing behind it to open. Not the shipped
 * defaults on purpose — those live in `@camstack/types`, which this bundle no
 * longer carries, and a pre-forked worker that silently held the defaults would
 * be a worker with a configuration nobody handed it.
 */
const UNSTARTED_LEASE_KNOBS: WorkerLeaseKnobs = {
  values: {
    holdFrames: 1,
    budgetMb: 0,
    activityMs: 0,
    admission: 'inferred',
    tileBudgetMb: 0,
    sceneBudgetMb: 0,
  },
  sources: {
    holdFrames: 'default',
    budgetMb: 'default',
    activityMs: 'default',
    admission: 'default',
    tileBudgetMb: 'default',
    sceneBudgetMb: 'default',
  },
}

/**
 * How long a subject tile is served. A TTL is honest HERE and dishonest on the
 * hold: nothing is waiting on a tile, it is speculative retention against a
 * request that may never come. Sized an order of magnitude above the measured
 * ask age (2.2-9.9 s on this cluster) because it can be — a tile is ~60-120 KB.
 * Env-tunable for a bisect; not an operator knob, because the RAM it costs is
 * already the operator's knob.
 */
const NATIVE_TILE_TTL_MS = (() => {
  const raw = Number(process.env['CAMSTACK_SESSION_NATIVE_TILE_TTL_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000
})()

/**
 * Most tiles cut from ONE frame, highest-confidence first (the runner orders
 * them). The bound exists because the cut runs on the decode worker between two
 * pulls: a frame that detected twenty subjects must not turn one late crop into
 * twenty encodes. Anything past it is counted, not silently dropped.
 */
const NATIVE_TILE_MAX_PER_FRAME = (() => {
  const raw = Number(process.env['CAMSTACK_SESSION_NATIVE_TILE_MAX_PER_FRAME'])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4
})()

/** JPEG quality for a retained tile. High: this is a MODEL INPUT, not a preview. */
const NATIVE_TILE_JPEG_QUALITY = 90

/**
 * How long a native-crop request waits for a tile cut that is still ENCODING.
 *
 * The cut reads its pixels synchronously at `FrameResult` time but only writes
 * the stores after N JPEG encodes; a request landing in between reads two empty
 * stores and is told `no retained tile for this frame` — the same sentence a
 * frame that was never cut gets. Measured 2026-09-07: misses onset at ~100 ms
 * (only 0.1% below it) and peak at 500-1000 ms, on cameras that cut a tile for
 * 99.7% of their inferred frames, so the window — not any lifetime — is what
 * they are landing in.
 *
 * 500 ms deliberately, not more: the confirmation gate bounds each crop attempt
 * at 300 ms and the capture scheduler drops an enrichment request older than
 * 3 s, so a miss held too long stops being a fast retryable `null` and becomes
 * an upstream timeout. Change it only once `cutLatencyMs` on the metrics line
 * says what the encode window really is.
 */
const TILE_CUT_WAIT_MS = 500

/** How many early-withdrawn frame ids the worker remembers for the miss line. */
const UNMARKED_MEMORY = 256

/**
 * How long lease capture stays off after the download path proves broken, and
 * the ceiling that backoff climbs to. Doubling from the base, so the Nth
 * failure in a dial costs `base × 2^(N-2)` — 60 s, 120 s, 240 s … capped.
 *
 * These replace a latch that was held for the REST OF THE DIAL. On a
 * continuously recording camera a dial is hours, and the 2026-08-08 harvest
 * measured what that costs: dev 618 at 93% `nativeCropMisses` across 24
 * disabled dials, dev 592 with a `leaseOffered` delta of 0 over 500 s while
 * answering ~15 crop requests/s. Every one of those misses is a detail
 * dispatch whose rung-1 native crop could never resolve.
 *
 * The bound that mattered is still bounded: the OOM the latch was written for
 * came from rebuilding a vaapi filtergraph PER FAILING FRAME (~25/s), and one
 * rebuild per cooldown is three orders of magnitude below that — while a
 * transient GPU fault now recovers without waiting for a re-dial.
 */
const LEASE_DOWNLOAD_COOLDOWN_BASE_MS = 60_000
const LEASE_DOWNLOAD_COOLDOWN_MAX_MS = 600_000

/**
 * Pinned-color RGB24 native-crop retention — the only lease download since the
 * 2026-07-20 rollout (its opt-out env was removed on 2026-10-06).
 *
 * ## What it fixes
 * On a HARDWARE session the full-frame download pins its YUV→RGB conversion to
 * the resolved `(matrix, range)` on the GPU filtergraph, but the native-CROP
 * lease path retains the frame as YUV420P and later converts it with a CPU
 * `SoftwareScaleContext` that node-av gives NO colorspace-pinning surface for —
 * so the crop falls back to libswscale's default coefficients. On a stream with
 * NO color-matrix metadata (`colorSpace = UNSPECIFIED`, e.g. cam 102) the full
 * frame (pinned bt709/limited by {@link resolveSourceColor}'s defaults) and the
 * crop (CPU-sws default) can resolve DIFFERENTLY → the crop gets a wrong hue /
 * desaturation while the full frame looks right.
 *
 * ## What it does
 * The HW→system lease download converts to RGB24 ONCE, pinned to the SAME
 * resolved color the full-frame path uses (see {@link buildLeaseDownloadDescription});
 * the later crop is then a pure SPATIAL RGB24→RGB24 crop + resize with no color
 * math (see {@link nativeScaleCropToBuffer}'s RGB branch), so it cannot diverge.
 *
 * ## Cost
 * A retained RGB24 frame is ~2x the RAM of YUV420P (3 vs 1.5 bytes/px — ~6.2 vs
 * ~3.1 MB per 1080p frame). Retention stays DEMAND-GATED by {@link leaseGate},
 * so cameras nothing is cropping retain nothing regardless of this flag. The
 * software-DEGRADE path is left on YUV420P (its full frame + crop both use the
 * CPU-sws default, so there is no mismatch to fix there).
 */

/**
 * The libav GPU scale filter for a hwaccel backend, or `null` when none is
 * known here — those backends fall back to the software crop+scale path.
 * Mirrors `addon-decoder-ffmpeg/src/ffmpeg-args.ts` `gpuScaleFilterForBackend`.
 */
function gpuScaleFilterForBackend(backend: HwAccelBackend): string | null {
  switch (backend) {
    case 'vaapi':
      return 'scale_vaapi'
    case 'qsv':
      return 'scale_qsv'
    case 'cuda':
    case 'nvdec':
      return 'scale_cuda'
    case 'videotoolbox':
      return 'scale_vt'
    default:
      // d3d11va / dxva2 / amf / vdpau / drm have no simple `scale_<be>` filter
      // wired here — decode still uses the HW device, but scaling stays on CPU.
      return null
  }
}

/** libav `format` filter target name for the requested detection pixel format. */
function pixelFilterName(format: 'rgb' | 'gray'): 'rgb24' | 'gray' {
  return format === 'gray' ? 'gray' : 'rgb24'
}

/**
 * The crop layout a retained frame's `AV_PIX_FMT_*` maps to, or `null` when this
 * path cannot read it.
 *
 * Only the formats the lease can actually hold are listed, and deliberately so:
 * a format nobody has seen must surface as a NAMED failure the next session can
 * act on, not as a guess that silently mis-reads chroma. `AV_PIX_FMT_NV12` is
 * here because a videotoolbox-era retained frame arrives as two planes — the
 * shape that made every subject tile on dev:102 fail.
 */
function planarCropKindFor(format: number, C: NodeAvConstants): PlanarCropKind | null {
  if (format === C.AV_PIX_FMT_YUV420P) return 'yuv420p'
  if (format === C.AV_PIX_FMT_NV12) return 'nv12'
  return null
}

/** The `AV_PIX_FMT_*` a native-crop scaler is built with for a source layout. */
function navPixelFormatFor(format: NativeCropSourceFormat, C: NodeAvConstants): NavPixFmt {
  switch (format) {
    case 'yuv420p':
      return C.AV_PIX_FMT_YUV420P
    case 'nv12':
      return C.AV_PIX_FMT_NV12
    case 'rgb24':
      return C.AV_PIX_FMT_RGB24
  }
}

let _nav: NodeAvModule | null = null
let _consts: NodeAvConstants | null = null

/**
 * Import a node-av entry, falling back to the agent's explicit node-av path
 * when the bare specifier can't be resolved.
 *
 * WHY: this worker runs as a plain `child_process.fork` (see
 * `fork-decode-worker.ts`) which does NOT inherit the addon-runner's module
 * resolution (the framework ESM hook). On the HUB the fork inherits that hook,
 * so the bare `import('node-av')` resolves; on an AGENT it does not and the bare
 * import throws `Cannot find package 'node-av'`. The candidate layouts, and why
 * the resolver hook is not simply registered in the child instead, live in
 * `shared/host-external-import.ts`. `sharp` needs the same treatment and gets it
 * through `shared/lazy-sharp.ts` — one mechanism, two callers.
 *
 * Each candidate is tried in turn so a copy whose native binary fails to load
 * doesn't mask a working one. A dynamic `import(url)` is typed `any`, so the
 * caller's declared module type applies without a cast.
 */
async function importNodeAv<T>(bareSpecifier: string): Promise<T> {
  try {
    // A dynamic `import()` with a non-literal specifier is typed `any`, so the
    // caller's `T` applies here without a cast.
    const mod = await import(bareSpecifier)
    return mod
  } catch (bareErr) {
    for (const url of hostExternalEntryUrls(bareSpecifier)) {
      try {
        const mod = await import(url)
        return mod
      } catch {
        // Try the next bundle candidate (e.g. the asar.unpacked mirror).
      }
    }
    throw bareErr
  }
}

// The PROMISE is memoised, not the module: the boot-time preload
// ({@link DecodeWorkerChild.warm}) and a `start` that lands while it is still in
// flight must share one import, not race two `dlopen`s of the same library.
let _navLoading: Promise<NodeAvModule> | null = null
let _constsLoading: Promise<NodeAvConstants> | null = null

async function getNodeAv(): Promise<NodeAvModule> {
  if (_nav) return _nav
  _navLoading ??= importNodeAv<NodeAvModule>('node-av').then((mod) => {
    _nav = mod
    return mod
  })
  try {
    return await _navLoading
  } catch (err) {
    // A failed import stays retryable (a LOAD failure, not a resolution one —
    // see `host-external-import.ts`): the next caller tries again.
    _navLoading = null
    throw err
  }
}

async function getConstants(): Promise<NodeAvConstants> {
  if (_consts) return _consts
  _constsLoading ??= importNodeAv<NodeAvConstants>('node-av/constants').then((mod) => {
    _consts = mod
    return mod
  })
  try {
    return await _constsLoading
  } catch (err) {
    _constsLoading = null
    throw err
  }
}

/** The HOLD store, sized from one session's knobs. */
function buildLeaseStore(
  lease: WorkerLeaseKnobs,
  onEvict?: (frameId: number) => void,
): NativeLeaseStore<LeasedNavFrame> {
  return new NativeLeaseStore<LeasedNavFrame>({
    budgetBytes: lease.values.budgetMb * MB,
    maxFrames: lease.values.holdFrames,
    ...(onEvict ? { onEvict } : {}),
  })
}

/** A TILE store (subject or scene) under `budgetMb`, on the shared tile TTL. */
function buildTileStore(budgetMb: number): NativeTileStore {
  return new NativeTileStore({ budgetBytes: budgetMb * MB, ttlMs: NATIVE_TILE_TTL_MS })
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Render a cut-latency percentile for the metrics line. `-` when nothing has
 * been cut yet: a worker that cut nothing and one that cuts in 0 ms must not
 * read the same, or the number that sizes {@link TILE_CUT_WAIT_MS} is a guess.
 */
function formatLatency(ms: number | null): string {
  return ms === null ? '-' : String(Math.round(ms))
}

/**
 * RTSP low-latency demuxer options — mirrors
 * `addon-decoder-nodeav/src/pull-demuxer-options.ts` (duplicated here rather
 * than cross-imported: this file is a standalone forked entry point, not an
 * addon consumer of that package). `analyzeduration`/`probesize` stay small
 * but non-zero — zeroing them starves the Reolink rfc4571 restream demuxer.
 */
/**
 * Restore the unconditional `avformat_find_stream_info` probe on the pull dial.
 *
 * Inline rollback (no deploy) for the probe skip, and the A/B that MEASURES it:
 * `demuxerOpenMs` with this set minus `demuxerOpenMs` with it clear is the
 * probe's cost on that camera. Read once at module load — a knob that can change
 * mid-session is a knob with two values during a session
 * (`native-lease-config.ts` makes the same argument for the lease knobs).
 * See `pull-demuxer-open.ts`.
 */
const FORCE_STREAM_INFO_PROBE = process.env['CAMSTACK_DECODE_PROBE_STREAM_INFO'] === '1'

function buildDemuxerOptions(consumerTag: string): Record<string, string> {
  return {
    rtsp_transport: 'tcp',
    fflags: 'nobuffer',
    analyzeduration: '1000000',
    probesize: '1000000',
    max_delay: '0',
    reorder_queue_size: '0',
    // REQUIRED, not defaulted. It used to be the constant `decode-worker`,
    // shared by every decode session on the node, so the broker's
    // `restream pre-roll served` / `restream attach live-edge` lines could name
    // a consumer and identify nothing: two attaches on the same camera minutes
    // apart, and a dozen cameras' dials, were one string. The recorder's
    // `consumerTag` (`ffmpeg-args.ts`) solved exactly this and is the shape
    // copied here — it is the only identity that crosses from this process into
    // an `RtspSession`, and without it a served window cannot be joined to the
    // first frame it produced.
    user_agent: consumerTag,
  }
}

type NavHwDeviceType = NodeAvConstants['AV_HWDEVICE_TYPE_VIDEOTOOLBOX']

/** Map a canonical backend name to the node-av `AV_HWDEVICE_TYPE_*` constant. */
function backendToHwDeviceConst(
  backend: HwAccelBackend,
  consts: NodeAvConstants,
): NavHwDeviceType | null {
  switch (backend) {
    case 'videotoolbox':
      return consts.AV_HWDEVICE_TYPE_VIDEOTOOLBOX
    case 'cuda':
    case 'nvdec':
      return consts.AV_HWDEVICE_TYPE_CUDA
    case 'vaapi':
      return consts.AV_HWDEVICE_TYPE_VAAPI
    case 'qsv':
      return consts.AV_HWDEVICE_TYPE_QSV
    case 'd3d11va':
      return consts.AV_HWDEVICE_TYPE_D3D11VA
    case 'dxva2':
      return consts.AV_HWDEVICE_TYPE_DXVA2
    case 'amf':
      return consts.AV_HWDEVICE_TYPE_AMF
    case 'vdpau':
      return consts.AV_HWDEVICE_TYPE_VDPAU
    case 'drm':
      return consts.AV_HWDEVICE_TYPE_DRM
    default:
      return null
  }
}

/**
 * Build the libav filtergraph description for the GPU crop+scale path.
 *
 * Full-frame — the ONLY shape the session-decode pump ever asks for (it passes
 * `resize`+`format`, never `crop`, see `session-decode-pump.ts`): scale on the
 * GPU, then `hwdownload` pulls only the small detection-sized surface into
 * system memory + a cheap pixel-convert. This is byte-for-byte the chain the
 * ffmpeg decoder already ships (`addon-decoder-ffmpeg/src/ffmpeg-args.ts`
 * `buildVideoFilter`): `scale_<be>=w=W:h=H,hwdownload,format=nv12,format=<pixel>`.
 *
 * Sub-region crop — contract-supported but unused on the hot path: the generic
 * `crop` filter offsets plane POINTERS, which corrupts opaque VAAPI/QSV
 * surfaces, so there is no safe GPU crop for those. A real crop is therefore
 * done on the CPU AFTER `hwdownload` (`hwdownload,format=nv12,crop=…,scale=…`).
 * It is correct and never crashes; it just forgoes the GPU win for that rare
 * call — exactly the safety/behaviour trade-off the task calls for.
 */
function buildGpuFilterDescription(
  scaleFilter: string,
  region: ResolvedRegion,
  target: ResizeTarget,
  fullFrame: boolean,
  pixel: 'rgb24' | 'gray',
  color: ResolvedSourceColor,
): string {
  // The YUV→RGB/gray convert runs on the CPU after `hwdownload` (an opaque HW
  // surface can't be pixel-converted on-device). Historically that convert was
  // a bare `format=<pixel>`, which let libav auto-insert an sws convert using
  // whatever colorspace/range each frame happened to carry — the RC-5
  // intermittent-desaturation bug (a fallback-GOP frame with UNSPECIFIED range
  // got guessed differently than its neighbours). Pin it EXPLICITLY instead:
  // an sws `scale` filter carrying the resolved src matrix/range + full-range
  // output, so every GOP converts identically regardless of its tags.
  const convert = `scale=${colorConvertFilterOptions(color)}`
  if (fullFrame) {
    return `${scaleFilter}=w=${target.width}:h=${target.height},hwdownload,format=nv12,${convert},format=${pixel}`
  }
  return (
    `hwdownload,format=nv12,` +
    `crop=${region.width}:${region.height}:${region.left}:${region.top},` +
    `scale=${target.width}:${target.height}:${colorConvertFilterOptions(color)},format=${pixel}`
  )
}

/**
 * Copy a single-plane packed frame (rgb24 / gray8 out of the filtergraph) into
 * a tightly-packed `Uint8Array` of `width*channels*height`, stripping libav's
 * row padding (`linesize` ≥ `width*channels`). Keeps the `toBuffer` output
 * contract byte-identical to the software `scaleRoiToBuffer`.
 */
function packSinglePlane(
  plane: Buffer,
  linesize: number,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const rowBytes = width * channels
  const stride = linesize > 0 ? linesize : rowBytes
  const out = Buffer.allocUnsafe(rowBytes * height)
  if (stride === rowBytes) {
    plane.copy(out, 0, 0, rowBytes * height)
  } else {
    for (let row = 0; row < height; row++) {
      plane.copy(out, row * rowBytes, row * stride, row * stride + rowBytes)
    }
  }
  return out
}

/**
 * The forked child's whole runtime: decode-loop lifecycle, the latest-wins
 * frame slot, and the ROI scaler for `toBuffer`. One instance per process.
 */
/** What the process entry (or a test) hands the worker (D652). */
export interface DecodeWorkerHooks {
  /** Begin the bounded exit — `stop` lands here. Default: nothing (a test). */
  readonly requestExit?: (code: number) => void
  /** The one door for native disposes. Default: a disposer that logs refusals at debug. */
  readonly disposer?: NativeDisposer
}

export class DecodeWorkerChild {
  /**
   * Every native dispose / close goes through here, and it refuses once the
   * exit has begun (D652) — see `native-disposer.ts`.
   */
  private readonly native: NativeDisposer
  private readonly requestExit: (code: number) => void
  /** Set once the inherited stderr failed; raw writes stop (D666). */
  private stderrLost = false

  constructor(hooks: DecodeWorkerHooks = {}) {
    this.requestExit = hooks.requestExit ?? ((): void => undefined)
    this.native =
      hooks.disposer ??
      new NativeDisposer((what) =>
        this.emitStderr(
          `decode-worker-child: native dispose left to process exit — ${what}\n`,
          'debug',
        ),
      )
  }

  private nav: NodeAvModule | null = null
  private consts: NodeAvConstants | null = null
  private hwContext: NavHardwareContext | null = null
  /**
   * Reused software scaler + the geometry/format key it was built for.
   * Building a fresh `SoftwareScaleContext` on EVERY `toBuffer` (24fps)
   * churned native libav memory unboundedly (a persistent worker grew to
   * ~10GB/h). Detection uses a stable ROI + resize target, so the scaler is
   * built once and reused, rebuilt only when the key changes — mirroring the
   * shared decoder session (`nodeav-decoder-session.ts`, which reuses one
   * `this.scaler` for the same reason). Reclaimed by process exit (D652).
   */
  private scaler: NavScaler | null = null
  private scalerKey = ''
  /** libav GPU scale filter for the resolved hwaccel backend, or null when GPU filtering isn't available. */
  private gpuScaleFilter: string | null = null
  /**
   * GPU crop+scale path decision — picked ONCE per session.
   * - `software`: the decoder downloads every frame to YUV420P system memory and
   *   `toBuffer` uses the CPU {@link scaler}. This is the original, leak-safe
   *   behaviour; the default until a HW device + `scale_<be>` filter is found.
   * - `undecided`: a HW device + GPU scale filter are available; the decoder
   *   emits GPU surfaces and the FIRST HW frame is probed through the GPU
   *   filtergraph — success ⇒ `hardware`, any failure ⇒ `software` (re-dial).
   * - `hardware`: the decoder emits GPU surfaces and `toBuffer` runs the GPU
   *   crop+scale, downloading only the tiny detection-sized result.
   */
  private hwFilterDecision: 'undecided' | 'hardware' | 'software' = 'software'
  /** Skip the re-dial backoff when the re-dial is specifically to switch to software. */
  private redialAsSoftware = false
  /**
   * Cached GPU crop+scale filtergraph + the geometry/format key it was built
   * for — the HW analogue of {@link scaler}/{@link scalerKey}. Rebuilt (old
   * CLOSED) only when the key changes. Its internal `scale_<be>` OUTPUT hw
   * frames pool is the leak-prone VAAPI surface pool, so it is closed on EVERY
   * re-dial ({@link closeInput}) and by process exit — this discipline is what stops
   * the prior "keeping decoded frames on the GPU leaked the VAAPI surface pool
   * on every re-dial" incident from recurring.
   */
  private hwFilter: NavFilterApi | null = null
  private hwFilterKey = ''
  /**
   * DEDICATED native-crop GPU filtergraph + software scaler, kept SEPARATE from
   * the detection {@link hwFilter}/{@link scaler} so a native-crop request never
   * evicts (rebuilds) the hot-path detection filter cache — the crop geometry
   * differs from the stable detection geometry, so sharing one cache would
   * thrash it. Same dispose discipline: both are closed on every re-dial
   * ({@link closeInput}) and by process exit. Rebuilt lazily per crop geometry.
   */
  private nativeCropHwFilter: NavFilterApi | null = null
  private nativeCropHwFilterKey = ''
  private nativeCropScaler: NavScaler | null = null
  private nativeCropScalerKey = ''
  /**
   * Bounded native-frame retention ring — the survival window for a frame's
   * NATIVE surface between detection (on the shipped small frame) and the crop
   * request that follows. Hard-capped at {@link NATIVE_RING_CAP}; single
   * ownership via the {@link FrameSlot} `retainSuperseded` hook (a frame enters
   * the ring exactly when the slot would otherwise free it). Cleared on every
   * re-dial, reclaimed by process exit (see {@link closeInput}).
   */
  private readonly nativeRing = new NativeFrameRing<NavFrame>(NATIVE_RING_CAP)
  /**
   * PRIMARY native-frame survival window — a bounded RAM copy of each shipped
   * detection frame, keyed by frameId, held until release / TTL / budget
   * eviction. Replaces the tiny GPU {@link nativeRing} as the default (the ring
   * is used only when the lease is disabled via a 0 budget). Because it holds
   * DOWNLOADED (system-memory) frames, retaining a large window has no VAAPI
   * surface-pool starvation risk. Cleared on every re-dial; reclaimed by process exit.
   */
  private leaseStore = buildLeaseStore(UNSTARTED_LEASE_KNOBS)
  /**
   * What SURVIVES a held frame: one compressed native tile per subject, cut at
   * the instant the frame's detection result arrived. Every late native crop
   * that the hold can no longer serve is served from here — which measurement
   * says is the ordinary case, not the exception. See `native-tile-store.ts`.
   */
  private tileStore = buildTileStore(UNSTARTED_LEASE_KNOBS.values.tileBudgetMb)
  /**
   * What survives a held frame for a FULL-FRAME request: one JPEG of the whole
   * native raster, cut in the SAME synchronous read phase as the subject tiles.
   *
   * A separate store, not a fifth entry in {@link tileStore}, because a scene
   * tile is ~20× a subject tile: one shared budget would let a busy camera's
   * key frames evict the face/plate tiles the recognisers live on. Two stores
   * make starving that tier impossible rather than unlikely.
   */
  private sceneStore = buildTileStore(UNSTARTED_LEASE_KNOBS.values.sceneBudgetMb)
  /** Tiles cut / served / refused-for-containment, on the throughput line. */
  private tilesCut = 0
  private tileHits = 0
  private tileMisses = 0
  private tileCutFailures = 0
  /**
   * Serves that produced pixels ONLY because the request waited for a cut that
   * was still encoding — i.e. misses before {@link TILE_CUT_WAIT_MS} existed.
   *
   * This is the counter the write-gap hypothesis stands or falls on. If it
   * stays near zero while `tileMisses` does not move, the misses were never a
   * timing race and the question becomes WHICH frames get cut at all.
   */
  private tileMissesResolvedByWait = 0
  /** Requests that gave up on an in-flight cut at the bound — dropped work. */
  private tileWaitTimeouts = 0
  /** Cuts between "I have the pixels" and "the stores can answer". */
  private readonly pendingCuts = new PendingCuts({ waitMs: TILE_CUT_WAIT_MS })
  /** Scene tiles cut / served, on the throughput line. */
  private scenesCut = 0
  private sceneHits = 0
  /**
   * Full-frame cuts NOT taken because the rung is switched off
   * (`sceneBudgetMb: 0`). A branch that drops work counts it — this one drops a
   * key frame that can never be captured again.
   */
  private sceneRefused = 0
  /** Scenes planned and cut that no tile in the cut was classified as. */
  private sceneUnclassified = 0

  /**
   * Native frame dimensions the retained tiles were cut from. A session's
   * resolution does not change (a re-dial clears the store), so ONE pair is
   * enough — and it has to be remembered because a tile outlives the frame that
   * knew it.
   */
  private tileFrameWidth = 0
  private tileFrameHeight = 0
  /**
   * Demand gate for lease capture — armed at dial start + on every native-crop
   * request; while cold, {@link captureNativeFrame} declines retention so the
   * per-frame native-res GPU→RAM download (the N100 saturation source) stops
   * on cameras nothing is cropping. See `lease-activity-gate.ts`.
   */
  private leaseGate = new LeaseActivityGate(UNSTARTED_LEASE_KNOBS.values.activityMs)
  /**
   * WHICH delivered frames are worth a native lease — the runner marks the ones
   * it admitted to inference (`markInferred`), and in `inferred` mode only
   * those are retained. Also the premise counter: it tallies every crop request
   * naming a frame that was never marked, in BOTH modes, so the assumption the
   * filter rests on is measured on live traffic rather than argued. See
   * `lease-admission-ledger.ts`.
   */
  private admission = new LeaseAdmissionLedger({
    mode: UNSTARTED_LEASE_KNOBS.values.admission,
  })
  /**
   * One-frame park for a late `markInferred` after supersede. Holds the native
   * surface WITHOUT downloading until the mark arrives or the next supersede
   * discards it — closes `toBuffer miss — released` with `marked=true` when
   * the mark IPC loses the race with pull N+1. See `pending-mark-hold.ts`.
   */
  private readonly pendingMark = new PendingMarkHold<NavFrame>()
  /**
   * The knobs this session runs under — `null` until `start` hands them over.
   * The stores above are REBUILT from them at that moment (they are empty then:
   * nothing is captured before a dial), and never again: a knob that changes
   * after the first frame is a knob with two values during a session.
   */
  private lease: WorkerLeaseKnobs | null = null
  /**
   * The hwaccel backends the node's resolver offered on `start` (D926);
   * `null` = unresolved, the platform order applies.
   */
  private hwaccelOffer: SessionHwaccelOffer = null
  /**
   * DEDICATED full-frame GPU→system download filtergraph
   * (`scale_<be>=iw:ih,hwdownload,format=nv12,format=yuv420p`) used ONLY to
   * materialize a HW surface into a leasable software frame at NATIVE
   * resolution (no scale). Kept separate from the detection/native-crop filters
   * (different geometry). Same dispose discipline: closed on every re-dial
   * ({@link closeInput}), since it references the decoder's per-dial
   * `hw_frames_ctx`.
   */
  private nativeLeaseDownloadFilter: NavFilterApi | null = null
  private nativeLeaseDownloadFilterKey = ''
  /** Root-cause instrumentation for the sporadic EIO/EINVAL add-frame failures (task: lease-filter EIO). */
  private leaseDownloadFilterUses = 0
  private leaseDownloadFilterBuiltAt = 0
  /**
   * Per-dial create budget for the lease-download filtergraph (S1 / N100 OOM
   * unit). Metric {@link LeaseDownloadRebuildCap.createsThisDial} is emitted as
   * `leaseDownloadFilterCreates` on the forensics + metrics lines.
   */
  private readonly leaseDownloadRebuildCap = new LeaseDownloadRebuildCap()
  private dialStartedAt = 0
  /**
   * `HardwareContext.create` cost, measured once per worker.
   *
   * Reported rather than assumed. The hw device is resolved BEFORE the first
   * dial and reused across re-dials, so if it is cheap there is nothing to
   * overlap with `Demuxer.open`; if it is not, this is the number that says so.
   * Nothing else in this path could answer that question.
   */
  private hwContextMs = 0
  /**
   * Guards {@link WorkerDialTiming} to ONE report per worker: it describes the
   * dial that produced the first decoded frame, and a re-dial's numbers would
   * silently overwrite the cold start the operator is asking about.
   */
  private dialTimingSent = false
  /**
   * Download failures within the CURRENT dial. Forensics (2026-07-16 late,
   * dev 618): failures cluster in the FIRST seconds of a dial after 4-10
   * successful uses — the decoder re-creates its hw_frames_ctx shortly after
   * dial start (post-probe pool re-init), stranding the just-built filter on
   * the old pool. One rebuild per dial recovers that case (the ctx has
   * settled by the next capture); a SECOND failure starts the cooldown, and
   * {@link leaseDownloadRebuildCap} refuses a third `FilterAPI.create` for
   * the dial (the OOM unit — never the per-frame rebuild that OOM'd the N100).
   */
  private leaseDownloadFailuresThisDial = 0
  /** Throttled native-crop hit/miss counters, emitted with the throughput line. */
  private nativeCropHits = 0
  private nativeCropMisses = 0
  /**
   * Last `(path, rawColorSpace, rawColorRange)` provenance key emitted — a
   * change re-emits a one-line TRANSITION marker (RC-5 diagnostic: pinpoints an
   * intermittent desaturation recurrence by showing the exact GOP whose color
   * tags drifted). See {@link logColorProvenance}.
   */
  /** Last color-provenance key PER decode path. A single shared key ping-pongs
   *  when two paths process every frame (hw-fullframe + pinned hw-crop since
   *  2026-07-23) — each emit differs from the previous one and every frame logs
   *  as a "TRANSITION", flooding the log ring (~40 lines/s per camera). */
  private readonly lastColorProvenanceKeyByPath = new Map<DecodeScalePath, string>()
  /** Throughput counters (plain integers, no per-frame allocation). */
  private framesDecoded = 0
  /** Releases that found a held frame / that found nothing to release. */
  private leaseReleased = 0
  private leaseReleaseMisses = 0
  /** Releases that beat the supersede and withdrew the mark instead. */
  private leaseReleasedEarly = 0
  /** Frame ids withdrawn early → by whom (insertion-ordered, bounded). */
  private readonly unmarkedBy = new Map<number, 'release' | 'cut'>()
  /** Child-side skips only (HW-guard drops + probe/degrade frees); slot drops add {@link FrameSlot.droppedCount}. */
  private framesSkipped = 0
  /** Frames actually handed to the parent as a `frame` reply. */
  private framesDelivered = 0
  private lastMetricsAt = 0
  /** Process start, for the `ageS` field. A worker that outlives its siblings
   *  by two orders of magnitude is the signal this exists to surface. */
  private readonly startedAt = Date.now()
  /** One-shot, so a legitimately long session does not repeat the warning
   *  every ten seconds. */
  private warnedLarge = false
  /**
   * One-shot for "there is no JPEG encoder here" — see {@link tileEncoder}. The
   * branch it guards runs once per subject per frame, which is what made the
   * un-guarded version a log flood rather than a diagnosis.
   */
  private warnedTileEncoderUnavailable = false
  /** One-shot: the scene rung is off by configuration, which cannot change under
   *  a running worker. The VOLUME lives on `sceneRefused`. */
  private warnedSceneDisabled = false
  /**
   * The last subject-tile-cut failure REASON logged — see
   * {@link reportTileCutFailure}. Compared, not counted: the count lives on the
   * metrics line where it can be read per device.
   */
  private lastTileCutFailureReason = ''
  private lastDeliveredSnapshot = 0
  private metricsTimer: NodeJS.Timeout | null = null
  private demuxer: NavDemuxer | null = null
  private decoder: NavDecoder | null = null
  private abortController: AbortController | null = null

  private started = false
  private stopped = false
  /**
   * Set by `drain` (D652): decoding has stopped but every frame already handed
   * out is kept, so the parent can still read what it admitted. The decode
   * loop's per-dial `closeInput` is skipped while this is set — that is what
   * would free the hold — and `stop` ends the process, whose exit reclaims everything.
   */
  private draining = false
  /**
   * Set by the EXIT path (SIGTERM / `stop` / a lost channel / an uncaught
   * error): nothing native is disposed from here on — the decode loop may
   * still be inside libav, and process exit reclaims it all (D652).
   */
  private exiting = false
  /**
   * The numeric device id this worker decodes for — learned from the `start`
   * message's {@link VideoFrameSource}. The child's stderr is INHERITED by the
   * pipeline-runner (silent:false fork), so these lines land in the runner's
   * raw stderr WITHOUT passing through a scoped logger; prefixing every line
   * with `[dev:<id>]` (see {@link emitStderr}) is what lets the per-device log
   * UI attribute the forked worker's output to its camera. `null` only for the
   * brief pre-`start` window (e.g. a malformed first message).
   */
  private deviceId: number | null = null
  /**
   * Dials this worker has made. Part of {@link consumerTag} so two attaches on
   * the same camera are two identities on the broker's side — a re-dial after a
   * source drop is a different join, with a different burst, and averaging the
   * two together is how a slow start hides behind a fast one.
   */
  private dialSeq = 0
  private sessionFormat: 'rgb' | 'gray' = 'rgb'
  private minIntervalMs = 0
  /**
   * Session media clock, anchored on the FIRST decoded frame. Null until that
   * frame arrives, or forever on a source whose pts cannot be read — in which
   * case every frame falls back to the wall clock, exactly as before.
   */
  /** Anchored per DIAL (see `mediaClockForDial`): a re-dial is a new pts epoch. */
  private mediaClock: DialMediaClock | null = null
  /** History this dial asked the broker for; `0` ⇒ there is no burst. */
  private preRollMs = 0
  /** Frames the catch-up burst may send to inference. */
  private preRollMaxFrames = 0
  /** The live catch-up burst, or null once it has ended (or never started). */
  private preRollBurst: PreRollBurst | null = null
  /** Whether the burst's report has already been sent — it is sent exactly once. */
  private preRollReported = false
  /**
   * What became of the pre-roll frames the burst delivered — read, let go, or
   * lost after the burst's report went out (D652). Its summary is a second,
   * later line (`preRollSettled`), never a delay on the report itself.
   */
  private readonly preRollSettle = new PreRollSettleTracker()
  /** Every IPC send until its callback fires, so an exit can wait for them (D652). */
  readonly outbound = new OutboundSendTracker()
  /** Frames this burst may send to inference, after the hold cap (D652). */
  private preRollBudgetFrames = 0
  /** Media wall clock of the OLDEST and NEWEST frames the burst admitted. */
  private preRollFirstMediaWall: number | null = null
  private preRollLastMediaWall: number | null = null
  /**
   * The latest-wins decoded-frame slot + reserved-for-`toBuffer` holder +
   * pending-pull flag — extracted to `FrameSlot` (Epic C P2 Task 2 / I2) so
   * the reserve-on-pull invariant is unit-tested without
   * node-av. See that file's doc comment for the full semantics.
   */
  private readonly frames = new FrameSlot<NavFrame>({
    // A DELIVERED frame that the next pull supersedes is captured for native
    // crops instead of being freed — this is the ONLY seam that keeps a frame's
    // native surface alive past its reserve window. It transfers ownership (the
    // lease store / ring frees it on eviction / clear), so nothing is aliased.
    retainSuperseded: (frameId, frame) => this.captureNativeFrame(frameId, frame),
  })
  /**
   * Mirrors whether `this.frames` currently has a pull waiting, so
   * `quiesceForExit` knows to resolve it with `{kind:'ended'}` — `FrameSlot`
   * intentionally exposes no pending-pull query, only `markPendingPull()`,
   * so the child tracks this in lockstep (set in `handlePull`, cleared
   * whenever `consumeDecodedFrame`'s `publish` resolves it).
   */
  private pendingPull = false
  private ended = false
  private redialTimer: NodeJS.Timeout | null = null

  handleMessage(message: unknown): void {
    if (!isWorkerRequest(message)) {
      this.sendError('decode-worker-child: malformed request')
      return
    }
    // Exiting: no request may start native work inside the exit window — a
    // `toBuffer` reaching `degradeToSoftware`, a crop rebuilding a filter.
    // Each is answered as a refusal so the parent's waiter settles (D652).
    if (this.exiting) {
      this.refuseWhileExiting(message)
      return
    }
    switch (message.kind) {
      case 'start':
        this.handleStart(message.source, message.opts, message.lease, message.hwaccel)
        return
      case 'pull':
        this.handlePull()
        return
      case 'toBuffer':
        void this.handleToBuffer(message.frameId, message.opts)
        return
      case 'nativeCrop':
        this.handleNativeCrop(message.requestId, message.frameId, message.bbox, message.maxWidth)
        return
      case 'cutTiles':
        // Fire-and-forget: the encode must never be able to delay the runner,
        // and the hold ends either way (the `finally` inside).
        void this.handleCutTiles(message.frameId, message.bboxes)
        return
      case 'releaseNativeLease':
        this.noteLeaseRelease(message.frameId, this.leaseStore.release(message.frameId), 'release')
        return
      case 'markInferred':
        this.admission.mark(message.frameId)
        // A mark IS demand for this frame's pixels. The activity gate exists to
        // stop eager `all`-mode native downloads on quiet cameras; closing it
        // also freed MARKED frames, and every lazy detection `toBuffer` after
        // the next pull superseded them missed (`toBuffer miss — released`,
        // marked=true, leaseFrames=0, holdOverflow=0 — live 2026-10-02).
        this.leaseGate.arm()
        // Late mark: pull N+1 already superseded this id into the pending hold.
        // Promote now — without this, lazy toBuffer misses with marked=true on
        // a freed id (reserved-slot margin only covers the newest frame).
        this.promotePendingMark(message.frameId)
        return
      case 'drain':
        this.handleDrain()
        return
      case 'stop':
        this.handleStop()
        return
    }
  }

  /** The answer to a request that arrives after the exit began (D652). */
  private refuseWhileExiting(message: WorkerRequest): void {
    switch (message.kind) {
      case 'toBuffer':
        this.send({
          kind: 'error',
          message: 'decode-worker-child: exiting — toBuffer refused',
          frameId: message.frameId,
        })
        return
      case 'nativeCrop':
        this.send({
          kind: 'nativeCropMiss',
          requestId: message.requestId,
          reason: 'worker exiting',
        })
        return
      case 'pull':
        this.send({ kind: 'ended' })
        return
      case 'stop':
        this.requestExit(0)
        return
      default:
        // start / drain / cutTiles / releaseNativeLease / markInferred: nothing
        // to do for a process that is leaving, and nothing native to touch.
        return
    }
  }

  /**
   * Stop decoding without giving up a single frame the parent holds (D652).
   *
   * The loop ends at its next frame and never re-dials, a dial still opening is
   * aborted, and a later `pull` answers `ended`. The reserved slot, the hold and
   * the tile/scene stores are left exactly as they are: those are the frames the
   * runner already admitted, and the whole point is that they stay readable
   * until the parent has read them and sends `stop`.
   */
  private handleDrain(): void {
    if (this.stopped) return
    this.draining = true
    this.stopped = true
    this.ended = true
    if (this.redialTimer) {
      clearTimeout(this.redialTimer)
      this.redialTimer = null
    }
    this.abortController?.abort()
    // Keep only what a READ needs (D652). The one undelivered slot frame will
    // never be pulled — free it now. The network input is closed when the
    // decode loop has left it (`runDecodeLoop`'s finally): disposing a demuxer
    // under an in-flight read is a use-after-free, and this process now lives
    // on for the drain. The decoder stays: held GPU surfaces belong to its pool.
    this.native.run('undeliveredSlotFrame', () => this.frames.freeUndelivered())
    // The burst is over by definition; its report goes out now, as it would at
    // the live edge. Its frames' late fate follows on `preRollSettled`.
    this.endPreRollBurst()
  }

  /**
   * Exit step 1 (`createWorkerExit`): stop everything that runs, WITHOUT a
   * native call. Before D652 this also freed the frames and disposed the
   * demuxer, decoder, scalers and GPU context — while the decode loop could
   * still sit in native I/O, and the process now lives on up to
   * `WORKER_EXIT_FLUSH_BOUND_MS` after it. Process exit reclaims every native
   * resource, the GPU pool included, so the exit path disposes nothing.
   */
  quiesceForExit(): void {
    // FIRST: from here on no native object is disposed, by any path (D652).
    this.native.refuseFromNowOn()
    this.exiting = true
    this.stopped = true
    this.ended = true
    if (this.redialTimer) {
      clearTimeout(this.redialTimer)
      this.redialTimer = null
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
    if (this.started) this.logMetrics(true)
    // A session torn down mid-burst still reports what the burst managed —
    // a burst that never finished and a burst that inferred nothing must not
    // read the same.
    this.endPreRollBurst()
    this.abortController?.abort()
    if (this.pendingPull) {
      this.pendingPull = false
      this.send({ kind: 'ended' })
    }
  }

  /** Exit step 2: the last report lines — `unsettled` included. */
  flushFinalLines(): void {
    const settled = this.preRollSettle.flush()
    if (settled) this.send({ kind: 'preRollSettled', ...settled })
  }

  /**
   * Emit the compact throughput line (window `deliveredFps`); cheap,
   * integer-only.
   *
   * **`rssMb` and `ageS` are here because their absence cost a Home Assistant
   * outage.** On 2026-08-05 one worker stayed alive 1h58m and grew to 4.9 GiB
   * at ~46 MB/min while its eleven siblings recycled every ~30 s; the host ran
   * out of memory and the kernel killed the largest process on the box, which
   * was somebody else's VM. Nothing in any log said a decode worker was large,
   * or old — the leak was only found by sampling `ps` by hand.
   *
   * This line already runs every 10 s per session and is already grouped by
   * device in Loki, so carrying the worker's own RSS and age turns "a runner
   * is big" into "THIS camera's worker has been climbing for an hour", which
   * is the question that was unanswerable. Retained-store sizes ride along
   * because they are the first thing to suspect and they are free to read.
   */
  private logMetrics(final: boolean): void {
    const now = Date.now()
    const windowMs = Math.max(1, now - this.lastMetricsAt)
    const deliveredDelta = this.framesDelivered - this.lastDeliveredSnapshot
    const deliveredFps = Math.round((deliveredDelta / windowMs) * 1000 * 10) / 10
    const skipped = this.framesSkipped + this.frames.droppedCount
    const rssMb = Math.round(process.memoryUsage().rss / 1048576)
    const ageS = Math.round((now - this.startedAt) / 1000)
    this.emitStderr(
      `session-decode metrics {framesDecoded:${this.framesDecoded}, framesSkipped:${skipped}, ` +
        `deliveredFps:${deliveredFps}, nativeCropHits:${this.nativeCropHits}, ` +
        `nativeCropMisses:${this.nativeCropMisses}, ` +
        // The saving, and the one number that proves it is safe. `leaseOffered`
        // is what admission SAW; `leaseAdmitted` is what it kept; their ratio is
        // the RAM reduction. `leaseUnmarkedCrops` must stay 0 — any other value
        // means a crop asked for a frame the filter is entitled to have dropped.
        `leaseOffered:${this.admission.offered}, leaseAdmitted:${this.admission.admitted}, ` +
        // S1 OOM unit: how many lease-download FilterAPI.create calls this dial
        // has paid. Harvest "rebuilds/h" from this without correlating stderr.
        `leaseDownloadFilterCreates:${this.leaseDownloadRebuildCap.createsThisDial}, ` +
        // `leaseMarks` is what makes `leaseUnmarkedCrops:0` mean something. With
        // no marks arriving, the marked window is empty, every crop request is
        // "unknowable" rather than "unmarked", and the premise counter reads 0
        // for the wrong reason.
        `leaseMarks:${this.admission.marks}, ` +
        `leaseUnmarkedCrops:${this.admission.unmarkedCrops}, ` +
        `leaseAdmission:${this.lease?.values.admission ?? 'unstarted'}, ` +
        // The lease's RESIDENT cost, which is what admission actually changes.
        // `rssMb` below cannot answer it: it is a high-water mark dominated by
        // the decoder's own pools and V8's heap, and it never comes back down,
        // so a real reduction in retained frames is invisible in it.
        `leaseMb:${Math.round(this.leaseStore.totalBytes / 1048576)}, ` +
        `leaseFrames:${this.leaseStore.size}, ` +
        // The HOLD's health. Non-zero `holdOverflow` is a runner that stopped
        // answering — a different sentence from "the crop was late", and the
        // only one this side can say.
        `holdOverflow:${this.leaseStore.overflowCount}, ` +
        // The other side of the hold's ledger: releases that found a held
        // frame, and releases that found nothing (already evicted, or never
        // admitted). `leaseAdmitted - leaseReleased - leaseFrames` is what the
        // bound had to evict — if it is not ~holdOverflow, a release path is
        // missing.
        `leaseReleased:${this.leaseReleased}, leaseReleaseMisses:${this.leaseReleaseMisses}, ` +
        `leaseReleasedEarly:${this.leaseReleasedEarly}, ` +
        // The TILE tier: what survives a frame, and whether it is answering.
        // `tileMisses` counts the containment refusals — a rectangle no tile
        // covers is a MISS on purpose, never a clamp, so this number is the
        // honest cost of that rule and the input to the padding ratio.
        `tilesCut:${this.tilesCut}, tileHits:${this.tileHits}, ` +
        `tileMisses:${this.tileMisses}, tileCutFailures:${this.tileCutFailures}, ` +
        // The write-gap counters. `tileMissesResolvedByWait` is what makes the
        // hypothesis falsifiable: near zero while `tileMisses` stays put means
        // the misses were never a timing race. `cutLatencyMs` is the window
        // itself — the number that says whether the bound is sized right.
        `tileMissesResolvedByWait:${this.tileMissesResolvedByWait}, ` +
        `tileWaitTimeouts:${this.tileWaitTimeouts}, ` +
        `cutLatencyMsP50:${formatLatency(this.pendingCuts.latencyMs(50))}, ` +
        `cutLatencyMsP95:${formatLatency(this.pendingCuts.latencyMs(95))}, ` +
        `cutsInFlight:${this.pendingCuts.inFlight}, ` +
        `tileMb:${Math.round(this.tileStore.totalBytes / 1048576)}, ` +
        `tileFrames:${this.tileStore.frameCount}, ` +
        // The SCENE tier: the only rung that can answer a FULL-FRAME request
        // (native keyFrame, detail `frameJpeg`, gallery fallback) once the hold
        // has ended. `sceneRefused` is the rung switched off; `sceneEvicted` is
        // its budget binding before its TTL — the number that says 10 s of
        // coverage is not actually being bought.
        `scenesCut:${this.scenesCut}, sceneHits:${this.sceneHits}, ` +
        `sceneRefused:${this.sceneRefused}, sceneUnclassified:${this.sceneUnclassified}, ` +
        `sceneEvicted:${this.sceneStore.evictedCount}, ` +
        `sceneMb:${Math.round(this.sceneStore.totalBytes / 1048576)}, ` +
        `sceneFrames:${this.sceneStore.frameCount}, ` +
        `rssMb:${rssMb}, ageS:${ageS}}` +
        `${final ? ' (final)' : ''}\n`,
    )
    this.lastMetricsAt = now
    this.lastDeliveredSnapshot = this.framesDelivered

    // A worker that crosses the threshold says so ONCE, loudly, at the moment
    // it becomes anomalous — not after somebody notices the host is out of
    // memory. It is deliberately not killed: a long session can be legitimate
    // (continuous detection keeps one alive), so the honest action is to make
    // it visible and let the operator decide. The one-shot flag keeps a
    // genuinely long session from writing this line every ten seconds.
    if (!this.warnedLarge && rssMb >= WORKER_RSS_WARN_MB) {
      this.warnedLarge = true
      this.emitStderr(
        `decode-worker-child: WORKER IS LARGE — rssMb=${rssMb} ageS=${ageS} ` +
          `framesDecoded=${this.framesDecoded}. Siblings normally recycle in ~30s; ` +
          `a worker this size at this age is how the host ran out of memory on 2026-08-05.\n`,
      )
    }
  }

  private handleStart(
    source: VideoFrameSource,
    opts: VideoFrameGenOptions,
    lease: WorkerLeaseKnobs,
    hwaccel: SessionHwaccelOffer,
  ): void {
    if (this.started) {
      this.emitStderr('decode-worker-child: duplicate start ignored\n')
      return
    }
    this.started = true
    this.deviceId = source.deviceId
    // The session's knobs, and the stores sized from them — built HERE, at the
    // one moment a worker acquires a configuration. The pre-start stores are
    // empty by construction (nothing is captured before a dial), so replacing
    // them frees nothing and re-homes nothing.
    this.lease = lease
    this.hwaccelOffer = hwaccel
    this.leaseStore = buildLeaseStore(lease, (frameId) => this.settlePreRoll(frameId, 'evicted'))
    this.tileStore = buildTileStore(lease.values.tileBudgetMb)
    this.sceneStore = buildTileStore(lease.values.sceneBudgetMb)
    this.leaseGate = new LeaseActivityGate(lease.values.activityMs)
    this.admission = new LeaseAdmissionLedger({ mode: lease.values.admission })
    this.pendingMark.clear()
    // The knob line carries the `[dev:<id>]` tag because `deviceId` is only
    // known from `start`, and a line without it cannot answer the question
    // this line exists for ("why is 102's crop quality worse than 101's" — the
    // settings are cluster-wide, so a per-camera answer has to come from a
    // per-camera line). `info` because it states an operator's configuration
    // taking effect, and because a setting that silently failed to arrive is
    // invisible at `debug`.
    this.emitStderr(`decode-worker-child: ${formatNativeLeaseKnobs(lease)}\n`, 'info')
    this.sessionFormat = opts.format ?? 'rgb'
    this.minIntervalMs = opts.fps && opts.fps > 0 ? 1000 / opts.fps : 0
    // The pre-roll catch-up: what this dial asked the broker for, and what the
    // burst may spend on it. Both arrive on `start` because only the parent
    // knows them — the worker cannot see the url's intent parameters or the
    // camera's settings.
    this.preRollMs = opts.preRollMs && opts.preRollMs > 0 ? opts.preRollMs : 0
    this.preRollMaxFrames =
      opts.preRollMaxFrames && opts.preRollMaxFrames > 0 ? opts.preRollMaxFrames : 0
    this.lastMetricsAt = Date.now()
    this.metricsTimer = setInterval(() => this.logMetrics(false), METRICS_INTERVAL_MS)
    // Never keep the process alive just for metrics — teardown/exit must win.
    this.metricsTimer.unref?.()
    void this.runDecodeLoop(source.restreamUrl).catch((err: unknown) => {
      this.sendError(`decode-worker-child: decode loop crashed — ${errMessage(err)}`)
    })
  }

  private handlePull(): void {
    if (this.ended) {
      this.send({ kind: 'ended' })
      return
    }
    const reply = this.frames.pull()
    if (reply) {
      this.deliverFrame(reply)
      return
    }
    // No frame decoded yet — hold the request until the first frame arrives
    // (or the worker ends first, which resolves it with `ended` in quiesceForExit).
    this.pendingPull = true
    this.frames.markPendingPull()
  }

  /**
   * Account for a release. A release that found no lease is the runner being
   * done BEFORE the supersede leased the frame: withdraw its mark so the
   * supersede declines it (`LeaseAdmissionLedger.unmark`), and count it.
   */
  private noteLeaseRelease(frameId: number, held: boolean, by: 'release' | 'cut'): void {
    this.settlePreRoll(frameId, 'released')
    if (held) {
      this.leaseReleased += 1
      return
    }
    this.leaseReleaseMisses += 1
    if (this.admission.isMarked(frameId)) {
      this.admission.unmark(frameId)
      this.leaseReleasedEarly += 1
      // Remembered so a later read of this frame can say WHO withdrew it —
      // the one question a `released` miss leaves open. Bounded.
      this.unmarkedBy.set(frameId, by)
      if (this.unmarkedBy.size > UNMARKED_MEMORY) {
        const oldest = this.unmarkedBy.keys().next().value
        if (oldest !== undefined) this.unmarkedBy.delete(oldest)
      }
    }
  }

  private async handleToBuffer(
    frameId: number,
    opts: FrameImageOptions | undefined,
  ): Promise<void> {
    const frame =
      this.leaseStore.get(frameId)?.frame ??
      this.pendingMark.get(frameId) ??
      this.frames.toBuffer(frameId)
    // A read that finds its frame gone is a LOSS for a pre-roll frame; a read
    // that finds it is the ordinary end of its life (D652).
    this.settlePreRoll(frameId, frame ? 'read' : 'miss')
    if (!frame) {
      this.sendError(
        describeToBufferMiss({
          frameId,
          reservedFrameId: this.frames.reservedFrameId,
          marked: this.admission.isMarked(frameId),
          leaseFrames: this.leaseStore.size,
          holdFrames: this.lease?.values.holdFrames ?? UNSTARTED_LEASE_KNOBS.values.holdFrames,
          holdOverflow: this.leaseStore.overflowCount,
          ...(this.unmarkedBy.has(frameId) ? { unmarkedBy: this.unmarkedBy.get(frameId) } : {}),
        }),
        frameId,
      )
      return
    }
    try {
      // Dispatch purely on the retained frame's residency: a GPU surface goes
      // through the GPU crop+scale filtergraph (small download); a software
      // frame uses the CPU YUV420P scaler. This stays correct even if the
      // session has just degraded to software mid-flight (a lingering HW frame
      // still routes to the GPU path; new frames arrive as YUV420P).
      const jpeg = opts?.format === 'jpeg'
      const rawOpts: FrameImageOptions | undefined = jpeg ? { ...opts, format: 'rgb' } : opts
      const bytes = frame.isHwFrame()
        ? this.hwScaleToBuffer(frame, rawOpts)
        : this.scaleRoiToBuffer(frame, rawOpts)
      const output = jpeg
        ? await (async () => {
            const region = resolveCropRegion(frame.width, frame.height, opts?.crop)
            const target = resolveResizeTarget(region.width, region.height, opts?.resize)
            const sharp = await getSharp()
            return new Uint8Array(
              await sharp(bytes, {
                raw: { width: target.width, height: target.height, channels: 3 },
              })
                .jpeg({ quality: 85, mozjpeg: false })
                .toBuffer(),
            )
          })()
        : bytes
      this.send({ kind: 'buffer', frameId, bytes: output })
    } catch (err) {
      this.sendError(`decode-worker-child: toBuffer failed — ${errMessage(err)}`, frameId)
    }
  }

  /**
   * Best-effort NATIVE-resolution crop of a still-retained frame. Resolves the
   * frame from the reserved slot (the latest, most common case) or the
   * retention ring (an older frame detection has since moved past). A miss
   * (frame aged out) or ANY crop error replies `nativeCropMiss` so the caller
   * falls back to today's detection-frame crop — it NEVER degrades the
   * detection session (unlike {@link hwScaleToBuffer}, which flips the whole
   * session to software on a GPU-filter error).
   */
  private handleNativeCrop(
    requestId: number,
    frameId: number,
    bbox: NormalizedBbox,
    maxWidth: number | undefined,
  ): void {
    // Any native-crop demand (hit OR miss) re-arms the lease gate: a miss on a
    // cold gate falls back to the detection-frame crop ONCE, and the retry /
    // next snapshot lands on a captured lease.
    this.leaseGate.arm()
    // Premise accounting BEFORE resolution: was this frame one the runner ever
    // sent to inference? A `true` here means something can name a frame outside
    // the inference set and `nativeLeaseAdmission: 'inferred'` is unsafe. It is
    // counted in both modes precisely so the answer exists before the filter is
    // switched on.
    if (this.admission.noteCropRequest(frameId)) {
      this.emitStderr(
        `decode-worker-child: native crop named an UNINFERRED frame (frameId ${frameId}) — ` +
          `the 'inferred' lease-admission premise does not hold on this path; ` +
          `total=${this.admission.unmarkedCrops}\n`,
      )
    }
    // Resolution order: the RAM lease (primary) → the GPU ring (only populated
    // when the lease is disabled) → the reserved slot (the newest frame, not yet
    // superseded/captured). A leased frame is always SOFTWARE, so it crops via
    // the leak-free CPU path; the ring/reserved frame may still be a GPU surface.
    const frame = this.leaseStore.get(frameId)?.frame ?? this.resolveRetainedFrame(frameId)
    if (!frame) {
      // The hold has ended — which is the ORDINARY state by the time a crop is
      // asked for (measured: 2.2-9.9 s after the frame). The subject tiles cut
      // when the result arrived are what answer now.
      void this.serveTileFallback(requestId, frameId, bbox, maxWidth)
      return
    }
    try {
      const resolved = this.resolveNativeCrop(frame, bbox, maxWidth)
      const bytes = frame.isHwFrame()
        ? this.nativeHwCropToBuffer(frame, resolved)
        : this.nativeScaleCropToBuffer(frame, resolved)
      this.nativeCropHits++
      this.send({
        kind: 'nativeCropResult',
        requestId,
        bytes,
        width: resolved.target.width,
        height: resolved.target.height,
        source: 'lease',
      })
    } catch (err) {
      this.nativeCropMisses++
      const reason = errMessage(err)
      this.emitStderr(
        `decode-worker-child: native crop failed (requestId ${requestId}) — ${reason}\n`,
      )
      this.send({ kind: 'nativeCropMiss', requestId, reason: `crop failed — ${reason}` })
    }
  }

  /**
   * Answer a native-crop request from the tile tier, or report the miss.
   *
   * Separate from {@link handleNativeCrop} because it is ASYNC (a JPEG decode)
   * while the hold path is synchronous, and because the reason strings differ:
   * `no tile contains the requested rectangle` and `no tiles retained` have
   * different fixes, and a single "not retained" hid both.
   */
  private async serveTileFallback(
    requestId: number,
    frameId: number,
    bbox: NormalizedBbox,
    maxWidth: number | undefined,
  ): Promise<void> {
    try {
      // Wait ONLY when waiting can change the answer: anything already retained
      // is served at once, so a cut still encoding a LATER subject of the same
      // frame never delays a request the stores can already answer.
      const attempt = await attemptTileServe(this.pendingCuts, frameId, {
        hasRetained: (): boolean =>
          this.tileStore.get(frameId).length > 0 || this.sceneStore.get(frameId).length > 0,
        serve: (): Promise<{ bytes: Uint8Array; width: number; height: number } | null> =>
          this.serveFromTile(frameId, bbox, maxWidth),
      })
      const served = attempt.served
      if (attempt.wait === 'timeout') this.tileWaitTimeouts += 1
      if (served) {
        this.tileHits += 1
        this.nativeCropHits++
        if (attempt.resolvedByWait) this.tileMissesResolvedByWait += 1
        this.send({
          kind: 'nativeCropResult',
          requestId,
          bytes: served.bytes,
          width: served.width,
          height: served.height,
          source: 'tile',
        })
        return
      }
      this.tileMisses += 1
      this.nativeCropMisses++
      this.send({
        kind: 'nativeCropMiss',
        requestId,
        reason: this.tileMissReason(frameId, attempt.wait),
      })
    } catch (err) {
      this.tileMisses += 1
      this.nativeCropMisses++
      const reason = errMessage(err)
      this.emitStderr(`decode-worker-child: tile serve failed (frame ${frameId}) — ${reason}\n`)
      this.send({ kind: 'nativeCropMiss', requestId, reason: `tile serve failed — ${reason}` })
    }
  }

  /**
   * Why nothing retained could answer — named per RUNG, because they have
   * different fixes. "Subject tiles are off" and "the scene rung is off" and
   * "the rectangle is outside every container" are three different sentences,
   * and one "not retained" hid all of them.
   */
  private tileMissReason(frameId: number, wait: PendingCutWait): string {
    // A branch that DROPS work names itself. This one gave up on a cut that was
    // still running, which is a different sentence from every other miss here:
    // the pixels existed and the request simply outran the encode.
    if (wait === 'timeout') {
      return (
        `frame ${frameId} released and its tile cut did not finish within ` +
        `${TILE_CUT_WAIT_MS} ms — the request outran the encode, not the retention`
      )
    }
    if (!this.tileStore.enabled && !this.sceneStore.enabled) {
      return `frame ${frameId} released and retention is DISABLED (tileBudgetMb 0, sceneBudgetMb 0)`
    }
    if (!this.sceneStore.enabled) {
      return (
        `frame ${frameId} released and no retained subject tile contains the requested ` +
        `rectangle; scene tiles are DISABLED (sceneBudgetMb 0), so a full-frame request ` +
        `cannot be served at all`
      )
    }
    if (!this.tileStore.enabled) {
      return `frame ${frameId} released and subject tiles are DISABLED (tileBudgetMb 0)`
    }
    // Two different questions, once one answer: "was anything retained for
    // this frame at all" separates an evicted/never-cut frame from a rectangle
    // no retained tile happens to contain. 40 753 of 40 764 misses on
    // 2026-09-05 carried the same string and could not tell them apart.
    if (this.tileStore.get(frameId).length === 0 && this.sceneStore.get(frameId).length === 0) {
      return `frame ${frameId} released and no retained tile for this frame`
    }
    return `frame ${frameId} released and no retained subject or scene tile contains the requested rectangle`
  }

  /** The GPU-ring, pending-mark, or reserved-slot frame for `frameId`. */
  private resolveRetainedFrame(frameId: number): NavFrame | null {
    return (
      this.nativeRing.get(frameId) ?? this.pendingMark.get(frameId) ?? this.frames.toBuffer(frameId)
    )
  }

  /**
   * The runner has this frame's detections. Cut one native TILE per subject and
   * end the hold.
   *
   * This is the hinge of the two-tier design: it runs at the last instant the
   * frame's native pixels exist, and what it leaves behind is a handful of
   * subject-sized JPEGs instead of a ~24.9 MB raster. A frame on which nothing
   * was detected leaves nothing at all, which is the asymmetry the old
   * per-frame lease could not express.
   *
   * Three properties are load-bearing:
   *  - the hold ENDS regardless of what happens here (`finally`), including on
   *    an encode failure — a tile is a bonus, a pinned frame is a leak;
   *  - the tile is a CONTAINER, padded wider than any model-input rectangle the
   *    cluster convention can produce. The rectangle a model is fed is still
   *    derived once, by the runner, and cut out of the tile in
   *    {@link serveFromTile} ([D52](../../../../docs/decisions/adr-0052.md));
   *  - every drop is counted. A silently-skipped tile is a crop miss with no
   *    explanation, which is the failure this whole redesign exists to remove.
   */
  private async handleCutTiles(frameId: number, bboxes: readonly NormalizedBbox[]): Promise<void> {
    // BEFORE the first await, so no crop request can observe the window between
    // "this frame's pixels are in hand" and "the stores can answer for it".
    // Settled in the `finally` below — including on a throw, and including the
    // early return for a frame that detected nothing, whose waiter must not be
    // held for the full bound to be told there is nothing.
    this.pendingCuts.begin(frameId)
    try {
      // Either rung being on is reason to cut: the two budgets are independent
      // knobs, so `tileBudgetMb: 0` must not also silence the scene rung — and
      // subjects are not read at all when only the scene rung is on, because
      // their encodes would be paid for a store that refuses them.
      if ((!this.tileStore.enabled && !this.sceneStore.enabled) || bboxes.length === 0) return
      const wanted = this.tileStore.enabled ? bboxes.slice(0, NATIVE_TILE_MAX_PER_FRAME) : []
      if (bboxes.length > wanted.length) {
        this.emitStderr(
          `decode-worker-child: tile cut capped at ${NATIVE_TILE_MAX_PER_FRAME} of ` +
            `${bboxes.length} subjects on frame ${frameId} — the rest fall back to the ≤640 tier\n`,
        )
      }
      // Resolve the encoder BEFORE the frame, and once — not per subject.
      //
      // Both halves of that order are paid for in incidents. Per-subject
      // resolution with `sharp` unresolvable in this process re-entered the
      // module loader on every subject of every frame (3 800 WARN/min
      // cluster-wide, zero tiles — `shared/lazy-sharp.ts`). And resolving it
      // AFTER the frame puts an `await` between "I have this frame" and "I have
      // read it", which is the window a `pull`-driven eviction walks through.
      const sharp = await this.tileEncoder()
      const frame = this.leaseStore.get(frameId)?.frame ?? this.resolveRetainedFrame(frameId)
      if (!frame) {
        // The hold already ended (bound overflow, re-dial). Nothing to cut and
        // nothing to say beyond the counter — the overflow itself is logged.
        this.tileCutFailures += 1
        return
      }
      if (sharp === null) {
        // Never silent: the drop is counted here and named once by
        // {@link tileEncoder}. Every subject falls back to the ≤640 tier.
        this.tileCutFailures += wanted.length
        return
      }
      if (!this.isRetainedFrameLive(frame)) {
        // Dead on arrival — and NOT overwriting `tileFrameWidth/Height` below is
        // part of the fix: a freed frame reports 0x0, and storing that would
        // make every later `serveFromTile` on this session return null.
        this.tileCutFailures += wanted.length
        this.reportTileCutFailure(frameId, 'the retained frame was released before the cut')
        return
      }
      this.tileFrameWidth = frame.width
      this.tileFrameHeight = frame.height
      // The SCENE rectangle rides the same cut. It has to: `cutSubjectTiles`
      // reads every rectangle in one synchronous turn, and a second pass taken
      // after the first cut's encodes have awaited is exactly the `pull`-driven
      // eviction window that once cut subject 1 of each frame and lost the rest.
      const plan = planFrameCuts(wanted, {
        sceneEnabled: this.sceneStore.enabled,
        hasDetections: bboxes.length > 0,
      })
      if (!plan.scene) {
        // Never silent. Off by configuration is still a full-frame request that
        // will find nothing — the miss profile this rung exists to remove.
        this.sceneRefused += 1
        if (!this.warnedSceneDisabled) {
          this.warnedSceneDisabled = true
          this.emitStderr(
            'decode-worker-child: scene tiles DISABLED (sceneBudgetMb 0) — every late ' +
              'FULL-FRAME request (native keyFrame, detail frameJpeg, gallery fallback) ' +
              'will miss once this frame is released; refusals are counted as sceneRefused\n',
          )
        }
      }
      // Every pixel read happens inside `cutSubjectTiles`'s SYNCHRONOUS first
      // phase; the JPEG encodes run afterwards, off copied bytes. See
      // `subject-tile-cut.ts` for why this ordering — not a liveness check — is
      // what makes the eviction race unreachable.
      const cut = await cutSubjectTiles(frame, plan.bboxes, {
        isLive: (f: NavFrame): boolean => this.isRetainedFrameLive(f),
        cutRaw: (f: NavFrame, bbox: NormalizedBbox): RawSubjectTile => {
          const { region } = resolveNativeTileRegion(
            f.width,
            f.height,
            bbox,
            NATIVE_TILE_PADDING_RATIO,
          )
          const resolved: ResolvedNativeCrop = {
            region,
            target: { width: region.width, height: region.height },
          }
          const raw = f.isHwFrame()
            ? this.nativeHwCropToBuffer(f, resolved)
            : this.nativeScaleCropToBuffer(f, resolved)
          return { region, raw }
        },
        encode: async (tile: RawSubjectTile): Promise<NativeTile> => {
          const jpeg = await sharp(tile.raw, {
            raw: { width: tile.region.width, height: tile.region.height, channels: 3 },
          })
            .jpeg({ quality: NATIVE_TILE_JPEG_QUALITY })
            .toBuffer()
          return { region: tile.region, bytes: new Uint8Array(jpeg) }
        },
        onFrameLost: (): void => {
          this.reportTileCutFailure(frameId, 'the retained frame was released mid-cut')
        },
        onCutFailed: (reason: string): void => {
          this.reportTileCutFailure(frameId, reason)
        },
      })
      // Exactly one failure per rectangle that did not become a tile — counted
      // in ONE place, over the WHOLE plan, so a lost frame and a failed encode
      // cannot double-count and the scene rectangle is not accounted twice.
      this.tileCutFailures += plan.bboxes.length - cut.length
      // The full-frame tile goes to its OWN store; everything else is a subject.
      // Split on the resolved REGION, not on position in the cut list, because a
      // rectangle whose read or encode failed is dropped and positional identity
      // does not survive that. Only when a scene WAS planned: with the rung off,
      // a padded subject that happens to span the frame is still a subject, and
      // routing it to a disabled store would drop a tile that used to be kept.
      // Against the CAPTURED size, never `frame.width` re-read here: the encode
      // awaits above are the `pull`-driven eviction window, a freed NavFrame
      // reports 0×0, and `isSceneRegion(…, 0, 0)` is false — which filed every
      // scene raster as a SUBJECT on the hub (tilesCut/scenesCut 87:1, scene
      // store empty, subject store full of 2 MB scenes; 2026-09-05).
      const { subjects, scene } = plan.scene
        ? partitionSceneTile(cut, this.tileFrameWidth, this.tileFrameHeight)
        : { subjects: cut, scene: null }
      if (plan.scene && scene === null && cut.length > 0) {
        // A scene was planned and cut, and nothing in the cut reads as one:
        // the rung below the hold has silently lost this frame. Counted, so
        // the metrics line can tell it from "no detection on this frame".
        this.sceneUnclassified += 1
      }
      if (subjects.length > 0) {
        this.tilesCut += subjects.length
        this.tileStore.put(frameId, subjects)
      }
      if (scene !== null) {
        this.scenesCut += 1
        this.sceneStore.put(frameId, [scene])
      }
    } finally {
      // The stores now hold whatever this cut produced — possibly nothing, if
      // an encode threw. Either way every waiter is released here: a crop is
      // best-effort and a waiter that can wedge is not.
      this.pendingCuts.settle(frameId)
      // The hold's whole contract: a frame lives until its result arrives, and
      // this IS its result arriving. Releasing in `finally` is what keeps a
      // failed encode from turning into pinned RAM.
      this.noteLeaseRelease(frameId, this.leaseStore.release(frameId), 'cut')
    }
  }

  /**
   * Is this retained frame still backed by pixels?
   *
   * A node-av frame whose `free()` has run reports `AV_PIX_FMT_NONE` and no
   * planes — that is what dev:1443 logged (`pixel format -1 (planes=0,
   * hw=false)`) when an eviction landed mid-cut. A HW frame legitimately has no
   * `data` planes, so residency is judged there by format and dimensions.
   *
   * This is an ASSERTION of the invariant `subject-tile-cut.ts` establishes by
   * ORDERING, not the mechanism that enforces it: within one synchronous turn
   * nothing can free the frame, so the check can only fail for a frame that was
   * already dead when the cut arrived. It is kept, and consulted before every
   * read, so that an edit which reintroduces an await inside the loop degrades
   * to a counted miss instead of a read of recycled memory.
   */
  private isRetainedFrameLive(frame: NavFrame): boolean {
    const C = this.consts
    if (!C) return false
    if (frame.format === C.AV_PIX_FMT_NONE) return false
    if (frame.width <= 0 || frame.height <= 0) return false
    if (frame.isHwFrame()) return true
    return (frame.data?.length ?? 0) > 0
  }

  /**
   * Report a failed subject-tile cut — on TRANSITION, not per subject.
   *
   * Every failure is COUNTED (`tileCutFailures`, on the periodic metrics line
   * per device), so the volume is never hidden; what is suppressed is only the
   * repetition of a cause already stated. A tile cut fails once per subject per
   * frame, so a standing cause — a retained format this path cannot read, which
   * is precisely what dev:102 had — writes one line per subject per frame: 533
   * identical lines that said the same thing 533 times.
   *
   * Transition rather than one-shot, mirroring {@link logColorProvenance}: a
   * SECOND, different cause is worth a line, and a cause that comes back after
   * another one intervened is a real signal. The frame id is in the message but
   * deliberately not in the comparison key — otherwise every frame is a
   * "transition" and nothing is suppressed.
   */
  private reportTileCutFailure(frameId: number, reason: string): void {
    if (reason === this.lastTileCutFailureReason) return
    this.lastTileCutFailureReason = reason
    this.emitStderr(
      `decode-worker-child: subject tile cut FAILED on frame ${frameId} — ${reason} ` +
        `(further identical failures are counted in tileCutFailures, not logged)\n`,
    )
  }

  /**
   * The JPEG encoder for subject tiles, or `null` when `sharp` cannot be
   * resolved in this process at all.
   *
   * `getSharp()` memoizes an unresolvable `sharp` (see `shared/lazy-sharp.ts`),
   * so this costs one module-loader round trip for the worker's whole life and a
   * rejected promise thereafter. The diagnostic is one-shot for the same reason
   * the memo is: the cause cannot change under a running worker, and the failing
   * branch is per subject per frame. The loader emits its own line naming every
   * path it tried; this one names the CONSEQUENCE, which is what an operator
   * looking at a camera with no detail crops needs to read.
   */
  private async tileEncoder(): Promise<SharpFactory | null> {
    try {
      return await getSharp()
    } catch (err) {
      if (!this.warnedTileEncoderUnavailable) {
        this.warnedTileEncoderUnavailable = true
        this.emitStderr(
          `decode-worker-child: subject tile tier DISABLED — no JPEG encoder: ${errMessage(err)}\n`,
        )
      }
      return null
    }
  }

  /**
   * Serve a native crop from a retained subject TILE — the rung that covers the
   * ordinary case, where the request arrives seconds after the frame is gone.
   *
   * The rectangle is the SAME one {@link resolveNativeCrop} would have cut from
   * the full frame; only the raster it is taken from differs. A rectangle no
   * tile CONTAINS is a miss (`null`) — never a clamp into the nearest tile,
   * which would enrich a different part of the scene and error nowhere.
   */
  private async serveFromTile(
    frameId: number,
    bbox: NormalizedBbox,
    maxWidth: number | undefined,
  ): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
    // Subject tiles FIRST, scene tile second — `selectTileForRect` already
    // prefers the smallest container, and asking the subject store first keeps
    // a subject crop off the 20×-larger scene raster when both could serve it.
    const scenes = this.sceneStore.get(frameId)
    const tiles = this.tileStore.get(frameId)
    if (tiles.length === 0 && scenes.length === 0) return null
    const width = this.tileFrameWidth
    const height = this.tileFrameHeight
    if (width <= 0 || height <= 0) return null
    const { region, target } = resolveNativeCropGeometry(width, height, bbox, maxWidth)
    const served = selectRetainedTile(tiles, scenes, region)
    if (!served) return null
    if (served.source === 'scene') this.sceneHits += 1
    const sharp = await getSharp()
    let pipeline = sharp(served.tile.bytes).extract({
      left: served.local.left,
      top: served.local.top,
      width: served.local.width,
      height: served.local.height,
    })
    if (target.width !== served.local.width || target.height !== served.local.height) {
      pipeline = pipeline.resize(target.width, target.height, { fit: 'fill' })
    }
    const raw = await pipeline.removeAlpha().raw().toBuffer()
    return { bytes: new Uint8Array(raw), width: target.width, height: target.height }
  }

  /**
   * Resolve a decoded frame's `(colorSpace, colorRange)` tags to the EXPLICIT
   * `(matrix, range)` every RGB conversion site pins — the RC-5 fix. `colorSpace`
   * / `colorRange` are node-av branded `number` subtypes, so they pass to the
   * plain-number helper directly.
   */
  private resolveFrameColor(frame: NavFrame): ResolvedSourceColor {
    return resolveSourceColor(frame.colorSpace, frame.colorRange)
  }

  /**
   * Emit the color-provenance marker: which decode/scale path produced this
   * frame + its raw and resolved source color. Always logs on a TRANSITION (the
   * path or the frame's raw color tags changed vs the last emit — rare, and the
   * exact signal a desaturation recurrence leaves).
   */
  private logColorProvenance(path: DecodeScalePath, color: ResolvedSourceColor): void {
    const key = `${color.rawColorSpace}|${color.rawColorRange}`
    const transition = this.lastColorProvenanceKeyByPath.get(path) !== key
    if (transition) this.lastColorProvenanceKeyByPath.set(path, key)
    if (transition) this.emitStderr(colorProvenanceLine(path, color, transition))
  }

  /**
   * Retain a just-superseded DELIVERED frame for later native crops. Transfers
   * ownership from the {@link FrameSlot} (the caller MUST NOT free when this
   * returns `true`).
   *
   * - Lease ENABLED (default): materialize a SOFTWARE RAM copy and put it in the
   *   {@link leaseStore}. A HW surface is downloaded to system memory ONCE here
   *   (freeing the GPU surface immediately — no VAAPI-pool pin); a software frame
   *   is leased directly. A download failure still consumes ownership (freed
   *   here) so the slot never double-frees — the crop simply misses → fallback.
   * - Lease DISABLED (`budget 0`): fall back to today's tiny GPU {@link nativeRing}.
   *
   * ## LEASE ADMISSION — what actually gets stored
   *
   * Three conditions decide it, and only the third is per-frame:
   *   1. the lease is enabled (`budgetMb > 0`);
   *   2. {@link leaseGate} is inside its demand window (`activityMs` since the
   *      last native-crop request or the dial);
   *   3. {@link admission} accepts the frame — everything in `all` mode, only
   *      frames the runner MARKED as having reached inference in `inferred`
   *      mode (`nativeLeaseAdmission`).
   *
   * When (2) or (3) would decline, the frame is PARKED in {@link pendingMark}
   * for one supersede — a late `markInferred` can still promote it. The next
   * supersede discards an unmarked pending. No GPU download until promote or
   * lease, so quiet cameras still avoid the per-frame bandwidth burn.
   *
   * What reaches this function at all is the {@link FrameSlot} lifecycle, not a
   * quality filter. `retainSuperseded` is called only from
   * `FrameSlot.reserveSlot()` (`frame-slot.ts`), on the frame the PREVIOUS
   * `pull` delivered to the parent, at the moment the next `pull` supersedes it.
   * So:
   *   - frames dropped by the `minIntervalMs` fps throttle never enter the slot
   *     and are never offered;
   *   - frames superseded in the slot before any `pull` took them (latest-wins)
   *     are freed by `publish` and never offered;
   *   - every DELIVERED frame is offered exactly once, and then rule 3 decides.
   *
   * ## Why `inferred` is safe, and how that is checked rather than assumed
   *
   * A native crop names a `frameId`, and the only way a `frameId` leaves the
   * runner is on a `FrameHandle` riding an INFERENCE RESULT — post-analysis
   * reaches every one of its handles through `processFrame`, whose only
   * handle-bearing caller is `handleInferenceResult`. A frame the runner never
   * enqueued is therefore a frame nobody can ask for. The counter that keeps
   * this honest is `leaseUnmarkedCrops` on the metrics line: it counts crop
   * requests naming an unmarked frame in BOTH modes, so the premise is a
   * production number, not a reading of the call graph.
   *
   * The NEWEST delivered frame is never at risk either way: it is the slot's
   * reserved frame and {@link handleNativeCrop} resolves it through
   * `FrameSlot.toBuffer`, never through the lease. A late mark for the PREVIOUS
   * frame is the pending-mark hold's job — the reserved margin does not cover it.
   *
   * ## What it costs / saves
   *
   * One 4K frame is ~24.9 MB on the default pinned-RGB24 lease path
   * (pinned RGB24), ~12.4 MB as YUV420P. At the ~25 delivered fps of
   * `all` mode that is ~620 MB/s of GPU→RAM download while the gate is open and
   * a steady-state resident set of roughly `frameBytes × deliveredFps ×
   * ttlSeconds`. `inferred` cuts both by the governor's admit ratio — ~5 of 25
   * frames on a two-plane camera, so ~80%. Prompt `releaseNativeLease` reclaims
   * earlier still, so the observed figure is lower than the ceiling; the
   * ceiling is what the budget knob has to survive. See
   * `docs/design/decode-path.md` → "Lease admission".
   */
  private captureNativeFrame(frameId: number, frame: NavFrame): boolean {
    if (!this.leaseStore.enabled) {
      // No hold, so nothing for the hold to evict: not a pre-roll loss.
      this.flushPendingMark()
      this.settlePreRoll(frameId, 'released')
      return this.nativeRing.retain(frameId, frame)
    }
    // No recent demand → park UNMARKED frames for one supersede (a late mark
    // can still promote). No download here — that is what stops the per-frame
    // native-res GPU→RAM burn on cameras nothing is cropping. A MARKED frame
    // is demand: lease it even when the gate is cold (live 2026-10-02).
    if (!this.leaseGate.active && !this.admission.isMarked(frameId)) {
      return this.parkPendingMark(frameId, frame)
    }
    // Admission (Option B): in `inferred` mode keep only the frames the runner
    // marked. Peek first so a decline parks without double-counting offered
    // when a late mark later promotes.
    if (!this.admission.wouldAdmit(frameId)) {
      return this.parkPendingMark(frameId, frame)
    }
    this.flushPendingMark()
    if (!this.admission.admit(frameId)) {
      this.settlePreRoll(frameId, 'released')
      return false
    }
    return this.leaseNativeFrame(frameId, frame)
  }

  /**
   * Discard a pending mark that lost the race (never marked before the next
   * supersede). Counts as an offered decline so metrics still see the delivery.
   */
  private flushPendingMark(): void {
    const id = this.pendingMark.frameId
    if (id === null) return
    this.pendingMark.discard()
    this.admission.admit(id)
    this.settlePreRoll(id, 'released')
  }

  /** Park a just-superseded frame awaiting a possible late `markInferred`. */
  private parkPendingMark(frameId: number, frame: NavFrame): boolean {
    this.flushPendingMark()
    this.pendingMark.park(frameId, frame)
    return true
  }

  /**
   * Promote a parked frame into the lease after a late mark. No-op when the
   * pending id does not match (mark arrived in time and the frame was already
   * leased, or a newer supersede already discarded it).
   */
  private promotePendingMark(frameId: number): void {
    const frame = this.pendingMark.take(frameId)
    if (!frame) return
    if (!this.admission.admit(frameId)) {
      frame.free()
      this.settlePreRoll(frameId, 'released')
      return
    }
    this.leaseNativeFrame(frameId, frame)
  }

  /**
   * Download (if HW) and put into {@link leaseStore}. Consumes ownership of
   * `frame` whether or not the download succeeds (returns `true` either way
   * so the slot / pending hold never double-frees).
   */
  private leaseNativeFrame(frameId: number, frame: NavFrame): boolean {
    if (frame.isHwFrame()) {
      const software = this.downloadToSoftware(frame)
      frame.free()
      if (!software) {
        // Ownership consumed; nothing leased → a later read misses. For a
        // pre-roll frame that is a loss, and it is named as one (D652).
        this.settlePreRoll(frameId, 'download-failed')
        return true
      }
      // `downloadToSoftware` produced a pinned RGB24 frame (3 bytes/px); wrap it
      // as one so the RAM-budget tally stays exact.
      this.leaseStore.put(frameId, toLeasedRgbNavFrame(software))
      return true
    }
    // Already a system-memory frame — lease it directly (ownership transfer).
    this.leaseStore.put(frameId, toLeasedNavFrame(frame))
    return true
  }

  /**
   * Download a HW surface to a NATIVE-resolution software YUV420P frame via the
   * dedicated full-frame download filtergraph. Returns the software frame (owned
   * by the caller) or `null` on any failure (the lease is then simply skipped).
   * `processAllSync` only refs the input surface, so the caller frees it after.
   */
  private downloadToSoftware(frame: NavFrame): NavFrame | null {
    const nav = this.nav
    const scaleFilter = this.gpuScaleFilter
    if (!nav || !scaleFilter || !this.hwContext) return null
    try {
      // Resolve the frame's source color ONCE and pin the GPU download to it
      // (→ full-range RGB24), IDENTICALLY to the full-frame path, so the later
      // crop needs no color math. The transition marker fires so a
      // pinned-download recurrence stays diagnosable.
      const color = this.resolveFrameColor(frame)
      this.logColorProvenance('hw-crop', color)
      const filter = this.ensureLeaseDownloadFilter(
        nav,
        scaleFilter,
        frame.width,
        frame.height,
        color,
      )
      const outputs = filter.processAllSync(frame)
      const first = outputs[0] ?? null
      for (let i = 1; i < outputs.length; i++) outputs[i]?.free()
      return first
    } catch (err) {
      const reason = errMessage(err)
      // S1: the dial create budget is exhausted — refuse without closing a
      // graph we never opened and without counting another download failure
      // (that would only escalate the cooldown while the real bound already
      // holds). Crops fall back until the next dial resets the cap.
      if (reason === LEASE_DOWNLOAD_REBUILD_CAP_REASON) {
        this.emitStderr(
          `decode-worker-child: native lease download refused — ${LEASE_DOWNLOAD_REBUILD_CAP_REASON} ` +
            `[forensics: frame=${frame.width}x${frame.height} fmt=${frame.format} hw=${frame.isHwFrame()} ` +
            `filterUses=${this.leaseDownloadFilterUses} ` +
            `leaseDownloadFilterCreates=${this.leaseDownloadRebuildCap.createsThisDial} ` +
            `dialAgeMs=${Date.now() - this.dialStartedAt} decoded=${this.framesDecoded}]\n`,
        )
        return null
      }
      // Root-cause forensics (lease-filter EIO): everything needed to tell a
      // poisoned/stale filtergraph (fails on a REUSED filter after N ok uses —
      // hw_frames_ctx drift) from a create-time/first-use failure (fails with
      // uses=1 — device/format mismatch) from load-shedding (EIO under GPU
      // pressure at arbitrary uses).
      this.emitStderr(
        `decode-worker-child: native lease download failed — ${reason} ` +
          `[forensics: frame=${frame.width}x${frame.height} fmt=${frame.format} hw=${frame.isHwFrame()} ` +
          `filterUses=${this.leaseDownloadFilterUses} filterAgeMs=${Date.now() - this.leaseDownloadFilterBuiltAt} ` +
          `leaseDownloadFilterCreates=${this.leaseDownloadRebuildCap.createsThisDial} ` +
          `dialAgeMs=${Date.now() - this.dialStartedAt} decoded=${this.framesDecoded}]\n`,
      )
      // A failed add/receive leaves the CACHED filtergraph in a broken state
      // (live: one EIO/EINVAL was followed by an unbroken burst of identical
      // failures until the next re-dial). Close it AND disable lease capture
      // for the REST OF THE DIAL: retrying per frame means either feeding a
      // poisoned graph (frames accumulate inside it — the slow pre-existing
      // RSS leak) or rebuilding a vaapi filtergraph per failing frame (node-av
      // reclaims hw pools only by process exit — live 2026-07-16 this OOM'd
      // the N100 agent, 6GB RSS in minutes). Crops fall back to the
      // detection-frame crop until the next dial rebuilds cleanly.
      this.native.run('nativeLeaseDownloadFilter', () => this.nativeLeaseDownloadFilter?.close())
      this.nativeLeaseDownloadFilter = null
      this.nativeLeaseDownloadFilterKey = ''
      this.leaseDownloadFailuresThisDial++
      if (this.leaseDownloadFailuresThisDial >= 2) {
        // Second failure this dial: not the early-dial ctx re-init — stop
        // capturing, but only for a COOLDOWN (see field doc; this is the OOM
        // guard). It used to stop for the rest of the dial, which on a
        // continuously recording camera meant hours of 100% rung-1 crop misses.
        const cooldownMs = Math.min(
          LEASE_DOWNLOAD_COOLDOWN_MAX_MS,
          LEASE_DOWNLOAD_COOLDOWN_BASE_MS * 2 ** (this.leaseDownloadFailuresThisDial - 2),
        )
        this.leaseGate.disableFor(cooldownMs)
        // This branch DROPS work — every native crop asked for during the
        // cooldown misses rung 1 and the detail dispatch falls to the retained
        // full frame or to nothing at all. Announce it: the silent version of
        // this cost a day of 93% crop misses that read as a lease-TTL problem.
        this.emitStderr(
          `decode-worker-child: native lease capture OFF for ${cooldownMs}ms — ` +
            `${this.leaseDownloadFailuresThisDial} download failures this dial; ` +
            `native crops will MISS until it expires (detail dispatches fall back ` +
            `to the retained full frame)\n`,
        )
      }
      return null
    }
  }

  /**
   * Build-once / reuse the full-frame GPU→system download filtergraph.
   *
   * - `color === null` (flag OFF): YUV420P download, byte-for-byte the historical
   *   `scale=w=iw:h=ih,hwdownload,format=nv12,format=yuv420p` + `${srcW}x${srcH}` key.
   * - `color !== null` (flag ON): pinned-color RGB24 download; the resolved color
   *   is folded into the cache key so a mid-session colorspace/range change
   *   rebuilds the graph instead of reusing one pinned to the old color.
   */
  private ensureLeaseDownloadFilter(
    nav: NodeAvModule,
    scaleFilter: string,
    srcW: number,
    srcH: number,
    color: ResolvedSourceColor | null,
  ): NavFilterApi {
    const key = leaseDownloadFilterKey(srcW, srcH, color)
    const cached = this.nativeLeaseDownloadFilter
    if (cached && key === this.nativeLeaseDownloadFilterKey) {
      this.leaseDownloadFilterUses++
      return cached
    }
    // S1: refuse BEFORE FilterAPI.create — the create itself is the OOM unit
    // (VAAPI hw pools reclaim only on process exit). Named so forensics and
    // the disarming spec share one vocabulary.
    this.leaseDownloadRebuildCap.recordCreate()
    this.native.run('nativeLeaseDownloadFilter', () => this.nativeLeaseDownloadFilter?.close())
    this.nativeLeaseDownloadFilter = null
    this.nativeLeaseDownloadFilterKey = ''
    const description = buildLeaseDownloadDescription(scaleFilter, color)
    const filter = nav.FilterAPI.create(description, {
      hardware: this.hwContext,
      threads: FILTER_THREADS,
    })
    this.nativeLeaseDownloadFilter = filter
    this.nativeLeaseDownloadFilterKey = key
    this.leaseDownloadFilterUses = 1
    this.leaseDownloadFilterBuiltAt = Date.now()
    return filter
  }

  /** Map a normalized bbox to an even-aligned pixel crop + (optionally capped) target. */
  private resolveNativeCrop(
    frame: NavFrame,
    bbox: NormalizedBbox,
    maxWidth: number | undefined,
  ): ResolvedNativeCrop {
    return resolveNativeCropGeometry(frame.width, frame.height, bbox, maxWidth)
  }

  /**
   * Software native crop — the leak-free path: offset the retained YUV420P
   * frame's plane pointers to the crop origin (zero-copy) and scale ONLY the
   * ROI into a tightly-packed rgb buffer via a DEDICATED scaler (never the
   * detection {@link scaler}). Mirrors {@link scaleRoiToBuffer}, rgb-fixed.
   */
  private nativeScaleCropToBuffer(frame: NavFrame, resolved: ResolvedNativeCrop): Uint8Array {
    const nav = this.nav
    const C = this.consts
    if (!nav || !C) throw new Error('node-av not initialized')
    // `pinnedRgbCrop` path: the leased frame is already pinned full-range RGB24
    // (color converted ONCE at download, identical to the full-frame path), so
    // this is a pure SPATIAL crop + RGB→RGB resize with NO color math. Dispatch
    // on the retained frame's RESIDENCY (its pixel format), mirroring the
    // isHwFrame() dispatch elsewhere — flag OFF never retains an RGB frame, so
    // this branch is unreachable and the YUV420P path below runs unchanged.
    if (frame.format === C.AV_PIX_FMT_RGB24) {
      return this.nativeRgbCropToBuffer(nav, C, frame, resolved)
    }
    // Provenance (RC-5): CPU crop path — see the sws-limitation note in
    // scaleRoiToBuffer. Deterministic default conversion; marker for diagnosis.
    this.logColorProvenance('sw-crop', this.resolveFrameColor(frame))
    const { region, target } = resolved
    // Dispatch on the frame's ACTUAL layout. Hardcoding three planes is what
    // made the subject-tile tier unusable on dev:102: a videotoolbox-era NV12
    // frame has two, and the guard threw for every subject of every frame. The
    // format is NAMED in every failure here — the message it replaces said only
    // "missing planar YUV420P data", which is why 533 identical lines answered
    // nothing. See `planar-crop-source.ts`.
    const kind = planarCropKindFor(frame.format, C)
    if (kind === null) {
      throw new Error(
        `decode-worker-child: retained frame in unsupported pixel format ${frame.format} ` +
          `(planes=${frame.data?.length ?? 0}, hw=${frame.isHwFrame()}) — cannot crop`,
      )
    }
    const source = resolvePlanarCropSource(kind, frame.data, frame.linesize, region)
    if (!source) {
      throw new Error(
        `decode-worker-child: retained ${kind} frame missing plane data for ` +
          `${region.width}x${region.height}+${region.left}+${region.top} ` +
          `(planes=${frame.data?.length ?? 0})`,
      )
    }
    const scaler = this.ensureNativeCropScaler(
      nav,
      C,
      region.width,
      region.height,
      target.width,
      target.height,
      kind,
    )
    // libswscale writes rows with SIMD and can overshoot past `width*3` bytes
    // within a row — the dst stride MUST be aligned and the buffer must carry
    // that slack, or the LAST row's overshoot lands past the end of the
    // allocation (live heap corruption: glibc sysmalloc assert → SIGABRT a few
    // crops later, killed the 592 worker on every face-detail burst). The
    // detection path never hit it because its 640px slots make an aligned
    // stride by luck; native-crop targets are arbitrary widths. Scale into an
    // aligned-stride buffer, then pack tight (same as the hw path).
    const tightStride = target.width * 3
    const dstStride = (tightStride + 63) & ~63
    // Tail slack is MANDATORY, not just stride alignment: sws SIMD row writes
    // can overshoot the row's byte count, and on the LAST row that lands past
    // the end of the allocation (live: malloc "corrupted top size" aborts —
    // and 320px targets make tightStride 960, already 64-aligned, so aligned
    // stride alone gave ZERO slack). Mirror av_image_alloc's padding.
    const dstBuffer = Buffer.allocUnsafe(dstStride * target.height + 64)
    // Zero-copy Buffer views over the plane subarrays (`scaleSync` wants
    // Buffers) — the same wrapping the RGB path does, no pixels are moved.
    const srcPlanes = source.planes.map((plane) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength),
    )
    const scaledHeight = scaler.scaleSync(
      srcPlanes,
      [...source.strides],
      0,
      region.height,
      [dstBuffer],
      [dstStride],
    )
    if (scaledHeight < 0) throw new Error(`native crop sws_scale failed: ${scaledHeight}`)
    if (scaledHeight !== target.height) {
      throw new Error(`native crop scaler produced ${scaledHeight} of ${target.height} rows`)
    }
    if (dstStride === tightStride) return dstBuffer.subarray(0, tightStride * target.height)
    return packSinglePlane(dstBuffer, dstStride, target.width, target.height, 3)
  }

  /**
   * `pinnedRgbCrop` software crop — the retained frame is ALREADY pinned
   * full-range RGB24 (color resolved once at download), so this is a pure
   * SPATIAL crop + RGB→RGB resize: offset the single packed plane to the crop
   * origin (zero-copy) and scale ONLY the ROI. NO color math, NO YUV planes, NO
   * provenance marker (the conversion happened + was logged at download time).
   * Mirrors {@link nativeScaleCropToBuffer}'s stride-alignment + tail-slack
   * discipline exactly (same SIMD-overshoot heap-corruption guard).
   */
  private nativeRgbCropToBuffer(
    nav: NodeAvModule,
    C: NodeAvConstants,
    frame: NavFrame,
    resolved: ResolvedNativeCrop,
  ): Uint8Array {
    const { region, target } = resolved
    const plane = frame.data?.[0]
    if (!plane) {
      throw new Error('decode-worker-child: retained RGB frame missing packed plane data')
    }
    const srcStride = frame.linesize[0] ?? 0
    // Packed RGB24 → 3 bytes/px. Prefer the zero-copy stride-offset view, but a
    // bottom/right-edge ROI leaves the plane tail `left*3` bytes short of the
    // span libswscale reads, so `resolveRgbCropSource` repacks THOSE (and only
    // those) into a slack-padded tight buffer. This is the subject-ROI-vs-full-
    // frame asymmetry fix: full-frame crops were always exactly sized (landed),
    // edge ROIs over-read and threw → reported as a native miss.
    const { src: srcRgb, stride: srcSliceStride } = resolveRgbCropSource(plane, srcStride, region)
    // Zero-copy Buffer view (scaleSync wants a Buffer; `srcRgb` is either the
    // plane subarray or the repacked ROI buffer — both back a Buffer view).
    const srcSlice = Buffer.from(srcRgb.buffer, srcRgb.byteOffset, srcRgb.byteLength)
    const scaler = this.ensureNativeCropScaler(
      nav,
      C,
      region.width,
      region.height,
      target.width,
      target.height,
      'rgb24',
    )
    // Same SIMD-overshoot guard as the YUV path: aligned dst stride + a 64-byte
    // tail slack so the last row's overshoot never lands past the allocation.
    const tightStride = target.width * 3
    const dstStride = (tightStride + 63) & ~63
    const dstBuffer = Buffer.allocUnsafe(dstStride * target.height + 64)
    const scaledHeight = scaler.scaleSync(
      [srcSlice],
      [srcSliceStride],
      0,
      region.height,
      [dstBuffer],
      [dstStride],
    )
    if (scaledHeight < 0) throw new Error(`native rgb crop sws_scale failed: ${scaledHeight}`)
    if (scaledHeight !== target.height) {
      throw new Error(`native rgb crop scaler produced ${scaledHeight} of ${target.height} rows`)
    }
    if (dstStride === tightStride) return dstBuffer.subarray(0, tightStride * target.height)
    return packSinglePlane(dstBuffer, dstStride, target.width, target.height, 3)
  }

  /**
   * Hardware native crop — run the retained GPU surface through a DEDICATED
   * crop filtergraph (`hwdownload,format=nv12,crop=…,scale=…,format=rgb24`) and
   * pack the small result. Mirrors {@link hwScaleToBuffer} but uses its OWN
   * cached filter and, on error, throws WITHOUT degrading the session.
   */
  private nativeHwCropToBuffer(frame: NavFrame, resolved: ResolvedNativeCrop): Uint8Array {
    const { region, target } = resolved
    const color = this.resolveFrameColor(frame)
    this.logColorProvenance('hw-crop', color)
    const filter = this.ensureNativeCropHwFilter(region, target, color)
    const outputs = filter.processAllSync(frame)
    const first = outputs[0]
    if (!first) {
      for (const out of outputs) out.free()
      throw new Error('native crop GPU filtergraph produced no frame')
    }
    try {
      const plane = first.data?.[0]
      if (!plane) throw new Error('native crop GPU frame missing packed plane data')
      return packSinglePlane(plane, first.linesize[0] ?? 0, target.width, target.height, 3)
    } finally {
      for (const out of outputs) out.free()
    }
  }

  /**
   * Build-once / reuse the dedicated native-crop software scaler (rgb out).
   * `srcFormat` names the SOURCE layout so the scaler matches the retained
   * frame: `yuv420p` (flag OFF / degrade — YUV→RGB convert), `nv12` (a
   * two-plane retained frame — libswscale reads it natively, so this is the same
   * single pass, not a conversion) or `rgb24` (`pinnedRgbCrop` — a pure RGB→RGB
   * spatial resize). The cache key folds the format in so scalers of identical
   * geometry never alias one slot (see {@link nativeCropScalerKey}).
   */
  private ensureNativeCropScaler(
    nav: NodeAvModule,
    C: NodeAvConstants,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    srcFormat: NativeCropSourceFormat,
  ): NavScaler {
    const srcFmt = navPixelFormatFor(srcFormat, C)
    const key = nativeCropScalerKey(srcW, srcH, dstW, dstH, srcFormat)
    const cached = this.nativeCropScaler
    if (cached && key === this.nativeCropScalerKey) return cached
    this.native.run('nativeCropScaler', () => this.nativeCropScaler?.[Symbol.dispose]?.())
    this.nativeCropScaler = null
    this.nativeCropScalerKey = ''
    const scaler = new nav.SoftwareScaleContext()
    scaler.getContext(srcW, srcH, srcFmt, dstW, dstH, C.AV_PIX_FMT_RGB24, C.SWS_FAST_BILINEAR)
    const initRet = scaler.initContext()
    if (initRet < 0) {
      this.native.run('nativeCropScaler', () => scaler[Symbol.dispose]?.())
      throw new Error(`native crop sws_init_context failed: ${initRet}`)
    }
    this.nativeCropScaler = scaler
    this.nativeCropScalerKey = key
    return scaler
  }

  /** Build-once / reuse the dedicated native-crop GPU filtergraph (rgb out). */
  private ensureNativeCropHwFilter(
    region: ResolvedRegion,
    target: ResizeTarget,
    color: ResolvedSourceColor,
  ): NavFilterApi {
    const nav = this.nav
    const scaleFilter = this.gpuScaleFilter
    if (!nav || !scaleFilter || !this.hwContext) {
      throw new Error('decode-worker-child: native GPU crop requested without a HW context')
    }
    // Color key folded in — a colorspace/range change must rebuild the graph.
    const key = `${region.left},${region.top},${region.width},${region.height}->${target.width}x${target.height}:${sourceColorKey(color)}`
    const cached = this.nativeCropHwFilter
    if (cached && key === this.nativeCropHwFilterKey) return cached
    this.native.run('nativeCropHwFilter', () => this.nativeCropHwFilter?.close())
    this.nativeCropHwFilter = null
    this.nativeCropHwFilterKey = ''
    const description = buildGpuFilterDescription(
      scaleFilter,
      region,
      target,
      false,
      'rgb24',
      color,
    )
    const filter = nav.FilterAPI.create(description, {
      hardware: this.hwContext,
      threads: FILTER_THREADS,
    })
    this.nativeCropHwFilter = filter
    this.nativeCropHwFilterKey = key
    return filter
  }

  private handleStop(): void {
    this.requestExit(0)
  }

  private async runDecodeLoop(url: string): Promise<void> {
    const nav = await getNodeAv()
    const C = await getConstants()
    if (this.stopped) return
    this.nav = nav
    this.consts = C
    // Silence per-missed-ref HEVC ERROR spam (mirrors the push/pull decoder).
    nav.Log.setLevel(C.AV_LOG_FATAL)
    const hwContextStartedAt = Date.now()
    await this.ensureHwContext(nav, C)
    this.hwContextMs = Date.now() - hwContextStartedAt

    while (!this.stopped) {
      try {
        await this.dialAndDecode(nav, C, url)
      } catch (err) {
        if (this.stopped) break
        this.emitStderr(`decode-worker-child: dial ended — re-dial scheduled: ${errMessage(err)}\n`)
      } finally {
        // The loop has left the input, so closing it is safe here — what to
        // close is `inputCloseAfterLoop`: everything on a re-dial; only the
        // demuxer on a drain (held surfaces belong to the decoder's pool);
        // nothing on exit (process exit reclaims it).
        const close = inputCloseAfterLoop({ draining: this.draining, exiting: this.exiting })
        if (close === 'all') this.closeInput()
        else if (close === 'demuxer-only') {
          this.native.run('demuxer', () => this.demuxer?.[Symbol.dispose]?.())
          this.demuxer = null
        }
      }
      if (this.stopped) break
      // A re-dial requested specifically to switch to the software path skips
      // the backoff so first-frame latency isn't paid twice for the fallback.
      const skipBackoff = this.redialAsSoftware
      this.redialAsSoftware = false
      if (!skipBackoff) await this.sleep(REDIAL_MS)
    }
  }

  /**
   * One dial: open the demuxer, pick the video stream, build a HW/SW decoder,
   * and pump `demuxer.packets → decoder.frames → consumeDecodedFrame` until the
   * stream ends, errors, or teardown aborts it.
   *
   * Two decoder shapes, selected by {@link hwFilterDecision} (picked once per
   * session):
   * - HW path (`undecided`/`hardware`): NO `rescale` — the decoder keeps frames
   *   as GPU surfaces so `toBuffer` can crop+scale them on the GPU and download
   *   only the small detection-sized result.
   * - Software path (`software`): `rescale.pixelFormat: YUV420P` forces a
   *   full-res GPU→system download so the CPU ROI scaler reads plain planes.
   *   This is the ORIGINAL contract — keeping decoded frames on the GPU leaked
   *   the VAAPI surface pool on every re-dial (see `nodeav-decoder-session.ts`);
   *   the HW path avoids that leak by closing its filtergraph + freeing every
   *   surface on every re-dial/teardown (see {@link closeInput}/{@link teardown}).
   *
   * Same demuxer options + `exitOnError: false` bad-frame tolerance throughout.
   */
  private async dialAndDecode(nav: NodeAvModule, C: NodeAvConstants, url: string): Promise<void> {
    // Fresh dial: clear a previous dial's broken-download flag, then arm —
    // a fresh dial builds a fresh graph, and an on-motion session dispatches
    // BECAUSE something is happening, so the first track's media should be
    // native-quality before any crop request has been seen.
    this.leaseGate.reset()
    this.leaseGate.arm()
    this.dialStartedAt = Date.now()
    this.dialSeq++
    this.leaseDownloadFailuresThisDial = 0
    this.leaseDownloadRebuildCap.resetForDial()
    this.abortController = new AbortController()
    // The stream-info probe is skipped when the opened input already describes
    // its video stream — which the broker's own restream always does, because
    // it refuses PLAY until it has the parameter sets. See
    // `pull-demuxer-open.ts` for the measurement and the fallback.
    const opened = await openPullDemuxer({
      url,
      demuxerOptions: buildDemuxerOptions(this.consumerTag()),
      signal: this.abortController.signal,
      open: (target, options) => nav.Demuxer.open(target, options),
      forceStreamInfoProbe: FORCE_STREAM_INFO_PROBE,
      note: (message) => this.emitStderr(message),
    })
    const demuxer = opened.demuxer
    if (this.stopped) {
      this.native.run('demuxer', () => demuxer[Symbol.dispose]?.())
      return
    }
    this.demuxer = demuxer

    const videoStream = demuxer.video()
    if (!videoStream) {
      throw new Error('decode-worker-child: pull input has no video stream')
    }

    const wantHwFrames = this.hwContext !== null && this.hwFilterDecision !== 'software'
    const decoderStartedAt = Date.now()
    const decoder = await nav.Decoder.create(videoStream, {
      ...(this.hwContext ? { hardware: this.hwContext } : {}),
      // HW path keeps GPU surfaces (no rescale); software path forces YUV420P.
      ...(wantHwFrames ? {} : { rescale: { pixelFormat: C.AV_PIX_FMT_YUV420P } }),
      // ── Codec threads, bounded ─────────────────────────────────────────
      //
      // Left at auto, libavcodec creates min(cores, 16) frame threads — and it
      // creates them even under VAAPI, which never uses them. Measured on this
      // hub 2026-09-18: every live worker carried 16 `av:h264:dfN` threads it
      // could not have been using, on top of its filter pools, for a total of
      // 45-126 threads per worker with up to 8 workers alive.
      //
      // That is charged to the container's pid cgroup, whose ceiling is 2048
      // and which was REFUSING creations — 22 in 45 minutes, one of which lost
      // a subject tile on camera 107. The refusals arrive as
      // `glib: Error creating thread`, never as "out of pids".
      //
      // One under hardware, where the GPU does the work. On the software
      // fallback a 4K stream really is a parallel job, so it keeps a few — but
      // a few, not one per core.
      context: { threadCount: wantHwFrames ? 1 : SOFTWARE_DECODE_THREADS },
      exitOnError: false,
    })
    const decoderCreateMs = Date.now() - decoderStartedAt
    if (this.stopped) {
      this.native.run('decoder', () => decoder[Symbol.dispose]?.())
      return
    }
    this.decoder = decoder

    const decodeStartedAt = Date.now()
    for await (const frame of decoder.frames(demuxer.packets(videoStream.index))) {
      if (this.stopped) {
        // The frame decoded after a drain/stop is nobody's: freed on a drain,
        // left to process exit on the exit path (D652).
        releaseFrameAfterStop(frame, { draining: this.draining, exiting: this.exiting })
        break
      }
      if (!frame) continue // exitOnError:false skips bad frames as null — keep decoding.
      // Reported from HERE — before the GPU-filter probe and before publishing —
      // so `firstDecodeMs` is libav's cost and not this worker's own work. It
      // rides ahead of the `frame` reply this frame will produce, which is what
      // lets the pump attach it to the first-frame line.
      this.reportDialTiming({
        hwContextMs: this.hwContextMs,
        demuxerOpenMs: opened.demuxerOpenMs,
        decoderCreateMs,
        firstDecodeMs: Date.now() - decodeStartedAt,
        streamInfoProbed: opened.streamInfoProbed,
      })
      this.consumeDecodedFrame(frame)
      // The GPU-filter probe (or a runtime degrade) asked to re-dial as
      // software — break so the loop rebuilds the decoder with YUV420P rescale.
      if (this.redialAsSoftware) break
    }
  }

  /**
   * Send the cold-start split ONCE — for the dial that produced the first
   * decoded frame of this worker's life.
   *
   * Not sent on later dials on purpose: a re-dial's numbers are a different
   * question (a degrade-to-software rebuild, a reconnect), and letting them
   * overwrite the cold start would make the one line the operator reads mean
   * two different things depending on what happened afterwards.
   */
  private reportDialTiming(timing: WorkerDialTiming): void {
    if (this.dialTimingSent) return
    this.dialTimingSent = true
    this.send({ kind: 'dialTiming', ...timing })
  }

  /**
   * Route a decoded frame according to the session's {@link hwFilterDecision}.
   * On the software path a frame is published straight to the latest-wins slot;
   * on the HW path the FIRST GPU surface is probed through the GPU filtergraph
   * to commit (or fall back) the path, then GPU surfaces are published for
   * `toBuffer` to crop+scale on the GPU. Publishing itself (drop-older, the
   * `minIntervalMs` throttle, resolving a pending `pull`) is `FrameSlot`'s job.
   */
  private consumeDecodedFrame(frame: NavFrame): void {
    this.framesDecoded++
    if (this.hwFilterDecision === 'software') {
      // Software session: the decoder downloads every frame to YUV420P. A stray
      // HW frame (a failed GPU→system download) can't be read by the CPU scaler
      // — drop it (the original defensive guard) and count it as skipped.
      if (frame.isHwFrame()) {
        this.framesSkipped++
        frame.free()
        return
      }
      this.publishFrame(frame)
      return
    }
    // `undecided` or `hardware`: the decoder is emitting GPU surfaces.
    if (!frame.isHwFrame()) {
      // Decoder produced software frames despite the HW request (an internal
      // software fallback) — re-dial into the normalised YUV420P software path.
      this.framesSkipped++
      frame.free()
      this.degradeToSoftware()
      return
    }
    if (this.hwFilterDecision === 'undecided') {
      if (!this.probeHwFilter(frame)) {
        this.framesSkipped++
        frame.free()
        this.degradeToSoftware()
        return
      }
      this.hwFilterDecision = 'hardware'
      this.emitStderr(`decode-worker-child: GPU crop+scale path active (${this.gpuScaleFilter})\n`)
    }
    this.publishFrame(frame)
  }

  /**
   * Publish to the latest-wins slot; deliver immediately if a `pull` is pending.
   *
   * ## Where the pre-roll used to die
   *
   * This method used to be one line: `this.frames.publish(frame, Date.now(),
   * this.minIntervalMs)`. `FrameSlot.publish` throttles by comparing that
   * `Date.now()` against the previous publish's, and during a catch-up burst
   * that comparison is meaningless — the restreamer replays ~4 s of retained
   * media and the decoder chews through all of it inside a few hundred
   * milliseconds of WALL clock. So the throttle admitted one or two frames of
   * the whole window and `frame.free()`d the rest, and the two frames on which
   * device 102's cyclist scored above the vehicle floor (0.5669 and 0.5366,
   * 1.68 s before the live track was born) were freed here, having been
   * received, decoded and paid for in full.
   *
   * The fix is not to weaken the throttle. A live frame still paces on wall
   * clock, unchanged. A HISTORY frame paces on its own MEDIA clock instead,
   * under an explicit budget, because media time is the only clock on which
   * "one frame per 333 ms of footage" means what it says.
   */
  private publishFrame(frame: NavFrame): void {
    const now = Date.now()
    const mediaWall = this.mediaWallClockOfFrame(frame, now)
    const verdict = this.offerToPreRollBurst(mediaWall, now)
    if (verdict === 'dropped') {
      // A branch that drops work says so. Counted here and reported once per
      // session on the `preRollReport` reply — silence reads as "never
      // happened", which is exactly how this bug survived.
      this.framesSkipped++
      frame.free()
      return
    }
    const preRoll = verdict === 'pre-roll'
    // History bypasses the wall-clock throttle (its stride was already applied
    // in media time); live keeps it untouched.
    const reply = this.frames.publish(
      frame,
      preRoll ? mediaWall : now,
      preRoll ? 0 : this.minIntervalMs,
      { capturedAt: mediaWall, preRoll },
    )
    if (reply) {
      this.pendingPull = false
      this.deliverFrame(reply)
    }
  }

  /**
   * The frame's own moment, from its pts — or the wall clock when the source
   * cannot say.
   *
   * The media clock is anchored on the FIRST frame of the session: that frame
   * is `preRollMs` old by construction, because the pre-roll is what the dial
   * asked for and the restreamer serves it before anything live. A source whose
   * pts cannot be converted (no time base, a zero denominator) gets no clock at
   * all and therefore no burst — a fabricated media time would date a whole
   * burst of detections at one wrong instant, which is worse than not inferring
   * them at all.
   */
  private mediaWallClockOfFrame(frame: NavFrame, now: number): number {
    const ptsMs = this.frameMediaPtsMs(frame)
    if (ptsMs === null) return now
    // Same dial ⇒ same anchor. A NEW dial (warm re-attach, GPU degrade,
    // reconnect) restarts the pts epoch and gets a fresh anchor on ITS first
    // frame — measured 2026-09-09: an anchor kept across a re-dial dated every
    // later frame 268 s in the past for the rest of the session.
    if (this.mediaClock === null || this.mediaClock.dialSeq !== this.dialSeq) {
      // The SERVED span, not the requested one — and we do not have it here.
      //
      // `this.preRollMs` is what the dial ASKED for (15 000 ms). Measured
      // 2026-09-09 across 18 bursts, the broker served 1 270–6 391 ms, and
      // using the ask for both of the values below broke both halves of D411:
      //   - the anchor back-dated EVERY frame of every session by the
      //     difference, pushing `frameAge.avg` to 10–15 s on three nodes and
      //     twelve cameras against a 5 ms baseline;
      //   - the stride came out 15000/12 = 1250 ms on all 18 bursts, so the
      //     pass sampled history at 0.8 fps and dropped 96–98 % of the frames
      //     it was offered — while the case D411 exists to catch had its two
      //     above-floor frames 100 ms apart.
      //
      // The ANCHOR stays at NOW, and that is still the honest answer: how far
      // in the past this first frame really sits is the SERVED span, the
      // restreamer's `preRollSpanMs`, and it does not reach this process.
      // Back-dating every frame by the ASK instead was measured to push
      // `frameAge.avg` to 10-15 s across three nodes and twelve cameras
      // against a 5 ms baseline. A number nobody measured is not a better
      // anchor than none (D393).
      //
      // What DID change is the burst. It used to be suppressed with the anchor,
      // on the reasoning that a burst planned on an unknown span is the defect
      // — and the cost of that was 1 157 suppressions in 20 h on this fleet,
      // with the broker's ~4 s of history decoded and discarded every time.
      // The tracks the operator flagged start late for exactly this reason.
      //
      // The span is not needed to know a frame is HISTORY. While the decoder
      // races through buffered media it produces frames faster than real time,
      // so each frame's own moment leads the wall clock; when the two converge
      // it has caught up. `PreRollBurst` measures that directly — and reports
      // the span it saw, which is the number this child could never be told.
      this.mediaClock = mediaClockForDial(this.mediaClock, this.dialSeq, {
        firstPtsMs: ptsMs,
        preRollMs: 0,
        nowWall: now,
      })
      if (this.preRollMs > 0 && this.preRollMaxFrames > 0) {
        const preRollCadenceMs = this.minIntervalMs > 0 ? this.minIntervalMs : 1000
        // D652: never send inference more history than the hold keeps — the
        // burst used to evict its own oldest frames before the lane reached
        // them. The REACH (maxFrames × cadence) is kept; only density drops.
        const withinHold = planPreRollWithinHold({
          requestedFrames: this.preRollMaxFrames,
          cadenceMs: preRollCadenceMs,
          holdFrames: this.lease?.values.holdFrames ?? UNSTARTED_LEASE_KNOBS.values.holdFrames,
          holdEnabled: this.leaseStore.enabled,
        })
        this.preRollBudgetFrames = withinHold.budgetFrames
        this.preRollBurst = new PreRollBurst({
          budget: { maxFrames: withinHold.budgetFrames, maxWallMs: PRE_ROLL_BURST_MAX_WALL_MS },
          // The stride is the session's own CADENCE, and the reach is what the
          // frame budget buys at that cadence.
          //
          // Planning it from the ask gave 15 000 / 12 = 1 250 ms on all 18
          // measured bursts — history sampled at 0.8 fps, while the case this
          // exists to catch had its two above-floor frames 100 ms apart. The
          // planner widens a stride to SPREAD a budget across a known window,
          // and the window is exactly what this process does not know; feeding
          // it the ask makes it spread 12 frames over 15 s of history that was
          // never served.
          //
          // So the window handed to the planner is the one the budget can
          // actually cover at cadence (`maxFrames × cadence`), which leaves the
          // stride at the cadence and makes the operator's "Pre-roll frames"
          // slider mean REACH: 12 frames at 10 fps is the newest 1.2 s of
          // history, 30 is 3 s. Dense and short rather than sparse and wide —
          // the opposite trade from the one that shipped, and the one that
          // finds a subject that was already in frame when motion fired.
          // Since D652 that reach is spread over at most `holdFrames - 1`
          // frames (`planPreRollWithinHold`).
          plan: withinHold.plan,
          startedAtWall: now,
        })
      }
    }
    return mediaWallClockOf(this.mediaClock.anchor, ptsMs, now)
  }

  /** This frame's pts in ms, or `null` when the source cannot express one. */
  private frameMediaPtsMs(frame: NavFrame): number | null {
    const pts: unknown = frame.pts
    const timeBase: unknown = frame.timeBase
    if (typeof pts !== 'bigint') return null
    if (typeof timeBase !== 'object' || timeBase === null) return null
    const num: unknown = Reflect.get(timeBase, 'num')
    const den: unknown = Reflect.get(timeBase, 'den')
    if (typeof num !== 'number' || typeof den !== 'number') return null
    return ptsToMs(pts, { num, den })
  }

  /**
   * Ask the burst whether this frame is history worth inferring.
   *
   * `'live'` — no burst, or the burst has ended. The ordinary path, untouched.
   * `'pre-roll'` — inside the budget; delivered marked, to the runner's lane.
   * `'dropped'` — history the budget refused. Freed by the caller and counted.
   */
  private offerToPreRollBurst(mediaWall: number, now: number): 'live' | 'pre-roll' | 'dropped' {
    const burst = this.preRollBurst
    if (!burst) return 'live'
    const verdict = burst.offer(mediaWall, now)
    if (verdict.admitted) {
      if (this.preRollFirstMediaWall === null) this.preRollFirstMediaWall = mediaWall
      this.preRollLastMediaWall = mediaWall
      return 'pre-roll'
    }
    if (burst.finished) {
      // The burst is over. `live-edge` means the decoder caught up and THIS
      // frame is live, so it must be published, not freed. Any other terminal
      // reason means the budget ran out mid-history: that frame is history the
      // live path has no use for, so it goes. Either way the burst is closed
      // and every later frame takes the untouched live path.
      this.endPreRollBurst()
      return verdict.reason === 'live-edge' ? 'live' : 'dropped'
    }
    return 'dropped'
  }

  /** Close the burst and send its accounting — exactly once per session. */
  private endPreRollBurst(): void {
    const burst = this.preRollBurst
    this.preRollBurst = null
    if (!burst || this.preRollReported) return
    this.preRollReported = true
    burst.finish()
    const report = burst.report()
    const first = this.preRollFirstMediaWall
    const last = this.preRollLastMediaWall
    this.send({
      kind: 'preRollReport',
      offered: report.offered,
      inferred: report.inferred,
      dropped: report.dropped,
      droppedByReason: report.droppedByReason,
      strideMs: report.strideMs,
      subsampled: report.subsampled,
      spanMs: first !== null && last !== null ? Math.round(last - first) : 0,
      budgetFrames: this.preRollBudgetFrames,
    })
    const settled = this.preRollSettle.endBurst()
    if (settled) this.send({ kind: 'preRollSettled', ...settled })
  }

  /** One pre-roll frame's fate; sends the settle summary when it was the last owed. */
  private settlePreRoll(frameId: number, outcome: PreRollSettleOutcome): void {
    const settled = this.preRollSettle.settle(frameId, outcome)
    if (settled) this.send({ kind: 'preRollSettled', ...settled })
  }

  /** Send a `frame` reply to the parent and count it toward `deliveredFps`. */
  private deliverFrame(reply: FrameSlotReply): void {
    this.framesDelivered++
    if (reply.preRoll) this.preRollSettle.admit(reply.frameId)
    this.send(this.toFrameReply(reply))
  }

  /**
   * One-shot GPU-filter capability probe on the FIRST decoded HW frame: build a
   * no-op `scale_<be>=iw:ih,hwdownload,format=nv12` graph and push the frame
   * through it. A frame out ⇒ the driver supports GPU crop+scale for this
   * session; any throw / empty output ⇒ fall back to software. The probe graph
   * and its output frames are freed here regardless of outcome, so no surface
   * leaks out of the probe. The input `frame` keeps its own ref (buffersrc only
   * ref'd it) and is published by the caller on success.
   */
  private probeHwFilter(frame: NavFrame): boolean {
    const nav = this.nav
    const scaleFilter = this.gpuScaleFilter
    if (!nav || !scaleFilter || !this.hwContext) return false
    let filter: NavFilterApi | null = null
    try {
      filter = nav.FilterAPI.create(`${scaleFilter}=w=iw:h=ih,hwdownload,format=nv12`, {
        threads: FILTER_THREADS,
        hardware: this.hwContext,
      })
      const outputs = filter.processAllSync(frame)
      const ok = outputs.length > 0
      for (const out of outputs) out.free()
      return ok
    } catch (err) {
      this.emitStderr(
        `decode-worker-child: GPU filter probe failed — using software decode: ${errMessage(err)}\n`,
      )
      return false
    } finally {
      this.native.run('hwFilterProbe', () => filter?.close())
    }
  }

  /**
   * Abandon the GPU filter path for the rest of the session: close the
   * filtergraph (freeing its GPU surface pool), mark the decision `software`,
   * and abort the current HW dial so the decode loop re-dials with a YUV420P
   * rescale. Called from the probe path AND from a runtime `toBuffer` GPU-filter
   * failure, so a surprising driver/format error never leaves the session
   * silently producing no usable frames. Idempotent.
   */
  private degradeToSoftware(): void {
    if (this.hwFilterDecision === 'software') return
    this.hwFilterDecision = 'software'
    this.redialAsSoftware = true
    this.native.run('hwFilter', () => this.hwFilter?.close())
    this.hwFilter = null
    this.hwFilterKey = ''
    this.abortController?.abort()
  }

  private toFrameReply(reply: FrameSlotReply): WorkerReply {
    return {
      kind: 'frame',
      frameId: reply.frameId,
      timestamp: reply.timestamp,
      width: reply.width,
      height: reply.height,
      format: this.sessionFormat,
      // Both ride the SLOT, so a frame published now and pulled later still
      // reports its own moment rather than the pull's.
      capturedAt: reply.capturedAt,
      ...(reply.preRoll ? { preRoll: true } : {}),
    }
  }

  /**
   * ROI `toBuffer`: crop (via plane-pointer offset, not a re-decode) + resize
   * + format-convert a retained decoded frame with `SoftwareScaleContext`.
   * Writes straight into a tightly-packed destination buffer via the
   * low-level `scaleSync` (no `dstFrame` + row-strip step needed — the same
   * zero-copy destination technique as `scaleIntoRingSlot` in
   * `nodeav-decoder-session.ts`, adapted to also OFFSET the source planes so
   * a single scaler call handles the crop.
   */
  private scaleRoiToBuffer(frame: NavFrame, opts: FrameImageOptions | undefined): Uint8Array {
    const nav = this.nav
    const C = this.consts
    if (!nav || !C) throw new Error('node-av not initialized')

    const region = resolveCropRegion(frame.width, frame.height, opts?.crop)
    const target = resolveResizeTarget(region.width, region.height, opts?.resize)
    const requestedFormat = opts?.format ?? this.sessionFormat
    const format = requestedFormat === 'gray' ? 'gray' : 'rgb'
    const dstFmt = format === 'gray' ? C.AV_PIX_FMT_GRAY8 : C.AV_PIX_FMT_RGB24
    const channels = format === 'gray' ? 1 : 3
    // Provenance (RC-5): record which path + source color produced this frame.
    // NOTE: node-av's `SoftwareScaleContext` exposes no `sws_setColorspaceDetails`
    // /option surface, so this CPU path cannot be pinned like the GPU filtergraph;
    // it relies on libswscale's DETERMINISTIC default (limited-YUV→full-RGB for
    // standard content). Because that default is INVARIANT frame-to-frame, the
    // CPU path cannot produce the intermittent one-GOP desaturation (which was a
    // per-frame-metadata divergence — only possible on the auto-converting GPU
    // path). The marker still fires so a CPU-path recurrence would be diagnosable.
    this.logColorProvenance(
      isFullFrameRegion(region, frame.width, frame.height) ? 'sw-fullframe' : 'sw-crop',
      this.resolveFrameColor(frame),
    )

    const kind = softwareRoiKind(frame.format, C)
    if (kind === null) {
      throw new Error(
        `decode-worker-child: decoded frame in unsupported pixel format ${frame.format} ` +
          `(planes=${frame.data?.length ?? 0}, hw=${frame.isHwFrame()})`,
      )
    }
    if (kind === 'rgb24' && format === 'rgb') {
      return this.nativeRgbCropToBuffer(nav, C, frame, { region, target })
    }

    const source =
      kind === 'rgb24'
        ? (() => {
            const plane = frame.data?.[0]
            const stride = frame.linesize[0] ?? 0
            if (!plane || stride <= 0) return null
            const rgb = resolveRgbCropSource(plane, stride, region)
            return { planes: [rgb.src], strides: [rgb.stride] }
          })()
        : resolvePlanarCropSource(kind, frame.data, frame.linesize, region)
    if (!source) {
      throw new Error(
        `decode-worker-child: retained ${kind} frame missing plane data for ` +
          `${region.width}x${region.height}+${region.left}+${region.top} ` +
          `(planes=${frame.data?.length ?? 0})`,
      )
    }

    const scaler = this.ensureScaler(
      nav,
      C,
      region.width,
      region.height,
      target.width,
      target.height,
      dstFmt,
      kind,
    )

    const dstStride = target.width * channels
    // Tail slack is MANDATORY, exactly as on the two native-crop paths above
    // (`nativeScaleCropToBuffer`, `nativeRgbCropToBuffer`): libswscale writes
    // rows with SIMD and can overshoot a row's byte count, and on the LAST row
    // that overshoot lands past the end of the allocation — live glibc
    // `corrupted top size` aborts. Alignment alone does NOT provide it: the
    // detection path's 640px RGB target makes `dstStride` 1920, already
    // 64-aligned, i.e. exactly zero slack. Mirror av_image_alloc's padding and
    // hand back only the pixels.
    const dstBuffer = Buffer.allocUnsafe(dstStride * target.height + 64)
    const srcPlanes = source.planes.map((plane) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength),
    )
    const scaledHeight = scaler.scaleSync(
      srcPlanes,
      [...source.strides],
      0,
      region.height,
      [dstBuffer],
      [dstStride],
    )
    if (scaledHeight < 0) throw new Error(`sws_scale failed: ${scaledHeight}`)
    if (scaledHeight !== target.height) {
      throw new Error(`scaler produced ${scaledHeight} of ${target.height} rows`)
    }
    return dstBuffer.subarray(0, dstStride * target.height)
  }

  /**
   * Build-once / reuse the {@link NavScaler} for a given src+dst geometry and
   * dst format. Rebuilt (old disposed) only when the key changes — detection's
   * ROI + resize target are stable, so this is a per-worker singleton in the
   * steady state. Replaces the previous per-frame `new SoftwareScaleContext()`
   * that leaked native libav memory at frame rate. Synchronous + single-thread
   * (Node), so no epoch/race guard is needed (unlike the async shared session).
   */
  private ensureScaler(
    nav: NodeAvModule,
    C: NodeAvConstants,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    dstFmt: NavPixFmt,
    srcKind: NativeCropSourceFormat = 'yuv420p',
  ): NavScaler {
    const key = `${srcKind}:${srcW}x${srcH}->${dstW}x${dstH}:${dstFmt}`
    const cached = this.scaler
    if (cached && key === this.scalerKey) return cached

    this.native.run('scaler', () => this.scaler?.[Symbol.dispose]?.())
    this.scaler = null
    this.scalerKey = ''

    const scaler = new nav.SoftwareScaleContext()
    scaler.getContext(
      srcW,
      srcH,
      navPixelFormatFor(srcKind, C),
      dstW,
      dstH,
      dstFmt,
      C.SWS_FAST_BILINEAR,
    )
    const initRet = scaler.initContext()
    if (initRet < 0) {
      this.native.run('scaler', () => scaler[Symbol.dispose]?.())
      throw new Error(`sws_init_context failed: ${initRet}`)
    }
    this.scaler = scaler
    this.scalerKey = key
    return scaler
  }

  /**
   * GPU crop+scale `toBuffer`: run the retained GPU surface through the cached
   * GPU filtergraph (`scale_<be>→hwdownload→format` for the full-frame case),
   * pulling ONLY the small detection-sized result into system memory, then pack
   * it into the tightly-packed output buffer. On any GPU-filter failure,
   * {@link degradeToSoftware} flips the whole session to the CPU path (via a
   * re-dial) and this call rethrows so the pump drops just this one frame.
   *
   * Surface lifecycle: the input GPU surface is owned by {@link frames} (freed
   * by the slot lifecycle) — `processAllSync` only ref's it. Every OUTPUT frame
   * the filtergraph returns is freed here in the `finally`.
   */
  private hwScaleToBuffer(frame: NavFrame, opts: FrameImageOptions | undefined): Uint8Array {
    try {
      const region = resolveCropRegion(frame.width, frame.height, opts?.crop)
      const target = resolveResizeTarget(region.width, region.height, opts?.resize)
      const requestedFormat = opts?.format ?? this.sessionFormat
      const format = requestedFormat === 'gray' ? 'gray' : 'rgb'
      const channels = format === 'gray' ? 1 : 3
      const color = this.resolveFrameColor(frame)
      this.logColorProvenance(
        isFullFrameRegion(region, frame.width, frame.height) ? 'hw-fullframe' : 'hw-crop',
        color,
      )
      const filter = this.ensureHwFilter(region, target, frame.width, frame.height, format, color)
      const outputs = filter.processAllSync(frame)
      const first = outputs[0]
      if (!first) throw new Error('GPU filtergraph produced no frame')
      try {
        const plane = first.data?.[0]
        if (!plane) throw new Error('GPU filtergraph frame missing packed plane data')
        return packSinglePlane(plane, first.linesize[0] ?? 0, target.width, target.height, channels)
      } finally {
        for (const out of outputs) out.free()
      }
    } catch (err) {
      this.degradeToSoftware()
      throw err instanceof Error ? err : new Error(errMessage(err))
    }
  }

  /**
   * Build-once / reuse the GPU crop+scale {@link NavFilterApi} for a given crop
   * region + resize target + pixel format — the HW analogue of
   * {@link ensureScaler}. Rebuilt (old CLOSED, freeing its GPU surface pool)
   * only when the key changes; detection's ROI + resize target are stable, so
   * this is a per-worker singleton in the steady state.
   */
  private ensureHwFilter(
    region: ResolvedRegion,
    target: ResizeTarget,
    srcW: number,
    srcH: number,
    format: 'rgb' | 'gray',
    color: ResolvedSourceColor,
  ): NavFilterApi {
    const nav = this.nav
    const scaleFilter = this.gpuScaleFilter
    if (!nav || !scaleFilter || !this.hwContext) {
      throw new Error('decode-worker-child: GPU filter requested without a HW context')
    }
    const fullFrame = isFullFrameRegion(region, srcW, srcH)
    const pixel = pixelFilterName(format)
    // The color key MUST be part of the cache key: a mid-session colorspace/range
    // change must rebuild the pinned-conversion graph, not reuse the old one.
    const key = `${region.left},${region.top},${region.width},${region.height}->${target.width}x${target.height}:${pixel}:${sourceColorKey(color)}`
    const cached = this.hwFilter
    if (cached && key === this.hwFilterKey) return cached

    this.native.run('hwFilter', () => this.hwFilter?.close())
    this.hwFilter = null
    this.hwFilterKey = ''

    const description = buildGpuFilterDescription(
      scaleFilter,
      region,
      target,
      fullFrame,
      pixel,
      color,
    )
    const filter = nav.FilterAPI.create(description, {
      hardware: this.hwContext,
      threads: FILTER_THREADS,
    })
    this.hwFilter = filter
    this.hwFilterKey = key
    return filter
  }

  /**
   * Resolve the HW context ONCE (reused across every re-dial, freed in
   * `teardown`). Tries the platform's ordered candidate list; the first
   * `HardwareContext.create` that succeeds wins; every failure falls through
   * to software decode (`hardware` omitted from `Decoder.create`). When a GPU
   * device is found, the session becomes a GPU crop+scale CANDIDATE
   * (`hwFilterDecision = 'undecided'`) only if a `scale_<be>` filter exists for
   * that backend — otherwise it stays on the software path.
   */
  private async ensureHwContext(nav: NodeAvModule, C: NodeAvConstants): Promise<void> {
    // Only what the node's resolver offers: a node whose libva cannot
    // initialise the driver offers no vaapi/qsv, and that was already logged
    // ONCE at resolve time — trying it here again cost a failure per session.
    const candidates = sessionDecodeCandidates(process.platform, this.hwaccelOffer)
    if (candidates.length === 0) return
    for (const backend of candidates) {
      const deviceType = backendToHwDeviceConst(backend, C)
      if (deviceType === null) continue
      const hw = nav.HardwareContext.create(deviceType)
      if (!hw) {
        this.emitStderr(
          `decode-worker-child: hwaccel candidate '${backend}' failed — trying next\n`,
        )
        continue
      }
      this.hwContext = hw
      this.gpuScaleFilter = gpuScaleFilterForBackend(backend)
      this.hwFilterDecision = this.gpuScaleFilter !== null ? 'undecided' : 'software'
      return
    }
    this.emitStderr('decode-worker-child: no hwaccel backend available — using software decode\n')
  }

  /** Interruptible re-dial backoff — `teardown` clears the pending timer. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.redialTimer = setTimeout(() => {
        this.redialTimer = null
        resolve()
      }, ms)
    })
  }

  /**
   * Dispose the CURRENT dial's demuxer + decoder (the HW *device* context is
   * reused across dials). The GPU filtergraph is closed FIRST: it references the
   * decoder's per-dial `hw_frames_ctx` AND owns the `scale_<be>` OUTPUT surface
   * pool, so freeing it before the decoder is what stops re-dials from
   * accumulating VAAPI surfaces (the exact prior leak). It is rebuilt lazily on
   * the next dial's first `toBuffer`.
   */
  private closeInput(): void {
    // Free EVERY retained native surface + its crop filtergraph BEFORE the
    // decoder/hw_frames_ctx they reference is disposed — same ordering + rigor
    // as the detection `hwFilter` below (a re-dial builds a fresh pool; a
    // retained surface from the old pool must not outlive it). This is what
    // keeps native retention from re-introducing the VAAPI surface-pool leak.
    this.native.run('nativeRing', () => this.nativeRing.clear())
    // A pending mark still holds a native surface from this dial — free it
    // before the decoder/hw_frames_ctx it may reference goes away.
    this.native.run('pendingMark', () => this.pendingMark.clear())
    // The lease store holds DOWNLOADED (system-memory) frames, but its download
    // filtergraph references the decoder's per-dial `hw_frames_ctx`, so both are
    // released here before the decoder is disposed — same rigor as the ring.
    this.native.run('leaseStore', () => this.leaseStore.clear())
    // Every pre-roll frame still owed a read is gone with the hold (a re-dial
    // or teardown): counted as `cleared`, never silently (D652).
    const cleared = this.preRollSettle.settleAll('cleared')
    if (cleared) this.send({ kind: 'preRollSettled', ...cleared })
    this.tileStore.clear()
    // Same rigor, same line: a scene tile is a retained raster derived from the
    // dial that is going away, and a pin that survives its session is a leak.
    this.sceneStore.clear()
    // Release every waiter before the stores they were waiting on go away: a
    // cut belonging to the dial that is ending can never settle now, and a
    // waiter parked on it would sit out its whole bound for nothing.
    this.pendingCuts.clear()
    this.tileFrameWidth = 0
    this.tileFrameHeight = 0
    this.native.run('nativeLeaseDownloadFilter', () => this.nativeLeaseDownloadFilter?.close())
    this.nativeLeaseDownloadFilter = null
    this.nativeLeaseDownloadFilterKey = ''
    this.native.run('nativeCropHwFilter', () => this.nativeCropHwFilter?.close())
    this.nativeCropHwFilter = null
    this.nativeCropHwFilterKey = ''
    this.native.run('hwFilter', () => this.hwFilter?.close())
    this.hwFilter = null
    this.hwFilterKey = ''
    this.native.run('decoder', () => this.decoder?.[Symbol.dispose]?.())
    this.decoder = null
    this.native.run('demuxer', () => this.demuxer?.[Symbol.dispose]?.())
    this.demuxer = null
  }

  /**
   * Load the native modules BEFORE any session, then say so. This is what a
   * pre-forked worker in the zygote pool (`decode-worker-pool.ts`) spends its
   * idle on — node-av's `dlopen` measured ~50 ms on the hub, and after D453
   * removed the types chunk it is the largest piece of a cold boot that is left.
   * It touches no stream, no demuxer, no GPU: a warm worker costs RSS and
   * nothing else, which is the property the pool exists for and the exact
   * inverse of the keep-warm D282 measured.
   *
   * A failure is reported, not fatal: `start` re-runs the same import and
   * fails the session the way it always has, so a node where node-av cannot
   * load is no worse off than before — it just is not warm.
   */
  async warm(): Promise<void> {
    try {
      await getNodeAv()
      await getConstants()
      this.send({ kind: 'ready', warm: true })
    } catch (err) {
      this.emitStderr(
        `decode-worker-child: native module preload failed — ${errMessage(err)}\n`,
        'warn',
      )
      this.send({ kind: 'ready', warm: false })
    }
  }

  private send(reply: WorkerReply): void {
    if (!process.send) return
    // Tracked until the channel took it, so a shutdown can wait for the last
    // lines instead of exiting over them (`createWorkerExit`, D652).
    const done = this.outbound.begin()
    try {
      process.send(reply, undefined, undefined, () => done())
    } catch {
      done()
    }
  }

  /**
   * The `User-Agent` this worker's RTSP dial carries — its identity inside the
   * broker's `RtspSession`, and the ONLY key that joins a burst the broker
   * served to the first frame this worker produced from it.
   *
   * Shaped `decode/<deviceId>/<dial>` after the recorder's `consumerTag`. `?`
   * for a device id that has not arrived yet, which is itself worth seeing: a
   * dial made before the source message is a dial nobody can attribute.
   */
  private consumerTag(): string {
    return `decode/${this.deviceId ?? '?'}/${this.dialSeq}`
  }

  /**
   * Write one diagnostic line to the (inherited) stderr, prefixed with the
   * device tag so the per-device log UI can attribute the forked worker's
   * output. Public so the module-level process handlers — which only hold the
   * `worker` instance — emit device-tagged lines too. Callers pass the line
   * INCLUDING its trailing newline (unchanged from the prior direct writes).
   *
   * `level` overrides the derived severity for the few lines whose importance
   * is not inferable from their words — the lease-knob line states an
   * operator's configuration taking effect and would otherwise sit at `debug`,
   * where a setting that failed to arrive is indistinguishable from silence.
   */
  emitStderr(line: string, level?: WorkerLogLevel): void {
    const tag = this.deviceId === null ? '[dev:?]' : `[dev:${this.deviceId}]`
    // Once the inherited stderr has failed, its reader is gone: every further
    // raw write would only raise another EPIPE (D666). The IPC copy below is
    // unaffected — the parent may well still be there.
    if (!this.stderrLost) {
      try {
        process.stderr.write(`${tag} ${line}`)
      } catch {
        this.stderrLost = true
      }
    }
    // ALSO forward to the coordinator so the line lands in the runner's scoped
    // logger (→ `addons.getLogs`); the inherited raw stderr above is NOT
    // captured there, which hid every worker-side native-crop failure. Severity
    // is derived from the line so failures surface at `warn` (visible at the
    // default log level) while routine provenance/transition lines stay `debug`.
    // Guarded: a closed IPC channel must never crash the worker over a log line.
    try {
      this.send({
        kind: 'log',
        level: level ?? logLevelForLine(line),
        message: `${tag} ${line.trimEnd()}`,
      })
    } catch {
      /* channel gone — the raw stderr line above still carries the diagnostic */
    }
  }

  /**
   * The inherited stderr failed (EPIPE — its reader died with the process that
   * held it). From here on {@link emitStderr} forwards over IPC only (D666).
   */
  markStderrLost(): void {
    this.stderrLost = true
  }

  private sendError(message: string, frameId?: number): void {
    this.emitStderr(`${message}\n`)
    this.send(
      frameId === undefined ? { kind: 'error', message } : { kind: 'error', message, frameId },
    )
  }
}
