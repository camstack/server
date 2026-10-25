/**
 * Plane → tee → file → sidecar, end to end, with nothing faked but the clock.
 *
 * The three units each prove their own contract; what is only provable here is
 * that they are WIRED — that a HomeKit recording actually leaves a playable
 * file and a listable record behind, and that a store which cannot write
 * anything still leaves the recording alone.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IScopedLogger } from '@camstack/types'
import { Fmp4FragmentPlane } from '@camstack/types/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HksvClipStore } from '../clip-store.js'
import { createClipTeeFactory } from '../clip-tee.js'

const DEVICE_ID = 101

interface LogLine {
  readonly level: string
  readonly message: string
}

function logger(sink: LogLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (message: string): void => {
      sink.push({ level, message })
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

let root = ''
let logs: LogLine[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hksv-tee-'))
  logs = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function unit(kind: 'init' | 'fragment', sequence: number) {
  return { kind, sequence, data: new Uint8Array(8).fill(sequence) }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Let the tee's own async work finish.
 *
 * Bounded by WALL CLOCK, not by a count of microtasks. The first cut spun 200
 * `setImmediate` turns, which is a budget that shrinks as the machine gets
 * busier — it passed alone and failed inside the full suite roughly one run in
 * five. The tee deliberately does its work off the delegate's path, through
 * real filesystem I/O, so the only honest wait is for the real outcome under a
 * deadline generous enough that only a broken wiring can miss it.
 */
async function settle(until: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await until()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

describe('the clip tee, wired', () => {
  it('leaves a file and a listable record behind one HomeKit recording', async () => {
    const store = new HksvClipStore({
      logger: logger(logs),
      resolveRoot: async () => join(root, 'hksv-clips'),
      now: () => 50_000,
    })
    const factory = createClipTeeFactory({
      logger: logger(logs),
      deviceId: DEVICE_ID,
      store,
      width: 1280,
      height: 720,
      fragmentMs: 4_000,
      now: () => 10_000,
    })
    const plane = new Fmp4FragmentPlane(undefined, { windowMs: 60_000, maxBytes: 100_000 })
    plane.publish(unit('init', 0))
    const subscription = plane.subscribe({ tag: 'clip/101#3', withPrebuffer: true })
    const tee = factory({ streamId: 3, subscription, prebufferSpanMs: 8_000 })
    if (tee === null) throw new Error('the factory refused')

    plane.publish(unit('fragment', 1))
    plane.publish(unit('fragment', 2))
    await tick()
    tee.finish()
    await settle(async () => (await store.listRecords(DEVICE_ID)).length > 0)

    const records = await store.listRecords(DEVICE_ID)
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.fragments).toBe(2)
    expect(record?.bytes).toBe(24)
    expect(record?.prebufferSpanMs).toBe(8_000)
    expect(record?.acknowledgedByHomeKit).toBe(false)
    const file = await stat(join(root, 'hksv-clips', String(DEVICE_ID), record?.file ?? ''))
    expect(file.size).toBe(24)

    tee.acknowledge()
    await settle(async () => {
      const [r] = await store.listRecords(DEVICE_ID)
      return r?.acknowledgedByHomeKit === true
    })
    const [acknowledged] = await store.listRecords(DEVICE_ID)
    expect(acknowledged?.acknowledgedByHomeKit).toBe(true)
  })

  it('refuses without throwing when the store cannot write at all', async () => {
    // A FILE where the store's root should be: every `mkdir` under it fails.
    const blocked = join(root, 'not-a-dir')
    await writeFile(blocked, 'x')
    const store = new HksvClipStore({ logger: logger(logs), resolveRoot: async () => blocked })
    const factory = createClipTeeFactory({
      logger: logger(logs),
      deviceId: DEVICE_ID,
      store,
      width: 1280,
      height: 720,
      fragmentMs: 4_000,
    })
    const plane = new Fmp4FragmentPlane(undefined, { windowMs: 60_000, maxBytes: 100_000 })
    plane.publish(unit('init', 0))
    const subscription = plane.subscribe({ tag: 'clip/101#4', withPrebuffer: true })
    const tee = factory({ streamId: 4, subscription, prebufferSpanMs: 0 })
    if (tee === null) throw new Error('the factory refused synchronously')

    plane.publish(unit('fragment', 1))
    await tick()
    tee.finish()
    await settle(async () => subscription.closedReason !== null)

    expect(await store.listRecords(DEVICE_ID)).toHaveLength(0)
    // The subscription is let go rather than left to fill and be closed as a
    // slow consumer on a plane that is serving HomeKit.
    expect(subscription.closedReason).toBe('released')
    expect(logs.some((l) => l.level === 'warn')).toBe(true)
  })
})
