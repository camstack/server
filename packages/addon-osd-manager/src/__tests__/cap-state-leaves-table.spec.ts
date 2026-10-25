import { ALL_CAPABILITY_DEFINITIONS } from '@camstack/types'
import { CAP_STATE_LEAVES } from '@camstack/types/addon'
import { describe, expect, it } from 'vitest'
import { osdStateLeavesByName, osdStateLeavesOf } from '../osd-source-fields.js'
import { stateLeavesOf } from '../state-leaves.js'

/**
 * D28. The source picker reads the bindable leaves from the codegen'd, schema-free
 * `CAP_STATE_LEAVES` table instead of walking `ALL_CAPABILITY_DEFINITIONS` (which
 * inlined every cap schema into the OSD runner, ~+100 MB). The table is generated
 * by running `stateLeavesOf` over every definition, so it must agree with it for
 * every cap — otherwise codegen was skipped after a `.cap.ts` change.
 */
describe('CAP_STATE_LEAVES generated table', () => {
  it('equals stateLeavesOf for every capability definition', () => {
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      const truth = stateLeavesOf(def).map((leaf) => ({
        path: leaf.path,
        valueType: leaf.valueType,
        ...(leaf.enumValues !== undefined ? { enumValues: leaf.enumValues } : {}),
      }))
      expect(
        CAP_STATE_LEAVES[def.name] ?? [],
        `${def.name} — generated leaves disagree (run \`npm run codegen\`)`,
      ).toEqual(truth)
    }
  })

  it('names no capability that does not exist', () => {
    const names = new Set(ALL_CAPABILITY_DEFINITIONS.map((d) => d.name))
    for (const cap of Object.keys(CAP_STATE_LEAVES)) expect(names.has(cap)).toBe(true)
  })

  it('osdStateLeavesByName answers like osdStateLeavesOf for every cap', () => {
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      expect(osdStateLeavesByName(def.name), def.name).toEqual(osdStateLeavesOf(def))
    }
  })
})
