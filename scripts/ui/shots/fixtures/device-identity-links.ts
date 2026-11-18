/**
 * A device's Hardware block with its identity links (D1063): one PoE port that
 * powers it (linked), one same-device proposal waiting for the operator.
 * `--fixtures device-identity-links --route "/devices/20"
 *  --step 'click:role=button[name="Hardware"]'`. Names are invented.
 */
import { defineFixtures } from './_define'

const device = (id: number, name: string, addonId: string, type: string) => ({
  id,
  stableId: `${addonId}:dev-${id}`,
  addonId,
  type,
  name,
  location: 'Garden',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: { manufacturer: 'Acme', model: 'GX-4' },
  identifiers: {
    mac: [{ value: 'aa:bb:cc:00:11:22', origin: 'read', readAt: 1 }],
    ip: { value: '192.0.2.50', origin: 'read', readAt: 1 },
  },
})

const HOST = device(20, 'Garden gate', 'provider-acme', 'switch')
const PORT = device(10, 'Port 7 (Garden gate)', 'provider-unifi', 'switch')
const TWIN = device(30, 'Garden gate relay', 'provider-other', 'switch')
const DEVICES: Record<number, ReturnType<typeof device>> = { 10: PORT, 20: HOST, 30: TWIN }

const side = (d: ReturnType<typeof device>) => ({
  addonId: d.addonId,
  stableId: d.stableId,
  deviceId: d.id,
})

const LINKS = [
  {
    id: 'poe-power:port|host',
    kind: 'poe-power',
    a: side(PORT),
    b: side(HOST),
    state: 'linked',
    origin: 'auto',
    evidence: [
      { key: 'ip', value: '192.0.2.50' },
      { key: 'mac', value: 'aa:bb:cc:00:11:22' },
    ],
    createdAt: 1,
    decidedAt: 1,
  },
  {
    id: 'same-device:host|twin',
    kind: 'same-device',
    a: side(HOST),
    b: side(TWIN),
    state: 'proposed',
    origin: 'auto',
    evidence: [{ key: 'mac', value: 'aa:bb:cc:00:11:22' }],
    createdAt: 1,
  },
]

export default defineFixtures({
  area: 'device-identity-links',
  description: 'Device Hardware block with a linked PoE port and a same-device proposal',
  handlers: {
    'deviceManager.listAll': Object.values(DEVICES),
    'deviceManager.getDevice': (input: { deviceId?: number }) =>
      DEVICES[input.deviceId ?? -1] ?? null,
    'deviceManager.getDeviceAggregate': {
      settings: { tabs: [], sections: [] },
      live: { sections: [] },
      deviceId: 20,
    },
    'deviceManager.getBindings': { deviceId: 20, entries: [] },
    'deviceManager.getChildren': [],
    'deviceManager.listIdentityLinks': { status: 'answered', links: LINKS },
    'powerSource.getStatus': { linked: false },
  },
})
