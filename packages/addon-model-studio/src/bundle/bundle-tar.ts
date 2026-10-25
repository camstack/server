/**
 * A minimal, allowlist-only tar reader for model bundles (D806).
 *
 * The bundle comes from a trainer we did not run on this machine, so the
 * reader trusts nothing in it: every regular file must be NAMED in the
 * caller's allowlist (exact match after normalisation), anything else — an
 * unlisted file, a link, a device, an absolute or `..` path — fails the whole
 * bundle. Files are streamed to disk in chunks and hashed on the way; nothing
 * is held whole in memory.
 *
 * Formats read: POSIX ustar (with its 155-byte prefix), PAX `path` records
 * (`x`), GNU long names (`L`) — what Python's `tarfile` writes. Directory
 * entries are accepted and ignored (directories are created from file paths).
 */
import { createHash } from 'node:crypto'
import { open, mkdir } from 'node:fs/promises'
import path from 'node:path'

const BLOCK = 512
const COPY_CHUNK = 1024 * 1024

export interface ExtractedFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export type ExtractResult =
  | { readonly kind: 'extracted'; readonly files: readonly ExtractedFile[] }
  | { readonly kind: 'refused'; readonly detail: string }

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString('utf8')
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const text = readString(buf, start, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

function isZeroBlock(buf: Buffer): boolean {
  for (const byte of buf) if (byte !== 0) return false
  return true
}

/** `a/b/c` only: no absolute path, no `.`/`..`/empty segment, no backslash. */
export function isSafeBundlePath(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    return false
  }
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

function paxPath(body: Buffer): string | null {
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(body.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1)
    offset += length
  }
  return null
}

/**
 * Extract every allowlisted regular file of `tarPath` under `destDir`,
 * keeping its relative path. Refuses on the first entry outside the
 * allowlist, a duplicate, a non-file entry or a truncated archive.
 */
export async function extractBundleTar(
  tarPath: string,
  destDir: string,
  allow: ReadonlySet<string>,
): Promise<ExtractResult> {
  const handle = await open(tarPath, 'r')
  try {
    const header = Buffer.alloc(BLOCK)
    const seen = new Map<string, ExtractedFile>()
    let position = 0
    let pendingName: string | null = null
    for (;;) {
      const { bytesRead } = await handle.read(header, 0, BLOCK, position)
      if (bytesRead === 0) break
      if (bytesRead < BLOCK) return { kind: 'refused', detail: 'truncated tar header' }
      position += BLOCK
      if (isZeroBlock(header)) break
      const size = readOctal(header, 124, 12)
      const type = String.fromCharCode(header[156] ?? 0x30)
      const padded = Math.ceil(size / BLOCK) * BLOCK
      if (type === 'x' || type === 'L') {
        const body = Buffer.alloc(size)
        await handle.read(body, 0, size, position)
        pendingName = type === 'x' ? paxPath(body) : readString(body, 0, size)
        position += padded
        continue
      }
      if (type === 'g') {
        position += padded
        continue
      }
      const prefix = readString(header, 345, 155)
      const shortName = readString(header, 0, 100)
      const name = (pendingName ?? (prefix !== '' ? `${prefix}/${shortName}` : shortName)).replace(
        /^\.\//,
        '',
      )
      pendingName = null
      if (type === '5') {
        position += padded
        continue
      }
      if (type !== '0' && type !== '\0' && type !== '7') {
        return { kind: 'refused', detail: `entry "${name}" is not a regular file (type ${type})` }
      }
      if (!isSafeBundlePath(name) || !allow.has(name)) {
        return { kind: 'refused', detail: `entry "${name}" is not part of the declared bundle` }
      }
      if (seen.has(name)) return { kind: 'refused', detail: `entry "${name}" appears twice` }
      const written = await copyEntry(handle, position, size, path.join(destDir, name))
      if (written === null) return { kind: 'refused', detail: `entry "${name}" is truncated` }
      seen.set(name, { path: name, bytes: size, sha256: written })
      position += padded
    }
    return { kind: 'extracted', files: [...seen.values()] }
  } finally {
    await handle.close()
  }
}

async function copyEntry(
  source: Awaited<ReturnType<typeof open>>,
  start: number,
  size: number,
  target: string,
): Promise<string | null> {
  await mkdir(path.dirname(target), { recursive: true })
  const out = await open(target, 'w')
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(size, 1)))
  try {
    let done = 0
    while (done < size) {
      const want = Math.min(chunk.length, size - done)
      const { bytesRead } = await source.read(chunk, 0, want, start + done)
      if (bytesRead === 0) return null
      const piece = chunk.subarray(0, bytesRead)
      hash.update(piece)
      await out.write(piece)
      done += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await out.close()
  }
}
