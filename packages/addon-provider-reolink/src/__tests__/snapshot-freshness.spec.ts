import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reolinkCameraSchema } from '../schema.js'
import {
  buildSnapshotFreshnessSection,
  formatSnapshotAge,
  formatSnapshotAgeLine,
  resolveSnapshotAge,
  SNAPSHOT_GROUPS,
  stampSnapshotFreshness,
} from '../snapshot-freshness.js'

/**
 * Per-snapshot freshness (D224 generalised, D346). The whole `deviceCache`
 * used to carry ONE `probedAt`, so an operator could not tell whether
 * `encSnapshot` was read a minute ago or frozen at adoption — the exact
 * confusion that hid the OSD staleness bug.
 *
 * Discipline pinned here:
 *   - stamps are written WHERE the snapshot is written, only for the
 *     groups actually written (a failed probe keeps its old stamp);
 *   - a legacy group with no stamp reads as UNKNOWN age — never as fresh;
 *   - an absent group reads as NEVER — not-yet-read must not look like read;
 *   - pre-map embedded stamps (osd `fetchedAt`, email `lastReadAt`,
 *     per-cap options `fetchedAt`) still resolve so today's OSD fix keeps
 *     reporting a real age on caches written before the map existed.
 *
 * Pure-function tests + structural wiring assertions (the sibling
 * osd-settings-freshness pattern — `ReolinkCamera` cannot be constructed
 * without a full DeviceContext).
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

const NOW = 1_756_000_000_000

describe('stampSnapshotFreshness — stamped where written, only what was written', () => {
  it('stamps exactly the written keys at now', () => {
    const stamped = stampSnapshotFreshness(undefined, ['encSnapshot', 'osdSnapshot'], NOW)
    expect(stamped).toEqual({ encSnapshot: NOW, osdSnapshot: NOW })
  })

  it('preserves stamps of untouched groups — a failed probe must not look refreshed', () => {
    const previous = { encSnapshot: NOW - 100_000, ntpSnapshot: NOW - 200_000 }
    const stamped = stampSnapshotFreshness(previous, ['encSnapshot'], NOW)
    expect(stamped).toEqual({ encSnapshot: NOW, ntpSnapshot: NOW - 200_000 })
  })

  it('returns a new map — the previous object is never mutated', () => {
    const previous = { encSnapshot: NOW - 100_000 }
    const stamped = stampSnapshotFreshness(previous, ['maskSnapshot'], NOW)
    expect(stamped).not.toBe(previous)
    expect(previous).toEqual({ encSnapshot: NOW - 100_000 })
  })
})

describe('resolveSnapshotAge — tri-state, unknown never reads as fresh', () => {
  it('absent group → never', () => {
    expect(resolveSnapshotAge({}, 'encSnapshot', NOW)).toEqual({ state: 'never' })
    expect(resolveSnapshotAge(undefined, 'encSnapshot', NOW)).toEqual({ state: 'never' })
  })

  it('present group without any stamp → unknown age (legacy persist)', () => {
    const cache = { encSnapshot: { audio: 1 } }
    expect(resolveSnapshotAge(cache, 'encSnapshot', NOW)).toEqual({ state: 'unknown' })
  })

  it('stamped group → known with its own age', () => {
    const cache = {
      encSnapshot: { audio: 1 },
      snapshotFetchedAt: { encSnapshot: NOW - 42_000 },
    }
    expect(resolveSnapshotAge(cache, 'encSnapshot', NOW)).toEqual({
      state: 'known',
      fetchedAt: NOW - 42_000,
      ageMs: 42_000,
    })
  })

  it('osdSnapshot falls back to its embedded fetchedAt (pre-map stamp from the OSD fix)', () => {
    const cache = { osdSnapshot: { channelEnabled: false, fetchedAt: NOW - 5_000 } }
    expect(resolveSnapshotAge(cache, 'osdSnapshot', NOW)).toEqual({
      state: 'known',
      fetchedAt: NOW - 5_000,
      ageMs: 5_000,
    })
  })

  it('emailConfigSnapshot falls back to lastReadAt', () => {
    const cache = { emailConfigSnapshot: { smtpServer: 'smtp.lan', lastReadAt: NOW - 9_000 } }
    expect(resolveSnapshotAge(cache, 'emailConfigSnapshot', NOW)).toEqual({
      state: 'known',
      fetchedAt: NOW - 9_000,
      ageMs: 9_000,
    })
  })

  it('capOptionsSnapshot uses the newest per-cap stamp', () => {
    const cache = {
      capOptionsSnapshot: {
        ptz: { value: {}, fetchedAt: NOW - 30_000 },
        'day-night': { value: {}, fetchedAt: NOW - 10_000 },
      },
    }
    expect(resolveSnapshotAge(cache, 'capOptionsSnapshot', NOW)).toEqual({
      state: 'known',
      fetchedAt: NOW - 10_000,
      ageMs: 10_000,
    })
  })

  it('the map wins over an embedded stamp when both exist', () => {
    const cache = {
      osdSnapshot: { channelEnabled: false, fetchedAt: NOW - 90_000 },
      snapshotFetchedAt: { osdSnapshot: NOW - 1_000 },
    }
    expect(resolveSnapshotAge(cache, 'osdSnapshot', NOW)).toEqual({
      state: 'known',
      fetchedAt: NOW - 1_000,
      ageMs: 1_000,
    })
  })
})

describe('formatting — honest words for each state', () => {
  it('ages format across units', () => {
    expect(formatSnapshotAge(12_000)).toBe('12 s ago')
    expect(formatSnapshotAge(3 * 60_000)).toBe('3 m ago')
    expect(formatSnapshotAge(5 * 3_600_000)).toBe('5 h ago')
    expect(formatSnapshotAge(12 * 24 * 3_600_000)).toBe('12 d ago')
  })

  it('unknown age is SAID — never rendered as a time', () => {
    expect(formatSnapshotAgeLine('Encoder', { state: 'unknown' })).toBe(
      'Encoder: age unknown (recorded before per-snapshot freshness tracking)',
    )
    expect(formatSnapshotAgeLine('Encoder', { state: 'never' })).toBe('Encoder: never read')
  })
})

describe('buildSnapshotFreshnessSection — one line per group, no reads triggered', () => {
  it('lists every snapshot group with its own state', () => {
    const cache = {
      encSnapshot: { audio: 1 },
      snapshotFetchedAt: { encSnapshot: NOW - 60_000 },
      osdSnapshot: { channelEnabled: false, fetchedAt: NOW - 120_000 },
      imageSnapshot: { bright: 128 }, // legacy, no stamp
    }
    const section = buildSnapshotFreshnessSection(cache, { sleeping: false, now: NOW })
    expect(section.tab).toBe('advanced')
    const info = section.fields[0]
    if (info === undefined || info.type !== 'info') throw new Error('info field expected')
    expect(info.content).toContain('Encoder (getEnc): read 1 m ago')
    expect(info.content).toContain('OSD overlay (getOsd): read 2 m ago')
    expect(info.content).toContain(
      'Image (getVideoInput): age unknown (recorded before per-snapshot freshness tracking)',
    )
    expect(info.content).toContain('Motion (getMotionAlarm): never read')
    // Every declared group appears.
    for (const { label } of SNAPSHOT_GROUPS) {
      expect(info.content).toContain(label)
    }
  })

  it('a sleeping battery camera is named — the panel cannot refresh it and says so', () => {
    const section = buildSnapshotFreshnessSection(undefined, { sleeping: true, now: NOW })
    const info = section.fields[0]
    if (info === undefined || info.type !== 'info') throw new Error('info field expected')
    expect(info.content).toContain('never woken')
  })
})

describe('the schema persists the stamp map', () => {
  it('snapshotFetchedAt round-trips through the config schema', () => {
    const parsed = reolinkCameraSchema.parse({
      host: '192.168.10.121',
      username: 'admin',
      password: 'x',
      deviceCache: {
        encSnapshot: { audio: 1 },
        snapshotFetchedAt: { encSnapshot: NOW },
      },
    })
    expect(parsed.deviceCache?.snapshotFetchedAt).toEqual({ encSnapshot: NOW })
  })
})

describe('ReolinkCamera wiring (structural)', () => {
  it('the bulk snapshot persist stamps exactly the written groups', () => {
    // The stamp call must sit between building `cacheUpdate` and the
    // `setAll` that writes it, and be fed by the written keys.
    expect(cameraSource).toContain(
      "const writtenSnapshotKeys = Object.keys(cacheUpdate).filter((k) => k.endsWith('Snapshot'))",
    )
    expect(cameraSource).toContain('cacheUpdate.snapshotFetchedAt = stampSnapshotFreshness(')
  })

  it('the email-config persist stamps its group', () => {
    expect(cameraSource).toMatch(
      /emailConfigSnapshot:[\s\S]{0,600}stampSnapshotFreshness\(\s*current\.snapshotFetchedAt,\s*\['emailConfigSnapshot'\]/,
    )
  })

  it('the cap-options persist stamps its group', () => {
    expect(cameraSource).toMatch(
      /capOptionsSnapshot:[\s\S]{0,600}stampSnapshotFreshness\(\s*current\.snapshotFetchedAt,\s*\['capOptionsSnapshot'\]/,
    )
  })

  it('the autofocus write-path re-read stamps its group', () => {
    expect(cameraSource).toMatch(
      /autoFocusSnapshot:[\s\S]{0,800}stampSnapshotFreshness\(\s*afCurrent\?\.snapshotFetchedAt,\s*\['autoFocusSnapshot'\]/,
    )
  })

  it('the settings form renders the freshness panel', () => {
    expect(cameraSource).toContain('buildSnapshotFreshnessSection(cache, {')
  })
})
