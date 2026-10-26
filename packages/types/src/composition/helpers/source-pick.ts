/**
 * The request the common source selector (#236) accepts for a helper (D944 §5).
 * The selector's layout is not specified here. Groups ask for one device type
 * and the catalog field; they do not opt into incompatible fields.
 */
import type { DeviceType } from '../../device/device-type.js'
import type { CompositionSourceRef } from '../source-ref.js'
import type { GroupTemplate } from './catalog.js'
import { MAX_HELPER_MEMBERS } from './spec.js'

export interface SourcePickAccept {
  readonly cap: string
  readonly fieldPath: string
  readonly valueKind: 'number' | 'boolean'
}

export interface SourcePickHistory {
  readonly required: boolean
  readonly minRetentionMs: number | null
}

export interface SourcePickRequest {
  readonly purpose: 'member' | 'reading' | 'historised'
  readonly multiple: boolean
  readonly max: number
  readonly deviceTypes: readonly DeviceType[]
  readonly accept: readonly SourcePickAccept[]
  readonly history: SourcePickHistory
  readonly mustBindCaps: readonly string[]
  readonly exclude: readonly CompositionSourceRef[]
}

export interface SourcePick {
  readonly source: CompositionSourceRef
  readonly deviceId: number
  readonly parentName: string | null
  readonly cap: string
  readonly fieldPath: string
  /** Current reading. `null` is unknown, never a stand-in 0. */
  readonly current: number | boolean | string | null
  readonly compatibility: 'direct' | 'convert' | 'incompatible'
  readonly history: 'recorded' | 'absent' | 'unknown'
}

/** What the member step asks the selector for this template. */
export function sourcePickForTemplate(template: GroupTemplate): SourcePickRequest {
  const valueKind: SourcePickAccept['valueKind'] =
    template.family === 'numeric' ? 'number' : 'boolean'
  return {
    purpose: 'member',
    multiple: true,
    max: MAX_HELPER_MEMBERS,
    deviceTypes: [template.memberDeviceType],
    accept: template.accept.map((field) => ({ ...field, valueKind })),
    history: { required: false, minRetentionMs: null },
    mustBindCaps: [],
    exclude: [],
  }
}
