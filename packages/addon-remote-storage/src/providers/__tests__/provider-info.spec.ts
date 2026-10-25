/**
 * Disk-space policy declaration for every remote `storage-provider`.
 *
 * Remote/object stores (S3, SFTP, WebDAV, SMB) have no local free-space
 * concept the recorder can evict against — they declare
 * `shouldSaveDiskSpace: false` + `minFreePercent: null`. Only
 * `getProviderInfo()` is exercised here (static metadata); the
 * injected logger + default client seams keep the providers
 * constructible without touching the network.
 *
 * `nodeLocal: false` is asserted alongside, because it stopped being a
 * routing hint the day the storage-access constraint started reading it: it
 * is now what refuses these providers for `local-path` location kinds and
 * refuses `storage.resolve` on their locations (D296). A provider that
 * declared `true` here to obtain statfs-backed capacity would disable a
 * safety constraint, not gain a convenience.
 */
import { describe, it, expect } from 'vitest'
import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { S3StorageProvider } from '../s3/s3-provider.js'
import { SftpStorageProvider } from '../sftp/sftp-provider.js'
import { WebDavStorageProvider } from '../webdav/webdav-provider.js'
import { SmbStorageProvider } from '../smb/smb-provider.js'

const noopLogger: IScopedLogger = {
  debug: (_message: string, _extras?: LogExtras) => undefined,
  info: (_message: string, _extras?: LogExtras) => undefined,
  warn: (_message: string, _extras?: LogExtras) => undefined,
  error: (_message: string, _extras?: LogExtras) => undefined,
  child: (_scope: string) => noopLogger,
  withTags: (_tags: LogTags) => noopLogger,
}

describe('remote providers disk-space policy', () => {
  const makers: ReadonlyArray<
    () => {
      getProviderInfo: () => Promise<{
        shouldSaveDiskSpace: boolean
        minFreePercent: number | null
        nodeLocal: boolean
      }>
    }
  > = [
    () => new S3StorageProvider(noopLogger),
    () => new SftpStorageProvider(noopLogger),
    () => new WebDavStorageProvider(noopLogger),
    () => new SmbStorageProvider(noopLogger),
  ]

  it('all declare shouldSaveDiskSpace=false, minFreePercent=null', async () => {
    for (const make of makers) {
      const info = await make().getProviderInfo()
      expect(info.shouldSaveDiskSpace).toBe(false)
      expect(info.minFreePercent).toBeNull()
    }
  })

  it('all declare nodeLocal=false — the flag the access constraint reads', async () => {
    for (const make of makers) {
      const info = await make().getProviderInfo()
      expect(info.nodeLocal).toBe(false)
    }
  })
})
