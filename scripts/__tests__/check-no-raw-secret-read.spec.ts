/**
 * D798 — addon code reads its settings resolved, never through a
 * marker-bearing view. Fixtures pin each rule; the last test runs the real tree.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import { ALLOWLIST, evaluate, findRawSecretReads, scanRepo } from '../check-no-raw-secret-read.ts'

function rules(text: string): string[] {
  return findRawSecretReads('addon.ts', text).map((f) => `${f.rule}:${f.text}`)
}

describe('check-no-raw-secret-read rules', () => {
  it("flags an initialize(context) override reading the unwrapped context's settings", () => {
    expect(
      rules(`
        class A extends BaseAddon {
          override async initialize(context: AddonContext) {
            const stored = await context.settings!.readAddonStore()
            this.password = stored['password']
            return super.initialize(context)
          }
        }`),
    ).toEqual(['context-bypass:context.settings'])
  })

  it('flags the element-access spelling too', () => {
    expect(
      rules(`
        class A extends BaseAddon {
          async initialize(ctx) { return ctx['settings'].readDeviceStore(1) }
        }`),
    ).toEqual(["context-bypass:ctx['settings']"])
  })

  it('passes an override that only hands the context to super (the reolink shape)', () => {
    expect(
      rules(`
        class A extends BaseAddon {
          override async initialize(context: AddonContext) {
            const base = await super.initialize(context)
            const stored = await this.ctx.settings!.readAddonStore()
            return base
          }
        }`),
    ).toEqual([])
  })

  it("flags BaseAddon's private raw members and a handle's raw reads", () => {
    expect(
      rules(`
        class A extends BaseAddon {
          async x() {
            const h = Reflect.get(this, '_secretSettings')
            await (this as any)._secretSettings.raw.readAddonStore()
            await (this as any).rawSettings()
            await (this as any).readRawProjectedStore()
            createSecretAwareContext(ctx, opts)
          }
        }`),
    ).toEqual([
      'private-raw-surface:(this as any)._secretSettings.raw.readAddonStore',
      'private-raw-surface:(this as any)._secretSettings',
      'private-raw-surface:(this as any).rawSettings',
      'private-raw-surface:(this as any).readRawProjectedStore',
      'private-raw-surface:createSecretAwareContext',
    ])
  })

  it('passes the resolved surface', () => {
    expect(
      rules(`
        class A extends BaseAddon {
          async x() {
            await this.resolveGlobalStore()
            await this.ctx.settings.readDeviceStore(1)
            await this.state('k', schema, '').get()
          }
        }`),
    ).toEqual([])
  })

  it('a stale allowlist entry fails', () => {
    expect(evaluate([], new Map([['gone#context-bypass#x', 'fixed']])).stale).toEqual([
      'gone#context-bypass#x',
    ])
  })
})

describe('check-no-raw-secret-read on the real tree', () => {
  itRealTree('finds nothing outside the allowlist, and the allowlist is not stale', () => {
    const result = evaluate(scanRepo(resolve(__dirname, '../..')), ALLOWLIST)
    expect(result.violations).toEqual([])
    expect(result.stale).toEqual([])
  })
})
