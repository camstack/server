import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  parseHomeConnectIddfXml,
  type HomeConnectCompactDescription,
} from './home-connect-device-description.js'

function appendZipEntry(input: {
  readonly name: string
  readonly data: Buffer
  readonly method: 0 | 8
  readonly offset: number
}): { readonly local: Buffer; readonly central: Buffer; readonly nextOffset: number } {
  const nameBuf = Buffer.from(input.name, 'utf8')
  const uncompressed = input.data
  const payload = input.method === 8 ? deflateRawSync(uncompressed) : uncompressed
  const local = Buffer.alloc(30 + nameBuf.length + payload.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(input.method, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0, 12)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(uncompressed.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  nameBuf.copy(local, 30)
  payload.copy(local, 30 + nameBuf.length)

  const central = Buffer.alloc(46 + nameBuf.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(input.method, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0, 14)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(uncompressed.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(input.offset, 42)
  nameBuf.copy(central, 46)

  return { local, central, nextOffset: input.offset + local.length }
}

function buildZip(files: Readonly<Record<string, string | Uint8Array>>, method: 0 | 8): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const entry = appendZipEntry({ name, data, method, offset })
    localParts.push(entry.local)
    centralParts.push(entry.central)
    offset = entry.nextOffset
  }
  const centralDir = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDir, end])
}

/** Store (no compression) entries in a minimal ZIP buffer. */
export function buildStoreZip(files: Readonly<Record<string, string | Uint8Array>>): Buffer {
  return buildZip(files, 0)
}

/** DEFLATE (method 8) ZIP — matches cloud IDDF archives. */
export function buildDeflateZip(files: Readonly<Record<string, string | Uint8Array>>): Buffer {
  return buildZip(files, 8)
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset)
}

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset)
}

function decodeZipPayload(method: number, payload: Buffer): Buffer | null {
  if (method === 0) return payload
  if (method === 8) {
    try {
      return inflateRawSync(payload)
    } catch {
      return null
    }
  }
  return null
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** The end-of-central-directory record is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_MAX_SCAN = 22 + 0xffff

function findEndOfCentralDirectory(zip: Buffer): number | null {
  const lowest = Math.max(0, zip.length - EOCD_MAX_SCAN)
  for (let pos = zip.length - 22; pos >= lowest; pos -= 1) {
    if (readUInt32LE(zip, pos) === EOCD_SIG) return pos
  }
  return null
}

/**
 * Entries named by the central directory — the authoritative sizes. A streamed archive (bit 3,
 * as a Java `ZipOutputStream` writes it, and as the cloud IDDF arrives) has ZERO sizes in every
 * local header; only the central directory and the data descriptors carry them.
 */
function entriesFromCentralDirectory(zip: Buffer): Map<string, Buffer> | null {
  const eocd = findEndOfCentralDirectory(zip)
  if (eocd === null) return null
  const count = readUInt16LE(zip, eocd + 10)
  let pos = readUInt32LE(zip, eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count && pos + 46 <= zip.length; i += 1) {
    if (readUInt32LE(zip, pos) !== CENTRAL_SIG) break
    const method = readUInt16LE(zip, pos + 10)
    const compSize = readUInt32LE(zip, pos + 20)
    const nameLen = readUInt16LE(zip, pos + 28)
    const extraLen = readUInt16LE(zip, pos + 30)
    const commentLen = readUInt16LE(zip, pos + 32)
    const localOffset = readUInt32LE(zip, pos + 42)
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen
    if (localOffset + 30 > zip.length || readUInt32LE(zip, localOffset) !== LOCAL_SIG) continue
    const dataStart =
      localOffset + 30 + readUInt16LE(zip, localOffset + 26) + readUInt16LE(zip, localOffset + 28)
    const decoded = decodeZipPayload(method, zip.subarray(dataStart, dataStart + compSize))
    if (decoded !== null) out.set(name, decoded)
  }
  return out
}

/** Extract file bodies from a ZIP (store + deflate): central directory first, local headers as a fallback. */
export function extractZipEntries(zip: Buffer): ReadonlyMap<string, Buffer> {
  if (zip.length < 22) return new Map()
  const central = entriesFromCentralDirectory(zip)
  if (central !== null && central.size > 0) return central
  return entriesFromLocalHeaders(zip)
}

function entriesFromLocalHeaders(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let pos = 0
  while (pos + 30 <= zip.length) {
    const sig = readUInt32LE(zip, pos)
    if (sig === 0x06054b50) break
    if (sig !== 0x04034b50) break
    const method = readUInt16LE(zip, pos + 8)
    const compSize = readUInt32LE(zip, pos + 18)
    const nameLen = readUInt16LE(zip, pos + 26)
    const extraLen = readUInt16LE(zip, pos + 28)
    const nameStart = pos + 30
    const name = zip.subarray(nameStart, nameStart + nameLen).toString('utf8')
    const dataStart = nameStart + nameLen + extraLen
    const compressed = zip.subarray(dataStart, dataStart + compSize)
    const decoded = decodeZipPayload(method, compressed)
    if (decoded !== null) out.set(name, decoded)
    pos = dataStart + compSize
  }
  return out
}

export function parseIddfZipBuffer(
  zip: Buffer,
  haId: string,
): HomeConnectCompactDescription | null {
  const entries = extractZipEntries(zip)
  let deviceXml: string | undefined
  let mappingXml: string | undefined
  for (const [name, body] of entries) {
    if (name.endsWith('_DeviceDescription.xml')) deviceXml = body.toString('utf8')
    if (name.endsWith('_FeatureMapping.xml')) mappingXml = body.toString('utf8')
  }
  if (!deviceXml || !mappingXml) return null
  return parseHomeConnectIddfXml({
    deviceDescriptionXml: deviceXml,
    featureMappingXml: mappingXml,
    haId,
  })
}

/**
 * The IDDF request carries the bearer token and NOTHING else — the reference downloaders send
 * no `Accept`, and the endpoint answered 403 to `accept: application/zip` on a live hub.
 */
export function homeConnectIddfHeaders(token: string): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${token}` }
}

export const HOME_CONNECT_IDDF_URL = (haId: string): string =>
  `https://eu.services.home-connect.com/api/iddf/v1/iddf/${encodeURIComponent(haId)}`
