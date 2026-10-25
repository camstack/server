import { describe, expect, it } from 'vitest'
import { findAddonsWithoutSuper } from '../check-addon-calls-super'

const file = (content: string) => [{ rel: 'packages/x/src/x.addon.ts', content }]

describe('check-addon-calls-super', () => {
  it('flags an addon class with no constructor', () => {
    const findings = findAddonsWithoutSuper(
      file(
        `export class PaletteAddon extends BaseAddon {\n  readonly id = 'p'\n  protected async onInitialize() { return [] }\n}\n`,
      ),
    )
    expect(findings).toEqual([
      { file: 'packages/x/src/x.addon.ts', line: 1, className: 'PaletteAddon' },
    ])
  })

  it('accepts a constructor that calls super with a config', () => {
    expect(
      findAddonsWithoutSuper(
        file(
          `export class A extends BaseAddon<Config> {\n  constructor() {\n    super({ ...DEFAULTS })\n  }\n}\n`,
        ),
      ),
    ).toEqual([])
  })

  it('ignores abstract bases and classes that extend something else', () => {
    expect(
      findAddonsWithoutSuper(
        file(`export abstract class Base extends BaseAddon {\n}\nclass Other extends Thing {\n}\n`),
      ),
    ).toEqual([])
  })

  it('does not take a super call in a later class as this one', () => {
    const findings = findAddonsWithoutSuper(
      file(
        `class A extends BaseAddon {\n  readonly id = 'a'\n}\nclass B extends BaseAddon {\n  constructor() {\n    super({})\n  }\n}\n`,
      ),
    )
    expect(findings.map((f) => f.className)).toEqual(['A'])
  })
})
