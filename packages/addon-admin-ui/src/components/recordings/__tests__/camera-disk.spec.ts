/**
 * The Disk column's attribution, and the honesty rule it exists to keep:
 * an answer the data supports is EXACT, an answer it only implies is MARKED,
 * and an answer it cannot support at all is not rendered.
 */
import { describe, expect, it } from 'vitest'
import { resolveCameraDisk } from '../camera-disk'

const NAMES = new Map<string, string>([
  ['recordings:default', 'Array'],
  ['recordingsLow:default', 'Array (low)'],
  ['recordings:nvme', 'NVMe'],
])

describe('resolveCameraDisk', () => {
  it('one physical volume — the answer is exact', () => {
    const disk = resolveCameraDisk(
      [{ locationId: 'recordings:default', locationIds: ['recordings:default'] }],
      NAMES,
      'recordings:default',
    )
    expect(disk).toEqual({ label: 'Array', exact: true })
  })

  it('joins the aliases sharing one volume, as the disk cards do', () => {
    const disk = resolveCameraDisk(
      [
        {
          locationId: 'recordings:default',
          locationIds: ['recordings:default', 'recordingsLow:default'],
        },
      ],
      NAMES,
      'recordings:default',
    )
    expect(disk).toEqual({ label: 'Array + Array (low)', exact: true })
  })

  it('several volumes — falls back to the CLASS DEFAULT and marks it inexact', () => {
    const disk = resolveCameraDisk(
      [
        { locationId: 'recordings:nvme', locationIds: ['recordings:nvme'] },
        { locationId: 'recordings:default', locationIds: ['recordings:default'] },
      ],
      NAMES,
      'recordings:default',
    )
    // Per-camera placement is not on the cap, so this is an approximation and
    // says so. A guess rendered as a fact is how a column loses its operator.
    expect(disk).toEqual({ label: 'Array', exact: false })
  })

  it('several volumes and no known default — renders NOTHING rather than a guess', () => {
    const disk = resolveCameraDisk(
      [{ locationId: 'recordings:nvme' }, { locationId: 'recordings:default' }],
      NAMES,
      null,
    )
    expect(disk).toBeNull()
  })

  it('several volumes and a default on none of them — renders nothing', () => {
    const disk = resolveCameraDisk(
      [{ locationId: 'recordings:nvme' }, { locationId: 'recordings:usb' }],
      NAMES,
      'recordings:default',
    )
    expect(disk).toBeNull()
  })

  it('no volumes at all — nothing to attribute', () => {
    expect(resolveCameraDisk([], NAMES, 'recordings:default')).toBeNull()
  })

  it('falls back to the raw id when a location has no display name yet', () => {
    const disk = resolveCameraDisk([{ locationId: 'recordings:brand-new' }], NAMES, null)
    expect(disk).toEqual({ label: 'recordings:brand-new', exact: true })
  })

  it('names the degraded single-root fallback rather than showing an empty cell', () => {
    // `locationId: null` is the recorder's legacy/degraded single-root row.
    const disk = resolveCameraDisk([{ locationId: null }], NAMES, null)
    expect(disk).toEqual({ label: 'default root', exact: true })
  })
})
