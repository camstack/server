import { describe, it, expect } from 'vitest'
import { resolveMediaSettings, MEDIA_DEFAULTS } from '../media-settings.js'

describe('MEDIA_DEFAULTS', () => {
  it('cropPadding default is 0.15', () => {
    expect(MEDIA_DEFAULTS.cropPadding).toBe(0.15)
  })

  it('debug media is OFF by default, 5s snapshot interval', () => {
    expect(MEDIA_DEFAULTS.debugMediaEnabled).toBe(false)
    expect(MEDIA_DEFAULTS.snapshotIntervalMs).toBe(5_000)
  })

  it('motion-marker drought window defaults to 15 min (just past the fleet p90)', () => {
    expect(MEDIA_DEFAULTS.motionMarkerQuietMs).toBe(900_000)
  })

  it('movement-gate defaults: 3% frame diagonal, 30s max idle', () => {
    expect(MEDIA_DEFAULTS.snapshotMovementThreshold).toBe(0.03)
    expect(MEDIA_DEFAULTS.snapshotMaxIdleMs).toBe(30_000)
  })
})

describe('resolveMediaSettings — §5 snapshot cadence fields', () => {
  it('honours debugMediaEnabled + snapshotIntervalMs overrides', () => {
    const r = resolveMediaSettings({ debugMediaEnabled: true, snapshotIntervalMs: 12_000 })
    expect(r.debugMediaEnabled).toBe(true)
    expect(r.snapshotIntervalMs).toBe(12_000)
  })

  it('falls back per-field for invalid snapshot-cadence values', () => {
    const r = resolveMediaSettings({ debugMediaEnabled: 'yes', snapshotIntervalMs: 100 }) // below min 500
    expect(r.debugMediaEnabled).toBe(MEDIA_DEFAULTS.debugMediaEnabled)
    expect(r.snapshotIntervalMs).toBe(MEDIA_DEFAULTS.snapshotIntervalMs)
  })

  it('a retired saveThumbnails value in the stored blob does not resurrect the knob', () => {
    const r = resolveMediaSettings({ saveThumbnails: true })
    expect(r.debugMediaEnabled).toBe(false)
    expect('saveThumbnails' in r).toBe(false)
  })

  it('honours movement-gate overrides', () => {
    const r = resolveMediaSettings({ snapshotMovementThreshold: 0.08, snapshotMaxIdleMs: 45_000 })
    expect(r.snapshotMovementThreshold).toBe(0.08)
    expect(r.snapshotMaxIdleMs).toBe(45_000)
  })

  it('accepts 0 movement threshold (gate disabled)', () => {
    expect(resolveMediaSettings({ snapshotMovementThreshold: 0 }).snapshotMovementThreshold).toBe(0)
  })

  it('falls back per-field for out-of-range movement-gate values', () => {
    const r = resolveMediaSettings({ snapshotMovementThreshold: 2, snapshotMaxIdleMs: 100 })
    expect(r.snapshotMovementThreshold).toBe(MEDIA_DEFAULTS.snapshotMovementThreshold)
    expect(r.snapshotMaxIdleMs).toBe(MEDIA_DEFAULTS.snapshotMaxIdleMs)
  })
})

describe('resolveMediaSettings', () => {
  it('returns all defaults for an empty blob', () => {
    expect(resolveMediaSettings({})).toEqual(MEDIA_DEFAULTS)
  })

  it('honours a valid cropPadding override', () => {
    const r = resolveMediaSettings({ cropPadding: 0.3 })
    expect(r.cropPadding).toBe(0.3)
  })

  it('falls back to default for an invalid value (out of range)', () => {
    const r = resolveMediaSettings({ cropPadding: 5 })
    expect(r.cropPadding).toBe(MEDIA_DEFAULTS.cropPadding)
  })

  it('falls back to default for wrong type', () => {
    const r = resolveMediaSettings({ cropPadding: 'wide' })
    expect(r.cropPadding).toBe(MEDIA_DEFAULTS.cropPadding)
  })

  it('falls back to default for negative value (below min 0)', () => {
    const r = resolveMediaSettings({ cropPadding: -0.1 })
    expect(r.cropPadding).toBe(MEDIA_DEFAULTS.cropPadding)
  })

  it('accepts boundary values 0 and 2', () => {
    expect(resolveMediaSettings({ cropPadding: 0 }).cropPadding).toBe(0)
    expect(resolveMediaSettings({ cropPadding: 2 }).cropPadding).toBe(2)
  })
})
