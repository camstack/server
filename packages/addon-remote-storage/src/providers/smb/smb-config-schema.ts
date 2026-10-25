import type { ConfigUISchema } from '@camstack/types'

/**
 * SMB / CIFS `storage-provider` config schema — drives the "Add location"
 * wizard form in the admin UI.
 *
 * The shape follows the operator's own production Samba backup client:
 * a server address, a target
 * directory, username / password / domain, and a max-protocol override for
 * the servers that need one pinned.
 *
 * `share` is split out of the address rather than asking the operator for a
 * `//host/share` UNC string, because the pair `(host, share, basePath)` is the
 * duplicate-location key the provider refuses on — a free-form UNC string
 * would have to be re-parsed to ask that question, and would compare unequal
 * for two spellings of the same share.
 */
export const SMB_CONFIG_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'connection',
      title: 'Connection',
      titleKey: 'remote-storage:smb.s_connection.title',
      fields: [
        {
          type: 'text',
          key: 'host',
          label: 'Server',
          labelKey: 'remote-storage:smb.s_connection.host.label',
          description: 'SMB server hostname or IP (no slashes).',
          descriptionKey: 'remote-storage:smb.s_connection.host.description',
          required: true,
          placeholder: 'nas.local',
        },
        {
          type: 'text',
          key: 'share',
          label: 'Share',
          labelKey: 'remote-storage:smb.s_connection.share.label',
          description: 'Share name as exported by the server, without slashes.',
          descriptionKey: 'remote-storage:smb.s_connection.share.description',
          required: true,
          placeholder: 'backups',
        },
        {
          type: 'number',
          key: 'port',
          label: 'Port',
          labelKey: 'remote-storage:smb.s_connection.port.label',
          description: 'Leave empty for the default (445).',
          descriptionKey: 'remote-storage:smb.s_connection.port.description',
          min: 1,
          max: 65535,
        },
        {
          type: 'text',
          key: 'username',
          label: 'Username',
          labelKey: 'remote-storage:smb.s_connection.username.label',
          description: 'Leave empty for a guest (anonymous) connection.',
          descriptionKey: 'remote-storage:smb.s_connection.username.description',
        },
        {
          type: 'password',
          key: 'password',
          label: 'Password',
          labelKey: 'remote-storage:smb.s_connection.password.label',
          showToggle: true,
        },
        {
          type: 'text',
          key: 'domain',
          label: 'Domain / Workgroup',
          labelKey: 'remote-storage:smb.s_connection.domain.label',
          description: 'Optional. Required by some AD-joined servers.',
          descriptionKey: 'remote-storage:smb.s_connection.domain.description',
        },
        {
          type: 'text',
          key: 'maxProtocol',
          label: 'Max protocol',
          labelKey: 'remote-storage:smb.s_connection.maxProtocol.label',
          description:
            'Optional dialect ceiling, e.g. SMB3. Set this when a server negotiates a dialect the client mishandles.',
          descriptionKey: 'remote-storage:smb.s_connection.maxProtocol.description',
          placeholder: 'SMB3',
        },
      ],
    },
    {
      id: 'storage',
      title: 'Storage',
      titleKey: 'remote-storage:smb.s_storage.title',
      fields: [
        {
          type: 'text',
          key: 'basePath',
          label: 'Directory in share',
          labelKey: 'remote-storage:smb.s_storage.basePath.label',
          description:
            'Directory inside the share where files are written. Leave empty for the share root. Created if missing.',
          descriptionKey: 'remote-storage:smb.s_storage.basePath.description',
          placeholder: 'camstack',
        },
      ],
    },
  ],
}

export interface SmbConfig {
  readonly host: string
  readonly share: string
  readonly port?: number
  readonly username?: string
  readonly password?: string
  readonly domain?: string
  readonly maxProtocol?: string
  readonly basePath: string
}
