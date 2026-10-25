/**
 * The per-camera Analytics form shows the value the runtime USES.
 *
 * `readDeviceSettings` resolves `{ ...globalRaw, ...deviceRaw }`; the form used
 * to hydrate from `deviceRaw` alone and so displayed the schema default for a
 * field the camera never saved, even when the cluster had set another value.
 *
 * Disarm: hydrate from `deviceRaw` only (drop `globalRaw` from the merge in
 * `hydrateWithInheritedGlobals`) — the first two cases fail.
 */
import type { ConfigFieldWithValue, ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  hydrateWithInheritedGlobals,
  INHERITED_FROM_GLOBAL_NOTE,
} from '../inherited-device-values.js'
import { buildDetectionSettingsSections } from '../settings-schema-sections.js'

const schema: ConfigUISchema = { sections: [...buildDetectionSettingsSections()] }

function field(
  sections: ReturnType<typeof hydrateWithInheritedGlobals>,
  key: string,
): ConfigFieldWithValue {
  for (const section of sections) {
    for (const f of section.fields) if (f.key === key) return f
  }
  throw new Error(`field ${key} not in the form`)
}

function valueOf(f: ConfigFieldWithValue): unknown {
  return 'value' in f ? f.value : undefined
}

function descriptionOf(f: ConfigFieldWithValue): string {
  return 'description' in f ? (f.description ?? '') : ''
}

describe('hydrateWithInheritedGlobals', () => {
  it('a never-saved field shows the cluster value, not the schema default', () => {
    const sections = hydrateWithInheritedGlobals(schema, {}, { minHits: 7, cooldownSec: 11 })
    expect(valueOf(field(sections, 'minHits'))).toBe(7)
    expect(valueOf(field(sections, 'cooldownSec'))).toBe(11)
  })

  it('says so on the field that inherits, and only on that field', () => {
    const sections = hydrateWithInheritedGlobals(schema, {}, { minHits: 7 })
    expect(descriptionOf(field(sections, 'minHits'))).toContain(INHERITED_FROM_GLOBAL_NOTE)
    // minTrackAge has no cluster value: it shows its default and claims nothing.
    expect(descriptionOf(field(sections, 'minTrackAge'))).not.toContain(INHERITED_FROM_GLOBAL_NOTE)
  })

  it("the camera's own value wins and is not labelled inherited", () => {
    const sections = hydrateWithInheritedGlobals(schema, { minHits: 2 }, { minHits: 7 })
    expect(valueOf(field(sections, 'minHits'))).toBe(2)
    expect(descriptionOf(field(sections, 'minHits'))).not.toContain(INHERITED_FROM_GLOBAL_NOTE)
  })

  it('with no cluster value at all the form is exactly the old one', () => {
    const sections = hydrateWithInheritedGlobals(schema, { minHits: 2 }, {})
    expect(valueOf(field(sections, 'minHits'))).toBe(2)
    expect(descriptionOf(field(sections, 'cooldownSec'))).not.toContain(INHERITED_FROM_GLOBAL_NOTE)
  })

  it('labels an inheriting field that had no description of its own', () => {
    const bare: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [{ type: 'number', key: 'bare', label: 'Bare', default: 1 }],
        },
      ],
    }
    const sections = hydrateWithInheritedGlobals(bare, {}, { bare: 5 })
    expect(valueOf(field(sections, 'bare'))).toBe(5)
    expect(descriptionOf(field(sections, 'bare'))).toBe(INHERITED_FROM_GLOBAL_NOTE)
  })

  it('does not mutate its inputs', () => {
    const device = Object.freeze({ minHits: 2 })
    const global = Object.freeze({ cooldownSec: 11 })
    expect(() => hydrateWithInheritedGlobals(schema, device, global)).not.toThrow()
  })
})
