/**
 * The simple sensor card (#514): a sensor that measures ONE thing is drawn as
 * that reading, once, big, with its quantity's icon, over a backdrop that says
 * what the number means. The shell owns the rest — the state corner ("HOT ·
 * 2 min ago ›") opens the history, the top line names the integration.
 */
import type {
  HeroMeasurement,
  HeroMeasurementQuantity,
  HeroModel,
  IconKey,
} from "@camstack/types";
import type { SceneSpeed, SceneVisual } from "../../../hero-scene/types";
import type { CardCommon, CardState } from "../../shell/model";

/** The reading as the operator reads it: already in their display unit. */
export interface SensorReading {
  readonly quantity: HeroMeasurementQuantity;
  /** The quantity's icon beside the value; `null` = a text state, no icon. */
  readonly icon: IconKey | null;
  /** "48", "6.9", "Open", "Eco"; "—" when it has not reported. */
  readonly value: string;
  readonly unit: string | null;
}

export interface SensorCardModel {
  readonly common: CardCommon;
  readonly reading: SensorReading;
  readonly state: CardState;
  /** The backdrop; `null` = the scene stands still (a mild temperature, a closed contact, a text). */
  readonly visual: SceneVisual | null;
}

/** What of a measurement decides how its scene moves. */
export type MeasurementLook = Pick<
  HeroMeasurement,
  "quantity" | "band" | "level" | "tone"
>;

function powerSpeed(level: number): SceneSpeed {
  if (level < 0.15) return "slow";
  return level < 0.5 ? "normal" : "fast";
}

/**
 * The backdrop a measurement moves with: heat rising when hot, flakes when
 * cold, a wire at the speed of the power (still at 0 W), drops for humidity, a
 * ring while a contact is open; nothing for a text.
 */
export function measurementVisual(m: MeasurementLook): SceneVisual | null {
  const still = { tone: m.tone, speed: "normal", dim: false } as const;
  switch (m.quantity) {
    case "temperature":
      if (m.band === "hot") return { ...still, kind: "heat" };
      if (m.band === "cold") return { ...still, kind: "drop", speed: "slow" };
      return null;
    case "humidity":
      return { ...still, kind: "fall", speed: "slow" };
    case "power": {
      const level = m.level ?? 0;
      return {
        ...still,
        kind: "wire",
        speed: powerSpeed(level),
        dim: level <= 0,
      };
    }
    case "contact":
      return (m.level ?? 0) > 0 ? { ...still, kind: "ripple" } : null;
    case "text":
      return null;
  }
}

/**
 * The measurement the sensor card draws, or `null` when the device is not a
 * simple sensor: no single measurement, or a row the operator can still set (a
 * sensor with controls keeps the full hero card, which draws them).
 */
export function sensorMeasurementOf(
  model: Pick<HeroModel, "measurement" | "rows" | "gated">,
): HeroMeasurement | null {
  if (model.measurement === undefined) return null;
  const gated = new Set(model.gated);
  const settable = model.rows.some(
    (row) => !gated.has(row.id) && row.controls.length > 0,
  );
  return settable ? null : model.measurement;
}
