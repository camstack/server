import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OnboardingManifestSchema } from '../../packages/cli/src/onboarding/manifest-schema.ts'
import {
  compareSnapshot,
  liveProblems,
  manifestProblems,
  uiClaims,
  type RepositoryFacts,
} from '../onboarding-manifest-check.ts'

const MANIFEST = OnboardingManifestSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../packages/cli/src/onboarding/manifest.snapshot.json', import.meta.url),
      'utf8',
    ),
  ),
)

/** A repository that has everything the bundled manifest names. */
function agreeing(): RepositoryFacts {
  const claims = uiClaims(MANIFEST)
  return {
    // The admin UI mounts paths; a `?tab=` query in a claim is not part of the route.
    routes: new Set(claims.map((c) => c.ui.route.split('?')[0] ?? c.ui.route)),
    labels: new Set(claims.flatMap((c) => c.ui.nav)),
    addonPackages: new Map(
      MANIFEST.coreAddons.flatMap((g) => g.addons.map((a) => [a.id, a.package] as const)),
    ),
  }
}

describe('check-onboarding-manifest', () => {
  it('the bundled manifest makes UI claims at all (an empty walk would pass anything)', () => {
    expect(uiClaims(MANIFEST).length).toBeGreaterThan(5)
    expect(MANIFEST.coreAddons.flatMap((g) => g.addons).length).toBeGreaterThan(5)
  })

  it('a repository that has every route, label and addon is clean', () => {
    expect(manifestProblems(MANIFEST, agreeing())).toEqual([])
  })

  it('a route the admin UI no longer mounts is named with the step that points at it', () => {
    const facts = agreeing()
    const routes = new Set([...facts.routes].filter((r) => r !== '/system/data'))

    const problems = manifestProblems(MANIFEST, { ...facts, routes })

    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every((p) => p.includes('no route /system/data'))).toBe(true)
    expect(problems.join('\n')).toContain('step storage')
  })

  it('a claim with a ?tab= query is judged by the path the admin UI mounts', () => {
    const tabbed = uiClaims(MANIFEST).filter((c) => c.ui.route.includes('?tab='))
    expect(tabbed.length).toBeGreaterThan(0)
    expect(agreeing().routes.has('/system/data')).toBe(true)
    expect(manifestProblems(MANIFEST, agreeing())).toEqual([])
  })

  it('a renamed sidebar label is a problem', () => {
    const facts = agreeing()
    const labels = new Set([...facts.labels].filter((l) => l !== 'Identity & Access'))

    expect(manifestProblems(MANIFEST, { ...facts, labels }).join('\n')).toContain(
      'no label "Identity & Access"',
    )
  })

  it('an addon that moved to another package, or is gone, is a problem', () => {
    const facts = agreeing()
    const moved = new Map([
      ...facts.addonPackages,
      ['cloudflare-turn', '@camstack/addon-elsewhere'],
    ])
    const gone = new Map([...facts.addonPackages].filter(([id]) => id !== 'cloudflare-turn'))

    expect(manifestProblems(MANIFEST, { ...facts, addonPackages: moved }).join('\n')).toContain(
      'cloudflare-turn ships in @camstack/addon-elsewhere',
    )
    expect(manifestProblems(MANIFEST, { ...facts, addonPackages: gone }).join('\n')).toContain(
      'no addon has the id cloudflare-turn',
    )
  })

  it('the snapshot is compared as a value: formatting is not a difference, content is', () => {
    expect(compareSnapshot('{"a":1,"b":[2]}\n', '{\n  "a": 1,\n  "b": [2]\n}')).toEqual({
      kind: 'same',
    })
    expect(compareSnapshot('{"a":1}', '{"a":2}').kind).toBe('differs')
    expect(compareSnapshot('{"a":1}', '{"a":1,"b":1}').kind).toBe('differs')
  })

  it('live: behind is fine, ahead is not, one revision with two hashes is not', () => {
    const at = (revision: number, contentHash: string) => ({
      revision,
      contentHash,
    })

    expect(liveProblems(at(1, 'a'), at(1, 'a'))).toEqual([])
    expect(liveProblems(at(1, 'a'), at(2, 'b'))).toEqual([])
    expect(liveProblems(at(2, 'b'), at(1, 'a')).join()).toContain('publish the docs before the CLI')
    expect(liveProblems(at(1, 'a'), at(1, 'b')).join()).toContain('one number, two documents')
  })
})
