/**
 * Hub bootstrap selection — the list the launcher actually installs.
 *
 * `AddonInstaller.REQUIRED_PACKAGES` has its own coherence spec
 * (`packages/system/src/kernel/__tests__/addon-installer-required.spec.ts`),
 * but the HUB never boots through it: `launcher.ts` derives its own list from
 * the server package.json because the slim image strips the `@camstack/*`
 * symlinks. That second derivation dropped the
 * `camstack.agentOnlyBootstrapAddons` exclusion, so the hub npm-installed
 * `@camstack/addon-agent-ui` on every boot (observed live: manifest.json
 * entry with `source: "npm"`). Green suite, wrong function.
 *
 * The last test pins the real manifest, so re-adding an agent-only addon to
 * the server closure without excluding it fails here.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ServerBootstrapManifest } from '../bootstrap-packages.js'
import { selectHubBootstrapPackages } from '../bootstrap-packages.js'

function backendPackage(): ServerBootstrapManifest {
  const pkgPath = path.resolve(__dirname, '..', '..', 'package.json')
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as ServerBootstrapManifest
}

describe('selectHubBootstrapPackages', () => {
  it('keeps every @camstack/addon-* dep plus @camstack/system', () => {
    const selected = selectHubBootstrapPackages({
      dependencies: {
        '@camstack/addon-admin-ui': '*',
        '@camstack/system': '*',
        '@camstack/types': '*',
        fastify: '^5',
      },
    })
    expect([...selected].toSorted()).toEqual(['@camstack/addon-admin-ui', '@camstack/system'])
  })

  it('excludes camstack.agentOnlyBootstrapAddons — the hub must never install them', () => {
    const selected = selectHubBootstrapPackages({
      dependencies: {
        '@camstack/addon-admin-ui': '*',
        '@camstack/addon-agent-ui': '*',
        '@camstack/system': '*',
      },
      camstack: { agentOnlyBootstrapAddons: ['@camstack/addon-agent-ui'] },
    })
    expect(selected).not.toContain('@camstack/addon-agent-ui')
    expect([...selected].toSorted()).toEqual(['@camstack/addon-admin-ui', '@camstack/system'])
  })

  it('tolerates a manifest with no deps and no camstack block', () => {
    expect(selectHubBootstrapPackages({})).toEqual([])
  })

  it('excludes every agent-only addon declared by the REAL server manifest', () => {
    const pkg = backendPackage()
    const agentOnly = pkg.camstack?.agentOnlyBootstrapAddons ?? []
    // Guard the guard: an empty declaration would make this vacuously green.
    expect(agentOnly.length).toBeGreaterThan(0)
    const selected = selectHubBootstrapPackages(pkg)
    for (const name of agentOnly) {
      expect(pkg.dependencies?.[name]).toBeDefined()
      expect(selected).not.toContain(name)
    }
  })

  it('a fresh hub installs the benchmark addon — measuring works out of the box', () => {
    // A fresh 1.2.619 dev hub booted 41 addons and no benchmark: Model Studio's
    // and the operator's measurements (`benchmark.runPipelineTest`) had nowhere
    // to run until someone installed it by hand.
    expect(selectHubBootstrapPackages(backendPackage())).toContain('@camstack/addon-benchmark')
  })
})
