import { describe, expect, it } from 'vitest'
import {
  findUndeclaredIdentifiers,
  type IdentifierSourceFile,
} from '../check-device-identifiers-declared'

const WRITER = `await this.ctx.api.deviceManager?.setMetadata.mutate({ deviceId: this.id, patch })`

function pkg(name: string, files: Record<string, string>): IdentifierSourceFile[] {
  return Object.entries(files).map(([rel, content]) => ({
    pkg: name,
    rel: `packages/${name}/src/${rel}`,
    content,
  }))
}

describe('check-device-identifiers-declared', () => {
  it('flags a provider that writes a MAC into metadata and declares nothing', () => {
    const findings = findUndeclaredIdentifiers(
      pkg('addon-provider-x', {
        'gateway-metadata.ts': `export const patch = (m) => ({ manufacturer: 'X', mac: m })`,
        'gateway-device.ts': WRITER,
      }),
    )
    expect(findings).toEqual([
      {
        pkg: 'addon-provider-x',
        file: 'packages/addon-provider-x/src/gateway-metadata.ts',
        key: 'mac',
      },
    ])
  })

  it('accepts the same provider once it declares identifiers', () => {
    expect(
      findUndeclaredIdentifiers(
        pkg('addon-provider-x', {
          'gateway-metadata.ts': `export const patch = (m) => ({ serialNumber: m })`,
          'gateway-device.ts': `${WRITER}\nawait this.declareIdentifiers({ mac })`,
        }),
      ),
    ).toEqual([])
  })

  it('ignores a package that never writes metadata, and an identity key outside metadata files', () => {
    expect(
      findUndeclaredIdentifiers([
        ...pkg('addon-provider-y', { 'client.ts': `const r = { uid: 1, mac: 'x' }` }),
        ...pkg('addon-provider-z', {
          'device.ts': WRITER,
          'api.ts': `type R = { serial: string }`,
        }),
      ]),
    ).toEqual([])
  })

  it('does not take a comment naming setMetadata as a write', () => {
    expect(
      findUndeclaredIdentifiers(
        pkg('addon-admin-ui', {
          'Info.tsx': `/** refreshed via setMetadata */\n// setMetadata too\nconst label = { mac: 'MAC' }`,
        }),
      ),
    ).toEqual([])
  })

  it('exempts the packages that own the mechanism', () => {
    expect(
      findUndeclaredIdentifiers(pkg('system', { 'device-metadata.ts': `${WRITER}\n({ mac: 1 })` })),
    ).toEqual([])
  })
})
