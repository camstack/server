import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Heat pump settable surface (D1026): one typed method per parameter, never a
 * generic `set(key, value)`. The values a mode takes and the limits of a number
 * are the ones `heat-pump-status` carries (`allowed`, `min`, `max`, `step`),
 * read from the gateway; a provider refuses a value outside them. The state is
 * `heat-pump-status` — this cap has none.
 */

const deviceId = z.number().int().nonnegative()
const circuitId = z.string().min(1)
const mode = z.string().min(1)
const temp = z.number().finite()

export const heatPumpControlCapability = {
  name: 'heat-pump-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.HeatPump],
  methods: {
    // System modes — each independent, each with its real values.
    /** off / auto / on. */
    setSilentMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** off / on. */
    setAwayMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** off / manual / auto. */
    setAdditionalHeaterMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** off / hm1 .. hm8 (the programmes the gateway lists). */
    setHolidayMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    // Per circuit.
    setCircuitOperationMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setCircuitHeatCoolMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setCircuitSummerWinter: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setCircuitComfortSetpoint: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setCircuitEcoSetpoint: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setCircuitMaxFlowTemp: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    // Hot water.
    setDhwOperationMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setDhwTemperatureLevel: method(z.object({ deviceId, circuitId, level: mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setDhwChargeDuration: method(
      z.object({ deviceId, circuitId, minutes: z.number().int().positive() }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Start an extra-hot-water charge now: an action, not a stored mode. */
    startExtraHotWater: method(z.object({ deviceId, circuitId }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
} as const satisfies CapabilityDefinition

export type IHeatPumpControlProvider = InferProvider<typeof heatPumpControlCapability>
