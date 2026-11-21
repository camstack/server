import type { ErrorStatus } from '@camstack/types'
import type { HmDevice, ValueChangedEvent } from 'nodehomematic'
import { RADIO_SILENT_FAULT, ruleReading } from './homematic-fault-mapping.js'
import {
  type RadioInterface,
  radioInterfaceOfDataPointId,
  radioInterfaceOfDevice,
} from './homematic-radio-interface.js'

/** The part of the library facade the tracker listens to. */
export interface ValueChangedSource {
  on(event: 'valueChanged', listener: (payload: ValueChangedEvent) => void): () => void
}

/**
 * Feed a tracker from the library's `valueChanged`. The event's `ts` is epoch
 * milliseconds (the library stamps `Date.now()`), the unit the tracker keeps;
 * it is passed through untouched. Returns the unsubscribe function.
 */
export function attachRadioActivity(
  source: ValueChangedSource,
  tracker: RadioActivityTracker,
): () => void {
  return source.on('valueChanged', (event) => tracker.record(event.dpId, event.ts))
}

/** No device event from an interface for this long is silence. */
export const RADIO_SILENT_AFTER_MS = 15 * 60_000
/** An interface needs at least this many devices before silence means anything. */
export const RADIO_SILENT_MIN_DEVICES = 5

/**
 * Stamps the REAL device datapoint events of each radio interface (fed from the
 * library's `valueChanged`). A connection ping, an interface-level event or a
 * virtual / group device never passes {@link record}'s interface check, so none
 * of them keeps the silence alive. The reading rides the core state-refresh tick:
 * there is no timer here.
 */
export class RadioActivityTracker {
  readonly #lastEventAt = new Map<RadioInterface, number>()
  readonly #startedAt: number

  constructor(startedAt: number) {
    this.#startedAt = startedAt
  }

  /** Stamp one real device event, named by its data-point id. */
  record(dataPointId: string, at: number): void {
    const radio = radioInterfaceOfDataPointId(dataPointId)
    if (radio === null) return
    const previous = this.#lastEventAt.get(radio) ?? 0
    if (at > previous) this.#lastEventAt.set(radio, at)
  }

  /**
   * Silent when an interface with enough devices has had no event for
   * {@link RADIO_SILENT_AFTER_MS}. Before the first event the clock runs from
   * the tracker's start, so it is UNKNOWN until that long has passed.
   */
  reading(devices: readonly Pick<HmDevice, 'channels'>[], now: number): ErrorStatus {
    const counts = new Map<RadioInterface, number>()
    for (const device of devices) {
      const radio = radioInterfaceOfDevice(device)
      if (radio !== null) counts.set(radio, (counts.get(radio) ?? 0) + 1)
    }
    let judged = false
    let silent = false
    for (const [radio, count] of counts) {
      if (count < RADIO_SILENT_MIN_DEVICES) continue
      const last = this.#lastEventAt.get(radio)
      if (last === undefined && now - this.#startedAt < RADIO_SILENT_AFTER_MS) continue
      judged = true
      if (now - (last ?? this.#startedAt) >= RADIO_SILENT_AFTER_MS) silent = true
    }
    return ruleReading(RADIO_SILENT_FAULT, judged ? silent : null, now)
  }
}
