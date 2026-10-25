import { ContactStatusSchema } from '@camstack/types'
import { detectionValue, iface, unshaped } from './shared.js'
import type { GenericAdapter } from './types.js'

/** `contact` → `Alexa.ContactSensor` (CONTACT_SENSOR). Amazon: DETECTED = open. */
export const contactAdapter: GenericAdapter = {
  cap: 'contact',
  stateCaps: ['contact'],
  discoveryReads: [],
  describe: () => ({
    kind: 'publish',
    capabilities: [iface('Alexa.ContactSensor', 'detectionState')],
    category: 'CONTACT_SENSOR',
  }),
  properties: (_cap, slice) => {
    const p = ContactStatusSchema.pick({ entryOpen: true }).safeParse(slice)
    return p.success
      ? [
          {
            namespace: 'Alexa.ContactSensor',
            name: 'detectionState',
            value: detectionValue(p.data.entryOpen),
          },
        ]
      : []
  },
  directives: [],
  shaping: unshaped,
}
