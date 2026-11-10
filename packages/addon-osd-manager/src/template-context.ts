/**
 * What a slot's template needs from the hub renderer (D1021/D1025), and how a
 * render is read. The renderer is the hub's; this module only shapes the call
 * and judges the answer.
 */
import type { DeviceTemplateRender, DeviceTemplateThisDevice } from '@camstack/types'

/** The `camera.<name>` values the manager supplies besides the camera's own state. */
export const RECOGNITION_VALUE_NAMES = ['lastPerson', 'lastPlate'] as const

export interface OsdTemplateRenderInput {
  readonly templates: readonly string[]
  readonly thisDevice: DeviceTemplateThisDevice
}

/** The part of `checkDeviceTemplates` the manager reads: who a text depends on. */
export type OsdTemplateCheck =
  | {
      readonly ok: true
      readonly readsClock: boolean
      readonly aliases: readonly { readonly alias: string; readonly deviceId: number | null }[]
    }
  | { readonly ok: false }

/** One template, judged: the text to write, or why there is none. */
export type TemplateOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

/**
 * A refused render, and a render that printed an unavailable marker, both leave
 * the camera as it is: neither is text an operator wrote.
 */
export function outcomeOfRender(render: DeviceTemplateRender): TemplateOutcome {
  if (!render.ok) {
    return {
      ok: false,
      reason: `render refused (${render.refusal.reason}): ${render.refusal.message}`,
    }
  }
  const unavailable = render.trace[0]
  if (unavailable !== undefined) {
    return { ok: false, reason: `"${unavailable.ref}" is unavailable (${unavailable.reason})` }
  }
  return { ok: true, text: render.text }
}

export function mentionsRecognition(text: string): boolean {
  return RECOGNITION_VALUE_NAMES.some((name) => text.includes(name))
}
