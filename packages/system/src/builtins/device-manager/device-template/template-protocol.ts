/**
 * Messages between the renderer and its worker thread. Pure types and guards:
 * the worker loads this file, so it imports nothing from the types barrel.
 */
import type { DeviceTemplateRefusalReason } from '@camstack/types'

/** Fixed at spawn: the worker cannot read the types barrel, so the limits travel with it. */
export interface TemplateWorkerData {
  readonly allowedFilters: readonly string[]
  readonly maxSourceLength: number
  readonly maxOutput: number
  readonly unavailable: string
}

export interface RenderRequest {
  readonly id: number
  readonly source: string
  /** Plain JSON-like data, keyed by alias; the worker freezes it into null-prototype objects. */
  readonly context: Readonly<Record<string, unknown>>
  readonly nowMs: number
}

export type RenderResponse =
  | { readonly id: number; readonly ok: true; readonly text: string }
  | {
      readonly id: number
      readonly ok: false
      readonly reason: DeviceTemplateRefusalReason
      readonly message: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isRenderResponse(value: unknown): value is RenderResponse {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'number') return false
  if (value['ok'] === true) return typeof value['text'] === 'string'
  return (
    value['ok'] === false &&
    typeof value['reason'] === 'string' &&
    typeof value['message'] === 'string'
  )
}

export function isRenderRequest(value: unknown): value is RenderRequest {
  return (
    isRecord(value) &&
    typeof value['id'] === 'number' &&
    typeof value['source'] === 'string' &&
    isRecord(value['context']) &&
    typeof value['nowMs'] === 'number'
  )
}
