/**
 * The clips surface is a SECTION at the end of the Recording tab — not a tab
 * of its own.
 *
 * It shipped as a top-level `clips` tab beside `Recording`, and the operator
 * rejected the placement in one sentence: *"Io in realtà utilizzerei la stessa
 * tab recordings, lì abbiamo già tutto il necessario, una nuova sezione alla
 * fine per le clips"* [I would actually use the same recordings tab, there we already have everything necessary, a new section at the end for the clips]. The Recording tab already carries the recorder's panel,
 * the schedule bands and the unified retention policy; footage the camera
 * holds is the same question, asked of a different store.
 *
 * Placement is DATA (D14): the cap declares `tab`, `topTab` and `order`, the
 * aggregator emits the section, and `DeviceDetail.tsx` is never edited. So the
 * placement is pinned HERE, on the declaration, rather than by rendering a
 * device page — a render test would pass on a tab this file could still spell
 * wrong.
 *
 * The `clips` entry in `WELL_KNOWN_TABS` existed only to give that tab a label
 * and an icon. With no section pointing at it, a well-known id nobody declares
 * is an invitation to mint the tab again.
 */
import { describe, expect, it } from 'vitest'
import { videoclipsCapability } from '../capabilities/videoclips.cap.js'
import { WELL_KNOWN_TABS } from '../interfaces/config-ui.js'

describe('the clips surface is a section of the Recording tab', () => {
  it('declares the recording tab, not a clips tab', () => {
    expect(videoclipsCapability.deviceConfig.ui.tab).toBe('recording')
  })

  it('still contributes to the device page as a top-tab section', () => {
    // `topTab: true` is what puts the section on the header tab named by
    // `tab` — dropping it would re-home the browser inside the Config tab's
    // inner bar, where a player and a day's tiles do not fit.
    expect(videoclipsCapability.deviceConfig.ui.topTab).toBe(true)
  })

  it('sorts AFTER every section the recorder and retention contribute', () => {
    // "una nuova sezione alla fine" [a new section at the end] — the recorder's own panel is `order: 10`
    // and the re-homed retention section carries the analytics order. A
    // three-digit order is the end of the tab with room left in front of it.
    expect(videoclipsCapability.deviceConfig.ui.order).toBeGreaterThanOrEqual(100)
  })

  it('mints no well-known `clips` tab', () => {
    expect(WELL_KNOWN_TABS.map((tab) => tab.id)).not.toContain('clips')
  })
})
