/**
 * Read an optional `settingsSchema` named export from a compiled block bundle.
 *
 * The author declares the form next to their default export:
 *
 *   export const settingsSchema = { sections: [...] }
 *   export default async function (ctx) { … }
 *
 * Until the first successful extract, `getBlockSettings` returns null. A
 * failed import is NOT a compile failure — the block can still run; the
 * settings UI simply stays absent.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfigUISchema } from '@camstack/types'

function looksLikeSchema(value: unknown): value is ConfigUISchema {
  if (value === null || typeof value !== 'object') return false
  const sections = (value as { sections?: unknown }).sections
  return Array.isArray(sections)
}

/**
 * Import the bundled module and return its `settingsSchema` export, or null.
 * Never throws.
 */
export async function extractSettingsSchema(js: string): Promise<ConfigUISchema | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-block-schema-'))
  const file = path.join(dir, 'block.mjs')
  try {
    await fs.writeFile(file, js, 'utf-8')
    const mod: unknown = await import(pathToFileURL(file).href)
    if (mod === null || typeof mod !== 'object') return null
    const schema = (mod as { settingsSchema?: unknown }).settingsSchema
    return looksLikeSchema(schema) ? schema : null
  } catch {
    return null
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
