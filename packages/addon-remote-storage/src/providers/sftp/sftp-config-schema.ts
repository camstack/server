import type { ConfigUISchema } from '@camstack/types'

/**
 * SFTP `storage-provider` config schema — drives the "Add location" wizard
 * form in the admin UI.
 *
 * Field shape mirrors the rest of the addon ecosystem:
 *   - secrets use `type: 'password'` so the UI masks them, and any secret that
 *     is NOT a password input carries `secret: true` — `type` alone drives the
 *     widget, `isSecretConfigField` drives what leaves the process
 *   - conditional visibility uses `showWhen` (NOT `hideUnless` — that's
 *     not part of the ConfigField contract)
 *   - `basePath` is required so we can enforce path-traversal guards
 */
export const SFTP_CONFIG_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'connection',
      title: 'Connection',
      titleKey: 'remote-storage:sftp.s_connection.title',
      fields: [
        {
          type: 'text',
          key: 'host',
          label: 'Host',
          labelKey: 'remote-storage:sftp.s_connection.host.label',
          description: 'SSH server hostname or IP.',
          descriptionKey: 'remote-storage:sftp.s_connection.host.description',
          required: true,
          placeholder: 'sftp.example.com',
        },
        {
          type: 'number',
          key: 'port',
          label: 'Port',
          labelKey: 'remote-storage:sftp.s_connection.port.label',
          default: 22,
          min: 1,
          max: 65535,
        },
        {
          type: 'text',
          key: 'username',
          label: 'Username',
          labelKey: 'remote-storage:sftp.s_connection.username.label',
          required: true,
        },
        {
          type: 'select',
          key: 'authMethod',
          label: 'Authentication method',
          labelKey: 'remote-storage:sftp.s_connection.authMethod.label',
          default: 'password',
          options: [
            {
              value: 'password',
              label: 'Password',
              labelKey: 'remote-storage:sftp.s_connection.authMethod.o_password.label',
            },
            {
              value: 'privateKey',
              label: 'Private Key (PEM)',
              labelKey: 'remote-storage:sftp.s_connection.authMethod.o_privateKey.label',
            },
          ],
        },
        {
          type: 'password',
          key: 'password',
          label: 'Password',
          labelKey: 'remote-storage:sftp.s_connection.password.label',
          showToggle: true,
          showWhen: { field: 'authMethod', equals: 'password' },
        },
        {
          type: 'textarea',
          key: 'privateKey',
          label: 'Private Key (PEM)',
          labelKey: 'remote-storage:sftp.s_connection.privateKey.label',
          rows: 6,
          // A complete SSH private key, in a `textarea` because a PEM block
          // does not fit a password input. Redaction discovers secrets from
          // this schema, and its discriminator is `type: 'password' || secret`
          // precisely so a credential parked in another widget is not missed —
          // this field is the one that proved the point.
          secret: true,
          showWhen: { field: 'authMethod', equals: 'privateKey' },
        },
        {
          type: 'password',
          key: 'privateKeyPassphrase',
          label: 'Key Passphrase',
          labelKey: 'remote-storage:sftp.s_connection.privateKeyPassphrase.label',
          showToggle: true,
          showWhen: { field: 'authMethod', equals: 'privateKey' },
        },
        {
          type: 'text',
          key: 'hostKeyFingerprint',
          label: 'Expected Host Key Fingerprint (optional)',
          labelKey: 'remote-storage:sftp.s_connection.hostKeyFingerprint.label',
          description:
            'Pin the server fingerprint (sha256:...) to mitigate MITM. Leave blank to accept any.',
          descriptionKey: 'remote-storage:sftp.s_connection.hostKeyFingerprint.description',
        },
      ],
    },
    {
      id: 'storage',
      title: 'Storage',
      titleKey: 'remote-storage:sftp.s_storage.title',
      fields: [
        {
          type: 'text',
          key: 'basePath',
          label: 'Remote Path',
          labelKey: 'remote-storage:sftp.s_storage.basePath.label',
          description: 'Absolute remote directory where files are written. Created if missing.',
          descriptionKey: 'remote-storage:sftp.s_storage.basePath.description',
          required: true,
          placeholder: '/srv/backups/camstack',
        },
      ],
    },
  ],
}

export interface SftpConfig {
  readonly host: string
  readonly port?: number
  readonly username: string
  readonly authMethod?: 'password' | 'privateKey'
  readonly password?: string
  readonly privateKey?: string
  readonly privateKeyPassphrase?: string
  readonly hostKeyFingerprint?: string
  readonly basePath: string
}
