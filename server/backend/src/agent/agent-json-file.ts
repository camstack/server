/**
 * `agent.json` read/write helpers. The file is owner-only on every OS (an owner+SYSTEM ACL on
 * Windows, where 0600 is a no-op) because it holds the mesh private key.
 */
import * as fs from 'node:fs'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'

export function readJsonFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {}
  } catch {
    return {}
  }
}

export function writeJsonFile0600(file: string, data: Record<string, unknown>): void {
  writeOwnerOnlyFileSync(file, JSON.stringify(data, null, 2))
}
