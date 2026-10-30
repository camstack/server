/**
 * The two clip-refresh knobs, as DECLARED.
 *
 * Asserted cold, on the schema builders themselves, because every property
 * here is one an operator can only discover by having been burnt: a switch
 * that costs battery must say so in its own words, and it must not be
 * reachable by anything that dispatches device actions on a schedule.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIP_CATALOG_FORCED_WAKE_KEY,
  CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
  CLIP_CATALOG_REFRESH_MINUTES_KEY,
  CLIP_CATALOG_REFRESH_OFF,
} from '../clips/clip-refresh.js'
import {
  buildClipRefreshDeviceSection,
  buildClipRefreshSettingsSchema,
  CLIP_REFRESH_SECTION_ID,
} from '../clips/clip-refresh-settings.js'

const MAINS_STANDALONE = { isHubChild: false, isBattery: false } as const
const HUB_CHILD = { isHubChild: true, isBattery: true } as const
const BATTERY_STANDALONE = { isHubChild: false, isBattery: true } as const

function fieldsOf(sections: readonly { fields: readonly { key: string }[] }[]): readonly string[] {
  return sections.flatMap((section) => section.fields.map((field) => field.key))
}

describe('the global default', () => {
  it('declares the interval with the shipped default, and OFF as a reachable value', () => {
    const [section] = buildClipRefreshSettingsSchema().sections
    expect(section?.id).toBe(CLIP_REFRESH_SECTION_ID)
    const field = section?.fields.find((f) => f.key === CLIP_CATALOG_REFRESH_MINUTES_KEY)
    expect(field).toBeDefined()
    expect(field && 'default' in field ? field.default : undefined).toBe(
      CLIP_CATALOG_REFRESH_MINUTES_DEFAULT,
    )
    expect(field && 'min' in field ? field.min : undefined).toBe(CLIP_CATALOG_REFRESH_OFF)
  })

  it('states the uncommon meaning of the interval in the operator’s own text', () => {
    // On a camera CamStack can reach it is a cheap read — nothing to explain.
    // On a standalone battery camera it only marks the catalog stale and never
    // wakes it: one setting meaning something else silently is how this repo
    // has shipped knobs nobody could reason about, so that case is stated.
    const [section] = buildClipRefreshSettingsSchema().sections
    const field = section?.fields.find((f) => f.key === CLIP_CATALOG_REFRESH_MINUTES_KEY)
    const description = field && 'description' in field ? String(field.description) : ''
    expect(description).toMatch(/battery/i)
    expect(description).toMatch(/never wakes/i)
  })
})

describe('the per-camera section', () => {
  it('offers the interval on every camera, with NO default — empty means "use the global"', () => {
    for (const shape of [MAINS_STANDALONE, HUB_CHILD, BATTERY_STANDALONE]) {
      const sections = buildClipRefreshDeviceSection(shape)
      const field = sections[0]?.fields.find((f) => f.key === CLIP_CATALOG_REFRESH_MINUTES_KEY)
      expect(field).toBeDefined()
      // Seeding the global here would make every camera an override the first
      // time anybody pressed Save: reset == unset == the global (D562).
      expect(field && 'default' in field ? field.default : undefined).toBeUndefined()
    }
  })

  it('offers the forced wake ONLY where a wake is a thing that can happen', () => {
    expect(fieldsOf(buildClipRefreshDeviceSection(BATTERY_STANDALONE))).toContain(
      CLIP_CATALOG_FORCED_WAKE_KEY,
    )
    // A hub child is read through its parent and a mains camera on its own
    // socket; neither is ever woken by this timer, so a switch there would be
    // one more thing an operator has to learn to ignore.
    expect(fieldsOf(buildClipRefreshDeviceSection(HUB_CHILD))).not.toContain(
      CLIP_CATALOG_FORCED_WAKE_KEY,
    )
    expect(fieldsOf(buildClipRefreshDeviceSection(MAINS_STANDALONE))).not.toContain(
      CLIP_CATALOG_FORCED_WAKE_KEY,
    )
  })

  it('names the battery cost in the switch’s own description', () => {
    const sections = buildClipRefreshDeviceSection(BATTERY_STANDALONE)
    const field = sections[0]?.fields.find((f) => f.key === CLIP_CATALOG_FORCED_WAKE_KEY)
    const description = field && 'description' in field ? String(field.description) : ''
    // One wake per interval is the whole cost model; the switch says so.
    expect(description).toMatch(/one wake per interval/i)
    expect(description).toMatch(/battery/i)
  })

  it('is OFF by default', () => {
    const sections = buildClipRefreshDeviceSection(BATTERY_STANDALONE)
    const field = sections[0]?.fields.find((f) => f.key === CLIP_CATALOG_FORCED_WAKE_KEY)
    expect(field && 'default' in field ? field.default : undefined).toBe(false)
  })

  it('is a plain switch — nothing that dispatches device ACTIONS can spend a wake', () => {
    // A `device-action-button` is dispatched through
    // `deviceManager.runDeviceAction`, which is what a schedule or an
    // automation drives. The forced wake must be reachable only by an
    // operator editing this camera's settings.
    const sections = buildClipRefreshDeviceSection(BATTERY_STANDALONE)
    for (const field of sections[0]?.fields ?? []) {
      expect(field.type).not.toBe('device-action-button')
      expect('action' in field ? field.action : undefined).toBeUndefined()
    }
  })
})
