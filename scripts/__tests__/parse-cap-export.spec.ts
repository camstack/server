/**
 * `parseCapFile` reads a capability's export name, `name:` and `scope:` from
 * the CAPABILITY's own block — not from the first match in the file (D648).
 *
 * An extension-slot descriptor is declared above the cap that lists it, and a
 * constant above a cap may carry a `name: '…'` / `scope: '…'` of its own. The
 * first-in-file rule once made every proxy generator emit the descriptor's
 * type as the capability that declares the slot.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCapFile } from '../lib/parse-cap.ts'

const FIXTURE = `
import { z } from 'zod'

export const DECOY_SLOT = {
  id: 'decoy',
  name: 'decoy-slot',
  scope: 'system',
  value: z.object({ deviceIds: z.array(z.number()) }),
} as const

export const realThingCapability = {
  name: 'real-thing',
  scope: 'device',
  mode: 'singleton',
  extensionSlots: [DECOY_SLOT],
  methods: {},
} as const
`

describe('parseCapFile — the capability block, not the first match in the file', () => {
  it('names the *Capability export, its own name and its own scope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-cap-'))
    fs.writeFileSync(path.join(dir, 'real-thing.cap.ts'), FIXTURE)
    const info = parseCapFile(dir, 'real-thing.cap.ts')
    expect(info?.exportName).toBe('realThingCapability')
    expect(info?.capName).toBe('real-thing')
    expect(info?.scope).toBe('device')
  })
})
