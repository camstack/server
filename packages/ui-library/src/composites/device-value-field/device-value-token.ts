/**
 * The template token a device value is written as: `{{dev:<stableId>/<cap>.<fieldPath>}}`.
 * The token chip adapter of the device → value picker writes it; reading it back is
 * what the chip needs to show its label. Rendering a template is not here.
 */
export interface DeviceValueRef {
  readonly stableId: string
  readonly cap: string
  readonly fieldPath: string
}

const TOKEN_PATTERN = /^\{\{dev:([^/}]+)\/([^.}]+)\.([^}]+)\}\}$/

export function formatDeviceValueToken(ref: DeviceValueRef): string {
  return `{{dev:${ref.stableId}/${ref.cap}.${ref.fieldPath}}}`
}

/** null = not a device token (never a guess at a near miss). */
export function parseDeviceValueToken(text: string): DeviceValueRef | null {
  const match = TOKEN_PATTERN.exec(text.trim())
  if (match === null) return null
  const [, stableId, cap, fieldPath] = match
  if (stableId === undefined || cap === undefined || fieldPath === undefined) return null
  return { stableId, cap, fieldPath }
}
