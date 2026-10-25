/**
 * Pull one shared library out of a Debian package without `dpkg-deb`.
 *
 * A `.deb` is an `ar` archive holding `debian-binary`, `control.tar.*` and
 * `data.tar.*`; the payload's compression is the packager's choice. The two
 * debs the Coral delegate needs show both live ones: feranick's libedgetpu
 * ships `data.tar.xz`, Ubuntu's libusb (24.04 and every release since 21.10)
 * ships `data.tar.zst` — which `dpkg-deb` older than 1.21.18 and a stock
 * macOS `tar` without a `zstd` binary cannot open. So the ar container and a
 * zstd/gzip payload are unpacked IN-PROCESS (`node:zlib` has zstd since Node
 * 22.15, which the hub and the desktop's Electron both run); only an xz
 * payload goes through `tar -xJf`, which every POSIX host has.
 *
 * POSIX only: the delegate is never staged on Windows (no build exists).
 */
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractArchive, type ArchiveFormat } from './archive-extract.js'

/** The host-tar step, injectable so a spec can see what it is handed. */
export type TarExtract = (archivePath: string, format: ArchiveFormat, destDir: string) => void

const AR_MAGIC = '!<arch>\n'
const AR_HEADER_BYTES = 60

export interface ArMember {
  readonly name: string
  readonly data: Buffer
}

/** Every member of an `ar` archive, in order. Throws on anything that is not one. */
export function readArMembers(archive: Buffer): readonly ArMember[] {
  if (archive.subarray(0, AR_MAGIC.length).toString('latin1') !== AR_MAGIC) {
    throw new Error('not an ar archive (a .deb starts with "!<arch>")')
  }
  const members: ArMember[] = []
  let offset = AR_MAGIC.length
  while (offset + AR_HEADER_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + AR_HEADER_BYTES).toString('latin1')
    if (header.slice(58, 60) !== '`\n') {
      throw new Error(`corrupt ar member header at byte ${offset}`)
    }
    // GNU ar terminates a short name with "/"; BSD and dpkg pad with spaces.
    const name = header.slice(0, 16).trim().replace(/\/$/, '')
    const size = Number.parseInt(header.slice(48, 58).trim(), 10)
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`ar member "${name}" has no valid size`)
    }
    const start = offset + AR_HEADER_BYTES
    if (start + size > archive.length) {
      throw new Error(`ar member "${name}" runs past the end of the archive`)
    }
    members.push({ name, data: archive.subarray(start, start + size) })
    offset = start + size + (size % 2) // members are 2-byte aligned
  }
  return members
}

export type DebPayloadCompression = 'zst' | 'xz' | 'gz' | 'none'

export interface DebPayload {
  readonly compression: DebPayloadCompression
  readonly data: Buffer
}

/** The `data.tar.*` member of a `.deb`, with the compression its name declares. */
export function debDataMember(deb: Buffer): DebPayload {
  const member = readArMembers(deb).find((m) => m.name.startsWith('data.tar'))
  if (member === undefined) throw new Error('.deb has no data.tar member')
  const suffix = member.name.slice('data.tar'.length)
  const compression: DebPayloadCompression | null =
    suffix === '.zst'
      ? 'zst'
      : suffix === '.xz'
        ? 'xz'
        : suffix === '.gz'
          ? 'gz'
          : suffix === ''
            ? 'none'
            : null
  if (compression === null) {
    throw new Error(`.deb payload ${member.name} uses a compression this extractor does not read`)
  }
  return { compression, data: member.data }
}

/**
 * Unpack a `.deb`'s payload into `destDir` (the package's own tree: `usr/lib/…`).
 * zstd and gzip are decompressed in-process; the plain tar and the xz payload
 * are expanded by the host `tar`.
 */
export function extractDebPayload(
  deb: Buffer,
  destDir: string,
  workDir: string,
  extract: TarExtract = extractArchive,
): void {
  const payload = debDataMember(deb)
  mkdirSync(destDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  if (payload.compression === 'xz') {
    const xzPath = join(workDir, 'data.tar.xz')
    writeFileSync(xzPath, payload.data)
    extract(xzPath, 'tar.xz', destDir)
    return
  }
  const tar =
    payload.compression === 'zst'
      ? zstdDecompressSync(payload.data)
      : payload.compression === 'gz'
        ? gunzipSync(payload.data)
        : payload.data
  const tarPath = join(workDir, 'data.tar')
  writeFileSync(tarPath, tar)
  extract(tarPath, 'tar', destDir)
}

/**
 * The first entry named exactly `name` under `dir` — a regular file OR a
 * symlink: a library's soname (`libusb-1.0.so.0`) is a link to the versioned
 * file in every package, so a file-only search never finds it.
 */
export function findEntryByName(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === name) return full
    if (entry.isDirectory()) {
      const nested = findEntryByName(full, name)
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * Copy the library `memberName` out of the `.deb` at `debPath` to `targetPath`,
 * dereferencing the soname link to the real file. Throws, naming the member,
 * when the package does not carry it.
 */
export function installLibraryFromDeb(
  debPath: string,
  memberName: string,
  targetPath: string,
  workDir: string,
  extract: TarExtract = extractArchive,
): void {
  const tree = join(workDir, 'tree')
  try {
    extractDebPayload(readFileSync(debPath), tree, workDir, extract)
    const found = findEntryByName(tree, memberName)
    if (found === null) throw new Error(`${memberName} not found inside ${debPath}`)
    copyFileSync(found, targetPath) // follows the link: the bytes, not a dangling link
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
