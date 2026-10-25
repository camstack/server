/**
 * `parseCapFile` — device-bound detection reads the INPUT argument only.
 *
 * The parser used to regex-test the whole `method(...)` text, output schema
 * included, so an inline `deviceId: z.number()` in an OUTPUT row (a per-camera
 * entry in a list the method returns) silently marked the method device-bound
 * and routed it through the device proxy. `pipelineOrchestrator.rebalance` had
 * to declare its skip schema outside the method to dodge it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCapFile } from '../lib/parse-cap.js'

const CAP = `
import { z } from 'zod'
import { method, type CapabilityDefinition } from '../capability.js'

export const probeCapability = {
  name: 'probe-thing',
  scope: 'system',
  methods: {
    /** Output-only deviceId: a per-camera row in what the method RETURNS. */
    listSkips: method(
      z.void(),
      z.object({
        migrated: z.number(),
        skipped: z.array(z.object({ deviceId: z.number(), reason: z.string() })).default([]),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Input deviceId: genuinely device-bound. */
    getOne: method(z.object({ deviceId: z.number() }), z.string()),
    /** Input carries a device, the output carries another — still device-bound. */
    both: method(
      z.object({ deviceId: z.number(), nodeId: z.string() }),
      z.array(z.object({ deviceId: z.number() })),
      { kind: 'query' },
    ),
    /** No deviceId anywhere. */
    plain: method(z.object({ nodeId: z.string() }), z.void(), { kind: 'mutation' }),
  },
} as const satisfies CapabilityDefinition
`

describe('parseCapFile — device-bound detection', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-cap-'))
    fs.writeFileSync(path.join(dir, 'probe.cap.ts'), CAP)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('an OUTPUT-only deviceId does not make a method device-bound', () => {
    const info = parseCapFile(dir, 'probe.cap.ts')
    const bound = Object.fromEntries((info?.methods ?? []).map((m) => [m.name, m.deviceBound]))
    expect(bound).toEqual({ listSkips: false, getOne: true, both: true, plain: false })
  })

  it('still reads the kind from anywhere in the call', () => {
    const info = parseCapFile(dir, 'probe.cap.ts')
    const kinds = Object.fromEntries((info?.methods ?? []).map((m) => [m.name, m.kind]))
    expect(kinds).toEqual({
      listSkips: 'mutation',
      getOne: 'query',
      both: 'query',
      plain: 'mutation',
    })
  })
})
