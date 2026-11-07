/**
 * System → Terminal (`/system/terminal`): instances across three nodes in ONE
 * table. `old-mac.localdomain` left the cluster (its instance is kept and
 * flagged); `edge-proxmox` runs no terminal provider (the registry lists
 * providers on the hub and `garage-nuc` only), so it reads "Terminal not
 * installed on this node" and is not offered when creating a terminal.
 */
import { defineFixtures } from './_define'
import { iso, NOW } from './_time'

const node = (id: string, isHub: boolean, ip: string) => ({
  id,
  name: isHub ? 'Hub' : id,
  hostname: id,
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel(R) N100',
  cpuCores: 8,
  memoryMB: 16_000,
  engines: ['openvino'],
  isHub,
  isOnline: true,
  cpuPercent: 12.1,
  memoryPercent: 38.4,
  uptime: 4 * 86_400_000,
  lastSeen: iso(NOW),
  localIps: [ip],
  addons: [],
  processes: [],
  categories: [],
  rootPackage: { name: '@camstack/server', version: '0.0.0' },
})

const PROFILES = [
  {
    profileId: 'monitor',
    label: 'BTM',
    description: 'Interactive system monitor.',
    executable: 'btm',
    args: [],
    cwd: '',
    environment: [],
    settingsSchema: null,
  },
  {
    profileId: 'top',
    label: 'Top',
    executable: 'top',
    args: [],
    cwd: '',
    environment: [],
    settingsSchema: null,
  },
]

const TERMINAL_FORM = {
  sections: [
    {
      id: 'terminal',
      title: 'Terminal',
      columns: 2,
      fields: [
        { type: 'node-select', key: 'nodeId', label: 'Node', required: true },
        {
          type: 'select',
          key: 'profileId',
          label: 'Profile',
          required: true,
          options: PROFILES.map((p) => ({ value: p.profileId, label: p.label })),
        },
        { type: 'text', key: 'executable', label: 'Executable' },
        { type: 'text', key: 'cwd', label: 'Working directory' },
        { type: 'tags', key: 'args', label: 'Arguments' },
        { type: 'tags', key: 'environment', label: 'Environment' },
      ],
    },
  ],
}

const record = (
  id: string,
  name: string,
  nodeId: string,
  profileId: string,
  enabled: boolean,
  inCluster: boolean,
) => ({
  id,
  name,
  kind: 'terminals',
  configured: true,
  enabled,
  ...(inCluster ? {} : { status: { state: 'error', label: 'Node missing' } }),
  formValues: {
    name,
    enabled,
    nodeId,
    profileId,
    profileLabel: PROFILES.find((p) => p.profileId === profileId)?.label ?? profileId,
    executable: '',
    cwd: '',
    args: [],
    environment: [],
  },
})

export default defineFixtures({
  area: 'terminal',
  description:
    'Terminal instances on three nodes, one absent from the cluster, one without a provider',
  handlers: {
    'nodes.topology': [
      node('hub', true, '192.0.2.2'),
      node('garage-nuc', false, '192.0.2.21'),
      node('edge-proxmox', false, '192.0.2.22'),
    ],
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: 'singleton',
      providers: [i.name],
      activeProvider: i.name,
      disabledProviders: [],
      perNode: [
        { nodeId: 'hub', providers: ['terminal'], resolvedActive: 'terminal', hasOverride: false },
        {
          nodeId: 'garage-nuc',
          providers: ['terminal'],
          resolvedActive: 'terminal',
          hasOverride: false,
        },
      ],
    }),
    'pipelineOrchestrator.listAgentSettings': [],
    'deviceManager.listAll': [
      {
        id: 4101,
        stableId: 'terminal-camera-instance-3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0001',
        addonId: 'terminal',
        type: 'camera',
        name: 'BTM Hub',
        location: null,
        disabled: false,
        parentDeviceId: null,
        role: 'terminal-camera',
        online: true,
        probed: true,
        features: [],
        isCamera: true,
        config: {},
        secretConfigPaths: [],
        metadata: {},
      },
    ],
    'terminalSession.listProfiles': PROFILES,
    'terminalSession.listSessions': [],
    'terminalSession.listLegacyCameras': [],
    'integrationInstances.describe': (i: { addonId: string }) =>
      i.addonId === 'terminal'
        ? {
            role: 'services',
            instanceMode: 'multiple',
            kind: 'terminal',
            canTest: false,
            mintsId: true,
            kinds: [{ id: 'terminals', label: 'Terminal', functionCap: 'terminal-session' }],
          }
        : { role: 'services', instanceMode: 'multiple', kind: 'other', canTest: false, kinds: [] },
    'integrationInstances.instanceFormSchema': () => TERMINAL_FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'terminal'
        ? [
            record('3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0001', 'BTM Hub', 'hub', 'monitor', true, true),
            record(
              '3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0002',
              'Top garage-nuc',
              'garage-nuc',
              'top',
              false,
              true,
            ),
            record(
              '3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0003',
              'BTM old-mac',
              'old-mac.localdomain',
              'monitor',
              true,
              false,
            ),
          ]
        : [],
    'mut:integrationInstances.createInstance': (i: { id: string }) => ({ id: i.id }),
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
  },
})
