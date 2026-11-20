/**
 * The camera no longer hand-sets the features its caps already say (#459):
 * Rebootable, PanTiltZoom, PtzAutotrack and TwoWayAudio are derived by the
 * kernel from the `reboot` / `ptz` / `ptz-autotrack` / `intercom` caps. The
 * driver reports only what has no cap yet (NativeSnapshot), whatever the
 * persisted probe says, and never re-publishes a feature list after a probe.
 *
 * Disarm: put the probe-driven pushes back in `get features` or the
 * `refreshFeatures()` call after the probe, and this spec fails.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DeviceFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HikvisionCamera } from '../hikvision-camera.js'

function featuresOf(deviceCache: object): readonly DeviceFeature[] {
  const getter = Object.getOwnPropertyDescriptor(HikvisionCamera.prototype, 'features')?.get
  if (getter === undefined) throw new Error('HikvisionCamera.features getter missing')
  const subject = {
    config: { get: (key: string) => (key === 'deviceCache' ? deviceCache : undefined) },
  }
  return getter.call(subject)
}

describe('HikvisionCamera features', () => {
  it('reports only NativeSnapshot, even for a probe that found PTZ, autotrack and intercom', () => {
    expect(featuresOf({ hasPtz: true, hasAutotrack: true, hasIntercom: true })).toEqual([
      DeviceFeature.NativeSnapshot,
    ])
  })

  it('does not re-publish a feature list after the probe', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../hikvision-camera.ts', import.meta.url)),
      'utf8',
    )
    expect(source).not.toMatch(/\brefreshFeatures\s*\(/)
  })
})
