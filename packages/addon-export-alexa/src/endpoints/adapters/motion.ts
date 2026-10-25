import { MotionStatusSchema } from '@camstack/types'
import { detectionValue, iface, unshaped } from './shared.js'
import type { GenericAdapter } from './types.js'

/** `motion` → `Alexa.MotionSensor` (MOTION_SENSOR). */
export const motionAdapter: GenericAdapter = {
  cap: 'motion',
  stateCaps: ['motion'],
  discoveryReads: [],
  describe: () => ({
    kind: 'publish',
    capabilities: [iface('Alexa.MotionSensor', 'detectionState')],
    category: 'MOTION_SENSOR',
  }),
  properties: (_cap, slice) => {
    const p = MotionStatusSchema.pick({ detected: true }).safeParse(slice)
    return p.success
      ? [
          {
            namespace: 'Alexa.MotionSensor',
            name: 'detectionState',
            value: detectionValue(p.data.detected),
          },
        ]
      : []
  },
  directives: [],
  shaping: unshaped,
}
