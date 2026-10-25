import { type OsdSlotBinding, OsdSlotBindingSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type OsdFacts, renderSlot, resolveSource } from '../render.js'

const AT = Date.UTC(2026, 7, 7, 9, 5, 0)
const CAMERA = 101

function binding(patch: Partial<OsdSlotBinding>): OsdSlotBinding {
  return OsdSlotBindingSchema.parse({ source: { kind: 'static', text: '' }, ...patch })
}

function facts(
  state: Record<number, Record<string, unknown>>,
  gate?: Map<number, string>,
): OsdFacts {
  return {
    atMs: AT,
    stateByDevice: new Map(Object.entries(state).map(([k, v]) => [Number(k), v])),
    recognitionByDevice: new Map(),
    deviceState: (id) => gate?.get(id),
    templatesById: new Map(),
  }
}

describe('resolveSource', () => {
  it('reads a static string', () => {
    const out = resolveSource(
      binding({ source: { kind: 'static', text: 'HALL' } }),
      CAMERA,
      facts({}),
    )
    expect(out).toEqual({ value: { raw: 'HALL' } })
  })

  it('reads a clock', () => {
    const out = resolveSource(
      binding({ source: { kind: 'clock', pattern: 'HH:mm', timezone: 'UTC' } }),
      CAMERA,
      facts({}),
    )
    expect(out).toEqual({ value: { raw: '09:05' } })
  })

  it('reads the latest recognized person and plate for the camera', () => {
    const recognitionByDevice = new Map([[CAMERA, { person: 'Alice', plate: 'AB123CD' }]])
    const base = { ...facts({}), recognitionByDevice }
    expect(
      resolveSource(
        binding({ source: { kind: 'latest-recognition', recognition: 'person' } }),
        CAMERA,
        base,
      ),
    ).toEqual({ value: { raw: 'Alice' } })
    expect(
      resolveSource(
        binding({ source: { kind: 'latest-recognition', recognition: 'plate' } }),
        CAMERA,
        base,
      ),
    ).toEqual({ value: { raw: 'AB123CD' } })
  })

  it('reads a leaf of the camera OWN state when deviceId is omitted', () => {
    const out = resolveSource(
      binding({ source: { kind: 'device-state', capName: 'motion', valuePath: 'detected' } }),
      CAMERA,
      facts({ [CAMERA]: { motion: { detected: true } } }),
    )
    expect(out).toEqual({ value: { raw: true } })
  })

  it('reads another device when deviceId is given', () => {
    const out = resolveSource(
      binding({
        source: {
          kind: 'device-state',
          deviceId: 42,
          capName: 'temperature-sensor',
          valuePath: 'value',
        },
      }),
      CAMERA,
      facts({ 42: { 'temperature-sensor': { value: 21.7 } } }),
    )
    expect(out).toMatchObject({ value: { raw: 21.7, displayRaw: 21.7 } })
  })

  it('distinguishes an unmirrored device from a missing cap from a missing path', () => {
    const base = { kind: 'device-state' as const, capName: 'motion', valuePath: 'detected' }
    const noDevice = resolveSource(
      binding({ source: { ...base, deviceId: 99 } }),
      CAMERA,
      facts({}),
    )
    const noCap = resolveSource(
      binding({ source: base }),
      CAMERA,
      facts({ [CAMERA]: { battery: { level: 50 } } }),
    )
    const noPath = resolveSource(
      binding({ source: base }),
      CAMERA,
      facts({ [CAMERA]: { motion: { other: 1 } } }),
    )
    expect(noDevice).toMatchObject({ reason: expect.stringContaining('no state mirrored') })
    expect(noCap).toMatchObject({ reason: expect.stringContaining('publishes no "motion"') })
    expect(noPath).toMatchObject({ reason: expect.stringContaining('is absent') })
  })
})

describe('renderSlot', () => {
  it('reports unbound rather than pretending the slot is empty', () => {
    expect(renderSlot('text-1', null, CAMERA, facts({}), undefined)).toMatchObject({
      outcome: 'unbound',
    })
  })

  it('reports disabled and does not compute a value', () => {
    const result = renderSlot(
      'text-1',
      binding({ enabled: false, source: { kind: 'static', text: 'X' } }),
      CAMERA,
      facts({}),
      undefined,
    )
    expect(result).toMatchObject({ outcome: 'disabled', text: '' })
  })

  it('writes blank text for a none source', () => {
    const result = renderSlot(
      'text-1',
      binding({ source: { kind: 'none' } }),
      CAMERA,
      facts({}),
      undefined,
    )
    expect(result).toMatchObject({ outcome: 'written', text: '' })
  })

  it('renders a bound device-state value through the template', () => {
    const result = renderSlot(
      'text-1',
      binding({
        source: {
          kind: 'device-state',
          deviceId: 42,
          capName: 'temperature-sensor',
          valuePath: 'value',
          displayUnit: 'C',
        },
        template: 'T ${value}${unit}',
        maxDecimals: 1,
      }),
      CAMERA,
      facts({ 42: { 'temperature-sensor': { value: 21.78, unit: 'C' } } }),
      undefined,
    )
    expect(result).toEqual({ slotId: 'text-1', outcome: 'written', text: 'T 21.7°C' })
  })

  it('names the reason when the gate is closed (blank text)', () => {
    const result = renderSlot(
      'text-1',
      binding({
        source: { kind: 'static', text: 'ARMED' },
        conditions: { deviceState: { deviceId: 50, states: ['armed_away'] } },
      }),
      CAMERA,
      facts({}),
      undefined,
    )
    expect(result).toMatchObject({ outcome: 'gated', text: '', reason: 'condition "deviceState"' })
  })

  it('names the reason when the value is unreadable (blank text)', () => {
    const result = renderSlot(
      'text-1',
      binding({
        source: { kind: 'device-state', capName: 'motion', valuePath: 'detected' },
      }),
      CAMERA,
      facts({}),
      undefined,
    )
    expect(result.outcome).toBe('unreadable')
    expect(result.text).toBe('')
    expect(result.reason).toBeDefined()
  })

  it('reports unchanged when the render matches what we last wrote', () => {
    const b = binding({ source: { kind: 'static', text: 'HALL' }, template: '${value}' })
    const first = renderSlot('text-1', b, CAMERA, facts({}), undefined)
    expect(first.outcome).toBe('written')
    const second = renderSlot('text-1', b, CAMERA, facts({}), first.text)
    expect(second).toMatchObject({ outcome: 'unchanged', text: 'HALL' })
  })

  it('reports written again once the value moves', () => {
    const b = binding({
      source: { kind: 'device-state', capName: 'motion', valuePath: 'detected' },
      valueMap: { true: 'MOTION', false: '' },
      template: '${value}',
    })
    const on = renderSlot('t', b, CAMERA, facts({ [CAMERA]: { motion: { detected: true } } }), '')
    expect(on).toMatchObject({ outcome: 'written', text: 'MOTION' })
    const off = renderSlot(
      't',
      b,
      CAMERA,
      facts({ [CAMERA]: { motion: { detected: false } } }),
      'MOTION',
    )
    expect(off).toMatchObject({ outcome: 'written', text: '' })
  })
})
