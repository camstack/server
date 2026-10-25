import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AddonHeapProfile } from '@camstack/types'

/** One addon hosted inside a runner subprocess. */
export interface RunnerAddonSpec {
  readonly addonId: string
  readonly addonDir: string
}

/** The memory declarations one addon's manifest makes about its own runner. */
export interface AddonHeapDeclaration {
  readonly profile: AddonHeapProfile | undefined
  /** `execution.maxOldSpaceMb`, when declared. `0` means "this addon opts out of a ceiling". */
  readonly maxOldSpaceMb: number | undefined
  /**
   * `execution.rssBudgetMb`, when declared — the whole-process footprint the addon's role
   * considers legitimate. `undefined` means the addon declares no budget, which is NOT a
   * request for a default: a runner where nobody declares one reports itself UNWATCHED.
   */
  readonly rssBudgetMb: number | undefined
  /**
   * `execution.semiSpaceMb`, when declared and inside {@link SEMI_SPACE_MB_RANGE} — the
   * young-generation semi-space the addon measured its runner needs. See `AddonExecution`.
   */
  readonly semiSpaceMb: number | undefined
  /**
   * `execution.initialOldSpaceMb`, when declared and inside {@link INITIAL_OLD_SPACE_MB_RANGE}
   * — the old-space headroom the runner starts with. See `AddonExecution`.
   */
  readonly initialOldSpaceMb: number | undefined
}

const EMPTY_HEAP_DECLARATION: AddonHeapDeclaration = {
  profile: undefined,
  maxOldSpaceMb: undefined,
  rssBudgetMb: undefined,
  semiSpaceMb: undefined,
  initialOldSpaceMb: undefined,
}

/** Inclusive MB bounds a manifest value must sit in to be a declaration at all. */
export interface ManifestMbRange {
  readonly min: number
  readonly max: number
}

/**
 * `execution.semiSpaceMb` is accepted in `[1, 256]` MB. V8 itself clamps the flag to its
 * own limits (the 64-bit default is 64 MB after Node 24's scavenger change, a 256 MB
 * semi-space is three times anything measured useful here); below 1 MB the flag is
 * meaningless. Outside the range the declaration is IGNORED (the runner keeps its class
 * default) rather than clamped: a clamped number silently becomes a different setting from
 * the one in the file, and the spawn log would then say something the manifest does not.
 */
export const SEMI_SPACE_MB_RANGE: ManifestMbRange = { min: 1, max: 256 }

/**
 * `execution.initialOldSpaceMb` is accepted in `[16, 65536]` MB. Below 16 MB V8's default
 * already starts larger; 64 GB clears any runner in this fleet. The accepted value is then
 * clamped at spawn to the runner's old-space CEILING (`runnerHeapFlags`) — V8 refuses an
 * initial size above `--max-old-space-size`, and the ceiling is the one number that belongs
 * to the runner as a whole.
 */
export const INITIAL_OLD_SPACE_MB_RANGE: ManifestMbRange = { min: 16, max: 65536 }

/** An integer MB inside `range`, else `undefined` — a non-integer is floored first. */
function mbInRange(value: unknown, range: ManifestMbRange): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const mb = Math.floor(value)
  return mb >= range.min && mb <= range.max ? mb : undefined
}

/**
 * Resolve the declared heap profile + old-space ceiling for one addon by reading its package.json
 * manifest (`camstack.addons[].execution.{heapProfile,maxOldSpaceMb}`). `addonDir` points at the
 * addon's built `dist`, so the manifest is one level up; we also try `addonDir` itself for layouts
 * where it IS the package root.
 * Result is cached per (dir,id) — spawns are infrequent but a runner may re-spawn on crash/restart.
 * Returns an empty declaration when the manifest is unreadable → treated as light, default ceiling.
 */
const heapProfileCache = new Map<string, AddonHeapDeclaration>()

export function readAddonHeapDeclaration(spec: RunnerAddonSpec): AddonHeapDeclaration {
  const cacheKey = `${spec.addonDir}::${spec.addonId}`
  const cached = heapProfileCache.get(cacheKey)
  if (cached !== undefined) return cached

  let declaration: AddonHeapDeclaration = EMPTY_HEAP_DECLARATION
  for (const manifestPath of [
    path.join(spec.addonDir, 'package.json'),
    path.join(path.dirname(spec.addonDir), 'package.json'),
  ]) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const profile = extractHeapProfile(parsed, spec.addonId)
      const maxOldSpaceMb = extractMaxOldSpaceMb(parsed, spec.addonId)
      const rssBudgetMb = extractRssBudgetMb(parsed, spec.addonId)
      const semiSpaceMb = extractSemiSpaceMb(parsed, spec.addonId)
      const initialOldSpaceMb = extractInitialOldSpaceMb(parsed, spec.addonId)
      if (
        profile !== undefined ||
        maxOldSpaceMb !== undefined ||
        rssBudgetMb !== undefined ||
        semiSpaceMb !== undefined ||
        initialOldSpaceMb !== undefined
      ) {
        declaration = { profile, maxOldSpaceMb, rssBudgetMb, semiSpaceMb, initialOldSpaceMb }
        break
      }
      // A readable manifest with no declaration is authoritative — stop probing further paths.
      if (manifestHasAddon(parsed, spec.addonId)) break
    } catch {
      // try the next candidate path
    }
  }
  heapProfileCache.set(cacheKey, declaration)
  return declaration
}

/**
 * Drop the cached heap declaration for each addon so the NEXT `readAddonHeapDeclaration`
 * re-reads the manifest from disk. Called on operator-driven spawns / restarts
 * (a deploy may have changed `execution.heapProfile` / `execution.maxOldSpaceMb`); the
 * crash-respawn fast path deliberately does NOT invalidate — a crashing runner
 * has the same on-disk manifest, so re-reading it is pure overhead.
 */
export function invalidateHeapProfiles(addons: readonly RunnerAddonSpec[]): void {
  for (const spec of addons) {
    heapProfileCache.delete(`${spec.addonDir}::${spec.addonId}`)
  }
}

function manifestHasAddon(parsed: unknown, addonId: string): boolean {
  return readManifestAddons(parsed).some((a) => a.id === addonId)
}

function extractHeapProfile(parsed: unknown, addonId: string): AddonHeapProfile | undefined {
  const entry = readManifestAddons(parsed).find((a) => a.id === addonId)
  const value = entry?.execution?.heapProfile
  return value === 'heavy' || value === 'light' ? value : undefined
}

function extractMaxOldSpaceMb(parsed: unknown, addonId: string): number | undefined {
  const entry = readManifestAddons(parsed).find((a) => a.id === addonId)
  const value = entry?.execution?.maxOldSpaceMb
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/**
 * `execution.rssBudgetMb` for one addon. Only a POSITIVE finite number is a budget: unlike
 * `maxOldSpaceMb`, `0` here is not an escape hatch that lifts a cap, it is an absent budget —
 * and an absent budget is reported as "unwatched", never rounded into a default.
 */
function extractRssBudgetMb(parsed: unknown, addonId: string): number | undefined {
  const entry = readManifestAddons(parsed).find((a) => a.id === addonId)
  const value = entry?.execution?.rssBudgetMb
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/** `execution.semiSpaceMb` for one addon — only a value inside {@link SEMI_SPACE_MB_RANGE}. */
function extractSemiSpaceMb(parsed: unknown, addonId: string): number | undefined {
  const entry = readManifestAddons(parsed).find((a) => a.id === addonId)
  return mbInRange(entry?.execution?.semiSpaceMb, SEMI_SPACE_MB_RANGE)
}

/** `execution.initialOldSpaceMb` for one addon — only a value inside {@link INITIAL_OLD_SPACE_MB_RANGE}. */
function extractInitialOldSpaceMb(parsed: unknown, addonId: string): number | undefined {
  const entry = readManifestAddons(parsed).find((a) => a.id === addonId)
  return mbInRange(entry?.execution?.initialOldSpaceMb, INITIAL_OLD_SPACE_MB_RANGE)
}

interface ManifestAddonEntry {
  readonly id?: string
  readonly execution?: {
    readonly heapProfile?: string
    readonly maxOldSpaceMb?: number
    readonly rssBudgetMb?: number
    readonly semiSpaceMb?: number
    readonly initialOldSpaceMb?: number
  }
}

function readManifestAddons(parsed: unknown): readonly ManifestAddonEntry[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const camstack = (parsed as { camstack?: unknown }).camstack
  if (typeof camstack !== 'object' || camstack === null) return []
  const addons = (camstack as { addons?: unknown }).addons
  return Array.isArray(addons) ? (addons as readonly ManifestAddonEntry[]) : []
}

/**
 * A runner is heavy if ANY co-located addon declares `heapProfile: 'heavy'` in its manifest.
 * Everything else (the un-annotated default) is a light control-plane runner. No hard-coded names.
 */
export function isHeavyRunner(addons: readonly RunnerAddonSpec[]): boolean {
  return addons.some((a) => readAddonHeapDeclaration(a).profile === 'heavy')
}

/**
 * Default old-space ceiling for a HEAVY runner, in MB.
 *
 * ## Why a heavy runner needs a ceiling at all
 *
 * `heapProfile: 'heavy'` used to mean "V8 defaults", i.e. no `--max-old-space-size` — which on this
 * host is V8's own memory-derived default (multiple GB). Nothing then bounds a burst, and V8 does
 * not hand committed pages back (the long argument for that is in `kernel/heap-watch.ts`), so a
 * one-off burst becomes the runner's permanent RSS.
 *
 * Measured on the live hub, 2026-08-17: the `recorder` runner reaches **2122 MB RSS** and stays
 * there. The same addon on two agent nodes carrying the same code and a smaller archive sits at
 * **58 MB**.
 *
 * ⚠ This paragraph used to attribute that ~2 GB to "walk garbage" from the deferred archive walk,
 * and to argue from a ~21 MB `RecordingIndex`. Both were wrong, and the error cost a session on
 * 2026-08-27. The deferred walk had NO CALLER and never ran (it has since been deleted). And the
 * index is not 21 MB: a 2026-08-27 profile of the live recorder read `heapUsed = 1606 MB` against
 * `external = 8 MB`, with an `smaps` census putting 1510 MB in V8's 256 KB page ranges against
 * 54 MB of native heap — LIVE JavaScript retainers, not high-water garbage. The retained set is
 * ~7.1 M `SegmentRow`s plus their path strings and Map entries (13 cameras x 2 profiles x 8 640
 * segments/day x ~30 days), reseeded at boot by `SegmentHourLedger.hydrateIndex`.
 *
 * The lesson for anyone sizing this flag: a heap number needs a RETAINER, and "garbage the GC has
 * no reason to collect" is the explanation to reach for last, not first.
 *
 * ## Why 1024
 *
 * From the same live topology snapshot, every heavy runner's FULL RSS — which is a strict
 * over-estimate of its old space, since it also contains native allocations, `external` and
 * `arrayBuffers`, none of which `--max-old-space-size` bounds:
 *
 *   detection 471 MB · provider-reolink 507 MB · pipeline-orchestrator 238 MB · ml 218 MB ·
 *   snapshot 185 MB · decoder-nodeav 174 MB · audio-analyzer 170 MB
 *
 * 1024 MB clears the largest of those by ~2x while cutting the recorder's observed ratchet by
 * more than half. It is a CEILING, not a target: a runner that fits today keeps behaving exactly
 * as it does now, because V8 only collects harder as it approaches the limit.
 *
 * A runner whose working set genuinely does not fit declares its own number in its manifest
 * (`execution.maxOldSpaceMb`) — the number belongs next to the addon that knows its working set.
 * `recorder` (3072 MB; peak 2341 MB heapTotal) is the one shipped addon that does. `stream-broker` does NOT, despite 1585 MB peak RSS: ~1 GB of that is
 * `arrayBuffers` (47 RTP rings), which this flag does not bound and never will — its actual old
 * space peaks at 224 MB. Size the declaration from `heapTotal` in the `[mem]` heartbeat, never
 * from RSS.
 *
 * ## What this flag CANNOT do
 *
 * It bounds old space and nothing else — not `external`, not `arrayBuffers`, not what a native
 * addon mallocs. `hub/pipeline-analytics` reached 7334 MB RSS with this flag set to 1024 the
 * whole time, because 96% of it was native. That half is bounded in `runner-native-allocator.ts`.
 * Reaching for a bigger number here when RSS is the complaint is the standard wrong move.
 */
export const HEAVY_MAX_OLD_MB_DEFAULT = 1024

/**
 * V8 platform worker threads for a LIGHT runner (`--v8-pool-size`).
 *
 * ## What this bounds
 *
 * Node gives every process a V8 platform thread pool — background compilation,
 * parallel marking and sweeping — defaulted to 4. It is not the libuv pool
 * (`UV_THREADPOOL_SIZE`, which serves `fs`/`dns`/`zlib`/`crypto`) and it is
 * deliberately not touched here; see below.
 *
 * ## Why it is worth a flag
 *
 * A container cgroup counts THREADS, not processes, and this cluster forks a
 * runner per addon (D2). Measured on the live hub 2026-09-18 (20 cores,
 * `pids.max=2048`), after 22 fork refusals in 45 minutes earlier that day:
 *
 *   pids.current 991 · 47 node processes holding 469 threads
 *   of those, 29 LIGHT runners holding 274 (mean 9.4 threads each)
 *
 * A light runner is a control-plane addon with a 2 MB young generation. It does
 * not generate the background GC work four marking threads exist for, and it
 * pays 4 threads of the cgroup's pid budget for them anyway. Two returns ~58
 * threads — ~6% of the container's live thread count — for background GC that
 * is, on these heaps, a few milliseconds a cycle.
 *
 * ## Why TWO and never ZERO
 *
 * `--v8-pool-size=0` does not disable the pool: it tells V8 to size it from the
 * detected parallelism. Measured locally 2026-09-18 on a node process holding
 * the libuv pool open:
 *
 *   default            11 threads
 *   --v8-pool-size=2    9 threads
 *   --v8-pool-size=0   18 threads
 *
 * So the flag is only ever passed with a value of at least 1 — the same trap as
 * `MALLOC_ARENA_MAX=0` in `runner-native-allocator.ts`.
 *
 * ## What is deliberately NOT bounded
 *
 * HEAVY runners keep V8's default: they hold real heaps (the recorder declares
 * 3072 MB) where parallel marking is the difference between a pause and a stall.
 *
 * `UV_THREADPOOL_SIZE` is left alone on every runner. Its 4 threads are lazily
 * spawned, and the measurement above says most light runners have spawned all
 * four — i.e. they really do run concurrent `fs` work. Halving that would trade
 * ~58 more threads for serialized filesystem I/O in runners whose I/O profile
 * has not been measured, on a media system. A thread saving is not worth a
 * media gap.
 */
export const LIGHT_V8_POOL_SIZE_DEFAULT = 2

/** Light runners' young-generation semi-space, in MB. */
export const LIGHT_SEMI_SPACE_MB = 2

/**
 * The runner's old-space ceiling in MB, or 0 for "uncapped".
 *
 * The runner takes the MAXIMUM ceiling any co-located addon declares — co-location must never
 * silence the hungriest member (D2/D29: a runner is respawned as a whole, so an OOM caused by
 * under-sizing one member kills every addon in the group). An addon declaring `0` therefore lifts
 * the cap for the whole runner, which is the intended escape hatch.
 */
export function runnerMaxOldSpaceMb(addons: readonly RunnerAddonSpec[], heavy: boolean): number {
  const envDefault = heavy ? HEAVY_MAX_OLD_MB_DEFAULT : 0
  const declared = addons
    .map((a) => readAddonHeapDeclaration(a).maxOldSpaceMb)
    .filter((mb): mb is number => mb !== undefined)
  if (declared.length === 0) return envDefault
  // `0` (uncapped) wins over any finite number — it is the strictly larger ceiling.
  if (declared.includes(0)) return 0
  return Math.max(...declared)
}

/**
 * The runner's declared RSS budget in MB, or `undefined` when NOBODY declared one.
 *
 * Same rule as the old-space ceiling, for the same reason (D2/D29): the runner takes the MAXIMUM
 * any co-located addon declares, because a runner is respawned as a whole and co-location must
 * never silence the hungriest member. It would be strictly worse here than for a heap ceiling —
 * an under-sized budget does not kill anything, it just cries wolf, and a watchdog that cries
 * wolf is a watchdog that gets muted.
 *
 * `undefined` propagates as an ABSENT env var, and the child then announces itself unwatched.
 * There is deliberately no class default: see `AddonExecution.rssBudgetMb`.
 */
export function runnerRssBudgetMb(addons: readonly RunnerAddonSpec[]): number | undefined {
  const declared = addons
    .map((a) => readAddonHeapDeclaration(a).rssBudgetMb)
    .filter((mb): mb is number => mb !== undefined)
  return declared.length === 0 ? undefined : Math.max(...declared)
}

/**
 * Per-placement V8 flags (Block D). LIGHT runners cap their young generation
 * (`--max-semi-space-size`) to reclaim V8's over-reservation — a measured ~15 MB/runner win — bound
 * V8's platform thread pool (`--v8-pool-size`, see {@link LIGHT_V8_POOL_SIZE_DEFAULT}: a measured
 * ~58 threads across the hub's 29 light runners, against a cgroup `pids.max` this host has already
 * hit) and carry no old-space cap unless a manifest declares one. HEAVY
 * runners keep V8's default young generation but ALWAYS carry an old-space ceiling; see
 * {@link HEAVY_MAX_OLD_MB_DEFAULT} for why, and how a runner declares its own.
 *
 * The per-addon overrides are the manifest's declared `maxOldSpaceMb` (`0` = uncapped),
 * `semiSpaceMb` (`--max-semi-space-size`, replacing the class default) and
 * `initialOldSpaceMb` (`--initial-old-space-size`, clamped to the ceiling) — each the MAXIMUM
 * across a runner's co-located addons. Shipped for `stream-broker` alone (8 / 512): with the
 * heavy class default the hub's broker ran ~166 major GCs a minute and not one scavenge, at
 * 45–60 % of a core. The environment overrides and the `CAMSTACK_RUNNER_HEAP_TUNING=off` kill
 * switch were removed on 2026-10-06 — nothing had set them since the rollout. The flags must
 * be on the spawn command line: `v8.setFlagsFromString` at runtime changes neither space.
 */
export function runnerHeapFlags(addons: readonly RunnerAddonSpec[]): string[] {
  const heavy = isHeavyRunner(addons)
  const flags: string[] = []
  // A declared young generation wins over the class default, light or heavy. The
  // heavy case is the one it exists for: V8's 64 MB default against a small live
  // set restarts marking after every scavenge (`AddonExecution.semiSpaceMb`).
  const semiMb = runnerSemiSpaceMb(addons) ?? (heavy ? undefined : LIGHT_SEMI_SPACE_MB)
  if (semiMb !== undefined) flags.push(`--max-semi-space-size=${semiMb}`)
  if (!heavy) {
    // Bound V8's platform thread pool — see LIGHT_V8_POOL_SIZE_DEFAULT.
    flags.push(`--v8-pool-size=${LIGHT_V8_POOL_SIZE_DEFAULT}`)
  }
  const oldMb = runnerMaxOldSpaceMb(addons, heavy)
  if (oldMb > 0) flags.push(`--max-old-space-size=${oldMb}`)
  const initialOldMb = runnerInitialOldSpaceMb(addons)
  if (initialOldMb !== undefined) {
    // Never above the ceiling: V8 refuses an initial old space larger than its
    // maximum, and an uncapped runner (`oldMb === 0`) has no ceiling to exceed.
    const bounded = oldMb > 0 ? Math.min(initialOldMb, oldMb) : initialOldMb
    flags.push(`--initial-old-space-size=${bounded}`)
  }
  return flags
}

/**
 * The runner's declared young-generation semi-space in MB, or `undefined` when no
 * co-located addon declares one (→ the class default applies).
 *
 * The MAXIMUM across the group, like every other declaration here (D2/D29): the
 * member that measured its churn away must not be handed a smaller young
 * generation because a quieter co-tenant declared one.
 */
export function runnerSemiSpaceMb(addons: readonly RunnerAddonSpec[]): number | undefined {
  const declared = addons
    .map((a) => readAddonHeapDeclaration(a).semiSpaceMb)
    .filter((mb): mb is number => mb !== undefined)
  return declared.length === 0 ? undefined : Math.max(...declared)
}

/**
 * The runner's declared initial old space in MB, or `undefined` when nobody declares
 * one (→ V8 grows it from the live set). MAXIMUM across the group, same rule and same
 * reason as {@link runnerSemiSpaceMb}; the clamp to the runner's ceiling happens in
 * {@link runnerHeapFlags}, where the ceiling is known.
 */
export function runnerInitialOldSpaceMb(addons: readonly RunnerAddonSpec[]): number | undefined {
  const declared = addons
    .map((a) => readAddonHeapDeclaration(a).initialOldSpaceMb)
    .filter((mb): mb is number => mb !== undefined)
  return declared.length === 0 ? undefined : Math.max(...declared)
}
