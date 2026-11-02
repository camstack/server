/**
 * What a cover exports follows what the device DECLARES: `cover-positionable`
 * gives a position control, `cover-tilt` a tilt one, and neither is assumed.
 * An offline device is announced unavailable, and a refused command carries
 * the provider's own reason into the 422 body.
 *
 * Disarm: drop the `requiresFeature` filters (native, degraded and the stop command) — the
 * feature specs fail; drop `availability_topic` — the availability spec fails;
 * make `commandNotAppliedBody` return only `{ error }` — the 422 spec fails.
 */
import { describe, expect, it } from 'vitest'
import { applyCapCommand, type CapCommandDevice, commandNotAppliedBody } from '../command-routes.js'
import { LEGACY_SUPPORT } from '../component-support.js'
import { buildDerivedPlan } from '../entity-catalog.js'
import { projectDeviceStatus } from '../state-projector.js'
import { stateTopic } from '../topics.js'
import type { CatalogDevice, HaComponent, HaPlatform } from '../types.js'

const NATIVE = { platforms: new Set<HaPlatform>([...LEGACY_SUPPORT, 'cover']) }
const LEGACY = { platforms: LEGACY_SUPPORT }

function cover(features: readonly string[]): CatalogDevice {
  return {
    id: 5384,
    name: 'Velux',
    type: 'cover',
    features,
    boundCaps: ['cover'],
    zones: [],
    switches: [],
    slices: ['cover'],
  }
}

function native(plan: { readonly cmps: Readonly<Record<string, HaComponent>> }): HaComponent {
  const component = plan.cmps['cover-cover']
  if (component === undefined) throw new Error('no native cover')
  return component
}

describe('a cover exports only what it declares', () => {
  it('native: cover-positionable alone has position and no tilt', () => {
    const plan = buildDerivedPlan(cover(['cover-positionable']), NATIVE)
    const controls = native(plan).controls ?? {}
    expect(Object.keys(controls)).toContain('position')
    expect(Object.keys(controls)).not.toContain('tilt')
    expect(Object.keys(controls)).toEqual(expect.arrayContaining(['open', 'close']))
    expect(Object.keys(plan.cmps)).not.toContain('number-cover-tilt')
  })

  it('native: no feature means neither slider', () => {
    const controls = native(buildDerivedPlan(cover([]), NATIVE)).controls ?? {}
    expect(Object.keys(controls)).not.toContain('position')
    expect(Object.keys(controls)).not.toContain('tilt')
  })

  it('native: both features give both sliders', () => {
    const controls =
      native(buildDerivedPlan(cover(['cover-positionable', 'cover-tilt']), NATIVE)).controls ?? {}
    expect(Object.keys(controls)).toEqual(expect.arrayContaining(['position', 'tilt']))
  })

  it('degraded: no tilt number without cover-tilt, position kept', () => {
    const keys = Object.keys(buildDerivedPlan(cover(['cover-positionable']), LEGACY).cmps)
    expect(keys).toContain('number-cover-position')
    expect(keys).not.toContain('number-cover-tilt')
    expect(Object.keys(buildDerivedPlan(cover([]), LEGACY).cmps)).not.toContain(
      'number-cover-position',
    )
  })
})

describe('a cover has a stop only when it declares cover-stoppable', () => {
  it('native: cover-positionable alone has no stop, open and close stay', () => {
    const plan = buildDerivedPlan(cover(['cover-positionable']), NATIVE)
    const keys = Object.keys(native(plan).controls ?? {})
    expect(keys).not.toContain('stop')
    expect(keys).toEqual(expect.arrayContaining(['open', 'close']))
  })

  it('native: cover-stoppable gives stop', () => {
    const plan = buildDerivedPlan(cover(['cover-positionable', 'cover-stoppable']), NATIVE)
    expect(Object.keys(native(plan).controls ?? {})).toContain('stop')
  })

  it('degraded: no stop button without cover-stoppable, open and close stay', () => {
    const keys = Object.keys(buildDerivedPlan(cover(['cover-positionable']), LEGACY).cmps)
    expect(keys).not.toContain('button-cover-stop')
    expect(keys).toEqual(expect.arrayContaining(['button-cover-open', 'button-cover-close']))
  })

  it('degraded: cover-stoppable gives the stop button', () => {
    const keys = Object.keys(buildDerivedPlan(cover(['cover-stoppable']), LEGACY).cmps)
    expect(keys).toContain('button-cover-stop')
  })
})

describe('an offline cover is unavailable', () => {
  it('the native cover is available only on the device online topic', () => {
    const component = native(buildDerivedPlan(cover(['cover-positionable']), NATIVE))
    const onlineTopic = stateTopic('camstack-5384', 'online')
    expect(component.availability_topic).toBe(onlineTopic)
    expect(component.payload_available).toBe('true')
    expect(component.payload_not_available).toBe('false')
    const offline = projectDeviceStatus('camstack-5384', false)
    expect(offline).toEqual([{ topic: onlineTopic, value: 'false' }])
  })
})

describe('a refused command says why', () => {
  const failing: CapCommandDevice = {
    cover: {
      open: async () => undefined,
      close: async () => undefined,
      stop: async () => undefined,
      setTiltPosition: async () => undefined,
      getStatus: async () => null,
      setPosition: async () => {
        throw new Error('KLF session is down')
      },
    },
  }

  it('carries the reason and message in the 422 body', async () => {
    const outcome = await applyCapCommand(failing, {
      kind: 'cover-position',
      deviceId: 5384,
      position: 40,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(
      commandNotAppliedBody({ ok: false, reason: outcome.reason, message: outcome.error }),
    ).toEqual({
      error: 'command not applied',
      reason: 'refused',
      message: 'KLF session is down',
    })
  })

  it('omits message when there is none', () => {
    expect(commandNotAppliedBody({ ok: false, reason: 'no-provider' })).toEqual({
      error: 'command not applied',
      reason: 'no-provider',
    })
  })
})
