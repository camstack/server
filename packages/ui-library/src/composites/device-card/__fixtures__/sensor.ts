/**
 * The simple sensor page of the approved mockup ("Card sensore semplice",
 * 2026-11-12): a hot and a cold temperature, a power reading, an open contact,
 * a text state, a humidity, and a wide one.
 */
import type { HeroMeasurement } from "@camstack/types";
import {
  contactMeasurement,
  humidityMeasurement,
  powerMeasurement,
  temperatureMeasurement,
  textMeasurement,
} from "@camstack/types";
import {
  measurementVisual,
  type SensorCardModel,
} from "../scenes/sensor/model";
import type { CardOrientation } from "../shell/model";
import { offline } from "./common";
import type { WaveEFixture } from "./wave-e";
import { deviceCommon } from "./wave-d-common";

const MINUTE_MS = 60_000;

interface SensorInput {
  readonly name: string;
  readonly integration: string;
  readonly measurement: HeroMeasurement;
  readonly value: string;
  readonly unit: string | null;
  readonly label: string;
  readonly since: string | null;
  readonly battery?: number;
}

function sensor(input: SensorInput): SensorCardModel {
  const m = input.measurement;
  return {
    common: deviceCommon({
      name: input.name,
      integration: input.integration,
      ...(input.battery === undefined ? {} : { battery: input.battery }),
    }),
    reading: {
      quantity: m.quantity,
      icon: m.icon,
      value: input.value,
      unit: input.unit,
    },
    state: { label: input.label, since: input.since, tone: m.tone },
    visual: measurementVisual(m),
  };
}

const f = (
  id: string,
  caption: string,
  model: SensorCardModel,
  orientation: CardOrientation = "vertical",
): WaveEFixture<SensorCardModel> => ({ id, caption, orientation, model });

export function sensorFixtures(
  now: number = Date.now(),
): readonly WaveEFixture<SensorCardModel>[] {
  const ago = (min: number): number => now - min * MINUTE_MS;
  const hot = sensor({
    name: "Sauna",
    integration: "Shelly",
    measurement: temperatureMeasurement(48, ago(2)),
    value: "48",
    unit: "°C",
    label: "Caldo",
    since: "2 min fa",
  });
  return [
    f("sensor-hot", "Caldo", hot),
    f(
      "sensor-cold",
      "Freddo",
      sensor({
        name: "Frigorifero",
        integration: "Zigbee",
        measurement: temperatureMeasurement(6.9, ago(1)),
        value: "6,9",
        unit: "°C",
        label: "Freddo",
        since: "1 min fa",
        battery: 82,
      }),
    ),
    f(
      "sensor-power",
      "Potenza",
      sensor({
        name: "Lavatrice",
        integration: "Shelly",
        measurement: powerMeasurement(1221, ago(0)),
        value: "1221",
        unit: "W",
        label: "Assorbe",
        since: "adesso",
      }),
    ),
    f(
      "sensor-contact",
      "Contatto aperto",
      sensor({
        name: "Finestra cucina",
        integration: "Homematic",
        measurement: contactMeasurement(true, ago(12)),
        value: "Aperto",
        unit: null,
        label: "Aperto",
        since: "12 min",
        battery: 64,
      }),
    ),
    f(
      "sensor-text",
      "Stato testuale",
      sensor({
        name: "Modalità caldaia",
        integration: "Home Assistant",
        measurement: textMeasurement("Eco", ago(90)),
        value: "Eco",
        unit: null,
        label: "Eco",
        since: "1 h",
      }),
    ),
    f(
      "sensor-humidity",
      "Umidità",
      sensor({
        name: "Bagno",
        integration: "Zigbee",
        measurement: humidityMeasurement(58, ago(3)),
        value: "58",
        unit: "%",
        label: "Normale",
        since: "3 min fa",
        battery: 91,
      }),
    ),
    f("sensor-offline", "Offline", { ...hot, common: offline(hot.common) }),
    f("sensor-horizontal", "Orizzontale", hot, "horizontal"),
  ];
}
