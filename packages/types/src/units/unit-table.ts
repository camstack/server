/**
 * Unit-of-measurement conversion table — the single source of truth shared by
 * the render path (`resolveSensorDisplay` in `@camstack/ui-library`) and the
 * future Stage-X expression engine's `convert()` builtin.
 *
 * Every unit maps to a `UnitSpec` describing the LINEAR transform to its
 * dimension's canonical unit:
 *
 *   canonical = value * factor + offset
 *
 * `offset` is non-zero ONLY for the temperature family (°F / K carry an
 * additive term); every other dimension is a pure scale (`offset = 0`).
 * Cross-dimension conversion is intentionally impossible: a lookup returns the
 * unit's `dimension`, and `convertUnit` refuses any pair whose dimensions
 * differ (see `convert.ts`).
 *
 * Keys are the CANONICAL spellings `normalizeUnit` (`../device/source-info.ts`)
 * produces — callers pass a raw unit through `normalizeUnit` BEFORE lookup.
 * Unknown spellings resolve to `undefined` and cause conversion to be refused
 * (the render path falls back to the raw value + source unit — never silently
 * wrong). Single-unit dimensions (illuminance, irradiance, percentage, …) exist
 * so a same-unit identity conversion is well-defined while cross-family
 * conversion stays refused.
 */

/** The physical dimensions CamStack surfaces across HA + Ecowitt + vendors. */
export type UnitDimension =
  | 'temperature'
  | 'pressure'
  | 'speed'
  | 'precipitation-rate'
  | 'length'
  | 'area'
  | 'illuminance'
  | 'irradiance'
  | 'power'
  | 'apparent-power'
  | 'energy'
  | 'voltage'
  | 'current'
  | 'concentration-volume'
  | 'concentration-mass'
  | 'mass'
  | 'percentage'
  | 'volume'
  | 'duration'
  | 'information'
  | 'angle'
  | 'sound-level'
  | 'signal-level'
  | 'colour-temperature'
  | 'bitrate'
  | 'rate'

/**
 * Linear conversion spec: `canonical = value * factor + offset`. Temperature is
 * the ONLY family using a non-zero `offset`.
 */
export interface UnitSpec {
  readonly dimension: UnitDimension
  readonly factor: number
  readonly offset: number
}

/**
 * Frozen unit → spec table. `•` in the doc marks each dimension's canonical
 * unit (`factor: 1, offset: 0`). °F derives from `°C = (°F − 32) × 5/9` ⇒
 * `factor = 5/9`, `offset = -160/9` (kept as exact expressions, not rounded
 * decimals). K derives from `°C = K − 273.15`.
 */
export const UNIT_TABLE: Readonly<Record<string, UnitSpec>> = {
  // ── temperature (canonical •°C — the only offset family) ──
  '°C': { dimension: 'temperature', factor: 1, offset: 0 },
  '°F': { dimension: 'temperature', factor: 5 / 9, offset: -160 / 9 },
  K: { dimension: 'temperature', factor: 1, offset: -273.15 },

  // ── pressure (canonical •hPa) ──
  hPa: { dimension: 'pressure', factor: 1, offset: 0 },
  kPa: { dimension: 'pressure', factor: 10, offset: 0 },
  Pa: { dimension: 'pressure', factor: 0.01, offset: 0 },
  mbar: { dimension: 'pressure', factor: 1, offset: 0 },
  bar: { dimension: 'pressure', factor: 1000, offset: 0 },
  inHg: { dimension: 'pressure', factor: 33.8639, offset: 0 },
  mmHg: { dimension: 'pressure', factor: 1.33322, offset: 0 },
  psi: { dimension: 'pressure', factor: 68.9476, offset: 0 },

  // ── speed (canonical •m/s) ──
  'm/s': { dimension: 'speed', factor: 1, offset: 0 },
  'km/h': { dimension: 'speed', factor: 1 / 3.6, offset: 0 },
  mph: { dimension: 'speed', factor: 0.44704, offset: 0 },
  kn: { dimension: 'speed', factor: 0.514444, offset: 0 },

  // ── precipitation-rate (canonical •mm/h) ──
  'mm/h': { dimension: 'precipitation-rate', factor: 1, offset: 0 },
  'in/h': { dimension: 'precipitation-rate', factor: 25.4, offset: 0 },

  // ── length (canonical •m) ──
  m: { dimension: 'length', factor: 1, offset: 0 },
  mm: { dimension: 'length', factor: 0.001, offset: 0 },
  cm: { dimension: 'length', factor: 0.01, offset: 0 },
  km: { dimension: 'length', factor: 1000, offset: 0 },
  in: { dimension: 'length', factor: 0.0254, offset: 0 },
  ft: { dimension: 'length', factor: 0.3048, offset: 0 },
  mi: { dimension: 'length', factor: 1609.344, offset: 0 },

  // ── area (canonical •m²) ──
  'm²': { dimension: 'area', factor: 1, offset: 0 },

  // ── illuminance (single-unit — identity-only) ──
  lx: { dimension: 'illuminance', factor: 1, offset: 0 },

  // ── irradiance (single-unit — Ecowitt solar) ──
  'W/m²': { dimension: 'irradiance', factor: 1, offset: 0 },

  // ── power (canonical •W) ──
  W: { dimension: 'power', factor: 1, offset: 0 },
  kW: { dimension: 'power', factor: 1000, offset: 0 },

  // ── apparent-power (single-unit — deliberately NOT convertible to W) ──
  VA: { dimension: 'apparent-power', factor: 1, offset: 0 },

  // ── energy (canonical •Wh) ──
  Wh: { dimension: 'energy', factor: 1, offset: 0 },
  kWh: { dimension: 'energy', factor: 1000, offset: 0 },
  MWh: { dimension: 'energy', factor: 1e6, offset: 0 },

  // ── voltage (canonical •V) ──
  V: { dimension: 'voltage', factor: 1, offset: 0 },
  mV: { dimension: 'voltage', factor: 0.001, offset: 0 },

  // ── current (canonical •A) ──
  A: { dimension: 'current', factor: 1, offset: 0 },
  mA: { dimension: 'current', factor: 0.001, offset: 0 },

  // ── concentration-volume (canonical •ppm) ──
  ppm: { dimension: 'concentration-volume', factor: 1, offset: 0 },
  ppb: { dimension: 'concentration-volume', factor: 0.001, offset: 0 },

  // ── concentration-mass (canonical •µg/m³) ──
  'µg/m³': { dimension: 'concentration-mass', factor: 1, offset: 0 },
  'mg/m³': { dimension: 'concentration-mass', factor: 1000, offset: 0 },

  // ── mass (canonical •kg) ──
  kg: { dimension: 'mass', factor: 1, offset: 0 },
  g: { dimension: 'mass', factor: 0.001, offset: 0 },
  lb: { dimension: 'mass', factor: 0.453592, offset: 0 },
  oz: { dimension: 'mass', factor: 0.0283495, offset: 0 },

  // ── percentage (single-unit passthrough) ──
  '%': { dimension: 'percentage', factor: 1, offset: 0 },

  // ── volume (canonical •L) ──
  L: { dimension: 'volume', factor: 1, offset: 0 },
  mL: { dimension: 'volume', factor: 0.001, offset: 0 },
  gal: { dimension: 'volume', factor: 3.785411784, offset: 0 },

  // ── duration (canonical •s). Media position uses ms and stays on this scale. ──
  s: { dimension: 'duration', factor: 1, offset: 0 },
  ms: { dimension: 'duration', factor: 0.001, offset: 0 },
  min: { dimension: 'duration', factor: 60, offset: 0 },
  h: { dimension: 'duration', factor: 3600, offset: 0 },
  d: { dimension: 'duration', factor: 86400, offset: 0 },

  // ── information (canonical •B). Binary steps are the display scale. ──
  B: { dimension: 'information', factor: 1, offset: 0 },
  KiB: { dimension: 'information', factor: 1024, offset: 0 },
  MiB: { dimension: 'information', factor: 1024 ** 2, offset: 0 },
  GiB: { dimension: 'information', factor: 1024 ** 3, offset: 0 },
  TiB: { dimension: 'information', factor: 1024 ** 4, offset: 0 },
  kB: { dimension: 'information', factor: 1000, offset: 0 },
  MB: { dimension: 'information', factor: 1e6, offset: 0 },
  GB: { dimension: 'information', factor: 1e9, offset: 0 },

  // ── angle (canonical •°) ──
  '°': { dimension: 'angle', factor: 1, offset: 0 },

  // ── single-unit families (identity only — dB is not a linear scale) ──
  dBFS: { dimension: 'sound-level', factor: 1, offset: 0 },
  dBm: { dimension: 'signal-level', factor: 1, offset: 0 },
  mired: { dimension: 'colour-temperature', factor: 1, offset: 0 },
  kbps: { dimension: 'bitrate', factor: 1, offset: 0 },
  Mbps: { dimension: 'bitrate', factor: 1000, offset: 0 },
  fps: { dimension: 'rate', factor: 1, offset: 0 },
}

/** Union of every canonical unit key present in `UNIT_TABLE`. */
export type KnownUnit = keyof typeof UNIT_TABLE
