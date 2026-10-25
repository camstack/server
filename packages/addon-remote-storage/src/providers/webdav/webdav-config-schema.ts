import type { ConfigUISchema } from '@camstack/types'

/**
 * WebDAV / Nextcloud / OwnCloud config schema.
 *
 * `url` MUST point at the WebDAV root (e.g.
 * `https://nextcloud.example.com/remote.php/dav/files/<user>/`). The
 * provider does NOT auto-derive the user-scoped URL — operators copy
 * the right URL from their server's settings page.
 */
export const WEBDAV_CONFIG_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'connection',
      title: 'Connection',
      titleKey: 'remote-storage:webdav.s_connection.title',
      fields: [
        {
          type: 'text',
          key: 'url',
          label: 'WebDAV URL',
          labelKey: 'remote-storage:webdav.s_connection.url.label',
          required: true,
          placeholder: 'https://nextcloud.example.com/remote.php/dav/files/me/',
          inputType: 'url',
        },
        {
          type: 'select',
          key: 'authMethod',
          label: 'Authentication method',
          labelKey: 'remote-storage:webdav.s_connection.authMethod.label',
          default: 'basic',
          options: [
            {
              value: 'basic',
              label: 'Basic (username + password)',
              labelKey: 'remote-storage:webdav.s_connection.authMethod.o_basic.label',
            },
            {
              value: 'digest',
              label: 'Digest',
              labelKey: 'remote-storage:webdav.s_connection.authMethod.o_digest.label',
            },
            {
              value: 'token',
              label: 'Bearer Token',
              labelKey: 'remote-storage:webdav.s_connection.authMethod.o_token.label',
            },
          ],
        },
        {
          type: 'text',
          key: 'username',
          label: 'Username',
          labelKey: 'remote-storage:webdav.s_connection.username.label',
          showWhen: { field: 'authMethod', notEquals: 'token' },
        },
        {
          type: 'password',
          key: 'password',
          label: 'Password',
          labelKey: 'remote-storage:webdav.s_connection.password.label',
          showToggle: true,
          showWhen: { field: 'authMethod', notEquals: 'token' },
        },
        {
          type: 'password',
          key: 'token',
          label: 'Bearer Token',
          labelKey: 'remote-storage:webdav.s_connection.token.label',
          showToggle: true,
          showWhen: { field: 'authMethod', equals: 'token' },
        },
      ],
    },
    {
      id: 'storage',
      title: 'Storage',
      titleKey: 'remote-storage:webdav.s_storage.title',
      fields: [
        {
          type: 'text',
          key: 'basePath',
          label: 'Remote Path',
          labelKey: 'remote-storage:webdav.s_storage.basePath.label',
          description:
            'Subdirectory under the WebDAV root where files are written. Created if missing.',
          descriptionKey: 'remote-storage:webdav.s_storage.basePath.description',
          required: true,
          placeholder: '/Camstack/backups',
        },
      ],
    },
  ],
}

export interface WebDavConfig {
  readonly url: string
  readonly authMethod?: 'basic' | 'digest' | 'token'
  readonly username?: string
  readonly password?: string
  readonly token?: string
  readonly basePath: string
}
