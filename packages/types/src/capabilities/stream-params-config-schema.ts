/**
 * stream-params — server-side `ConfigUISchema` builder.
 *
 * Pure schema-shaping helper: turns the camera-probed `StreamParamsOptions`
 * (availability descriptor) + the current `StreamParamsStatus` (per-profile
 * config) into a `ConfigUISchema` the admin-ui `ConfigFormBuilder` renders
 * directly — one section per profile (main / sub / ext) with resolution,
 * codec, framerate, bitrate, bitrate-mode, encoder-profile and GOP controls.
 *
 * This is the server-side home of the logic that the bespoke
 * `StreamParamsSettings` cap-settings composite used to run client-side
 * (`buildProfileSection`). Both the Reolink and Hikvision `stream-params`
 * providers call `buildStreamParamsConfigSchema` from their
 * `getConfigSchema` cap method so the two cameras emit a structurally
 * identical form. No addon dependencies — only `@camstack/types` shapes —
 * so it lives in `@camstack/types` and is shared without a cross-addon
 * import.
 *
 * The form field keys follow the `stream<Profile>_<prop>` convention
 * (`streamMain_resolution`, `streamSub_codec`, …) so a flat form patch can
 * be re-split per profile on save by `parseStreamParamsFormPatch`.
 */
import type { ConfigField, ConfigSection, ConfigUISchema } from '../interfaces/config-ui.js'
import type {
  StreamParamsOptions,
  StreamParamsStatus,
  StreamProfile,
  StreamProfilePatch,
} from './stream-params.cap.js'

/** Layout metadata for one of the camera's stream profiles. */
export interface StreamProfileMeta {
  readonly profile: StreamProfile
  /** Form-field key prefix (`streamMain`, `streamSub`, `streamExt`). */
  readonly prefix: string
  /** Human-facing section title. */
  readonly label: string
}

/**
 * The three well-known stream profiles in render order. Exported so the
 * providers and the save-path parser share one definition.
 */
export const STREAM_PROFILE_META: readonly StreamProfileMeta[] = [
  { profile: 'main', prefix: 'streamMain', label: 'Main stream' },
  { profile: 'sub', prefix: 'streamSub', label: 'Sub stream' },
  { profile: 'ext', prefix: 'streamExt', label: 'Third stream' },
] as const

type ProfileOptions = NonNullable<StreamParamsOptions['main']>
type ProfileConfig = NonNullable<StreamParamsStatus['main']>

/**
 * Build the per-profile `ConfigSection` from one profile's camera-probed
 * options + current config. Returns `null` when the camera advertises no
 * configurable property for the profile (the caller drops the section).
 */
function buildProfileSection(
  meta: StreamProfileMeta,
  opt: ProfileOptions,
  cur: ProfileConfig | undefined,
): ConfigSection | null {
  const fields: ConfigField[] = []

  // ── Resolution ──────────────────────────────────────────────────
  if (opt.resolutions.length > 0) {
    const resOptions = opt.resolutions.map((r) => ({
      value: `${String(r.width)}x${String(r.height)}`,
      label: `${String(r.width)}×${String(r.height)}`,
    }))
    const curResValue = cur ? `${String(cur.width)}x${String(cur.height)}` : undefined
    if (curResValue && !resOptions.some((o) => o.value === curResValue)) {
      resOptions.unshift({
        value: curResValue,
        label: `${curResValue.replace('x', '×')} (current)`,
      })
    }
    fields.push({
      type: 'select',
      key: `${meta.prefix}_resolution`,
      label: 'Resolution',
      options: resOptions,
      default: curResValue ?? resOptions[0]?.value ?? '',
    })
  }

  // ── Codec ───────────────────────────────────────────────────────
  if (opt.codecs.length > 0) {
    fields.push({
      type: 'select',
      key: `${meta.prefix}_codec`,
      label: 'Codec',
      options: opt.codecs.map((c) => ({ value: c, label: c === 'h264' ? 'H.264' : 'H.265' })),
      default: cur?.codec ?? opt.codecs[0],
    })
  }

  // ── Frame rate ──────────────────────────────────────────────────
  if (opt.framerates.length > 0) {
    const fpsOptions = opt.framerates.map((f) => ({ value: String(f), label: `${String(f)} fps` }))
    const curFps = cur?.framerate
    if (curFps !== undefined && !opt.framerates.includes(curFps)) {
      fpsOptions.unshift({ value: String(curFps), label: `${String(curFps)} fps (current)` })
    }
    fields.push({
      type: 'select',
      key: `${meta.prefix}_framerate`,
      label: 'Frame rate',
      options: fpsOptions,
      default: curFps !== undefined ? String(curFps) : (fpsOptions[0]?.value ?? ''),
    })
  }

  // ── Bitrate — discrete select on a value list; bounded number
  //    input on a free range. ───────────────────────────────────────
  if (opt.bitrates.length > 0) {
    const brOptions = opt.bitrates.map((b) => ({ value: String(b), label: `${String(b)} kbps` }))
    const curBr = cur?.bitrate
    if (curBr !== undefined && !opt.bitrates.includes(curBr)) {
      brOptions.unshift({ value: String(curBr), label: `${String(curBr)} kbps (current)` })
    }
    fields.push({
      type: 'select',
      key: `${meta.prefix}_bitrate`,
      label: 'Bitrate',
      options: brOptions,
      default: curBr !== undefined ? String(curBr) : (brOptions[0]?.value ?? ''),
    })
  } else {
    const range = opt.bitrateRange
    fields.push({
      type: 'number',
      key: `${meta.prefix}_bitrate`,
      label: 'Bitrate',
      unit: 'kbps',
      ...(range ? { min: range[0], max: range[1] } : {}),
      default: cur?.bitrate ?? range?.[0] ?? 0,
    })
  }

  // ── Bitrate mode — only when the firmware exposes the knob ──────
  if (opt.supportsBitrateMode) {
    fields.push({
      type: 'select',
      key: `${meta.prefix}_bitrateMode`,
      label: 'Bitrate mode',
      options: [
        { value: 'vbr', label: 'VBR (variable)' },
        { value: 'cbr', label: 'CBR (constant)' },
      ],
      default: cur?.bitrateMode ?? 'vbr',
    })
  }

  // ── Encoder profile — only when supported ──────────────────────
  if (opt.supportsEncoderProfile) {
    fields.push({
      type: 'select',
      key: `${meta.prefix}_encoderProfile`,
      label: 'Encoder profile',
      options: [
        { value: 'baseline', label: 'Baseline' },
        { value: 'main', label: 'Main' },
        { value: 'high', label: 'High' },
      ],
      default: cur?.encoderProfile ?? 'main',
    })
  }

  // ── GOP (I-frame interval) — only when supported ────────────────
  // A camera-advertised range renders a selector (one entry per allowed
  // second); without a range we fall back to a bounded number input.
  if (opt.supportsGop) {
    const range = opt.gop
    if (range) {
      const gopOptions: { value: string; label: string }[] = []
      for (let v = range.min; v <= range.max; v += range.step) {
        gopOptions.push({ value: String(v), label: `${String(v)} s` })
      }
      const curGop = cur?.gop
      if (curGop !== undefined && !gopOptions.some((o) => o.value === String(curGop))) {
        gopOptions.unshift({ value: String(curGop), label: `${String(curGop)} s (current)` })
      }
      fields.push({
        type: 'select',
        key: `${meta.prefix}_gop`,
        label: 'I-frame interval (GOP)',
        options: gopOptions,
        default: curGop !== undefined ? String(curGop) : (gopOptions[0]?.value ?? ''),
      })
    } else {
      fields.push({
        type: 'number',
        key: `${meta.prefix}_gop`,
        label: 'I-frame interval (GOP)',
        unit: 's',
        min: 1,
        default: cur?.gop ?? 1,
      })
    }
  }

  if (fields.length === 0) return null
  return {
    id: `stream-${meta.profile}`,
    tab: 'streaming',
    title: meta.label,
    description:
      "Encoder parameters pushed to the camera. Option lists are read live from the camera — fields the firmware doesn't expose are hidden.",
    columns: 2,
    fields,
  }
}

/**
 * Build the full `stream-params` `ConfigUISchema` from the camera-probed
 * options + current per-profile config. Returns `null` when no profile
 * exposes a configurable property — the cap then reports "no schema" and
 * the renderer shows the unsupported-camera message.
 *
 * `default` on each field is seeded from the current config so the
 * `ConfigFormBuilder` (which reads `value ?? default`) renders the live
 * camera state without a separate `values` map.
 */
export function buildStreamParamsConfigSchema(
  options: StreamParamsOptions,
  status: StreamParamsStatus | null,
): ConfigUISchema | null {
  const sections: ConfigSection[] = []
  for (const meta of STREAM_PROFILE_META) {
    const opt = options[meta.profile]
    if (!opt) continue
    const section = buildProfileSection(meta, opt, status?.[meta.profile])
    if (section) sections.push(section)
  }
  if (sections.length === 0) return null
  return { sections }
}

/**
 * Re-split a flat `ConfigFormBuilder` patch into a `StreamProfilePatch`
 * for one profile. Returns `null` when no field for the profile changed.
 * Select fields arrive as strings — coerced here. Mirrors the save path
 * the bespoke `StreamParamsSettings` composite used.
 */
export function parseStreamParamsFormPatch(
  patch: Record<string, unknown>,
  prefix: string,
): StreamProfilePatch | null {
  const out: StreamProfilePatch = {}
  let touched = false

  const resKey = `${prefix}_resolution`
  if (resKey in patch && typeof patch[resKey] === 'string') {
    const [w, h] = patch[resKey].split('x').map(Number)
    if (Number.isFinite(w) && Number.isFinite(h)) {
      out.width = w
      out.height = h
      touched = true
    }
  }
  const codecKey = `${prefix}_codec`
  if (codecKey in patch && (patch[codecKey] === 'h264' || patch[codecKey] === 'h265')) {
    out.codec = patch[codecKey]
    touched = true
  }
  const fpsKey = `${prefix}_framerate`
  if (fpsKey in patch) {
    const fps = Number(patch[fpsKey])
    if (Number.isFinite(fps)) {
      out.framerate = fps
      touched = true
    }
  }
  const brKey = `${prefix}_bitrate`
  if (brKey in patch) {
    const br = Number(patch[brKey])
    if (Number.isFinite(br)) {
      out.bitrate = br
      touched = true
    }
  }
  const modeKey = `${prefix}_bitrateMode`
  if (modeKey in patch && (patch[modeKey] === 'vbr' || patch[modeKey] === 'cbr')) {
    out.bitrateMode = patch[modeKey]
    touched = true
  }
  const profKey = `${prefix}_encoderProfile`
  if (
    profKey in patch &&
    (patch[profKey] === 'high' || patch[profKey] === 'main' || patch[profKey] === 'baseline')
  ) {
    out.encoderProfile = patch[profKey]
    touched = true
  }
  const gopKey = `${prefix}_gop`
  if (gopKey in patch) {
    const gop = Number(patch[gopKey])
    if (Number.isFinite(gop)) {
      out.gop = gop
      touched = true
    }
  }

  return touched ? out : null
}
