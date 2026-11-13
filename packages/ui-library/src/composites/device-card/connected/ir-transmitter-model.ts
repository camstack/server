/**
 * Pure mapping from an IR transmitter's info, its runtime slice and the
 * in-progress learn onto the scene. A fact that was not read is "—"; "Never"
 * is only for a slice that answered with nothing.
 */
import type {
  IrLearnResult,
  IrMedium,
  IrTransmitterRuntimeState,
  IrTransmitterSendRecord,
} from '@camstack/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import type { CardReading } from '../parts/Readings'
import type { CardTone } from '../shell/model'
import { sinceText } from './since-text'

/** Shown when a query or a slice has not answered. Never the word "never". */
export const IR_UNKNOWN = '—'

export interface IrInfoReady {
  readonly media: readonly IrMedium[]
  readonly learn: boolean
}

/** The slice, once it has been read. Null records mean the action has not happened. */
export type IrSliceReady = Pick<IrTransmitterRuntimeState, 'lastSend' | 'lastLearn'>

export interface IrLearnProbe {
  readonly pending: boolean
  readonly result: IrLearnResult | null
  readonly errorCode: string | null
}

export interface IrTransmitterSceneInput {
  readonly info: IrInfoReady | null
  readonly slice: IrSliceReady | null
  readonly probe: IrLearnProbe
  readonly readOnly: boolean
  readonly now: number
  readonly t: UiTextFn
}

export interface IrTransmitterScene {
  readonly headline: string
  readonly since: string | null
  readonly tone: CardTone
  readonly readings: readonly CardReading[]
  readonly learned: string | null
  readonly learnLabel: string
  readonly learnEnabled: boolean
}

export const IR_PROBE_IDLE: IrLearnProbe = { pending: false, result: null, errorCode: null }

/** The typed code on a provider error or on a tRPC error that carried `data.i18n`. */
export function irClientErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const direct = Reflect.get(err, 'i18nCode')
  if (typeof direct === 'string' && direct.length > 0) return direct
  const data = Reflect.get(err, 'data')
  if (typeof data !== 'object' || data === null) return null
  const i18n = Reflect.get(data, 'i18n')
  if (typeof i18n !== 'object' || i18n === null) return null
  const code = Reflect.get(i18n, 'code')
  return typeof code === 'string' && code.length > 0 ? code : null
}

/** What the scene draws from one read of info, state and the learn probe. */
export function irTransmitterScene(input: IrTransmitterSceneInput): IrTransmitterScene {
  const { info, slice, probe, t, now } = input
  const headline = info === null ? IR_UNKNOWN : mediaLine(info.media, t)
  const lastSend = slice?.lastSend ?? null
  return {
    headline,
    since: slice === null || lastSend === null ? null : (sinceText(lastSend.at, now, t) ?? null),
    tone: toneOf(slice),
    readings: [
      {
        id: 'canLearn',
        label: t('uiLibrary.deviceCard.ir.canLearn', 'Can learn'),
        value: info === null ? IR_UNKNOWN : yesNo(info.learn, t),
      },
      {
        id: 'lastSend',
        label: t('uiLibrary.deviceCard.ir.lastSend', 'Last send'),
        value: attemptLine(slice, 'send', t, now),
      },
      {
        id: 'lastLearn',
        label: t('uiLibrary.deviceCard.ir.lastLearn', 'Last learn'),
        value: attemptLine(slice, 'learn', t, now),
      },
    ],
    learned: learnedLine(probe, t),
    learnLabel: t('uiLibrary.deviceCard.ir.learn', 'Learn a code'),
    learnEnabled: info !== null && info.learn && !probe.pending && !input.readOnly,
  }
}

function mediaLine(media: readonly IrMedium[], t: UiTextFn): string {
  if (media.length === 0) return IR_UNKNOWN
  return media.map((medium) => mediumLabel(medium, t)).join(', ')
}

function mediumLabel(medium: IrMedium, t: UiTextFn): string {
  return medium === 'ir'
    ? t('uiLibrary.deviceCard.ir.mediumIr', 'IR')
    : t('uiLibrary.deviceCard.ir.mediumRf', 'RF')
}

function yesNo(value: boolean, t: UiTextFn): string {
  return value ? t('uiLibrary.deviceCard.ir.yes', 'Yes') : t('uiLibrary.deviceCard.ir.no', 'No')
}

function toneOf(slice: IrSliceReady | null): CardTone {
  const send = slice?.lastSend
  if (send === undefined || send === null) return 'muted'
  return send.ok ? 'success' : 'danger'
}

function attemptLine(
  slice: IrSliceReady | null,
  kind: 'send' | 'learn',
  t: UiTextFn,
  now: number,
): string {
  if (slice === null) return IR_UNKNOWN
  if (kind === 'send') return sendLine(slice.lastSend, t, now)
  return learnLine(slice.lastLearn, t, now)
}

function sendLine(attempt: IrTransmitterSendRecord | null, t: UiTextFn, now: number): string {
  if (attempt === null) return t('uiLibrary.deviceCard.ir.never', 'Never')
  const when = sinceText(attempt.at, now, t) ?? IR_UNKNOWN
  const outcome = attempt.ok
    ? t('uiLibrary.deviceCard.ir.sent', 'Sent')
    : irRefusalLabel(attempt.error, t)
  return `${when} · ${outcome} · ${mediumLabel(attempt.medium, t)}`
}

function learnLine(
  attempt: IrTransmitterRuntimeState['lastLearn'],
  t: UiTextFn,
  now: number,
): string {
  if (attempt === null) return t('uiLibrary.deviceCard.ir.never', 'Never')
  const when = sinceText(attempt.at, now, t) ?? IR_UNKNOWN
  const outcome = attempt.ok
    ? t('uiLibrary.deviceCard.ir.learned', 'Learned')
    : irRefusalLabel(attempt.error, t)
  return `${when} · ${outcome}`
}

function learnedLine(probe: IrLearnProbe, t: UiTextFn): string | null {
  if (probe.pending) return t('uiLibrary.deviceCard.ir.listening', 'Listening…')
  if (probe.result !== null) return learnedSummary(probe.result, t)
  if (probe.errorCode !== null) return irRefusalLabel(probe.errorCode, t)
  return null
}

function learnedSummary(result: IrLearnResult, t: UiTextFn): string {
  if (result.native !== null) {
    return t('uiLibrary.deviceCard.ir.nativeCode', '{{format}}: {{code}}', {
      format: result.native.format,
      code: result.native.code,
    })
  }
  const count = result.timings.length
  if (result.carrierHz === null) {
    return t('uiLibrary.deviceCard.ir.pulses', '{{count}} pulses', { count })
  }
  return t('uiLibrary.deviceCard.ir.pulsesAt', '{{count}} pulses · {{hz}} Hz', {
    count,
    hz: result.carrierHz,
  })
}

/** A typed refusal, in the operator's language. An unknown code stays visible. */
export function irRefusalLabel(code: string | null, t: UiTextFn): string {
  switch (code) {
    case null:
      return t('uiLibrary.deviceCard.ir.failed', 'Failed')
    case 'ir-transmitter.learn-unsupported':
      return t('uiLibrary.deviceCard.ir.learnUnsupported', 'This transmitter cannot learn a code')
    case 'ir-transmitter.learn-timeout':
      return t('uiLibrary.deviceCard.ir.learnTimeout', 'Nothing was learned in time')
    case 'ir-transmitter.learn-undecodable':
      return t('uiLibrary.deviceCard.ir.learnUndecodable', 'The learned code could not be read')
    case 'ir-transmitter.learn-busy':
      return t('uiLibrary.deviceCard.ir.learnBusy', 'This transmitter is already learning a code')
    case 'ir-transmitter.too-long':
      return t('uiLibrary.deviceCard.ir.tooLong', 'The command has too many pulses')
    case 'ir-transmitter.offline':
      return t('uiLibrary.deviceCard.ir.offline', 'The transmitter is not reachable')
    case 'ir-transmitter.native-unsupported':
      return t(
        'uiLibrary.deviceCard.ir.nativeUnsupported',
        'This transmitter cannot send this kind of code',
      )
    case 'ir-transmitter.no-code':
      return t('uiLibrary.deviceCard.ir.noCode', 'Nothing to send')
    default:
      return t('uiLibrary.deviceCard.ir.failedCode', 'Failed ({{code}})', { code })
  }
}
