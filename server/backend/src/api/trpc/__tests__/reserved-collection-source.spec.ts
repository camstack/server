/**
 * A RESERVED collection source id may be minted by exactly one addon (D625).
 *
 * `recording`'s default is ours, always, and the way that is made structural
 * rather than a sort order is the reserved id `camstack`: an absent operator
 * choice MEANS that value, so a surface never needs a "first row" fallback and
 * there is nowhere to put one. That only holds while nothing else can SPELL
 * the id — a second `camstack` row would put the picker's default behind a
 * fan-out order, which is exactly the `?? sources[0]` accident the reservation
 * exists to remove.
 *
 * The dispatcher DROPS the impostor row rather than throwing: one lying
 * provider must not empty a camera's picker, and the camera's own sources are
 * still real. The drop is logged with `tags: { deviceId }`, per CLAUDE.md — a
 * fault like this is asked per-camera or it cannot be asked at all.
 */

import type { CapabilityRegistry } from '@camstack/system'
import { recordingCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { requireDeviceCollection } from '../device-collection-dispatch.js'

const DEVICE_ID = 107

interface SourceRow {
  readonly source: string
  readonly label: string
  readonly addonId?: string
}

/** The recorder's row — the legitimate one. */
const OURS: SourceRow = {
  source: 'camstack',
  label: 'CamStack recordings',
  addonId: 'recorder',
}
/** What a vendor provider is allowed to answer. */
const ONBOARD: SourceRow = {
  source: 'native:reolink:onboard',
  label: 'SD card',
}
/** The row the reservation exists to refuse. */
const IMPOSTOR: SourceRow = { source: 'camstack', label: 'SD card, pretending' }

function registry(
  providers: Readonly<Record<string, { listSources: () => readonly SourceRow[] }>>,
  boundCap = 'recording',
): CapabilityRegistry {
  return {
    getDefinition: () => recordingCapability,
    getCollectionEntries: () => Object.entries(providers),
    getNativeProvider: () => null,
    getNativeAddonId: () => null,
    resolveCollectionForDevice: () => Object.values(providers),
    getSingleton: (capName: string) =>
      capName === 'device-manager'
        ? {
            getBindings: async () => ({
              entries: Object.keys(providers).map((addonId) => ({
                capName: boundCap,
                providerAddonId: addonId,
              })),
            }),
          }
        : null,
  } as unknown as CapabilityRegistry
}

function logger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() }
}

describe('a reserved collection source id is served by its owner alone', () => {
  it('drops a `camstack` row from an addon that is not the recorder, and keeps that addon’s own rows', async () => {
    const log = logger()
    const reg = registry({
      recorder: { listSources: () => [OURS] },
      'provider-reolink': { listSources: () => [IMPOSTOR, ONBOARD] },
    })
    const dispatcher = requireDeviceCollection(reg, 'recording', log as never)
    const rows = (await dispatcher?.listSources?.({ deviceId: DEVICE_ID })) as readonly SourceRow[]

    // The impostor's own source survives — it is a real source.
    expect(rows.map((r) => `${r.addonId}/${r.source}`).sort()).toEqual([
      'provider-reolink/native:reolink:onboard',
      'recorder/camstack',
    ])
    // Exactly one `camstack` row, and it is the recorder's.
    expect(rows.filter((r) => r.source === 'camstack')).toHaveLength(1)
  })

  it('names the impostor, the cap and the source in a log line tagged with the deviceId', async () => {
    const log = logger()
    const reg = registry({
      recorder: { listSources: () => [OURS] },
      'provider-reolink': { listSources: () => [IMPOSTOR, ONBOARD] },
    })
    const dispatcher = requireDeviceCollection(reg, 'recording', log as never)
    await dispatcher?.listSources?.({ deviceId: DEVICE_ID })

    expect(log.warn).toHaveBeenCalledTimes(1)
    const [message, detail] = log.warn.mock.calls[0] as [string, Record<string, never>]
    expect(message).toContain('camstack')
    expect(message).toContain('recorder')
    expect(JSON.stringify(detail)).toContain('provider-reolink')
    expect((detail as unknown as { tags: { deviceId: number } }).tags.deviceId).toBe(DEVICE_ID)
  })

  it('keeps the recorder’s own reserved row when it is the only source (the one-source fast path)', async () => {
    const log = logger()
    const reg = registry({ recorder: { listSources: () => [OURS] } })
    const dispatcher = requireDeviceCollection(reg, 'recording', log as never)
    const rows = (await dispatcher?.listSources?.({ deviceId: DEVICE_ID })) as readonly SourceRow[]

    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('camstack')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('drops the reserved row even when the impostor is the ONLY source — the fast path is not a hole', async () => {
    const log = logger()
    const reg = registry({ 'provider-reolink': { listSources: () => [IMPOSTOR, ONBOARD] } })
    const dispatcher = requireDeviceCollection(reg, 'recording', log as never)
    const rows = (await dispatcher?.listSources?.({ deviceId: DEVICE_ID })) as readonly SourceRow[]

    expect(rows.map((r) => r.source)).toEqual(['native:reolink:onboard'])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('leaves a cap with no reservation alone — every videoclips row travels', async () => {
    const log = logger()
    const reg = registry(
      { 'provider-reolink': { listSources: () => [IMPOSTOR, ONBOARD] } },
      'videoclips',
    )
    const dispatcher = requireDeviceCollection(reg, 'videoclips', log as never)
    const rows = (await dispatcher?.listSources?.({ deviceId: DEVICE_ID })) as readonly SourceRow[]

    expect(rows.map((r) => r.source)).toEqual(['camstack', 'native:reolink:onboard'])
    expect(log.warn).not.toHaveBeenCalled()
  })
})
