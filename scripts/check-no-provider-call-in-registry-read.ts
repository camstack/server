#!/usr/bin/env tsx
/**
 * An integrations read never calls an addon (D1066).
 *
 * The hub registry row is the only stored switch of an instance, so `integrations.list`, `get`,
 * `getByAddonId`, `listByAddon` and `getAvailableTypes` are pure registry reads. A read that awaited
 * an addon made every integration read depend on every addon: a slow owner stalled the hub, and the
 * hub calling back into the owner closed a call cycle (a 23-32 s hub-main stall and an OOM'd runner).
 *
 * Textual: the bodies of those procedures (and of the helpers they use) in
 * `server/backend/src/api/core/cap-providers.ts` are read, and a call that reaches a provider is
 * refused: `.describe(`, `.listInstances(`, `.getInstance(`, `.instanceFormSchema(`, `.testInstance(`,
 * `.setInstanceEnabled(`, `.readResolved(`, or the name `projectSwitches`. What an addon described is
 * read from the hub's own cache (`cachedDescription`), filled once at registration.
 *
 * Usage: npx tsx scripts/check-no-provider-call-in-registry-read.ts
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TARGET = 'server/backend/src/api/core/cap-providers.ts'

/** The procedure and helper names whose bodies are registry reads. */
const READ_BODIES: readonly string[] = [
  'list',
  'get',
  'getByAddonId',
  'listByAddon',
  'getAvailableTypes',
  'hidesFromIntegrations',
  'describedInstancesOf',
]
const FORBIDDEN_CALL_RE =
  /\.(describe|listInstances|getInstance|instanceFormSchema|testInstance|setInstanceEnabled|readResolved)\s*\(/
const FORBIDDEN_NAME_RE = /\bprojectSwitches\b/

export interface Violation {
  readonly where: string
  readonly message: string
}

/** The text of the `{ ... }` that follows `start` (brace matched, strings and comments not parsed away). */
function blockAfter(text: string, start: number): string {
  const open = text.indexOf('{', start)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

/** Where a read body of `name` starts: an object member `name: async (` or a function `name(`. */
function bodyStarts(text: string, name: string): number[] {
  const starts: number[] = []
  const member = new RegExp(`^\\s{4}${name}:\\s*async\\s*\\(`, 'gm')
  const fn = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'gm')
  for (const re of [member, fn]) {
    for (let m = re.exec(text); m !== null; m = re.exec(text)) starts.push(m.index)
  }
  return starts
}

export function findProviderCallsInRegistryReads(text: string): Violation[] {
  const out: Violation[] = []
  if (FORBIDDEN_NAME_RE.test(text)) {
    out.push({
      where: TARGET,
      message:
        '`projectSwitches` is back: the switch is the registry row, never a projection of an addon (D1066)',
    })
  }
  for (const name of READ_BODIES) {
    for (const start of bodyStarts(text, name)) {
      const body = blockAfter(text, start)
      const hit = FORBIDDEN_CALL_RE.exec(body)
      if (hit !== null) {
        out.push({
          where: `${TARGET}: ${name}`,
          message: `a registry read calls an addon (\`${hit[0].trim()}\`): read the registry row or the description the hub cached at registration (D1066)`,
        })
      }
    }
  }
  return out
}

function main(): void {
  const violations = findProviderCallsInRegistryReads(readFileSync(path.join(ROOT, TARGET), 'utf8'))
  if (violations.length === 0) {
    console.log('check-no-provider-call-in-registry-read: ok')
    return
  }
  for (const v of violations) console.error(`${v.where}: ${v.message}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
