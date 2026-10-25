/**
 * Every cap-method FACTORY must be known to the codegen's cap reader.
 *
 * `scripts/lib/parse-cap.ts` finds a capability's methods with a source REGEX
 * naming the factories it knows. A cap declared with a factory that regex does
 * not list is not a build error and not a lint error — the method simply
 * **vanishes** from the generated DeviceProxy, the SystemProxy and the router
 * map, while the cap file plainly declares it and `InferProvider` plainly
 * types it. The first symptom is a type error in a generated file three
 * packages away, which says nothing about the cause.
 *
 * Measured: `videoclips.readClipBytes` disappeared from all three the moment
 * it was declared with `optionalMethod()` (2026-09-20), because the regex knew
 * only `method` and `systemMethod`.
 *
 * So: the alternation is compared against the factories `capability-definition.ts`
 * actually exports, mechanically, rather than against a comment asking the
 * next person to remember. Adding a fourth factory turns this red on the same
 * commit that adds it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * `export function <name>(` for every name ending in `method`/`Method`.
 * Deduped: `method` is declared three times (two overloads plus the
 * implementation), which is a fact about TypeScript and not about codegen.
 */
function exportedMethodFactories(): string[] {
  const src = readFileSync(
    `${REPO}packages/types/src/capabilities/capability-definition.ts`,
    'utf8',
  )
  const names = [...src.matchAll(/^export function (\w*[mM]ethod)</gm)].map((m) => m[1] ?? '')
  return [...new Set(names)].sort()
}

/** The alternation `parse-cap.ts` scans cap sources with. */
function parsedMethodFactories(): string[] {
  const src = readFileSync(`${REPO}scripts/lib/parse-cap.ts`, 'utf8')
  const alternation = /const methodRegex = \/\^\\s\+\(\\w\+\)\\s\*:\\s\*\((?:\?:)?([\w|]+)\)/.exec(
    src,
  )
  expect(alternation, 'parse-cap.ts no longer declares methodRegex as expected').not.toBeNull()
  return (alternation?.[1] ?? '').split('|').sort()
}

describe('cap-method factories', () => {
  it('codegen parses every factory capability-definition.ts exports', () => {
    expect(parsedMethodFactories()).toEqual(exportedMethodFactories())
  })

  it('and today those are exactly three', () => {
    expect(exportedMethodFactories()).toEqual(['method', 'optionalMethod', 'systemMethod'])
  })
})
