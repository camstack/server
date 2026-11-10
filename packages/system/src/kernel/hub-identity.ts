/**
 * The hub's ANNOUNCED identity (#494): `hub-<16 hex>`, random, generated once
 * and kept in `<dataDir>/hub-identity.json`. The hub announces it over mDNS and
 * gives it to an agent at pairing; the agent records it to find ITS hub again
 * when it has no address, and to refuse another hub on the same LAN.
 *
 * It is public (it grants nothing) and it is NOT the mesh node id: every hub is
 * still `hub` on its own mesh. A seed never overwrites: a file that exists but
 * cannot be read is reported and left alone, because paired agents hold the id
 * it carried.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isHubId } from '@camstack/types'

export const HUB_IDENTITY_FILE = 'hub-identity.json'

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
  if (!isHubId(hubId)) {
    return { hubId: null, created: false, problem: `${file} holds a value that is not a hub id` }
  }
  return { hubId, created: false, problem: null }
}

/** Read the hub id, generating and persisting it on the first call ever. Never throws. */
export function loadOrCreateHubId(dataDir: string): HubIdResult {
  const file = path.join(dataDir, HUB_IDENTITY_FILE)
  if (fs.existsSync(file)) return readHubIdFile(file)
  const hubId = `hub-${randomBytes(8).toString('hex')}`
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(dataDir, { recursive: true })
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
