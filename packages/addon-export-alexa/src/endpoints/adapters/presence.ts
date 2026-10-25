import { PresenceStatusSchema } from '@camstack/types'
import { detectionValue, iface, unshaped } from './shared.js'
import type { GenericAdapter } from './types.js'

/** `presence` (home = occupied) → `Alexa.MotionSensor` (MOTION_SENSOR). */
export const presenceAdapter: GenericAdapter = {
  cap: 'presence',
  stateCaps: ['presence'],
  discoveryReads: [],
  describe: () => ({
    kind: 'publish',
    capabilities: [iface('Alexa.MotionSensor', 'detectionState')],
    category: 'MOTION_SENSOR',
  }),
  properties: (_cap, slice) => {
    const p = PresenceStatusSchema.pick({ state: true }).safeParse(slice)
    return p.success
      ? [
          {
            namespace: 'Alexa.MotionSensor',
            name: 'detectionState',
            value: detectionValue(p.data.state === 'home'),
          },
        ]
      : []
  },
  directives: [],
  shaping: unshaped,
}
