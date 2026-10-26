/**
 * Shot fixtures must answer the same facts the Customize tab reads (D944).
 * Device 510 is an HA sensor whose only native cap is numeric-sensor: battery
 * is composable and absent natively, so the add card is offered. Device 511
 * already serves battery, so it is not.
 */
import { describe, expect, it } from 'vitest'
import appliances from '../ui/shots/fixtures/appliances'
import camera from '../ui/shots/fixtures/camera'

interface FixtureHandlers {
  readonly handlers: Readonly<Record<string, unknown>>
}

function answer(area: FixtureHandlers, path: string, input: unknown): unknown {
  const handler = area.handlers[path]
  if (typeof handler !== 'function') throw new Error(`${path} is not a function`)
  return handler(input)
}

function capNames(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || !('entries' in value)) return []
  const entries = value.entries
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    'capName' in entry &&
    typeof entry.capName === 'string'
      ? [entry.capName]
      : [],
  )
}

function composableCaps(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || !('caps' in value)) return []
  const caps = value.caps
  if (!Array.isArray(caps)) return []
  return caps.flatMap((cap) =>
    cap !== null && typeof cap === 'object' && 'cap' in cap && typeof cap.cap === 'string'
      ? [cap.cap]
      : [],
  )
}

describe('appliance customize fixtures (D944)', () => {
  it('offers battery on a sensor and records 510 as numeric-sensor only', () => {
    expect(
      composableCaps(answer(appliances, 'coreBlocks.listComposableCaps', { deviceType: 'sensor' })),
    ).toContain('battery')
    const native = capNames(answer(appliances, 'deviceManager.getBindings', { deviceId: 510 }))
    expect(native).toContain('numeric-sensor')
    expect(native).not.toContain('battery')
  })

  it('records 511 as a sensor that already serves battery', () => {
    const device = answer(appliances, 'deviceManager.getDevice', { deviceId: 511 })
    expect(device).toEqual(expect.objectContaining({ type: 'sensor' }))
    expect(capNames(answer(appliances, 'deviceManager.getBindings', { deviceId: 511 }))).toContain(
      'battery',
    )
  })

  it('offers running-state on a vacuum that does not serve it natively', () => {
    expect(
      composableCaps(answer(appliances, 'coreBlocks.listComposableCaps', { deviceType: 'vacuum' })),
    ).toContain('running-state')
    expect(
      capNames(answer(appliances, 'deviceManager.getBindings', { deviceId: 504 })),
    ).not.toContain('running-state')
  })
})

describe('camera customize fixtures (D944)', () => {
  it('answers camera sensors for a camera that does not serve motion natively', () => {
    expect(capNames(answer(camera, 'deviceManager.getBindings', { deviceId: 101 }))).not.toContain(
      'motion',
    )
    const status = answer(camera, 'pipelineOrchestrator.getCameraStatus', { deviceId: 101 })
    expect(status).toEqual(expect.objectContaining({ cameraSensors: expect.anything() }))
  })
})
