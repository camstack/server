/**
 * The event mode of the device picker: which events of which devices are
 * picked, and what a device declares it can fire.
 *
 * A pick is one event of one part of one device. What a device fires is its
 * `event-emitter` vocabulary; until that read answers it is not known, which is
 * never the same as "fires nothing" (D315).
 */
import {
  EventEmitterStatusSchema,
  type DeviceFiredLeaf,
  type EventVocabularyEntry,
  readEventVocabulary,
} from '@camstack/types'

/** The cap whose slice carries a device's event vocabulary. */
export const DEVICE_EVENT_CAP = 'event-emitter'

export interface PickedDeviceEvent {
  readonly deviceId: number
  /** The part of the device that fires (a button); absent when the device has no parts. */
  readonly sourceId?: string
  readonly eventId: string
}

export type DeviceEventVocabulary =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly entries: readonly EventVocabularyEntry[] }

export interface DeviceEventRead {
  readonly status: 'pending' | 'error' | 'success'
  readonly data: unknown
}

export function deviceEventVocabularyOf(read: DeviceEventRead): DeviceEventVocabulary {
  if (read.status === 'pending') return { kind: 'pending' }
  if (read.status === 'error') return { kind: 'unknown' }
  const parsed = EventEmitterStatusSchema.safeParse(read.data)
  if (!parsed.success) return { kind: 'unknown' }
  return { kind: 'known', entries: readEventVocabulary(parsed.data) }
}

/** A picked event as the automation stores it: a whole `device-fired` leaf. */
export type DeviceFiredEntry = DeviceFiredLeaf

/** A fresh leaf id: what a `triggered-by` of the entry's row reads. */
export function newEntryId(): string {
  return `ev-${Math.random().toString(36).slice(2, 8)}`
}

/** The event a leaf names, or undefined when it names none (or several) the picker cannot show. */
export function pickOfFiredEntry(entry: DeviceFiredEntry): PickedDeviceEvent | undefined {
  const eventId = entry.eventIds?.[0]
  if (eventId === undefined || entry.eventIds?.length !== 1) return undefined
  const sourceId = entry.sourceIds?.[0]
  return { deviceId: entry.deviceId, eventId, ...(sourceId === undefined ? {} : { sourceId }) }
}

export function firedEntryOfPick(pick: PickedDeviceEvent, id: string): DeviceFiredEntry {
  return {
    kind: 'device-fired',
    id,
    deviceId: pick.deviceId,
    eventIds: [pick.eventId],
    ...(pick.sourceId === undefined ? {} : { sourceIds: [pick.sourceId] }),
  }
}

/** Add the leaf of the pick, or remove it when it is already there; never past `max`. */
export function toggleFiredEntry(
  value: readonly DeviceFiredEntry[],
  pick: PickedDeviceEvent,
  max: number | undefined,
  makeId: () => string = newEntryId,
): readonly DeviceFiredEntry[] {
  const same = (entry: DeviceFiredEntry): boolean => {
    const own = pickOfFiredEntry(entry)
    return own !== undefined && sameDeviceEvent(own, pick)
  }
  if (value.some(same)) return value.filter((entry) => !same(entry))
  if (max !== undefined && value.length >= max) return value
  return [...value, firedEntryOfPick(pick, makeId())]
}

export function sameDeviceEvent(a: PickedDeviceEvent, b: PickedDeviceEvent): boolean {
  return a.deviceId === b.deviceId && a.sourceId === b.sourceId && a.eventId === b.eventId
}

export function pickOfEntry(deviceId: number, entry: EventVocabularyEntry): PickedDeviceEvent {
  return {
    deviceId,
    ...(entry.source === undefined ? {} : { sourceId: entry.source.id }),
    eventId: entry.id,
  }
}

/** Add the pick, or remove it when it is already there; never past `max`. */
export function toggleDeviceEvent(
  value: readonly PickedDeviceEvent[],
  pick: PickedDeviceEvent,
  max: number | undefined,
): readonly PickedDeviceEvent[] {
  if (value.some((v) => sameDeviceEvent(v, pick))) {
    return value.filter((v) => !sameDeviceEvent(v, pick))
  }
  if (max !== undefined && value.length >= max) return value
  return [...value, pick]
}

export interface DeviceEventGroup {
  /** The part's label; null for events the device fires as a whole. */
  readonly label: string | null
  readonly entries: readonly EventVocabularyEntry[]
}

/** The vocabulary by part, in declared order; events of the whole device first. */
export function groupDeviceEvents(
  entries: readonly EventVocabularyEntry[],
): readonly DeviceEventGroup[] {
  const whole = entries.filter((entry) => entry.source === undefined)
  const bySource = new Map<string, { label: string; entries: EventVocabularyEntry[] }>()
  for (const entry of entries) {
    if (entry.source === undefined) continue
    const group = bySource.get(entry.source.id)
    if (group === undefined) {
      bySource.set(entry.source.id, { label: entry.source.label, entries: [entry] })
    } else {
      bySource.set(entry.source.id, { label: group.label, entries: [...group.entries, entry] })
    }
  }
  return [...(whole.length === 0 ? [] : [{ label: null, entries: whole }]), ...bySource.values()]
}

/** "Button 1 · Short press" for a pick; its raw ids when the vocabulary does not name them. */
export function describeDeviceEvent(
  pick: PickedDeviceEvent,
  vocabulary: DeviceEventVocabulary,
): string {
  const entries = vocabulary.kind === 'known' ? vocabulary.entries : []
  const entry = entries.find((e) => e.id === pick.eventId && e.source?.id === pick.sourceId)
  const source =
    pick.sourceId === undefined
      ? undefined
      : (entries.find((e) => e.source?.id === pick.sourceId)?.source?.label ?? pick.sourceId)
  return [source, entry?.label ?? pick.eventId].filter((part) => part !== undefined).join(' · ')
}

/** Whether the device still declares the pick; unknown vocabulary claims nothing. */
export function isDeviceEventGone(
  pick: PickedDeviceEvent,
  vocabulary: DeviceEventVocabulary,
): boolean {
  if (vocabulary.kind !== 'known') return false
  return !vocabulary.entries.some((e) => e.id === pick.eventId && e.source?.id === pick.sourceId)
}
