/**
 * The hub's ANNOUNCED identity (#494): `hub-<16 hex>`, random, generated once
 * and kept in `<dataDir>/tls/hub-identity.json`, beside the mesh CA a system
 * backup already archives. A file still at the data root (the first location)
 * is read once and copied under `tls/`; it is never overwritten. The hub
 * announces the id over mDNS and gives it to an agent at pairing; the agent
 * records it to find ITS hub again when it has no address, and to refuse
 * another hub on the same LAN.
 *
 * It is public (it grants nothing) and it is NOT the mesh node id: every hub is
 * still `hub` on its own mesh. A seed never overwrites: a file that exists but
 * cannot be read is reported and left alone, because paired agents hold the id
 * it carried.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** `hub-<16 hex>`. The same shape as `@camstack/types` `isHubId`. */
const HUB_ID_PATTERN: RegExp = /^hub-[0-9a-f]{16}$/

export function isAnnouncedHubId(value: unknown): value is string {
  return typeof value === 'string' && HUB_ID_PATTERN.test(value)
}

export const HUB_IDENTITY_FILE: string = 'hub-identity.json'
/** Data-dir-relative path. Beside the mesh CA, so a backup of `tls/` keeps the id. */
export const HUB_IDENTITY_RELATIVE: string = `tls/${HUB_IDENTITY_FILE}`

export interface HubIdResult {
  /** The hub id, or `null` when the file exists but does not hold one. */
  readonly hubId: string | null
  /** This call generated the id. */
  readonly created: boolean
  /** Why there is no id; `null` when there is one. */
  readonly problem: string | null
}

function readHubIdFile(file: string): HubIdResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err: unknown) {
    return {
      hubId: null,
      created: false,
      problem: `${file} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const hubId: unknown =
    parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'hubId') : undefined
  if (!isAnnouncedHubId(hubId)) {
    return { hubId: null, created: false, problem: `${file} holds a value that is not a hub id` }
  }
  return { hubId, created: false, problem: null }
}

function identityPath(dataDir: string): string {
  return path.join(dataDir, HUB_IDENTITY_RELATIVE)
}

/** Persist `hubId` at `file`. A file that appears meanwhile is kept (link refuses it). */
function writeHubIdFile(file: string, hubId: string): HubIdResult {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify({ hubId }, null, 2)}\n`)
    // `link` refuses an existing target: a concurrent first boot keeps the id already written.
    fs.linkSync(tmp, file)
  } catch (err: unknown) {
    if (fs.existsSync(file)) return readHubIdFile(file)
    return {
      hubId: null,
      created: false,
      problem: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return { hubId, created: true, problem: null }
}

/**
 * Read the hub id, generating and persisting it on the first call ever.
 * Never throws. A file at the data root is copied under `tls/` once.
 */
export function loadOrCreateHubId(dataDir: string): HubIdResult {
  const file = identityPath(dataDir)
  if (fs.existsSync(file)) return readHubIdFile(file)
  const legacy = path.join(dataDir, HUB_IDENTITY_FILE)
  if (fs.existsSync(legacy)) {
    const read = readHubIdFile(legacy)
    if (read.hubId === null) return read
    const copied = writeHubIdFile(file, read.hubId)
    if (copied.hubId === null) return read
    return { hubId: read.hubId, created: false, problem: null }
  }
  return writeHubIdFile(file, `hub-${randomBytes(8).toString('hex')}`)
}
