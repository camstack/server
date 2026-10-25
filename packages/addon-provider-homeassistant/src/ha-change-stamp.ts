/**
 * WHEN did this entity's value last change — the `lastChangedAt` a slice carries.
 *
 * HA's `last_changed` is not that answer on its own. It moves whenever the STATE STRING
 * moves, and `on → unavailable → on` moves it twice: a Zigbee2MQTT restart, a coordinator
 * hiccup or an HA restart hands every entity a fresh `last_changed` while the value it
 * reports is the one it had all along. Every consumer of a sensor edge reads a fresh stamp
 * on an active level as "this just happened" (`evaluateSensorEdge`'s first sighting, the
 * alarm's openings), and on 2026-10-07 02:32Z four contacts that had been open for hours
 * came back from a Z2M restart as four fresh openings and pressed the armed panel.
 *
 * The provider is the one place that knows the level it last held (D224: a device fact is
 * kept fresh in the addon that owns the device), so the stamp is decided here, as one pure
 * function, and the slice a consumer reads is already the truth:
 *
 *  - `kept` — the value equals the last KNOWN value (a restored or observed slice with a
 *    real stamp): the level did not change, so neither did its change time. The slice is
 *    rewritten identical, and no consumer sees an event at all.
 *  - `seeded` — the push ENDS an outage this process saw, and nothing was known before it:
 *    the value is real but its change time is not. Stamped {@link HA_SEEDED_CHANGED_AT}
 *    (epoch + 1 ms), the convention a consumer reads as "known value, old or unknown change
 *    time" — it seeds a baseline and is never a fresh edge. Logged by the caller.
 *  - `ha` — a real change (or a first push with nothing to compare against): HA's own
 *    `last_changed`.
 */

/** "A known value whose change time is unknown" — the same convention Homematic writes. */
export const HA_SEEDED_CHANGED_AT = 1

export type HaChangeStamp =
  | { readonly kind: 'kept'; readonly at: number }
  | { readonly kind: 'seeded'; readonly at: number }
  | { readonly kind: 'ha'; readonly at: number }

export interface HaChangeStampInput {
  /** The value just pushed equals the value the slice already holds. */
  readonly sameValue: boolean
  /** The slice's current change stamp; `0` / absent is a placeholder (value unknown). */
  readonly priorChangedAt: number | undefined
  /** HA's `last_changed` for this push, in ms. */
  readonly haChangedAt: number
  /** This push ends an `unavailable` / `unknown` stretch this process saw. */
  readonly afterOutage: boolean
}

export function haChangeStamp(input: HaChangeStampInput): HaChangeStamp {
  const prior = input.priorChangedAt
  const priorKnown = prior !== undefined && Number.isFinite(prior) && prior > 0
  if (priorKnown && input.sameValue) return { kind: 'kept', at: prior }
  if (!priorKnown && input.afterOutage) return { kind: 'seeded', at: HA_SEEDED_CHANGED_AT }
  return { kind: 'ha', at: input.haChangedAt }
}

/** What the push handler is told beside the state. */
export interface HaStatePushContext {
  /** This push ends an `unavailable` / `unknown` stretch this process saw. */
  readonly afterOutage: boolean
}
