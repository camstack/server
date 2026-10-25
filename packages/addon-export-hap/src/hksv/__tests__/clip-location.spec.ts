/**
 * Which disk the teed clips go on — and every way that question can be
 * refused.
 *
 * The rule under test is D385's: a storage location has ONE typed state and
 * exactly one module interprets it. Nothing here reads `enabled` or
 * `config.readOnly`; it asks `mayWriteToLocation` and believes the answer. The
 * tests therefore feed rows in each mode and assert the resolver refuses, by
 * name, rather than writing to a disk the operator is draining.
 */
import type { IScopedLogger, StorageLocationMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import type { ClipLocationPorts, ClipLocationRow } from '../clip-location.js'
import { HksvClipLocation } from '../clip-location.js'

interface LogLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface LogPayload {
  readonly meta?: Record<string, unknown>
}

function logger(sink: LogLine[]): IScopedLogger {
  const record =
    (level: LogLine['level']) =>
    (message: string, payload?: LogPayload): void => {
      sink.push({ level, message, meta: payload?.meta ?? {} })
    }
  const log = {
    debug: () => {},
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
    withTags: () => log,
  }
  // Documented type boundary: only these six are ever called.
  return log as unknown as IScopedLogger
}

function row(mode: StorageLocationMode, id = 'homekitClips:default'): ClipLocationRow {
  return { id, type: 'homekitClips', mode, config: {} }
}

interface Harness {
  readonly location: HksvClipLocation
  readonly logs: LogLine[]
  readonly calls: { list: number; resolve: number }
  rows: ClipLocationRow[]
  root: string
  listThrows: boolean
  clock: number
}

function harness(rows: ClipLocationRow[] = [row('active')]): Harness {
  const logs: LogLine[] = []
  const calls = { list: 0, resolve: 0 }
  const state = { rows, root: '/mnt/media', listThrows: false, clock: 0 }
  const ports: ClipLocationPorts = {
    listLocations: async () => {
      calls.list += 1
      if (state.listThrows) throw new Error('storage cap unreachable')
      return state.rows
    },
    resolvePath: async () => {
      calls.resolve += 1
      return state.root
    },
  }
  const location = new HksvClipLocation({
    logger: logger(logs),
    ports,
    now: () => state.clock,
  })
  return {
    location,
    logs,
    calls,
    get rows() {
      return state.rows
    },
    set rows(v: ClipLocationRow[]) {
      state.rows = v
    },
    get root() {
      return state.root
    },
    set root(v: string) {
      state.root = v
    },
    get listThrows() {
      return state.listThrows
    },
    set listThrows(v: boolean) {
      state.listThrows = v
    },
    get clock() {
      return state.clock
    },
    set clock(v: number) {
      state.clock = v
    },
  }
}

describe('HksvClipLocation — the disk the operator chose', () => {
  it('writes into the class SUBTREE of the resolved location, never the shared root', async () => {
    const h = harness()
    // D327: occupancy of a class that shares a disk is the class subtree. This
    // location `defaultsTo: recordings`, so on a fresh install it IS the
    // recordings root and writing at its top level would count footage as ours.
    expect(await h.location.root()).toBe('/mnt/media/homekit-clips')
  })

  it.each([
    ['readonly'],
    ['drain'],
    ['disabled'],
  ] as const)('refuses a %s location — named, not silently written to', async (mode) => {
    const h = harness([row(mode)])
    expect(await h.location.root()).toBeNull()
    expect(h.location.lastRefusal).toBe('not-writable')
    const warned = h.logs.find((l) => l.level === 'warn')
    expect(warned?.meta).toMatchObject({ mode, reason: 'not-writable' })
  })

  it('refuses when no HomeKit clips location exists at all', async () => {
    const h = harness([])
    expect(await h.location.root()).toBeNull()
    expect(h.location.lastRefusal).toBe('no-location')
  })

  it('refuses WITHOUT throwing when the storage cap is unreachable', async () => {
    const h = harness()
    h.listThrows = true
    expect(await h.location.root()).toBeNull()
    expect(h.location.lastRefusal).toBe('unreachable')
  })

  it('asks the cap once and reuses the answer until the doorbell rings', async () => {
    const h = harness()
    await h.location.root()
    await h.location.root()
    await h.location.root()
    expect(h.calls.list).toBe(1)

    // `EventCategory.StorageLocationsChanged` is a doorbell: the payload is
    // never the authority, the re-read is.
    h.root = '/mnt/nas'
    h.location.invalidate()
    expect(await h.location.root()).toBe('/mnt/nas/homekit-clips')
    expect(h.calls.list).toBe(2)
  })

  it('re-reads on its own after the revalidation window, so a missed doorbell self-heals', async () => {
    const h = harness()
    await h.location.root()
    h.root = '/mnt/nas'
    h.clock = 120_000
    expect(await h.location.root()).toBe('/mnt/nas/homekit-clips')
  })

  it('does not repeat the same refusal on every clip, and speaks again when it changes', async () => {
    const h = harness([row('readonly')])
    await h.location.root()
    h.location.invalidate()
    await h.location.root()
    expect(h.logs.filter((l) => l.level === 'warn')).toHaveLength(1)

    h.rows = []
    h.location.invalidate()
    await h.location.root()
    expect(h.logs.filter((l) => l.level === 'warn')).toHaveLength(2)
  })

  it('takes the writable row and SAYS SO when the singleton has somehow become several', async () => {
    const h = harness([row('drain', 'homekitClips:old'), row('active', 'homekitClips:default')])
    expect(await h.location.root()).toBe('/mnt/media/homekit-clips')
    expect(h.logs.some((l) => l.level === 'warn' && /more than one/i.test(l.message))).toBe(true)
  })
})
