import { describe, expect, it } from 'vitest'
import {
  CAMERA_101,
  DOORBELL_SWITCH,
  GATE_SENSOR,
  PIR_SENSOR,
} from '../../../../../../../types/src/composition/customize/__fixtures__/refs.js'
import {
  applySpan,
  cameraSensorsMutation,
  motionTimeoutMutation,
  pulseFeatureFromForm,
  spanApplyFromForm,
} from '../event-form'

describe('event form apply', () => {
  it('compiles the operator doorbell', () => {
    const feature = pulseFeatureFromForm({
      cap: 'doorbell',
      targetId: 'pressed',
      device: CAMERA_101,
      enabled: true,
      debounceMs: 2_000,
      sources: [
        {
          addonId: DOORBELL_SWITCH.addonId,
          stableId: DOORBELL_SWITCH.stableId,
          cap: 'switch',
          fieldPath: 'on',
          changedAtField: 'lastChangedAt',
        },
      ],
    })
    expect(feature?.fields.lastPressedAt).toMatchObject({
      kind: 'expression',
      expr: 'latest(rose(active0, changed0, 2000))',
    })
    expect(feature?.fields.pressCountSinceStart).toMatchObject({ expr: 'count(lastPressedAt)' })
  })

  it('applies a span through setCameraSensors and motionCooldownMs', () => {
    const compiled = spanApplyFromForm({
      cap: 'motion',
      targetId: 'detected',
      device: CAMERA_101,
      timeoutMs: 45_000,
      cooldownMs: undefined,
      sources: [
        {
          addonId: PIR_SENSOR.addonId,
          stableId: PIR_SENSOR.stableId,
          cap: 'binary',
          fieldPath: 'on',
          mode: 'in-addition',
          label: 'PIR',
        },
        {
          addonId: GATE_SENSOR.addonId,
          stableId: GATE_SENSOR.stableId,
          cap: 'contact',
          fieldPath: 'entryOpen',
          mode: 'confirm',
          label: 'Gate',
        },
      ],
    })
    expect(compiled).not.toBeNull()
    if (compiled === null) return
    expect(cameraSensorsMutation(101, compiled)).toEqual({
      deviceId: 101,
      config: {
        sensors: [
          { addonId: PIR_SENSOR.addonId, stableId: PIR_SENSOR.stableId, mode: 'in-addition' },
          { addonId: GATE_SENSOR.addonId, stableId: GATE_SENSOR.stableId, mode: 'confirm' },
        ],
      },
    })
    expect(motionTimeoutMutation(101, compiled.timeoutMs)).toEqual({
      deviceId: 101,
      patch: { motionCooldownMs: 45_000 },
    })
  })

  it('does not write the timeout when the sensor list is refused', async () => {
    const compiled = spanApplyFromForm({
      cap: 'motion',
      targetId: 'detected',
      device: CAMERA_101,
      timeoutMs: 30_000,
      cooldownMs: undefined,
      sources: [],
    })
    expect(compiled).not.toBeNull()
    if (compiled === null) return
    const order: string[] = []
    await applySpan(
      101,
      compiled,
      async () => {
        order.push('sensors')
      },
      async () => {
        order.push('timeout')
      },
    )
    expect(order).toEqual(['sensors', 'timeout'])
    await expect(
      applySpan(
        101,
        compiled,
        async () => {
          throw new Error('refused')
        },
        async () => {
          order.push('late')
        },
      ),
    ).rejects.toThrow('refused')
    expect(order).not.toContain('late')
  })
})
