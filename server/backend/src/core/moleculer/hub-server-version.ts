/**
 * The `@camstack/server` version this hub runs, carried on every `$hub.registerNode` ack so an
 * agent can align its own closure to it (agent self-update). Read once from the running
 * package.json (`dist/core/moleculer/` -> `../../../package.json`); null when it cannot be read —
 * the ack then simply omits it and the agent says "hub version unknown" instead of guessing.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SERVER_ROOT_PACKAGE_NAME } from '../../server-root/index.js'

export function readServerVersionFrom(packageJsonPath: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    if (typeof raw !== 'object' || raw === null) return null
    const name: unknown = Reflect.get(raw, 'name')
    const version: unknown = Reflect.get(raw, 'version')
    if (name !== SERVER_ROOT_PACKAGE_NAME) return null
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}

let cached: string | null | undefined

export function readHubServerVersion(): string | null {
  if (cached === undefined) {
    cached = readServerVersionFrom(path.resolve(__dirname, '..', '..', '..', 'package.json'))
  }
  return cached
}
