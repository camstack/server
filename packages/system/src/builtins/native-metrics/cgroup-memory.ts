/**
 * The container's own memory, read from the cgroup — the number no sum of
 * per-process RSS can ever produce.
 *
 * ## Why this file exists
 *
 * Every memory number camstack had before it was PER PROCESS: the `[mem]`
 * heartbeat per runner (`packages/system/src/kernel/heap-watch.ts`) and the
 * `ps`-derived `memoryRssBytes` on each `NodeProcess`. On 2026-08-29 the hub's
 * 39 processes summed to 15.81 GiB while the container reported 23.14 GiB, and
 * the missing ~7 GiB was read for a leak. It was not one. `memory.stat` settled
 * it in a single command:
 *
 * ```
 * anon 19946409984   file 3642105856   shmem 1860067328   slab 95465928
 * memory.current 24045301760   memory.max 34359738368
 * ```
 *
 * **The sum of per-process RSS can never equal the container total.** Page
 * cache (`file`), shared memory (`shmem`, which is where the i915 driver parks
 * GPU buffers) and kernel slab belong to the cgroup, not to any process in the
 * way `ps` counts. On this hub they are ~6 GiB of 23. Read once by hand they
 * say nothing about direction; that is what this file is for.
 *
 * ## What it is NOT
 *
 * Measurement only. Nothing here reclaims, trims, drops caches or tunes an
 * allocator. The operator's standing position is that memory ceilings and
 * `malloc` variables are patches over deeper problems
 * (`docs/design/plans/2026-08-29-remove-the-memory-ceilings.md`); this exists
 * to make the deeper problem visible, never to paper over it.
 *
 * ## Absent is ABSENT
 *
 * Every unavailable number is `null`, never `0`. A node with no cgroup (a
 * developer Mac, a bare-metal host, a container with the hierarchy hidden)
 * produces `null` from {@link ContainerMemoryProbe.sample} and contributes no
 * point at all — because a zero here is indistinguishable from a healthy
 * container that happens to use no memory, which is the exact class of lie
 * this repo has been bitten by.
 *
 * ## The reads are pure, the I/O is injected
 *
 * Every parse below is a pure function over text, so the shapes are testable
 * against real `memory.stat` fixtures without a Linux kernel. The only impure
 * surface is {@link CgroupFileReader}, one method wide.
 */

import type { ContainerMemorySnapshot, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { readFileSync } from 'node:fs'

/**
 * Which hierarchy answered. Reported so a reading is never ambiguous.
 *
 * Narrowed from {@link ContainerMemorySnapshot}'s own field rather than
 * re-declared: the shape is the capability's Zod schema and this file must not
 * own a second copy of it.
 */
export type CgroupMemorySource = ContainerMemorySnapshot['source']

/** The one impure surface. Returns `null` for anything unreadable. */
export interface CgroupFileReader {
  read(path: string): string | null
}

/** `readFileSync`, with every failure flattened to `null`. */
export const nodeCgroupFileReader: CgroupFileReader = {
  read(path: string): string | null {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

/** Where the v2 unified hierarchy is mounted, and where v1 hangs its controllers. */
export const CGROUP_MOUNT_ROOT = '/sys/fs/cgroup'

/**
 * The i915 GEM accounting file.
 *
 * **debugfs, and it is not mounted in our containers.** Verified on the live
 * hub on 2026-08-29: readable on the Unraid host (`6014 shrinkable [0 free]
 * objects, 1194934272 bytes`), `ENOENT` inside the `CamStack` container where
 * `native-metrics` actually runs. It is probed ONCE per process and latched —
 * a bind mount cannot appear under a running container — so an absent file
 * costs one failed `open` for the life of the runner and one log line, never a
 * failure per tick.
 *
 * Making it populate is a one-line change on the container, not here:
 * mounting `/sys/kernel/debug` read-only into `CamStack` fills this field on
 * the next sample with no code change.
 */
export const I915_GEM_OBJECTS_PATH = '/sys/kernel/debug/dri/0/i915_gem_objects'

/** Where the numbers for one hierarchy live, once resolved. */
export interface CgroupMemoryLayout {
  readonly source: CgroupMemorySource
  /** Directory the three files below sit in. Kept for the resolution log line. */
  readonly directory: string
  readonly currentPath: string
  readonly limitPath: string
  readonly statPath: string
}

/** What `/proc/self/cgroup` says about this process. */
export interface CgroupSelfEntry {
  readonly version: 'v2' | 'v1'
  /** Path RELATIVE to the hierarchy root, always leading-slashed. */
  readonly path: string
}

/**
 * v1's "no limit" sentinel — `PAGE_COUNTER_MAX << PAGE_SHIFT`, which is what a
 * 64-bit kernel writes into `memory.limit_in_bytes` when nothing is set. It is
 * a limit in the same sense that `Infinity` is a number, so it reads as `null`.
 */
const V1_UNLIMITED_SENTINEL = 9223372036854771712

/**
 * Parse `/proc/self/cgroup`.
 *
 * Two formats, and the file may contain both on a hybrid host:
 *
 * ```
 * 0::/                                  ← v2 unified
 * 5:memory:/docker/9f3c…                ← v1, memory controller
 * 4:cpu,cpuacct:/docker/9f3c…           ← v1, other controllers
 * ```
 *
 * v2 wins when present: on a hybrid host the unified hierarchy is the one
 * carrying `memory.current`, and every camstack deployment is v2 (verified on
 * the live hub, which reports the single line `0::/`).
 *
 * Returns `null` when the file names no memory hierarchy at all — which is
 * also what a non-Linux host produces, because there is no file to read.
 */
export function parseCgroupSelf(text: string): CgroupSelfEntry | null {
  let v1: CgroupSelfEntry | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    // `hierarchy-ID:controller-list:cgroup-path` — the path may itself contain
    // colons, so split into exactly three parts.
    const first = line.indexOf(':')
    if (first < 0) continue
    const second = line.indexOf(':', first + 1)
    if (second < 0) continue
    const controllers = line.slice(first + 1, second)
    const path = line.slice(second + 1)
    if (path.length === 0) continue
    const normalized = path.startsWith('/') ? path : `/${path}`
    if (controllers.length === 0) return { version: 'v2', path: normalized }
    if (v1 === null && controllers.split(',').includes('memory')) {
      v1 = { version: 'v1', path: normalized }
    }
  }
  return v1
}

/**
 * Parse a `memory.stat` file — v1 or v2, both are `key value` per line.
 *
 * Unknown keys are KEPT rather than refused: a v2 `memory.stat` carries ~50
 * fields and we read five of them, and a kernel that adds a sixth must not
 * turn into a parse failure. A malformed line is skipped, not thrown on.
 */
export function parseCgroupStat(text: string): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space)
    const value = Number(line.slice(space + 1).trim())
    if (!Number.isFinite(value)) continue
    out.set(key, value)
  }
  return out
}

/**
 * Parse a single-scalar cgroup file (`memory.current`, `memory.max`, …).
 *
 * `max` — v2's word for "no limit" — and v1's `V1_UNLIMITED_SENTINEL` both
 * become `null`, because a ceiling nothing can reach is not a ceiling and
 * charting it as 8 exabytes would flatten every real series to zero.
 */
export function parseCgroupScalar(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (trimmed === 'max') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  if (value >= V1_UNLIMITED_SENTINEL) return null
  return value
}

/**
 * Parse the first line of `i915_gem_objects`.
 *
 * ```
 * 6014 shrinkable [0 free] objects, 1194934272 bytes
 * ```
 *
 * Only the byte total is taken. The format has changed across kernel releases
 * more than once, so a line that does not match reads `null` — an unrecognised
 * format is UNKNOWN, never zero.
 */
export function parseI915GemObjects(text: string): number | null {
  const match = text.match(/^\s*\d+\s+shrinkable\b[^,\n]*,\s*(\d+)\s+bytes/m)
  if (match === null) return null
  const bytes = Number(match[1])
  return Number.isFinite(bytes) ? bytes : null
}

/**
 * Find the cgroup from INSIDE this process — never a hard-coded path.
 *
 * The path the hub happens to have (`/sys/fs/cgroup/docker/<id>/memory.stat`
 * as seen from the Unraid host) is an artefact of where you are standing. From
 * inside the container the same cgroup is at the mount ROOT, because Docker
 * gives the container its own cgroup namespace and `/proc/self/cgroup` reports
 * `0::/`. Hard-coding either one breaks the other.
 *
 * So the resolution is: ask `/proc/self/cgroup` which hierarchy and which
 * path, then take the FIRST candidate directory that actually publishes the
 * usage file.
 *
 * - **v2** — `<mount><path>` then `<mount>`. The second candidate is the
 *   namespaced case and the one that answers on our hub; the first is the
 *   un-namespaced case (a host process, or `--cgroupns=host`).
 * - **v1** — `<mount>/memory<path>` then `<mount>/memory`, same reasoning.
 * - **neither** — `null`. macOS has no `/proc/self/cgroup` at all, so a
 *   developer Mac lands here and reports nothing, which is the truth.
 */
export function resolveCgroupMemoryLayout(fs: CgroupFileReader): CgroupMemoryLayout | null {
  const selfText = fs.read('/proc/self/cgroup')
  if (selfText === null) return null
  const entry = parseCgroupSelf(selfText)
  if (entry === null) return null

  const suffix = entry.path === '/' ? '' : entry.path
  const candidates =
    entry.version === 'v2'
      ? [`${CGROUP_MOUNT_ROOT}${suffix}`, CGROUP_MOUNT_ROOT]
      : [`${CGROUP_MOUNT_ROOT}/memory${suffix}`, `${CGROUP_MOUNT_ROOT}/memory`]

  const usageFile = entry.version === 'v2' ? 'memory.current' : 'memory.usage_in_bytes'
  const limitFile = entry.version === 'v2' ? 'memory.max' : 'memory.limit_in_bytes'

  for (const directory of candidates) {
    if (fs.read(`${directory}/${usageFile}`) === null) continue
    return {
      source: entry.version === 'v2' ? 'cgroup-v2' : 'cgroup-v1',
      directory,
      currentPath: `${directory}/${usageFile}`,
      limitPath: `${directory}/${limitFile}`,
      statPath: `${directory}/memory.stat`,
    }
  }
  return null
}

/** A stat lookup that answers `null` for a key this hierarchy does not publish. */
function statValue(stat: ReadonlyMap<string, number>, key: string): number | null {
  const value = stat.get(key)
  return value === undefined ? null : value
}

/**
 * v2 publishes `slab` directly; older v2 kernels publish only the two halves.
 * Summing them is the same number, so the fallback is exact rather than an
 * approximation — and when neither is present the answer is `null`.
 */
function resolveSlab(stat: ReadonlyMap<string, number>): number | null {
  const direct = statValue(stat, 'slab')
  if (direct !== null) return direct
  const reclaimable = stat.get('slab_reclaimable')
  const unreclaimable = stat.get('slab_unreclaimable')
  if (reclaimable === undefined || unreclaimable === undefined) return null
  return reclaimable + unreclaimable
}

/**
 * Turn one layout's three files into a snapshot.
 *
 * Pure over the text, so the whole mapping — including a v2 `memory.stat` full
 * of fields we do not read — is testable against a real fixture.
 *
 * v1's `memory.stat` names the same quantities differently and publishes fewer
 * of them: `rss` is the anonymous charge, `cache` is the page cache, and there
 * is no slab accounting at all. Mapping them onto the same field names is what
 * makes a v1 node and a v2 node comparable; reporting `slabBytes: null` on v1
 * is what stops that comparison from lying.
 */
export function buildContainerMemorySnapshot(input: {
  readonly source: CgroupMemorySource
  readonly currentText: string
  readonly limitText: string | null
  readonly statText: string | null
  readonly gpuShmemBytes: number | null
}): ContainerMemorySnapshot | null {
  const currentBytes = parseCgroupScalar(input.currentText)
  if (currentBytes === null) return null
  const stat = input.statText === null ? new Map<string, number>() : parseCgroupStat(input.statText)
  const isV2 = input.source === 'cgroup-v2'
  return {
    source: input.source,
    currentBytes,
    limitBytes: input.limitText === null ? null : parseCgroupScalar(input.limitText),
    anonBytes: statValue(stat, isV2 ? 'anon' : 'rss'),
    fileBytes: statValue(stat, isV2 ? 'file' : 'cache'),
    shmemBytes: statValue(stat, 'shmem'),
    slabBytes: isV2 ? resolveSlab(stat) : null,
    gpuShmemBytes: input.gpuShmemBytes,
  }
}

export interface ContainerMemoryProbeDeps {
  readonly logger: IScopedLogger
  readonly fs?: CgroupFileReader
  /** Set `false` to skip the debugfs probe entirely. Default `true`. */
  readonly readGpu?: boolean
}

/**
 * The sampler. Resolves once, latches, and logs TRANSITIONS only.
 *
 * Three states are worth a line and none of them is worth one per tick:
 *
 * 1. **Resolution** — once, at the first sample. Either the layout that
 *    answered, or "no cgroup on this node", which is a fact about the node and
 *    not an error.
 * 2. **GPU probe** — once, at the first sample. Absent debugfs is the normal
 *    case inside a container and is stated as such, then never retried: a bind
 *    mount cannot appear under a running container.
 * 3. **Read failing / recovering** — a cgroup that resolved and then stopped
 *    answering is a real change and says so, once in each direction. A tick
 *    that fails while already failing is silent, because the first line
 *    already said it.
 *
 * The silence is bounded by design: at the 10 s snapshot cadence a per-tick
 * warning would be 8 640 lines a day on a node that simply is not Linux.
 */
export class ContainerMemoryProbe {
  private readonly logger: IScopedLogger
  private readonly fs: CgroupFileReader
  private readonly wantGpu: boolean
  private resolved = false
  private layout: CgroupMemoryLayout | null = null
  private gpuProbed = false
  private gpuReadable = false
  /** `null` until the first sample — so the FIRST outcome is a transition too. */
  private lastReadOk: boolean | null = null

  constructor(deps: ContainerMemoryProbeDeps) {
    this.logger = deps.logger
    this.fs = deps.fs ?? nodeCgroupFileReader
    this.wantGpu = deps.readGpu ?? true
  }

  /** Did this node resolve a cgroup at all? Absent is a reportable fact. */
  get available(): boolean {
    return this.layout !== null
  }

  /**
   * One reading, or `null` when this node has no cgroup or the cgroup stopped
   * answering. `null` is ABSENT — the caller contributes no point, and no
   * point is what a chart must show, never a zero.
   */
  sample(): ContainerMemorySnapshot | null {
    const layout = this.resolveOnce()
    if (layout === null) return null

    const currentText = this.fs.read(layout.currentPath)
    if (currentText === null) {
      this.noteRead(false, `unreadable: ${layout.currentPath}`)
      return null
    }
    const snapshot = buildContainerMemorySnapshot({
      source: layout.source,
      currentText,
      limitText: this.fs.read(layout.limitPath),
      statText: this.fs.read(layout.statPath),
      gpuShmemBytes: this.readGpuShmem(),
    })
    if (snapshot === null) {
      this.noteRead(false, `unparseable: ${layout.currentPath}`)
      return null
    }
    this.noteRead(true, null)
    return snapshot
  }

  /** Resolve on first use and never again — a cgroup does not move under a pid. */
  private resolveOnce(): CgroupMemoryLayout | null {
    if (this.resolved) return this.layout
    this.resolved = true
    try {
      this.layout = resolveCgroupMemoryLayout(this.fs)
    } catch (err) {
      this.layout = null
      this.logger.warn('cgroup memory resolution failed — container memory will be ABSENT', {
        meta: { error: errMsg(err) },
      })
      return null
    }
    if (this.layout === null) {
      this.logger.info(
        'no cgroup on this node — container memory is ABSENT, not zero, for every sample',
        { meta: { platform: process.platform, probed: '/proc/self/cgroup' } },
      )
      return null
    }
    this.logger.info('container memory resolved from the cgroup', {
      meta: {
        source: this.layout.source,
        directory: this.layout.directory,
      },
    })
    return this.layout
  }

  /**
   * The GPU number, probed once.
   *
   * It is host-wide and lives in debugfs, so it is absent far more often than
   * it is present — inside every camstack container today. One `open` decides
   * it for the life of the process; after that an unreadable file costs
   * nothing at all, not even a syscall.
   */
  private readGpuShmem(): number | null {
    if (!this.wantGpu) return null
    if (!this.gpuProbed) {
      this.gpuProbed = true
      const text = this.fs.read(I915_GEM_OBJECTS_PATH)
      this.gpuReadable = text !== null && parseI915GemObjects(text) !== null
      this.logger.info(
        this.gpuReadable
          ? 'i915 GEM accounting is readable — GPU-backed shmem will be reported'
          : 'i915 GEM accounting is NOT readable — gpuShmemBytes stays UNKNOWN (this is normal: debugfs is not mounted in the container, and a node with no Intel GPU has no such file)',
        { meta: { path: I915_GEM_OBJECTS_PATH } },
      )
      if (!this.gpuReadable) return null
      return text === null ? null : parseI915GemObjects(text)
    }
    if (!this.gpuReadable) return null
    const text = this.fs.read(I915_GEM_OBJECTS_PATH)
    return text === null ? null : parseI915GemObjects(text)
  }

  /** Log a read outcome only when it CHANGES. Never once per tick. */
  private noteRead(ok: boolean, reason: string | null): void {
    if (this.lastReadOk === ok) return
    const first = this.lastReadOk === null
    this.lastReadOk = ok
    if (!ok) {
      this.logger.warn(
        'cgroup memory stopped answering — container memory is ABSENT until it returns',
        { meta: { reason: reason ?? 'unknown' } },
      )
      return
    }
    if (!first) this.logger.info('cgroup memory is answering again')
  }
}
