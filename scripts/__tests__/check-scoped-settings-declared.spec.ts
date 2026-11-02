import { describe, expect, it } from 'vitest'
import {
  capsOfManifest,
  findScopedSettingsFindings,
  type ScopedSource,
} from '../check-scoped-settings-declared'

const MANIFEST = new Map([['packages/addon-x', new Set(['detector', 'recorder'])]])
const file = (content: string): ScopedSource[] => [
  { rel: 'packages/addon-x/src/x.addon.ts', content },
]
const messages = (content: string): string[] =>
  findScopedSettingsFindings(file(content), MANIFEST).map((f) => f.message)

const GOOD = `
class X extends BaseAddon {
  protected override async clusterSettingsSchema(cap: string) {
    if (cap === 'detector') return { sections: [{ id: 'a', title: 'A', fields: [{ type: 'text', key: 'threshold', label: 'T' }] }] }
    return null
  }
  protected override async nodeSettingsSchema(cap: string) {
    switch (cap) {
      case 'detector':
        return { sections: [{ id: 'n', title: 'N', fields: [{ type: 'text', key: 'backend', label: 'B' }] }] }
      default:
        return null
    }
  }
  protected override async deviceDefaultsSchema(cap: string) {
    return cap === 'recorder' ? DEFAULTS : null
  }
}
const DEFAULTS = { sections: [{ id: 'd', title: 'D', fields: [{ type: 'number', key: 'retention', label: 'R' }] }] }
`

describe('check-scoped-settings-declared', () => {
  it('accepts disjoint scopes over provided capabilities, including a same-file helper', () => {
    expect(messages(GOOD)).toEqual([])
  })

  it('refuses a schema that names a capability the manifest does not provide', () => {
    const bad = GOOD.replace("cap === 'detector'", "cap === 'ghost'")
    expect(messages(bad).join('\n')).toMatch(
      /capability "ghost", which no manifest of packages\/addon-x provides/,
    )
  })

  it('refuses one key declared in two scopes of the same addon', () => {
    const bad = GOOD.replace("key: 'backend'", "key: 'threshold'")
    expect(messages(bad).join('\n')).toMatch(
      /"threshold" is declared in more than one scope \(cluster, node\)/,
    )
  })

  it('refuses a key that contains @', () => {
    const bad = GOOD.replace("key: 'retention'", "key: 'retention@hub'")
    expect(messages(bad).join('\n')).toMatch(/"retention@hub" contains "@"/)
  })

  it('refuses a hook that names no capability, and skips one that only returns null', () => {
    const noCap = `class X { protected async clusterSettingsSchema(cap: string) { return { sections: [{ id: 'a', title: 'A', fields: [{ type: 'text', key: 'k', label: 'K' }] }] } } }`
    expect(messages(noCap).join('\n')).toMatch(/names no capability/)
    const base = `class B { protected async clusterSettingsSchema(_cap: string): Promise<ConfigUISchema | null> {\n return null\n } }`
    expect(messages(base)).toEqual([])
  })

  it('does not take a comment that mentions a hook as a declaration', () => {
    expect(
      messages(
        '/** see `clusterSettingsSchema(cap)` and nodeSettingsSchema(cap) { x } */\nconst a = 1\n',
      ),
    ).toEqual([])
  })

  it('reads the capability names a package manifest declares', () => {
    const caps = capsOfManifest({
      camstack: {
        addons: [{ capabilities: [{ name: 'a' }, 'b'] }, { capabilities: [{ name: 'c' }] }],
      },
    })
    expect([...caps].toSorted()).toEqual(['a', 'b', 'c'])
  })
})
