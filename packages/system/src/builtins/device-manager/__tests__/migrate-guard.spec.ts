/**
 * The migration guard — a retried `migrateDevice` must never undo the one
 * that ran.
 *
 * Two claims, matching the 2026-09-01 incident's two windows:
 *
 * - MID-FLIGHT: a second call touching either device is refused, never
 *   queued. The meta write lock is FIFO, so "queued" means "re-swaps the
 *   moment the first run finishes".
 * - AFTER COMPLETION: a repeat of the same swap is answered with the original
 *   report — but only while the rows still carry exactly the fingerprint the
 *   recorded swap left, and only within the replay window. Anything else is a
 *   deliberate new operation and runs.
 */
import { describe, expect, it } from 'vitest'
import type { MigrateDeviceResult } from '../migrate-device.js'
import {
  createMigrationGuard,
  MIGRATION_REPLAY_WINDOW_MS,
  type DeviceIdentity,
} from '../migrate-guard.js'

const SOURCE = 618
const TARGET = 4362

const REOLINK: DeviceIdentity = {
  addonId: 'provider-reolink',
  stableId: 'reolink-abc',
}
const HIKVISION: DeviceIdentity = {
  addonId: 'provider-hikvision',
  stableId: 'hik-245',
}

function result(): MigrateDeviceResult {
  return {
    sourceId: SOURCE,
    targetId: TARGET,
    switches: [],
    sourceStillLive: [],
    swapped: true,
  }
}

describe('in-flight refusal', () => {
  it('refuses a second call on the same pair while one is running', () => {
    const guard = createMigrationGuard()
    guard.begin(SOURCE, TARGET)

    expect(() => guard.begin(SOURCE, TARGET)).toThrow(/already in flight/)
  })

  it('refuses a call sharing only ONE device with the running migration', () => {
    const guard = createMigrationGuard()
    guard.begin(SOURCE, TARGET)

    expect(() => guard.begin(TARGET, 9999)).toThrow(/already in flight/)
    expect(() => guard.begin(9999, SOURCE)).toThrow(/already in flight/)
  })

  it('a disjoint pair runs concurrently', () => {
    const guard = createMigrationGuard()
    guard.begin(SOURCE, TARGET)

    expect(() => guard.begin(700, 701)).not.toThrow()
  })

  it('end releases both ids for the next run', () => {
    const guard = createMigrationGuard()
    guard.begin(SOURCE, TARGET)
    guard.end(SOURCE, TARGET)

    expect(() => guard.begin(SOURCE, TARGET)).not.toThrow()
  })

  it('isInFlight answers for either device of a running migration, and nobody else (D663: a claim asks it)', () => {
    const guard = createMigrationGuard()
    expect(guard.isInFlight(SOURCE)).toBe(false)
    guard.begin(SOURCE, TARGET)

    expect(guard.isInFlight(SOURCE)).toBe(true)
    expect(guard.isInFlight(TARGET)).toBe(true)
    expect(guard.isInFlight(9999)).toBe(false)

    guard.end(SOURCE, TARGET)
    expect(guard.isInFlight(SOURCE)).toBe(false)
  })
})

describe('completed-swap replay', () => {
  it('replays the original report when the rows still carry the recorded fingerprint', () => {
    const guard = createMigrationGuard()
    const original = result()
    guard.recordCompleted({
      sourceId: SOURCE,
      targetId: TARGET,
      // Post-swap: the target's old identity sits at the source number.
      identityAtSource: REOLINK,
      identityAtTarget: HIKVISION,
      result: original,
    })

    expect(guard.matchReplay(SOURCE, TARGET, REOLINK, HIKVISION)).toBe(original)
  })

  it('an unknown pair is a new operation', () => {
    const guard = createMigrationGuard()

    expect(guard.matchReplay(SOURCE, TARGET, REOLINK, HIKVISION)).toBeNull()
  })

  it('a row that drifted from the fingerprint is a new operation', () => {
    const guard = createMigrationGuard()
    guard.recordCompleted({
      sourceId: SOURCE,
      targetId: TARGET,
      identityAtSource: REOLINK,
      identityAtTarget: HIKVISION,
      result: result(),
    })

    const replaced: DeviceIdentity = {
      addonId: 'provider-reolink',
      stableId: 'reolink-NEW',
    }
    expect(guard.matchReplay(SOURCE, TARGET, replaced, HIKVISION)).toBeNull()
    expect(guard.matchReplay(SOURCE, TARGET, REOLINK, replaced)).toBeNull()
  })

  it('the window separates a retry from a deliberate later re-swap', () => {
    let clock = 1_000_000
    const guard = createMigrationGuard(() => clock)
    guard.recordCompleted({
      sourceId: SOURCE,
      targetId: TARGET,
      identityAtSource: REOLINK,
      identityAtTarget: HIKVISION,
      result: result(),
    })

    clock += MIGRATION_REPLAY_WINDOW_MS - 1
    expect(guard.matchReplay(SOURCE, TARGET, REOLINK, HIKVISION)).not.toBeNull()

    clock += 2
    expect(guard.matchReplay(SOURCE, TARGET, REOLINK, HIKVISION)).toBeNull()
  })
})
