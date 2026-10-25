/**
 * Shared by `server-name.ts` (the hub was never named: the first-login dialog)
 * and `server-name-set.ts` (a named hub: the Settings field, the sidebar, the
 * Nodes row). D861.
 *
 * `system.info` carries the name; the hub node lists `system-config` among its
 * addons so System -> Settings draws that addon's form, whose Server section
 * mirrors the real one (`system-config.addon.ts`, `buildGlobalSchema`).
 */
import shell from './shell'

const FEATURES = {
  streaming: true,
  notifications: true,
  objectDetection: true,
  remoteAccess: true,
  agentCluster: true,
  smartHome: true,
  recordings: true,
  backup: true,
  repl: false,
}

interface Named {
  readonly name: string
  readonly isDefault: boolean
}

function shellTopology(): readonly Record<string, unknown>[] {
  const rows = shell.handlers['nodes.topology']
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  )
}

/** The shell's topology, with `system-config` installed on the hub. */
function topologyWithSystemConfig(): readonly Record<string, unknown>[] {
  return shellTopology().map((node) =>
    node['isHub'] === true
      ? {
          ...node,
          addons: [
            { id: 'system-config', capabilities: [], status: 'running', name: 'System config' },
          ],
        }
      : node,
  )
}

function serverSection(stored: string) {
  return {
    id: 'system-config-server',
    title: 'Server',
    description:
      'The name of this server, and its connection settings (read-only, loaded from config.yaml at bootstrap).',
    columns: 2,
    fields: [
      {
        type: 'text',
        key: 'name',
        label: 'Server name',
        description:
          "Shown in the admin UI and on the apps' sign-in screen (1 to 48 characters). Leave empty to use this machine's hostname.",
        placeholder: 'nas',
        span: 2,
        value: stored,
      },
      {
        type: 'info',
        key: 'server-restart-note',
        label: 'Restart required',
        content: 'Port, host and data path are read-only. Change them in config.yaml and restart.',
        variant: 'warning',
      },
      {
        type: 'text',
        key: 'port',
        label: 'Port',
        description: 'Listening port',
        disabled: true,
        value: '4443',
      },
      {
        type: 'text',
        key: 'host',
        label: 'Host',
        description: 'Bind address',
        disabled: true,
        value: '0.0.0.0',
      },
      {
        type: 'text',
        key: 'dataPath',
        label: 'Data Path',
        description: 'Root data directory',
        disabled: true,
        span: 2,
        value: '/data',
      },
    ],
  }
}

export function serverNameHandlers(info: Named, stored: string): Record<string, unknown> {
  return {
    'system.info': { ...FEATURES, serverName: info },
    'auth.listLoginMethods': [],
    'auth.getServerName': info,
    'nodes.topology': topologyWithSystemConfig(),
    'addonSettings.getGlobalSettings': (input: { addonId?: string }) =>
      input.addonId === 'system-config' ? { sections: [serverSection(stored)] } : null,
  }
}
