/**
 * Every router the hub serves has a macro group. The map in `api-method-groups.ts` is written by
 * hand, so a new router would otherwise fall into "Other" unnoticed; this reads the generated
 * API reference (`docs/reference/api.md`, regenerated on commit) and names any router left out.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unmappedRouters } from '../api-method-groups'

const REFERENCE_PATH = join('docs', 'reference', 'api.md')

/** The repository root, found upwards from where vitest runs (the root or the package). */
function apiReferenceFile(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, REFERENCE_PATH))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`${REFERENCE_PATH} not found above ${process.cwd()}`)
    dir = parent
  }
  return join(dir, REFERENCE_PATH)
}
const ROUTER_ROW = /\| `([a-zA-Z0-9-]+)\.[a-zA-Z0-9.]+` \|/g

function routersInReference(): readonly string[] {
  const text = readFileSync(apiReferenceFile(), 'utf8')
  return [...new Set([...text.matchAll(ROUTER_ROW)].map((match) => match[1] ?? ''))].filter(
    (router) => router.length > 0,
  )
}

describe('API explorer macro groups cover the served routers', () => {
  it('reads routers from the reference', () => {
    expect(routersInReference().length).toBeGreaterThan(100)
  })

  it('leaves no router to the Other bucket', () => {
    expect(unmappedRouters(routersInReference())).toEqual([])
  })
})
