/**
 * A live value next to an assigned device (spec U12) — four ANSWERED states
 * (D315). The first answer is a `deviceState.getCapSlice` read (answered or
 * failed); every later change is the pushed slice, which wins once it carries
 * anything.
 */
import { SOURCE_CAP_ACTIVE_FIELD } from '@camstack/types'
import type { QueryErrorLike } from '../known'
import { readPath } from '../source-picker-model'
import i18n from '../../../../i18n/index'

export interface LiveValueTarget {
  readonly deviceId: number
  readonly cap: string
  /** Dotted path inside the cap slice. */
  readonly path: string
}

export type LiveValue =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'value'; readonly value: unknown }

export interface LiveSliceQuery {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: Readonly<Record<string, unknown>> | null
  readonly error?: QueryErrorLike | null
}

function isSlice(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldOf(slice: Readonly<Record<string, unknown>>, path: string): LiveValue {
  const value = readPath(slice, path)
  return value === undefined ? { kind: 'absent' } : { kind: 'value', value }
}

export function liveValueOf(query: LiveSliceQuery, pushed: unknown, path: string): LiveValue {
  if (isSlice(pushed)) return fieldOf(pushed, path)
  if (query.status === 'error') {
    return {
      kind: 'unknown',
      reason: query.error?.message ?? i18n.t('helpers.liveValue.unreadable'),
    }
  }
  if (query.status === 'pending' || query.data === undefined) return { kind: 'pending' }
  if (query.data === null) return { kind: 'absent' }
  return fieldOf(query.data, path)
}

export interface LiveValueLabels {
  readonly active: string
  readonly inactive: string
  readonly open: string
  readonly closed: string
}

export type LiveValueTone = 'muted' | 'active' | 'normal' | 'warning'

export interface LiveValueDisplay {
  readonly text: string
  readonly tone: LiveValueTone
  readonly title?: string
}

function booleanDisplay(
  value: boolean,
  target: LiveValueTarget,
  labels: LiveValueLabels,
): LiveValueDisplay {
  const tone = value ? 'active' : 'muted'
  if (target.cap === 'contact' && target.path === 'entryOpen') {
    return { text: value ? labels.open : labels.closed, tone }
  }
  if (SOURCE_CAP_ACTIVE_FIELD[target.cap] === target.path) {
    return { text: value ? labels.active : labels.inactive, tone }
  }
  return { text: String(value), tone: 'normal' }
}

export function liveValueDisplay(
  value: LiveValue,
  target: LiveValueTarget,
  labels: LiveValueLabels,
): LiveValueDisplay {
  switch (value.kind) {
    case 'pending':
      return { text: '…', tone: 'muted' }
    case 'unknown':
      return { text: '?', title: value.reason, tone: 'warning' }
    case 'absent':
      return { text: '—', tone: 'muted' }
    case 'value': {
      const raw = value.value
      if (raw === null) return { text: '—', tone: 'muted' }
      if (typeof raw === 'boolean') return booleanDisplay(raw, target, labels)
      if (typeof raw === 'number') {
        return {
          text: target.path === 'percentage' ? `${Math.round(raw)} %` : String(raw),
          tone: 'normal',
        }
      }
      if (typeof raw === 'string') return { text: raw, tone: 'normal' }
      return { text: JSON.stringify(raw), tone: 'normal' }
    }
  }
}
