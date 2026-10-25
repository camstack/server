/**
 * D787 — an addon serving a global form with a secret field declares it via
 * `globalSettingsSchema()`, or the keychain never sees its secrets. Fixtures
 * pin each rule; the last test runs the real tree.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import {
  ALLOWLIST,
  evaluate,
  findUndeclaredGlobalSchemas,
  scanRepo,
  type ModuleReader,
} from '../check-global-schema-declared.ts'

const ABS = '/repo/packages/addon-x/src/addon.ts'

function scan(text: string, modules: Record<string, string> = {}): string[] {
  const read: ModuleReader = (abs) => modules[abs] ?? null
  return findUndeclaredGlobalSchemas('addon.ts', ABS, text, read).map((f) => f.className)
}

describe('check-global-schema-declared rules', () => {
  it('flags an override serving an inline password field with no globalSettingsSchema', () => {
    expect(
      scan(`
        class A extends BaseAddon {
          async getGlobalSettings() {
            return hydrateSchema({ sections: [{ id: 's', fields: [{ type: 'password', key: 'pw' }] }] }, {})
          }
        }`),
    ).toEqual(['A'])
  })

  it('flags a secret reached through a same-class builder method (the onvif shape)', () => {
    expect(
      scan(`
        class Onvif extends BaseDeviceProvider {
          private buildGlobalSchema() {
            return { sections: [{ id: 'c', fields: [{ type: 'password', key: 'defaultPassword' }] }] }
          }
          async getGlobalSettings() { return hydrateSchema(this.buildGlobalSchema(), {}) }
        }`),
    ).toEqual(['Onvif'])
  })

  it('flags a secret reached through a relatively-imported builder (the wyze shape)', () => {
    expect(
      scan(
        `import { buildSettingsSchema } from './settings-schema.js'
        class Wyze extends BaseDeviceProvider {
          async getGlobalSettings() { return hydrateSchema(buildSettingsSchema(), {}) }
        }`,
        {
          '/repo/packages/addon-x/src/settings-schema.ts': `export function buildSettingsSchema() {
            return { sections: [{ id: 'c', fields: [{ type: 'text', key: 'apiKey', secret: true }] }] }
          }`,
        },
      ),
    ).toEqual(['Wyze'])
  })

  it('passes once the class declares globalSettingsSchema()', () => {
    expect(
      scan(`
        class A extends BaseAddon {
          protected override globalSettingsSchema() {
            return { sections: [{ id: 's', fields: [{ type: 'password', key: 'pw' }] }] }
          }
          override async getGlobalSettings() { return hydrateSchema(this.globalSettingsSchema(), {}) }
        }`),
    ).toEqual([])
  })

  it('passes an override whose form has no secret field', () => {
    expect(
      scan(`
        class A extends BaseAddon {
          private build() { return { sections: [{ id: 's', fields: [{ type: 'text', key: 'host' }] }] } }
          async getGlobalSettings() { return hydrateSchema(this.build(), {}) }
        }`),
    ).toEqual([])
  })

  it('evaluate() reports allowlisted findings as accepted and unmatched entries as stale', () => {
    const allow = new Map([
      ['a.ts#A', 'reason'],
      ['gone.ts#G', 'reason'],
    ])
    const result = evaluate(
      [
        { file: 'a.ts', className: 'A' },
        { file: 'b.ts', className: 'B' },
      ],
      allow,
    )
    expect(result.undeclared.map((f) => f.className)).toEqual(['B'])
    expect(result.stale).toEqual(['gone.ts#G'])
  })
})

describe('check-global-schema-declared on the real tree', () => {
  itRealTree(
    'every getGlobalSettings override serving a secret declares globalSettingsSchema()',
    () => {
      const root = resolve(import.meta.dirname, '..', '..')
      const { undeclared, stale } = evaluate(scanRepo(root))
      expect(undeclared).toEqual([])
      expect(stale).toEqual([])
      expect(ALLOWLIST.size).toBeGreaterThan(0)
    },
  )
})
