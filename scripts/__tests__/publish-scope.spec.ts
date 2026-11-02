/**
 * What a change must republish — checked against the REAL workspace.
 *
 * These assertions are deliberately about this repo rather than about a
 * fixture: every one of them is a release that went out looking green and
 * changed nothing, and a fixture would have kept passing through all three.
 */
import { describe, expect, it } from 'vitest'
import {
  bundledSources,
  inlinedSources,
  orderForPublish,
  resolvePublishSet,
  staleRegistryPins,
} from '../ci/publish-scope.mjs'

const ROOT = new URL('../..', import.meta.url).pathname

describe('resolvePublishSet', () => {
  it('rebuilds every package that BUNDLES ui-library’s source, not just ui-library', () => {
    // The failure this exists for: ui-library@1.2.178 reached npm and all three
    // nodes, and the browser showed the previous editor — admin-ui aliases
    // `@camstack/ui-library` to `../ui-library/src` and holds a COPY.
    const set = resolvePublishSet(['packages/ui-library/src/widgets/host-widgets.ts'], ROOT)
    expect(set).toContain('packages/ui-library')
    expect(set).toContain('packages/addon-admin-ui')
    expect(set).toContain('packages/addon-agent-ui')
    // And the server, because ui-library is in its pinned closure.
    expect(set).toContain('server/backend')
  })

  it('drags @camstack/server in for any closure member', { timeout: 30_000 }, () => {
    for (const file of [
      'packages/types/src/capabilities/ptz.cap.ts',
      'packages/system/src/kernel/capability-registry.ts',
      'packages/sdk/src/index.ts',
    ]) {
      expect(resolvePublishSet([file], ROOT)).toContain('server/backend')
    }
  })

  it('leaves a standalone addon alone — no server, no dependents', () => {
    expect(resolvePublishSet(['packages/addon-provider-rtsp/src/addon.ts'], ROOT)).toEqual([
      'packages/addon-provider-rtsp',
    ])
  })

  it('publishes nothing for a docs-only change', () => {
    expect(resolvePublishSet(['docs/README.md', 'README.md'], ROOT)).toEqual([])
  })

  it('finds the bundlers by READING the build configs', () => {
    const bundles = bundledSources(ROOT)
    // agent-ui is a standalone app that bundles the library on purpose. A page
    // remote takes it from the host (#332), and a vitest config's alias builds
    // nothing, so neither makes a package a bundler.
    expect([...(bundles.get('packages/addon-agent-ui') ?? [])]).toContain('packages/ui-library')
    expect(bundles.get('packages/addon-model-studio')).toBeUndefined()
    expect(bundles.get('packages/addon-benchmark')).toBeUndefined()
    expect([...(bundles.get('packages/addon-admin-ui') ?? [])]).toContain('packages/ui-library')
    // A package that bundles nothing has no entry at all.
    expect(bundles.get('packages/addon-provider-rtsp')).toBeUndefined()
  })

  it('republishes the server with a types change — the framework inside it INLINES the cap definitions', () => {
    // 2026-09-19: `event-saving` reached types@1.2.229…231 across five runs and
    // system stayed at 1.2.273 from the evening before. The hub builds every
    // cap router from the copy system inlines (`bundleTypesMainEntry: true`,
    // no `../types/src` anywhere), so the fleet refused the ninth switch id
    // with an eight-id enum while the types package beside it had nine (D545).
    const set = resolvePublishSet(['packages/types/src/interfaces/camera-switches.ts'], ROOT)
    // The framework is private and published only inside the server (D989).
    expect(set).toContain('server/backend')
    expect(set).not.toContain('packages/system')
    expect([...(bundledSources(ROOT).get('packages/system') ?? [])]).toContain('packages/types')
  })

  it('knows every copy the artifacts carry, and cascades only the authoritative ones', () => {
    const inlined = inlinedSources(ROOT)
    // The preset flag: authoritative — the hub's API surface comes from it.
    expect(inlined.get('packages/system')?.get('packages/types')).toBe('authoritative')
    // A self-contained addon carries a PRIVATE copy of types: known, not cascaded.
    expect(inlined.get('packages/addon-provider-rtsp')?.get('packages/types')).toBe('private')
    expect(bundledSources(ROOT).get('packages/addon-provider-rtsp')).toBeUndefined()
    expect(resolvePublishSet(['packages/types/src/capabilities/ptz.cap.ts'], ROOT)).not.toContain(
      'packages/addon-provider-rtsp',
    )
    // tsup's rule for the CLI, and a `noExternal` list for the server.
    expect(inlined.get('packages/cli')?.get('packages/types')).toBe('private')
    expect(inlined.get('server/backend')?.get('packages/node-root')).toBe('private')
  })
})

describe('orderForPublish', () => {
  it('puts server/backend last — the closure gate waits for pins already on npm', () => {
    // nx show projects (scope=all) lists server before types/sdk; publishing
    // in that order made run 37223477606 sleep on pins this loop had not
    // reached. The detect filter must not re-introduce Set insertion order.
    expect(
      orderForPublish(['server/backend', 'packages/types', 'packages/sdk', 'packages/system']),
    ).toEqual(['packages/sdk', 'packages/system', 'packages/types', 'server/backend'])
    const set = resolvePublishSet(
      ['packages/types/src/capabilities/ptz.cap.ts', 'packages/sdk/src/index.ts'],
      ROOT,
    )
    expect(set.at(-1)).toBe('server/backend')
  })
})

describe('staleRegistryPins', () => {
  it('never calls the folded framework a stale registry pin — it ships inside the server', () => {
    // The 2026-09-19 closure had `system` pinned from npm next to a newer
    // `types`. The framework is no registry package any more (D989), so that
    // closure cannot be built: types in the set, the framework travels along.
    expect(staleRegistryPins(['packages/types'], ROOT)).not.toContainEqual({
      pinned: 'packages/system',
      publishes: 'packages/types',
    })
  })

  it('is satisfied once the cascade has done its work', () => {
    const set = resolvePublishSet(['packages/types/src/interfaces/camera-switches.ts'], ROOT)
    expect(staleRegistryPins(set, ROOT)).toEqual([])
  })

  it('ignores a publish set that touches no inlined package', () => {
    expect(staleRegistryPins(['packages/addon-provider-rtsp'], ROOT)).toEqual([])
  })
})
