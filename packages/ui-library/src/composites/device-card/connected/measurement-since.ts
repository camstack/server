import type { HeroMeasurement } from "@camstack/types";
import type { UiTextFn } from "../../../contexts/ui-text";
import { formatLastSeen } from "../../../lib/format-last-seen";
import { sinceText } from "./since-text";

/** The part of a measurement the state corner's "since" reads. */
export type MeasurementSince = Pick<HeroMeasurement, "since" | "sinceKind">;

/**
 * The state corner's "since" for a sensor: how long a state has HELD (the same
 * coarse duration every card's corner shows) for a `changed` measurement, "2 min
 * ago" for a value last READ then; `null` when never observed.
 */
export function measurementSinceText(
  m: MeasurementSince,
  t: UiTextFn,
  now: number = Date.now(),
): string | null {
  if (m.since === null) return null;
  if (m.sinceKind === "changed") return sinceText(m.since, now, t) ?? null;
  return formatLastSeen(m.since, t);
}
