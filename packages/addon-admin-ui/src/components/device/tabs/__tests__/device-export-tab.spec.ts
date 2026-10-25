/**
 * `isDeviceExportSection` decides TWO things at once: whether a section is
 * hoisted into the top-level "Export" device tab (`DeviceDetail.tsx`), and
 * whether it is dropped from the default Config tab (`DeviceAggregateSection`).
 * Get it wrong in one direction and the section renders twice; get it wrong in
 * the other and it lands under Config → Export while its siblings sit under the
 * top-level Export tab.
 *
 * The second is what shipped. The detector used to probe FIELDS for
 * `writerCapName === 'device-export'`, but the aggregator's `tagField`
 * deliberately skips structural field types (`separator` / `info` / `button`) —
 * they have no writer to route a patch back to. A `device-export` provider
 * whose contribution is currently a single `info` placeholder ("Not configured")
 * therefore carried NO marker at all and fell through to Config, while Alexa and
 * HomeKit — which have real boolean fields alongside their own `info` header —
 * were hoisted. Same cap, same declared `tab: 'export'`, two different tabs,
 * decided by whether the addon happened to have something to configure yet.
 *
 * The rule is now the section's own declaration (`tab: 'export'`), with the
 * writer probe kept as a fallback for a contributor that omits it.
 */

import type { ConfigSection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { isDeviceExportSection } from '../device-export-tab'

/** The `ha-export` section exactly as camera 101 serves it with no HA instance
 *  enabled — one `info` field, untagged, because `tagField` skips structural
 *  types. Verified on the live hub via `deviceManager.getDeviceAggregate`. */
const HA_EXPORT_INFO_ONLY: ConfigSection = {
  id: 'ha-export',
  title: 'Home Assistant',
  tab: 'export',
  columns: 1,
  order: 30,
  fields: [
    {
      type: 'info',
      key: 'haExport:101:__none',
      label: 'Not configured',
      content: 'Enable a Home Assistant instance in the addon settings first.',
      variant: 'info',
    },
  ],
}

/** Alexa's section from the same aggregate — an untagged `info` header plus
 *  editable fields that DO carry the writer tag. */
const ALEXA_EXPORT: ConfigSection = {
  id: 'export-alexa',
  title: 'Alexa',
  tab: 'export',
  fields: [
    { type: 'info', key: '__alexa-status', label: 'Status', content: 'Linked' },
    {
      type: 'boolean',
      key: 'alexa:101:enabled',
      label: 'Expose to Alexa',
      writerCapName: 'device-export',
      writerAddonId: 'export-alexa',
    },
  ],
}

/** A section that belongs to the Config tab and must never be hoisted. */
const UNRELATED_SECTION: ConfigSection = {
  id: 'snapshot',
  title: 'Snapshot',
  tab: 'image',
  fields: [
    {
      type: 'boolean',
      key: 'snapshot:cache',
      label: 'Cache snapshots',
      writerCapName: 'snapshot',
      writerAddonId: 'snapshot-addon',
    },
  ],
}

describe('isDeviceExportSection', () => {
  it('recognises an export section whose only field is a structural info placeholder', () => {
    // The regression: `tagField` never stamps `info`, so a field probe sees
    // nothing and the section drifts into Config → Export.
    expect(isDeviceExportSection(HA_EXPORT_INFO_ONLY)).toBe(true)
  })

  it('still recognises an export section by its tagged fields', () => {
    expect(isDeviceExportSection(ALEXA_EXPORT)).toBe(true)
  })

  it('recognises an export section by the writer tag even when the tab is absent', () => {
    const { tab: _dropped, ...noTab } = ALEXA_EXPORT
    expect(isDeviceExportSection(noTab as ConfigSection)).toBe(true)
  })

  it('leaves a non-export section in the Config tab', () => {
    expect(isDeviceExportSection(UNRELATED_SECTION)).toBe(false)
  })

  it('leaves an info-only section that does not claim the export tab alone', () => {
    const infoOnlyElsewhere: ConfigSection = {
      ...HA_EXPORT_INFO_ONLY,
      id: 'some-other-addon',
      tab: 'general',
    }
    expect(isDeviceExportSection(infoOnlyElsewhere)).toBe(false)
  })
})
