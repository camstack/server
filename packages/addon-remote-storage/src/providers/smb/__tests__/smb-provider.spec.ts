/**
 * SMB storage-provider.
 *
 * The properties under test are the ones that make this provider safe to point
 * at an operator's NAS, in order of how much they cost when wrong:
 *
 *  1. A missing `smbclient` binary REFUSES. It must never resemble an empty
 *     share — `empty` is what D293's delete guard needs to see before it lets
 *     an operator destroy a location, and a full share behind a missing binary
 *     must not clear that bar.
 *  2. `resolve` refuses. A remote path handed to a caller that `fs`-opens it
 *     is the trap the whole storage-access constraint exists to close.
 *  3. A transfer that lands at the wrong size FAILS. `close()` returning is
 *     not a durability statement over SMB and the backup manifest has no
 *     checksum, so the byte count is the only verification available.
 *  4. Two locations on one share are refused. Independent retention sweeps on
 *     one directory delete each other's archives, and the failure surfaces at
 *     restore time on a file the manifest swears is there.
 *  5. Credentials never appear in an operator-facing error string.
 */
import { statSync } from 'node:fs'
import type { IScopedLogger, StorageLocation } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mapSmbError, smbConfigFromRecord, SmbStorageProvider } from '../smb-provider.js'
import { SmbBinaryUnavailableError, type SmbClientLike, type SmbItem } from '../smb-client.js'
import { safeSmbRelativePath, shareIdentity } from '../smb-paths.js'

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  return logger as unknown as IScopedLogger
}

function location(over: Partial<StorageLocation> = {}): StorageLocation {
  const now = Date.now()
  return {
    id: 'backups:nas',
    type: 'backups',
    displayName: 'NAS',
    providerId: 'smb-storage',
    config: { host: 'nas.local', share: 'backups', basePath: 'camstack', password: 'hunter2' },
    isSystem: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

/** An in-memory share. `size` is what a listing reports for the landed file. */
class FakeSmbClient implements SmbClientLike {
  readonly files = new Map<string, number>()
  readonly commands: string[] = []
  /** Overrides the size a landed file reports — how a truncated write is faked. */
  landedSizeOverride: number | null = null

  constructor(private readonly localSizeOf: (localPath: string) => number) {}

  async sendFile(localPath: string, destination: string): Promise<unknown> {
    this.commands.push(`put ${destination}`)
    this.files.set(destination, this.landedSizeOverride ?? this.localSizeOf(localPath))
    return ''
  }
  async getFile(remotePath: string): Promise<unknown> {
    if (!this.files.has(remotePath)) throw new Error('NT_STATUS_OBJECT_NAME_NOT_FOUND')
    return ''
  }
  async deleteFile(fileName: string): Promise<unknown> {
    if (!this.files.has(fileName)) throw new Error('NT_STATUS_NO_SUCH_FILE')
    this.files.delete(fileName)
    return ''
  }
  async mkdir(remotePath: string): Promise<unknown> {
    this.commands.push(`mkdir ${remotePath}`)
    return ''
  }
  /**
   * `samba-client`'s `list(x)` runs `smbclient -c 'dir x'`, and smbclient's
   * `dir` argument is a MASK evaluated in the current directory — it is NOT
   * a directory to descend into. So:
   *
   *   - `dir *`        → every entry in the cwd
   *   - `dir sub/ *`   → every entry inside `sub`
   *   - `dir name.tgz` → that one entry, if it exists
   *   - `dir ""`       → NOTHING: an empty mask matches nothing
   *
   * The earlier fake here treated the argument as a directory, which made
   * `exists`, `list` and the post-upload verification pass in this suite
   * while all three answered "nothing is there" against a real share
   * holding the file (measured on the hub, 2026-09-07).
   */
  async list(mask: string): Promise<readonly SmbItem[]> {
    if (mask === '') return []
    const slash = mask.lastIndexOf('/')
    const dir = slash === -1 ? '' : mask.slice(0, slash)
    const pattern = slash === -1 ? mask : mask.slice(slash + 1)
    const prefix = dir === '' ? '' : `${dir}/`
    const out: SmbItem[] = []
    for (const [name, size] of this.files) {
      if (!name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      if (rest.includes('/')) continue
      if (pattern !== '*' && rest.toLowerCase() !== pattern.toLowerCase()) continue
      out.push({ name: rest, type: 'A', size, modifyTime: new Date(0) })
    }
    return out
  }
  async execute(command: string, args: string | readonly string[]): Promise<unknown> {
    const list = Array.isArray(args) ? args : [String(args)]
    this.commands.push(`${command} ${list.join(' ')}`)
    if (command === 'rename') {
      const [from, to] = list
      const size = this.files.get(String(from))
      if (size === undefined) throw new Error('NT_STATUS_OBJECT_NAME_NOT_FOUND')
      this.files.delete(String(from))
      this.files.set(String(to), size)
    }
    return ''
  }
}

let client: FakeSmbClient

function makeProvider(over: { hasBinary?: () => Promise<boolean> } = {}): SmbStorageProvider {
  return new SmbStorageProvider(makeLogger(), {
    hasBinary: over.hasBinary ?? (async () => true),
    createClient: async () => client,
  })
}

beforeEach(() => {
  // The provider really spools to a temp file, so the fake share reports the
  // spool's true size — a fake that invented the size would make the
  // verify-on-finalize assertion vacuous.
  client = new FakeSmbClient((localPath) => statSync(localPath).size)
})

describe('a missing smbclient binary refuses, and is never mistaken for an empty share', () => {
  it('testLocation reports the binary, not a connection error', async () => {
    const provider = makeProvider({ hasBinary: async () => false })
    const result = await provider.testLocation({
      config: { host: 'nas.local', share: 'backups', basePath: 'camstack' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('smbclient')
    expect(result.error).toContain('UNREACHABLE')
  })

  it('list() THROWS rather than returning an empty array', async () => {
    const provider = makeProvider({ hasBinary: async () => false })
    // The distinction the whole test exists for: an empty array here would be
    // read by a retention sweep as "there is nothing to keep".
    await expect(provider.list({ location: location() })).rejects.toBeInstanceOf(
      SmbBinaryUnavailableError,
    )
  })

  it('exists() THROWS rather than answering false', async () => {
    const provider = makeProvider({ hasBinary: async () => false })
    await expect(
      provider.exists({ location: location(), relativePath: 'a.zip' }),
    ).rejects.toBeInstanceOf(SmbBinaryUnavailableError)
  })

  it('recovers without a restart once the binary appears', async () => {
    let present = false
    const provider = makeProvider({ hasBinary: async () => present })
    await expect(provider.list({ location: location() })).rejects.toBeInstanceOf(
      SmbBinaryUnavailableError,
    )
    present = true
    await expect(provider.list({ location: location() })).resolves.toEqual([])
  })
})

describe('resolve refuses', () => {
  it('never returns a path a caller could hand to node:fs', async () => {
    const provider = makeProvider()
    await expect(provider.resolve({ location: location(), relativePath: '' })).rejects.toThrow(
      /no path this node can open/,
    )
  })
})

describe('upload verifies what landed', () => {
  it('writes through .partial → rename and accepts a matching size', async () => {
    const provider = makeProvider()
    const { uploadId } = await provider.beginUpload({
      location: location(),
      relativePath: 'archive-1.zip',
    })
    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array(16) })
    await provider.writeChunk({ uploadId, offset: 16, data: new Uint8Array(8) })
    await provider.finalizeUpload({ uploadId })

    expect(client.files.get('archive-1.zip')).toBe(24)
    expect(client.files.has('archive-1.zip.partial')).toBe(false)
    expect(client.commands).toContain('rename archive-1.zip.partial archive-1.zip')
  })

  it('FAILS when the landed file is a different size from what was sent', async () => {
    const provider = makeProvider()
    client.landedSizeOverride = 9 // the server truncated the write
    const { uploadId } = await provider.beginUpload({
      location: location(),
      relativePath: 'archive-2.zip',
    })
    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array(24) })
    await expect(provider.finalizeUpload({ uploadId })).rejects.toThrow(/landed at 9 bytes/)
  })

  it('rejects an out-of-order chunk instead of silently writing a hole', async () => {
    const provider = makeProvider()
    const { uploadId } = await provider.beginUpload({
      location: location(),
      relativePath: 'archive-3.zip',
    })
    await expect(
      provider.writeChunk({ uploadId, offset: 64, data: new Uint8Array(4) }),
    ).rejects.toThrow(/out-of-order/)
  })

  it('abortUpload leaves nothing on the share', async () => {
    const provider = makeProvider()
    const { uploadId } = await provider.beginUpload({
      location: location(),
      relativePath: 'archive-4.zip',
    })
    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array(8) })
    await provider.abortUpload({ uploadId })
    expect(client.files.size).toBe(0)
  })
})

/**
 * The hub, 2026-09-07: `backups:smb` held a 387 MB archive and a
 * `manifests.json`, and `storage.list({ location: 'backups:smb' })` answered
 * `[]` while `storage.exists` on the archive answered `false`. Every SMB
 * destination was write-only and then disowned — retention could not see an
 * archive, the manifest never grew, and every upload was refused by its own
 * post-transfer check.
 */
describe('a listing at the root of the basePath sees what is there', () => {
  it('lists the files at the root, not nothing', async () => {
    const provider = makeProvider()
    client.files.set('archive-a.tar.gz', 10)
    client.files.set('manifests.json', 2)
    client.files.set('sub/deep.bin', 3)

    const out = await provider.list({ location: location() })

    expect([...out].sort()).toEqual(['archive-a.tar.gz', 'manifests.json'])
  })

  it('lists the files inside a subdirectory when given a prefix', async () => {
    const provider = makeProvider()
    client.files.set('archive-a.tar.gz', 10)
    client.files.set('sub/deep.bin', 3)

    const out = await provider.list({ location: location(), prefix: 'sub' })

    expect([...out]).toEqual(['sub/deep.bin'])
  })

  it('sees a file that exists at the root', async () => {
    const provider = makeProvider()
    client.files.set('archive-a.tar.gz', 10)

    expect(await provider.exists({ location: location(), relativePath: 'archive-a.tar.gz' })).toBe(
      true,
    )
    expect(await provider.exists({ location: location(), relativePath: 'nope.tar.gz' })).toBe(false)
  })
})

describe('two locations on one share', () => {
  const existing = location({ id: 'backups:nas-a' })

  it('refuses a second record on the same (host, share, basePath)', () => {
    const provider = makeProvider()
    const duplicate = provider.findDuplicateShare(
      { host: 'NAS.local', share: 'Backups', basePath: '/camstack/' },
      'backups:nas-b',
      [existing],
    )
    expect(duplicate?.id).toBe('backups:nas-a')
  })

  it('allows a different directory on the same share', () => {
    const provider = makeProvider()
    expect(
      provider.findDuplicateShare(
        { host: 'nas.local', share: 'backups', basePath: 'camstack-2' },
        'backups:nas-b',
        [existing],
      ),
    ).toBeNull()
  })

  it('does not consider a location its own duplicate', () => {
    const provider = makeProvider()
    expect(provider.findDuplicateShare(existing.config, existing.id, [existing])).toBeNull()
  })
})

describe('nothing operator-facing carries a credential', () => {
  it('maps library errors to a closed set instead of forwarding them', () => {
    expect(mapSmbError(new Error('session setup failed: NT_STATUS_LOGON_FAILURE'))).toBe(
      'authentication failed',
    )
    expect(mapSmbError(new Error('tree connect failed: NT_STATUS_BAD_NETWORK_NAME'))).toBe(
      'share not found',
    )
    // The shape that matters: a raw message naming the account and the
    // password does not survive the mapping.
    const leaky = new Error('smbclient -U camstack --password hunter2 //nas/backups failed')
    expect(mapSmbError(leaky)).not.toContain('hunter2')
    expect(mapSmbError(leaky)).not.toContain('camstack')
  })

  it('testLocation reports a mapped reason, never the raw output', async () => {
    const provider = makeProvider()
    client.list = async () => {
      throw new Error('smbclient -U camstack --password hunter2: NT_STATUS_LOGON_FAILURE')
    }
    const result = await provider.testLocation({ config: location().config })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('authentication failed')
  })
})

describe('paths that reach smbclient’s command string', () => {
  it('refuses a quote, a semicolon and a backtick rather than escaping them', () => {
    for (const bad of ['a";rm -rf /;"', "a'b", 'a`b`', 'a$b', 'a|b', 'a\nb']) {
      expect(() => safeSmbRelativePath(bad)).toThrow(/cannot be passed to smbclient safely/)
    }
  })

  it('refuses traversal above the location base', () => {
    expect(() => safeSmbRelativePath('../secrets')).toThrow(/escapes the location base/)
    expect(() => safeSmbRelativePath('a/../../b')).toThrow(/escapes the location base/)
  })

  it('passes the names CamStack actually generates', () => {
    expect(safeSmbRelativePath('camstack-2026-08-30_02-00-00.zip')).toBe(
      'camstack-2026-08-30_02-00-00.zip',
    )
    expect(safeSmbRelativePath('/nested/dir/file.bin')).toBe('nested/dir/file.bin')
  })
})

describe('config parsing', () => {
  it('names the missing FIELD, never a value', () => {
    expect(() => smbConfigFromRecord({ share: 's' }, 'backups:x')).toThrow(/config\.host/)
    expect(() => smbConfigFromRecord({ host: 'h' }, 'backups:x')).toThrow(/config\.share/)
  })

  it('refuses a UNC-shaped host or share', () => {
    expect(() => smbConfigFromRecord({ host: '//nas/backups', share: 's' }, 'x')).toThrow(
      /without slashes/,
    )
  })

  it('compares share identity case-insensitively, as SMB does', () => {
    expect(shareIdentity({ host: 'NAS', share: 'Backups', basePath: '/CamStack/' })).toBe(
      shareIdentity({ host: 'nas', share: 'backups', basePath: 'camstack' }),
    )
  })
})
