import { LockControlStatusSchema } from '@camstack/types'
import { alexaLockStateFor, handleLock } from '../../handlers/lock-controller.js'
import { iface, unshaped } from './shared.js'
import type { GenericAdapter } from './types.js'

/** `lock-control` → `Alexa.LockController` (SMARTLOCK). */
export const lockAdapter: GenericAdapter = {
  cap: 'lock-control',
  stateCaps: ['lock-control'],
  discoveryReads: [],
  describe: () => ({
    kind: 'publish',
    capabilities: [iface('Alexa.LockController', 'lockState')],
    category: 'SMARTLOCK',
  }),
  properties: (_cap, slice) => {
    const p = LockControlStatusSchema.pick({ state: true }).safeParse(slice)
    return p.success
      ? [
          {
            namespace: 'Alexa.LockController',
            name: 'lockState',
            value: alexaLockStateFor(p.data.state),
          },
        ]
      : []
  },
  directives: ['Alexa.LockController/Lock', 'Alexa.LockController/Unlock'].map((key) => ({
    key,
    needsReachableDevice: true,
    handle: (c) => handleLock(c.header, c.endpoint, c.deps.lockController),
  })),
  shaping: unshaped,
}
