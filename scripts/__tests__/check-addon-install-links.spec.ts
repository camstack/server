/**
 * D860 guard — an "install an addon for X" offer must name a capability a
 * published addon package declares, and the catalog URL has one spelling.
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  declaredCapabilitiesOf,
  findCatalogLiterals,
  findInstallReferences,
  judgeInstallLinks,
  loadInstallableCapabilities,
} from '../lib/addon-install-links.ts'

const INSTALLABLE = new Set(['network-access', 'mesh-network'])

function judge(file: string, source: string): readonly string[] {
  return judgeInstallLinks({
    references: findInstallReferences(file, source),
    literals: findCatalogLiterals(file, source),
    installable: INSTALLABLE,
    allowedLiteralFiles: new Set(['builder.ts']),
  })
}

describe('check-addon-install-links', () => {
  it('flags an install offer for a capability no addon package declares', () => {
    const source = `const CAPABILITY = 'log-destination'\nconst g = { install: { capability: CAPABILITY, label: 'x' } }`
    expect(judge('Logging.tsx', source)).toEqual([expect.stringContaining('"log-destination"')])
  })

  it('accepts a declared capability, literal or same-file constant', () => {
    const source = `const CAPABILITY = 'network-access'\nconst a = { install: { capability: CAPABILITY } }\nhref(addonCatalogHref('mesh-network'))`
    expect(judge('ok.tsx', source)).toEqual([])
  })

  it('flags an addonCatalogHref argument naming an undeclared capability', () => {
    expect(judge('x.tsx', `addonCatalogHref('nope')`)).toHaveLength(1)
  })

  it('skips computed arguments and the builder declaration itself', () => {
    const source = `function addonCatalogHref(capability: string): string {}\nx(addonCatalogHref(group.install.capability))`
    expect(judge('x.ts', source)).toEqual([])
  })

  it('flags a hand-typed catalog URL outside the builder only', () => {
    const source = `navigate('/system/addons?capability=network-access')`
    expect(judge('Page.tsx', source)).toEqual([expect.stringContaining('addonCatalogHref()')])
    expect(judge('builder.ts', source)).toEqual([])
  })

  it('reads capability names from string and object entries', () => {
    expect(
      declaredCapabilitiesOf({
        camstack: { addons: [{ capabilities: ['a', { name: 'b' }] }, {}] },
      }),
    ).toEqual(['a', 'b'])
  })

  it('the real tree: training-provider is installable, log-destination is not', () => {
    const installable = loadInstallableCapabilities(path.resolve(import.meta.dirname, '../..'))
    expect(installable.has('training-provider')).toBe(true)
    expect(installable.has('log-destination')).toBe(false)
  })
})
