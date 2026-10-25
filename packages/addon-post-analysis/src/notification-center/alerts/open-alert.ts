/**
 * An OPEN alert episode, as the STATE SUMMARY reads it (D647).
 */
import type { NcDeviceIdentity } from '../device-directory.js'
import {
  incomingFromBatteryBand,
  incomingFromConsumableBand,
  incomingFromProviderConsumableBand,
  type NcIncomingEvent,
  type NcProviderConsumableAttention,
  type NcSystemEventFacts,
} from '../event-intake.js'
import type { NcSystemEventSubject } from '../rule-engine.js'
import { alertSubjectDeviceId, type NcAlertRow } from './alert-episode.js'
import { parseConsumableSubject } from './consumable-subject.js'
import type { ConsumableForm } from '@camstack/types'

export interface NcOpenAlert {
  readonly family: 'battery' | 'consumable'
  readonly since: number
  readonly subject: NcSystemEventSubject
  readonly measured: boolean
}

export interface NcUnmeasuredEpisodeInput {
  readonly subject: string
  readonly family: NcOpenAlert['family']
  readonly facts: NcSystemEventFacts
  readonly lookup: (deviceId: number) => NcDeviceIdentity | undefined
  readonly detail?: string
}

function unmeasuredEpisode(input: NcUnmeasuredEpisodeInput): NcIncomingEvent | null {
  const deviceId = alertSubjectDeviceId(input.subject)
  if (deviceId === undefined) return null
  const identity = input.lookup(deviceId)
  const facts = input.facts
  if (input.family === 'battery') {
    return incomingFromBatteryBand({
      facts,
      deviceId,
      band: 'low',
      reading: { percentage: 0, lastUpdated: 0, binary: true },
      identity,
    })
  }
  const parts = parseConsumableSubject(input.subject)
  if (parts !== null && parts.legacy) {
    const parsed = parseProviderVerdictDetail(input.detail)
    const attention: NcProviderConsumableAttention = parsed?.attention ?? 'low'
    const form = parsed?.form ?? 'tank'
    return incomingFromProviderConsumableBand({
      facts,
      deviceId,
      band: 'low',
      item: { key: parts.key, label: parts.key, form },
      attention,
      identity,
    })
  }
  if (parts !== null) {
    return incomingFromConsumableBand({
      facts,
      deviceId,
      band: 'low',
      item: { key: parts.key, label: parts.key, level: null, status: 'replace' },
      thresholdPercent: parts.thresholdPercent,
      identity,
    })
  }
  return null
}

const PROVIDER_DETAIL_FORMS = ['part', 'tank', 'product', 'bin'] as const

function isConsumableForm(value: string): value is ConsumableForm {
  return PROVIDER_DETAIL_FORMS.some((known) => known === value)
}

/** Durable `detail` for a provider-verdict episode: band plus form (D934). */
export function providerVerdictDetail(band: 'low' | 'full', form: ConsumableForm): string {
  return `${band}:${form}`
}

/**
 * A provider-verdict row's `detail`. Bare `low` / `full` are the rows written
 * before the form was stored: low reads as a tank, full as a bin.
 */
export interface NcProviderVerdictDetail {
  readonly attention: NcProviderConsumableAttention
  readonly form: ConsumableForm
}

export function parseProviderVerdictDetail(
  detail: string | undefined,
): NcProviderVerdictDetail | null {
  if (detail === 'low') return { attention: 'low', form: 'tank' }
  if (detail === 'full') return { attention: 'full', form: 'bin' }
  if (detail === undefined) return null
  const sep = detail.indexOf(':')
  if (sep < 1) return null
  const attention = detail.slice(0, sep)
  const form = detail.slice(sep + 1)
  if (attention !== 'low' && attention !== 'full') return null
  if (!isConsumableForm(form)) return null
  return { attention, form }
}

/** True when the row is a provider-verdict consumable, not a threshold episode. */
export function isProviderVerdictDetail(detail: string | undefined): boolean {
  return parseProviderVerdictDetail(detail) !== null
}

export interface NcOpenAlertInput {
  readonly facts: NcSystemEventFacts
  readonly restated: NcIncomingEvent | null
  readonly lookup: (deviceId: number) => NcDeviceIdentity | undefined
}

export function openAlertOf(row: NcAlertRow, input: NcOpenAlertInput): NcOpenAlert | null {
  const parts = parseConsumableSubject(row.subject)
  const family: NcOpenAlert['family'] = parts !== null ? 'consumable' : 'battery'
  const incoming =
    input.restated ??
    unmeasuredEpisode({
      subject: row.subject,
      family,
      facts: input.facts,
      lookup: input.lookup,
      ...(row.detail !== undefined ? { detail: row.detail } : {}),
    })
  const subject = incoming?.subject.systemEvent
  if (subject === undefined) return null
  const measured =
    input.restated !== null ||
    row.detail !== undefined ||
    (parts !== null && !parts.legacy && subject.textParams?.['percentage'] !== undefined)
  return { family, since: row.since, subject, measured }
}
