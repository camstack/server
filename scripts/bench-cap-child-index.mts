#!/usr/bin/env tsx
/**
 * `resolveChildId` — the linear scan, and the index that replaces it (D457).
 *
 * A 50 s V8 CPU profile of the live hub (D456) put `resolveChildId` at
 * **7.1 % self time of hub-main's busy main thread (1 259 ms)** — after D448,
 * larger than all of msgpack put together. It walked every connected child
 * and, for each, every descriptor in its cap manifest, on EVERY
 * `cap-call-out`, over 39 children.
 *
 * This harness runs BOTH resolutions over the same fleet and the same call
 * mix:
 *   - `legacyResolve` — the scan preserved verbatim, kept here and nowhere
 *     else so the A/B is against real code rather than a description of it.
 *   - the shipped `buildCapChildIndex`, built ONCE (which is what the registry
 *     does: it rebuilds only when a child registers or disconnects).
 * It asserts the two agree on every call before reporting any number — a
 * resolution that got faster by answering differently is caught, not reported.
 *
 * Method: best-of-N, the two implementations ALTERNATE per iteration, and a
 * FLOOR measures the harness's own loop so "how much of this is the benchmark"
 * is answered rather than assumed.
 *
 * Usage:
 *   npx tsx scripts/bench-cap-child-index.mts [best-of=7]
 *
 * Exit 0 on success, 1 if the two resolutions disagree.
 */
import { performance } from 'node:perf_hooks'
import {
  buildCapChildIndex,
  type CapIndexEntry,
} from '../packages/system/src/kernel/transport/cap-child-index.ts'
import type { ChildCapDescriptor } from '../packages/system/src/kernel/transport/child-cap-protocol.ts'

/** The ORIGINAL two-tier scan, preserved verbatim. */
function legacyResolve(
  entries: readonly CapIndexEntry[],
  capName: string,
  deviceId?: number,
): string | null {
  if (deviceId !== undefined) {
    for (const entry of entries) {
      if (entry.caps.some((cap) => cap.capName === capName && cap.deviceId === deviceId)) {
        return entry.childId
      }
    }
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (entry.caps.some((cap) => cap.capName === capName && cap.deviceId === undefined)) {
      candidates.push(entry.childId)
    }
  }
  return candidates.length === 0 ? null : candidates[0]!
}

/**
 * A fleet shaped like the hub the profile came from: 39 children. Six vendor
 * providers own a disjoint slice of ~120 cameras through device-scoped
 * descriptors; the rest are singleton addons.
 */
function buildFleet(): { entries: CapIndexEntry[]; deviceIds: number[] } {
  const entries: CapIndexEntry[] = []
  const deviceIds: number[] = []
  const VENDOR_CAPS = ['snapshot', 'ptz', 'motion-zones', 'camera-stream', 'device-state']

  for (let v = 0; v < 6; v += 1) {
    const caps: ChildCapDescriptor[] = []
    for (let d = 0; d < 20; d += 1) {
      const deviceId = v * 20 + d + 1
      deviceIds.push(deviceId)
      for (const capName of VENDOR_CAPS) caps.push({ capName, mode: 'collection', deviceId })
    }
    entries.push({ childId: `provider-${v}`, caps })
  }
  for (let a = 0; a < 33; a += 1) {
    entries.push({
      childId: `addon-${a}`,
      caps: [
        { capName: `addon-${a}-cap`, mode: 'singleton' },
        { capName: 'addon-widgets-source', mode: 'collection' },
      ],
    })
  }
  return { entries, deviceIds }
}

interface Call {
  readonly capName: string
  readonly deviceId?: number
}

/**
 * The call mix. `pipeline-runner`-style singletons dominate the live hub, so
 * the mix is deliberately weighted the way `getCapUsageGraph` measured it:
 * mostly singleton lookups, some device-scoped, a few misses.
 */
function buildCalls(deviceIds: readonly number[]): Call[] {
  const calls: Call[] = []
  for (let i = 0; i < 3000; i += 1) {
    const r = i % 10
    if (r < 6) calls.push({ capName: `addon-${i % 33}-cap` })
    else if (r < 9) calls.push({ capName: 'snapshot', deviceId: deviceIds[i % deviceIds.length]! })
    else calls.push({ capName: 'a-cap-nobody-provides' })
  }
  return calls
}

function main(): void {
  const bestOf = Number(process.argv[2] ?? 7)
  const { entries, deviceIds } = buildFleet()
  const calls = buildCalls(deviceIds)
  const descriptors = entries.reduce((n, e) => n + e.caps.length, 0)

  // Agreement first: a benchmark of two things that answer differently is not
  // a benchmark.
  const reference = buildCapChildIndex(entries)
  const indexed = (c: Call): string | null => {
    if (c.deviceId !== undefined) {
      const owner = reference.deviceOwner(c.capName, c.deviceId)
      if (owner !== null) return owner
    }
    const candidates = reference.singletonCandidates(c.capName)
    return candidates.length === 0 ? null : candidates[0]!
  }
  for (const c of calls) {
    if (indexed(c) !== legacyResolve(entries, c.capName, c.deviceId)) {
      process.stderr.write(`FAIL: disagreement on ${c.capName}/${c.deviceId ?? '-'}\n`)
      process.exit(1)
    }
  }

  let bestLegacy = Number.POSITIVE_INFINITY
  let bestIndex = Number.POSITIVE_INFINITY
  let bestFloor = Number.POSITIVE_INFINITY

  const runLegacy = (): void => {
    const t0 = performance.now()
    let sink = 0
    for (const c of calls) if (legacyResolve(entries, c.capName, c.deviceId) !== null) sink += 1
    const ms = performance.now() - t0
    if (sink < 0) throw new Error('unreachable')
    bestLegacy = Math.min(bestLegacy, ms)
  }
  const runIndex = (): void => {
    const t0 = performance.now()
    // The registry builds the index once per MUTATION of the children map, not
    // per call — so the build is inside the timed region, once, exactly as it
    // would be after a single respawn in this window.
    const index = buildCapChildIndex(entries)
    let sink = 0
    for (const c of calls) {
      let answer: string | null = null
      if (c.deviceId !== undefined) answer = index.deviceOwner(c.capName, c.deviceId)
      if (answer === null) {
        const candidates = index.singletonCandidates(c.capName)
        answer = candidates.length === 0 ? null : candidates[0]!
      }
      if (answer !== null) sink += 1
    }
    const ms = performance.now() - t0
    if (sink < 0) throw new Error('unreachable')
    bestIndex = Math.min(bestIndex, ms)
  }
  const runFloor = (): void => {
    const t0 = performance.now()
    let sink = 0
    for (const c of calls) if (c.capName.length > 0) sink += 1
    const ms = performance.now() - t0
    if (sink < 0) throw new Error('unreachable')
    bestFloor = Math.min(bestFloor, ms)
  }

  for (let i = 0; i < bestOf; i += 1) {
    if (i % 2 === 0) {
      runLegacy()
      runIndex()
    } else {
      runIndex()
      runLegacy()
    }
    runFloor()
  }

  process.stdout.write(
    `resolveChildId — ${entries.length} children, ${descriptors} cap descriptors, ` +
      `${calls.length} calls, best-of-${bestOf}\n\n`,
  )
  process.stdout.write(`  linear scan   ${bestLegacy.toFixed(3).padStart(9)} ms\n`)
  process.stdout.write(
    `  index (built once, then ${calls.length} lookups)   ${bestIndex.toFixed(3).padStart(9)} ms\n`,
  )
  process.stdout.write(`  floor (loop only)   ${bestFloor.toFixed(3).padStart(9)} ms\n\n`)
  const gained = bestLegacy - bestFloor
  const kept = bestIndex - bestFloor
  process.stdout.write(
    `  above the floor: ${gained.toFixed(3)} ms → ${kept.toFixed(3)} ms ` +
      `(${(100 - (kept / gained) * 100).toFixed(1)} % removed)\n`,
  )
  process.stdout.write(
    `  per call: ${((gained / calls.length) * 1000).toFixed(3)} µs → ` +
      `${((kept / calls.length) * 1000).toFixed(3)} µs\n`,
  )
}

main()
