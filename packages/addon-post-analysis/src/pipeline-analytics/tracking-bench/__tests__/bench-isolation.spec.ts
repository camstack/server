/**
 * Nothing under `tracking-bench/` except `recorder/` may reach a production
 * store or writer — replay, cases and metrics read files, they never write a
 * store (the D646 replay-isolation rule, `scripts/check-replay-isolation.ts`,
 * applied here).
 *
 * Disarm: add `import '../store/track-store.js'` to `replay.ts` — this test
 * must fail.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const FORBIDDEN = [
  /\/store\//,
  /track-store/,
  /media-store/,
  /event-store/,
  /@camstack\/system/,
  /\.\.\/index\.js/,
]

function sources(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory())
      return name === 'recorder' || name === '__tests__' ? [] : sources(full)
    return name.endsWith('.ts') ? [full] : []
  })
}

describe('tracking-bench isolation', () => {
  it('imports no store, writer or addon entry outside recorder/', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)) {
        const spec = m[1] ?? m[2] ?? ''
        if (FORBIDDEN.some((re) => re.test(spec)))
          offenders.push(`${path.relative(ROOT, file)} → ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
