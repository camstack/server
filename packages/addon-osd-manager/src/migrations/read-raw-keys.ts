import type { StoredKeyRead } from '@camstack/types'
import { OSD_MANAGER_ID } from './bindings-to-templates.js'

/**
 * Each of `keys` that has a row, raw. A key the store could not answer for throws, so the
 * migration fails instead of treating a failed read as "nothing to move".
 */
export async function readRawKeys(
  read: (key: string) => Promise<StoredKeyRead>,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const found: Record<string, unknown> = {}
  for (const key of keys) {
    const answer = await read(key)
    if (answer.kind === 'unreadable') {
      throw new Error(`${OSD_MANAGER_ID}: the setting ${key} cannot be read (${answer.reason})`)
    }
    if (answer.kind === 'present') found[key] = answer.value
  }
  return found
}
