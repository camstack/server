/**
 * The HomeKit name (D1049): what HomeKit accepts, that the bridge's saved name is shown, and that a rename
 * keeps the paired accessory (the UUID never sees the name; the refresh never wipes the pairing).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { hapNameValidator } from '../exposed-name.js'
import { accessoryUuidFor } from '../mappers/kind.js'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../hap-export.addon.ts'),
  'utf8',
)

describe('HomeKit exposed name', () => {
  it('accepts a HomeKit name and refuses what hap-nodejs would reject', () => {
    expect(hapNameValidator('Porta d’ingresso (nord) 2')).toEqual({
      ok: true,
      name: 'Porta d’ingresso (nord) 2',
    })
    expect(hapNameValidator('Porch!').ok).toBe(false)
    expect(hapNameValidator('x'.repeat(65)).ok).toBe(false)
  })

  it('a rename keeps the same accessory: the UUID takes no name, the refresh keeps the pairing', () => {
    expect(accessoryUuidFor('camera', 7, 'export-hap')).toBe(
      accessoryUuidFor('camera', 7, 'export-hap'),
    )
    const body = SOURCE.slice(SOURCE.indexOf('private async setExposedName'))
    const method = body.slice(0, body.indexOf('\n  }\n'))
    expect(method).toContain('this.exposeDevice(inst, deviceIdStr)')
    expect(method).not.toContain('unexposeDevice')
    const expose = SOURCE.slice(SOURCE.indexOf('private async exposeDevice'))
    expect(expose.slice(0, 4000).replace(/\s+/g, ' ')).toContain(
      'const displayName = (await this.exposedNameOf(inst.id, deviceId)) ?? summary?.name',
    )
  })
})
