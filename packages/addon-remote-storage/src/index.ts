/**
 * @camstack/addon-remote-storage — public entry.
 *
 * Ships FOUR addon manifest entries (sftp-storage / s3-storage /
 * webdav-storage / smb-storage), each registering one `storage-provider`
 * collection-cap provider. Splitting per-provider is required because
 * `CapabilityRegistry` keys collection providers by addonId — multiple
 * providers from the same addon collapse to one (last write wins).
 *
 * Every provider here declares `nodeLocal: false`, which is what makes them
 * eligible for `cap-mediated` storage kinds (`backups`) and refused for
 * `local-path` ones (`recordings`, `eventMedia`, `galleryMedia`) — see D296.
 */
export { SftpStorageAddon } from './sftp.addon.js'
export { S3StorageAddon } from './s3.addon.js'
export { WebDavStorageAddon } from './webdav.addon.js'
export { SmbStorageAddon } from './smb.addon.js'
export { SftpStorageProvider } from './providers/sftp/sftp-provider.js'
export { S3StorageProvider } from './providers/s3/s3-provider.js'
export { WebDavStorageProvider } from './providers/webdav/webdav-provider.js'
export { SmbStorageProvider } from './providers/smb/smb-provider.js'
export { SmbBinaryUnavailableError } from './providers/smb/smb-client.js'
