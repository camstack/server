/**
 * System → Terminal (`/system/terminal`). Terminal devices: instances across
 * three nodes in ONE table. Node shells (`?tab=shells`): the hub has opted in
 * to its shell, garage-nuc has not. `old-mac.localdomain` left the cluster (its instance is kept and
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
    // A node's Terminal settings (the `node` scope): the server-shell opt-in lives here.
    'addonSettings.getScopedSettings': (i: { addonId?: string }) =>
      i.addonId === 'terminal'
        ? {
            tabs: null,
            sections: [
              {
                id: 'terminal-server-shell',
                title: 'Server shell',
                description:
                  'A login shell in this node’s data directory, for admins. Off until this node opts in. Sessions close after they sit idle.',
                columns: 2,
                fields: [
                  {
                    type: 'boolean',
                    key: 'serverShellEnabled',
                    label: 'Allow server shell',
                    description:
                      'Lets an admin open a login shell on this node from the Terminal page. Off by default.',
                    value: false,
                  },
                  {
                    type: 'number',
                    key: 'serverShellIdleMinutes',
                    label: 'Idle timeout',
                    description:
                      'Close a server shell after this many minutes with no input and no output.',
                    value: 30,
                    min: 1,
                    max: 1440,
                    unit: 'minutes',
                  },
                ],
              },
            ],
          }
        : null,
    'terminalSession.listProfiles': PROFILES,
    // The hub opted in to its node shell; garage-nuc has not.
    'terminalSession.serverShellStatus': (i: { nodeId?: string }) => {
      const nodeId = i.nodeId ?? 'hub'
      return nodeId === 'hub'
        ? { nodeId, enabled: true, idleMinutes: 30, refusal: null }
        : {
            nodeId,
            enabled: false,
            idleMinutes: 30,
            refusal: {
              code: 'server-shell-disabled',
              nodeId,
              message: `Server shell is off on node ${nodeId}. Turn it on in that node's Terminal settings.`,
            },
          }
    },
    // One instance pty and one node shell: only the first is a "Live session" of Terminal devices.
    'terminalSession.listSessions': (i: { nodeId?: string }) =>
      (i.nodeId ?? 'hub') === 'hub'
        ? [
            {
              sessionId: 'tty-7c1e',
              profileId: 'monitor',
              label: 'BTM',
              cols: 120,
              rows: 32,
              startedAt: NOW - 600_000,
            },
            {
              sessionId: 'sh-91ad',
              profileId: 'server-shell',
              label: 'Server shell',
              cols: 120,
              rows: 32,
              startedAt: NOW - 120_000,
            },
          ]
        : [],
    'mut:terminalSession.openSession': (i: { nodeId: string; profileId: string }) => ({
      sessionId: `${i.profileId}-${i.nodeId}`,
      profileId: i.profileId,
      label: 'Server shell',
      cols: 120,
      rows: 32,
      startedAt: NOW,
    }),
    'mut:terminalSession.close': { ok: true },
    'terminalSession.listLegacyCameras': [
      {
        stableId: 'terminal-camera-garage-nuc',
        nodeId: 'garage-nuc',
        profileId: 'monitor',
        profileLabel: 'BTM',
        name: 'Garage NUC monitor',
        adoptable: true,
      },
    ],
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
