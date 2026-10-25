/**
 * image-settings — server-side `ConfigUISchema` builder + form-patch
 * parser. Sibling of `day-night-config-schema.ts` — see that file's
 * header for why this lives in `@camstack/system` rather than
 * `@camstack/types`.
 *
 * Field keys use the `imageSettings_<prop>` prefix so a flat form patch
 * can be re-parsed into an `ImageSettingsPatch` by
 * `parseImageSettingsFormPatch`.
 */
import type {
  BacklightMode,
  ConfigField,
  ConfigSection,
  ConfigUISchema,
  ExposureMode,
  ImageRotate,
  ImageSettingsOptions,
  ImageSettingsPatch,
  ImageSettingsStatus,
  WhiteBalanceMode,
} from '@camstack/types'

const ROTATE_LABELS: Readonly<Record<ImageRotate, string>> = {
  '0': '0°',
  '90': '90°',
  '180': '180°',
  '270': '270°',
}
const WHITE_BALANCE_LABELS: Readonly<Record<WhiteBalanceMode, string>> = {
  auto: 'Auto',
  manual: 'Manual',
}
const EXPOSURE_LABELS: Readonly<Record<ExposureMode, string>> = {
  auto: 'Auto',
  manual: 'Manual',
}
const BACKLIGHT_LABELS: Readonly<Record<BacklightMode, string>> = {
  off: 'Off',
  blc: 'Backlight compensation',
  wdr: 'Wide dynamic range',
  hlc: 'Highlight compensation',
}

const ROTATE_VALUES: ReadonlySet<string> = new Set<ImageRotate>(['0', '90', '180', '270'])
const WHITE_BALANCE_VALUES: ReadonlySet<string> = new Set<WhiteBalanceMode>(['auto', 'manual'])
const EXPOSURE_VALUES: ReadonlySet<string> = new Set<ExposureMode>(['auto', 'manual'])
const BACKLIGHT_VALUES: ReadonlySet<string> = new Set<BacklightMode>(['off', 'blc', 'wdr', 'hlc'])

function isImageRotate(value: unknown): value is ImageRotate {
  return typeof value === 'string' && ROTATE_VALUES.has(value)
}
function isWhiteBalanceMode(value: unknown): value is WhiteBalanceMode {
  return typeof value === 'string' && WHITE_BALANCE_VALUES.has(value)
}
function isExposureMode(value: unknown): value is ExposureMode {
  return typeof value === 'string' && EXPOSURE_VALUES.has(value)
}
function isBacklightMode(value: unknown): value is BacklightMode {
  return typeof value === 'string' && BACKLIGHT_VALUES.has(value)
}

/**
 * Build the `image-settings` `ConfigUISchema` from the camera-probed
 * options + current status. Returns `null` when the camera exposes no
 * configurable property.
 */
export function buildImageSettingsConfigSchema(
  options: ImageSettingsOptions,
  status: ImageSettingsStatus | null,
): ConfigUISchema | null {
  const fields: ConfigField[] = []

  if (options.supportsBrightness && options.brightness) {
    fields.push({
      type: 'slider',
      key: 'imageSettings_brightness',
      label: 'Brightness',
      labelKey: 'server:imageSettingsConfig.imageSettings_brightness.label',
      min: options.brightness.min,
      max: options.brightness.max,
      step: options.brightness.step,
      showValue: true,
      default: status?.brightness ?? options.brightness.min,
    })
  }
  if (options.supportsContrast && options.contrast) {
    fields.push({
      type: 'slider',
      key: 'imageSettings_contrast',
      label: 'Contrast',
      labelKey: 'server:imageSettingsConfig.imageSettings_contrast.label',
      min: options.contrast.min,
      max: options.contrast.max,
      step: options.contrast.step,
      showValue: true,
      default: status?.contrast ?? options.contrast.min,
    })
  }
  if (options.supportsSaturation && options.saturation) {
    fields.push({
      type: 'slider',
      key: 'imageSettings_saturation',
      label: 'Saturation',
      labelKey: 'server:imageSettingsConfig.imageSettings_saturation.label',
      min: options.saturation.min,
      max: options.saturation.max,
      step: options.saturation.step,
      showValue: true,
      default: status?.saturation ?? options.saturation.min,
    })
  }
  if (options.supportsSharpness && options.sharpness) {
    fields.push({
      type: 'slider',
      key: 'imageSettings_sharpness',
      label: 'Sharpness',
      labelKey: 'server:imageSettingsConfig.imageSettings_sharpness.label',
      min: options.sharpness.min,
      max: options.sharpness.max,
      step: options.sharpness.step,
      showValue: true,
      default: status?.sharpness ?? options.sharpness.min,
    })
  }
  if (options.supportsMirror) {
    fields.push({
      type: 'boolean',
      key: 'imageSettings_mirror',
      label: 'Mirror',
      labelKey: 'server:imageSettingsConfig.imageSettings_mirror.label',
      style: 'switch',
      default: status?.mirror ?? false,
    })
  }
  if (options.supportsFlip) {
    fields.push({
      type: 'boolean',
      key: 'imageSettings_flip',
      label: 'Flip',
      labelKey: 'server:imageSettingsConfig.imageSettings_flip.label',
      style: 'switch',
      default: status?.flip ?? false,
    })
  }
  if (options.rotateOptions.length > 0) {
    fields.push({
      type: 'select',
      key: 'imageSettings_rotate',
      label: 'Rotation',
      labelKey: 'server:imageSettingsConfig.imageSettings_rotate.label',
      options: options.rotateOptions.map((r) => ({ value: r, label: ROTATE_LABELS[r] })),
      default: status?.rotate ?? options.rotateOptions[0],
    })
  }
  if (options.whiteBalanceModes.length > 0) {
    fields.push({
      type: 'select',
      key: 'imageSettings_whiteBalance',
      label: 'White balance',
      labelKey: 'server:imageSettingsConfig.imageSettings_whiteBalance.label',
      options: options.whiteBalanceModes.map((m) => ({ value: m, label: WHITE_BALANCE_LABELS[m] })),
      default: status?.whiteBalance ?? options.whiteBalanceModes[0],
    })
  }
  if (options.supportsWarmth && options.warmth) {
    fields.push({
      type: 'slider',
      key: 'imageSettings_warmth',
      label: 'Warmth',
      labelKey: 'server:imageSettingsConfig.imageSettings_warmth.label',
      min: options.warmth.min,
      max: options.warmth.max,
      step: options.warmth.step,
      showValue: true,
      default: status?.warmth ?? options.warmth.min,
      // Manual white-balance warmth is only meaningful in manual mode.
      showWhen: { field: 'imageSettings_whiteBalance', equals: 'manual' },
    })
  }
  if (options.exposureModes.length > 0) {
    fields.push({
      type: 'select',
      key: 'imageSettings_exposureMode',
      label: 'Exposure mode',
      labelKey: 'server:imageSettingsConfig.imageSettings_exposureMode.label',
      options: options.exposureModes.map((m) => ({ value: m, label: EXPOSURE_LABELS[m] })),
      default: status?.exposureMode ?? options.exposureModes[0],
    })
  }
  if (options.backlightModes.length > 0) {
    fields.push({
      type: 'select',
      key: 'imageSettings_backlightMode',
      label: 'Backlight compensation',
      labelKey: 'server:imageSettingsConfig.imageSettings_backlightMode.label',
      options: options.backlightModes.map((m) => ({ value: m, label: BACKLIGHT_LABELS[m] })),
      default: status?.backlightMode ?? options.backlightModes[0],
    })
  }

  if (fields.length === 0) return null

  const section: ConfigSection = {
    id: 'image-settings',
    tab: 'image',
    title: 'Image adjustment',
    titleKey: 'server:section.s_image-settings.title',
    description:
      "Picture sliders, orientation and exposure. Option lists are read live from the camera — fields the firmware doesn't expose are hidden.",
    descriptionKey: 'server:section.s_image-settings.description',
    columns: 2,
    fields,
  }
  return { sections: [section] }
}

/**
 * Re-parse a flat `ConfigFormBuilder` patch into an `ImageSettingsPatch`.
 * Returns an empty object when no `imageSettings_*` field changed.
 */
export function parseImageSettingsFormPatch(patch: Record<string, unknown>): ImageSettingsPatch {
  const out: ImageSettingsPatch = {}

  if ('imageSettings_brightness' in patch) {
    const value = Number(patch.imageSettings_brightness)
    if (Number.isFinite(value)) out.brightness = value
  }
  if ('imageSettings_contrast' in patch) {
    const value = Number(patch.imageSettings_contrast)
    if (Number.isFinite(value)) out.contrast = value
  }
  if ('imageSettings_saturation' in patch) {
    const value = Number(patch.imageSettings_saturation)
    if (Number.isFinite(value)) out.saturation = value
  }
  if ('imageSettings_sharpness' in patch) {
    const value = Number(patch.imageSettings_sharpness)
    if (Number.isFinite(value)) out.sharpness = value
  }
  if ('imageSettings_mirror' in patch && typeof patch.imageSettings_mirror === 'boolean') {
    out.mirror = patch.imageSettings_mirror
  }
  if ('imageSettings_flip' in patch && typeof patch.imageSettings_flip === 'boolean') {
    out.flip = patch.imageSettings_flip
  }
  if ('imageSettings_rotate' in patch && isImageRotate(patch.imageSettings_rotate)) {
    out.rotate = patch.imageSettings_rotate
  }
  if (
    'imageSettings_whiteBalance' in patch &&
    isWhiteBalanceMode(patch.imageSettings_whiteBalance)
  ) {
    out.whiteBalance = patch.imageSettings_whiteBalance
  }
  if ('imageSettings_warmth' in patch) {
    const value = Number(patch.imageSettings_warmth)
    if (Number.isFinite(value)) out.warmth = value
  }
  if ('imageSettings_exposureMode' in patch && isExposureMode(patch.imageSettings_exposureMode)) {
    out.exposureMode = patch.imageSettings_exposureMode
  }
  if (
    'imageSettings_backlightMode' in patch &&
    isBacklightMode(patch.imageSettings_backlightMode)
  ) {
    out.backlightMode = patch.imageSettings_backlightMode
  }

  return out
}
