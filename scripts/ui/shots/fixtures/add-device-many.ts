/**
 * The ESPHome Add device modal with a long adoption list (120 boards, every fifth one already adopted):
 * the list must scroll inside the modal. Invented data only.
 */
import { addDeviceFixtures } from './add-device'

const BASE = addDeviceFixtures(
  'add-device-many',
  'Add device modal with a long candidate list',
  'scan',
)

const CANDIDATES = Array.from({ length: 120 }, (_, i) => {
  const number = String(i + 1).padStart(3, '0')
  const adopted = i % 5 === 0
  return {
    childNativeId: `esphome-node-${number}`,
    name: `node-${number}`,
    type: 'container',
    status: 'online',
    metadata: {},
    alreadyAdopted: adopted,
    adoptedDeviceId: adopted ? 100 + i : null,
    capabilities: [],
    children: [],
  }
})

export default {
  ...BASE,
  handlers: {
    ...BASE.handlers,
    'deviceManager.adoptionListCandidates': {
      candidates: CANDIDATES,
      totalCount: CANDIDATES.length,
      page: 1,
      pageSize: 500,
    },
  },
}
