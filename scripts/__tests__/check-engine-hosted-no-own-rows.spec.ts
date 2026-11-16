import { describe, expect, it } from 'vitest'
import { findEngineOwnedRows } from '../check-engine-hosted-no-own-rows'

const grid = (content: string) => [
  { rel: 'packages/system/src/builtins/camera-grid/addon.ts', content },
]

describe('check-engine-hosted-no-own-rows', () => {
  it('flags an engine that declares its own rows through DeclaredDevices', () => {
    expect(
      findEngineOwnedRows(grid(`const a = 1\nconst declared = new DeclaredDevices({ addonId })\n`)),
    ).toEqual([
      {
        file: 'packages/system/src/builtins/camera-grid/addon.ts',
        line: 2,
        call: 'new DeclaredDevices(',
      },
    ])
  })

  it('flags devices.create and allocateDeviceId in an engine', () => {
    const findings = findEngineOwnedRows([
      {
        rel: 'packages/addon-terminal/src/addon.ts',
        content: `await this.ctx.kernel.devices.create('x', Cam, {})\nawait devices.allocateDeviceId('y')\n`,
      },
    ])
    expect(findings.map((f) => f.call)).toEqual(['devices.create(', 'allocateDeviceId('])
  })

  it('accepts hosting on the composer row through loadContext', () => {
    expect(
      findEngineOwnedRows(
        grid(`const hosted = await devices.loadContext(stableId, id, null, {})\n`),
      ),
    ).toEqual([])
  })

  it('ignores specs and files outside the engines', () => {
    expect(
      findEngineOwnedRows([
        {
          rel: 'packages/system/src/builtins/camera-grid/__tests__/x.spec.ts',
          content: 'new DeclaredDevices({})',
        },
        {
          rel: 'packages/system/src/builtins/composer/addon.ts',
          content: 'new DeclaredDevices({})',
        },
      ]),
    ).toEqual([])
  })
})
