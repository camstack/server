import type { ConfigUISchema } from '@camstack/types'

/**
 * S3 (and S3-compatible: Minio, Backblaze B2, Cloudflare R2) config schema.
 *
 * `endpoint` is optional — empty means "use the default AWS endpoint
 * derived from `region`". `forcePathStyle` is required for Minio + R2.
 */
export const S3_CONFIG_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'connection',
      title: 'Connection',
      titleKey: 'remote-storage:s3.s_connection.title',
      fields: [
        {
          type: 'text',
          key: 'endpoint',
          label: 'Endpoint URL',
          labelKey: 'remote-storage:s3.s_connection.endpoint.label',
          description:
            'Leave empty for AWS S3. Set for Minio / R2 / Backblaze (e.g. https://nyc3.digitaloceanspaces.com).',
          descriptionKey: 'remote-storage:s3.s_connection.endpoint.description',
          placeholder: 'https://...',
        },
        {
          type: 'text',
          key: 'region',
          label: 'Region',
          labelKey: 'remote-storage:s3.s_connection.region.label',
          required: true,
          default: 'us-east-1',
        },
        {
          type: 'text',
          key: 'bucket',
          label: 'Bucket',
          labelKey: 'remote-storage:s3.s_connection.bucket.label',
          required: true,
        },
        {
          type: 'text',
          key: 'accessKeyId',
          label: 'Access Key ID',
          labelKey: 'remote-storage:s3.s_connection.accessKeyId.label',
          required: true,
        },
        {
          type: 'password',
          key: 'secretAccessKey',
          label: 'Secret Access Key',
          labelKey: 'remote-storage:s3.s_connection.secretAccessKey.label',
          required: true,
          showToggle: true,
        },
        {
          type: 'boolean',
          key: 'forcePathStyle',
          label: 'Force path-style addressing',
          labelKey: 'remote-storage:s3.s_connection.forcePathStyle.label',
          description: 'Required for Minio and Cloudflare R2. AWS S3 should leave this off.',
          descriptionKey: 'remote-storage:s3.s_connection.forcePathStyle.description',
          default: false,
        },
      ],
    },
    {
      id: 'storage',
      title: 'Storage',
      titleKey: 'remote-storage:s3.s_storage.title',
      fields: [
        {
          type: 'text',
          key: 'basePath',
          label: 'Key Prefix',
          labelKey: 'remote-storage:s3.s_storage.basePath.label',
          description:
            'Optional prefix prepended to every object key. Leave empty to use the bucket root.',
          descriptionKey: 'remote-storage:s3.s_storage.basePath.description',
          placeholder: 'camstack/',
        },
      ],
    },
  ],
}

export interface S3Config {
  readonly endpoint?: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly forcePathStyle?: boolean
  readonly basePath?: string
}
