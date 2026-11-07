/**
 * Network → Mesh Networks (`/system/network?section=mesh`): the tailnet record behind the list,
 * and the live status and peers the edit dialog's lead card shows. Invented data.
 */
import { defineFixtures } from './_define'

const SET = { $secret: 'ref', v: 1, set: true }

const TAILNET_FORM = {
  sections: [
    {
      id: 'tailnet',
      title: 'Tailnet',
      columns: 2,
      fields: [
        { type: 'password', key: 'authKey', label: 'Pre-auth key' },
        { type: 'text', key: 'hostname', label: 'Hostname', default: '' },
      ],
    },
  ],
}

export default defineFixtures({
  area: 'mesh-networks',
  description: 'the tailnet instance, its mesh status and peers (Network → Mesh Networks)',
  handlers: {
    'integrationInstances.describe': {
      instanceMode: 'single',
      kind: 'tailnet',
      canTest: true,
    },
    'integrationInstances.instanceFormSchema': TAILNET_FORM,
    'integrationInstances.listInstances': [
      {
        id: 'tailnet',
        name: 'Tailnet',
        configured: true,
        formValues: { authKey: SET, hostname: 'camstack-hub' },
      },
    ],
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.testInstance': { success: true, status: 'validated' },
    'meshNetwork.getStatus': {
      joined: true,
      meshIp: '100.64.0.7',
      magicDnsHostname: 'camstack-hub.tail1234.ts.net',
      peerCount: 2,
      endpoints: [
        {
          id: 'mesh',
          label: 'Mesh',
          url: 'https://camstack-hub.tail1234.ts.net',
          scope: 'mesh',
          hostname: 'camstack-hub.tail1234.ts.net',
          port: 443,
          protocol: 'https',
        },
      ],
      tenantName: 'example.com',
      magicDnsSuffix: 'tail1234.ts.net',
      userLogin: 'alice@example.com',
      controlPlaneUrl: 'https://controlplane.example.com',
      keyExpiry: Date.parse('2027-03-01T00:00:00.000Z'),
    },
    'meshNetwork.listPeers': {
      peers: [
        {
          id: 'peer-office-nas',
          hostname: 'office-nas',
          magicDns: 'office-nas.tail1234.ts.net',
          addresses: ['100.64.0.12'],
          online: true,
          lastSeenMs: Date.parse('2026-11-06T12:00:00.000Z'),
          isSelf: false,
          connection: 'direct',
          relay: null,
          lastHandshakeMs: Date.parse('2026-11-06T12:00:00.000Z'),
          rxBytes: 2097152,
          txBytes: 1048576,
          tags: [],
          exitNodeOption: false,
          advertisedRoutes: ['192.0.2.0/24'],
          userLogin: 'alice@example.com',
          keyExpiry: null,
        },
      ],
    },
  },
})
