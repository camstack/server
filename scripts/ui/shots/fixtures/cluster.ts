/**
 * System → Nodes (`/system/nodes`): "Agents found on the network" (D857) and the
 * pairing dialog. Four discovered agents in every state, and a pairing that is
 * waiting for both confirmations (the hub's code is shown, the input is empty).
 * The expiry is relative to the real clock so the countdown reads 4:xx.
 */
import { defineFixtures } from './_define'
import { loadSeries } from './_load-series'

const PAIRING_TTL_MS = 5 * 60_000
const FINGERPRINT = '9F:3A:C1:07:5B:E2:44:D8:10:6C:B9:7E:2A:F5:83:1D'

const AGENTS = [
  {
    nodeId: 'garage-nuc',
    host: '192.0.2.21',
    port: 4444,
    version: '1.2.421',
    state: 'unpaired',
    fingerprint: null,
    source: 'mdns',
    connected: false,
    pairing: null,
  },
  {
    nodeId: 'attic-pi',
    host: '192.0.2.34',
    port: 4444,
    version: '1.2.421',
    state: 'pending',
    fingerprint: null,
    source: 'address',
    connected: false,
    pairing: null,
  },
  {
    nodeId: 'basement-mini',
    host: '192.0.2.40',
    port: 4444,
    version: '1.2.421',
    state: 'paired',
    fingerprint: FINGERPRINT,
    source: 'mdns',
    connected: true,
    pairing: null,
  },
  {
    nodeId: 'shed-box',
    host: '192.0.2.57',
    port: 4444,
    version: '1.2.398',
    state: 'paired',
    fingerprint: '4B:0E:92:AA:31:C7:68:D5:F2:19:80:3C:E4:7D:A6:55',
    source: 'mdns',
    connected: false,
    pairing: null,
  },
]

function pairingView(): Record<string, unknown> {
  return {
    pairingId: 'pair-1',
    nodeId: 'garage-nuc',
    endpoint: { host: '192.0.2.21', port: 4444 },
    code: '482913',
    state: 'awaiting-confirmation',
    hubConfirmed: false,
    agentConfirmed: false,
    expiresAt: Date.now() + PAIRING_TTL_MS - 7_000,
    failure: null,
  }
}

export default defineFixtures({
  area: 'cluster',
  description: 'Discovered agents in every pairing state; a pairing waiting for both screens.',
  handlers: {
    'agentPairing.listDiscoveredAgents': { agents: AGENTS, scannedAt: 1 },
    'mut:agentPairing.beginPairing': pairingView,
    'agentPairing.getPairing': pairingView,
    // A node card's Load tab: three runner functions, one restart hole.
    'metricsProvider.getLoadSeries': (i: { forNodeId: string }) => loadSeries(i.forNodeId),
    'system.getLoadContributions': [],
    'pipelineOrchestrator.listAgentSettings': [],
  },
})
