/**
 * Network -> Remote Access (`/system/network?section=remote-access` or the page route it lives
 * under): one `network-access` table. A Cloudflare tunnel keeps a record (a row, connected, with
 * its endpoint); Tailscale Funnel keeps none (a fixed row, disconnected, last start refused).
 * Invented data.
 */
import { defineFixtures } from './_define'

const FORM = {
  sections: [
    {
      id: 'tunnel',
      title: 'Tunnel',
      columns: 2,
      fields: [{ type: 'text', key: 'label', label: 'Label', default: '' }],
    },
  ],
}

export default defineFixtures({
  area: 'remote-access',
  description: 'Remote Access as an instance row (connected) and a fixed row (disconnected)',
  handlers: {
    'addons.listCapabilityProviders': (i: { capName: string }) => {
      if (i.capName === 'network-access') {
        return ['cloudflare-tunnel', 'tailscale-ingress'].map((addonId) => ({
          addonId,
          capName: i.capName,
          isActive: true,
        }))
      }
      if (i.capName === 'integration-instances') {
        return [{ addonId: 'cloudflare-tunnel', capName: i.capName, isActive: true }]
      }
      return []
    },
    'integrationInstances.describe': { instanceMode: 'multiple', kind: 'tunnel', canTest: false },
    'integrationInstances.instanceFormSchema': FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'cloudflare-tunnel'
        ? [{ id: 'tun_001', name: 'cams.example.com', configured: true, formValues: { label: 'x' } }]
        : [],
    'networkAccess.getStatus': (i: { addonId: string }) =>
      i.addonId === 'cloudflare-tunnel'
        ? {
            connected: true,
            endpoint: {
              url: 'https://cams.example.com',
              hostname: 'cams.example.com',
              port: 443,
              protocol: 'https',
            },
          }
        : { connected: false, endpoint: null },
  },
})
