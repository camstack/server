/**
 * Per-Echo admission. A burst is dropped here, not queued: a queue would be
 * minutes of speech long after the event.
 */
import { SPEAK_COLLAPSE_MS, SPEAK_MIN_GAP_MS } from './constants.js'

export type SpeechAdmission = 'admit' | 'collapsed' | 'rate_limited'

export interface EchoSpeechMemory {
  readonly lastSpokenAt: number
  readonly lastText: string
}

export interface SpeechLedger {
  readonly byEcho: Readonly<Record<string, EchoSpeechMemory>>
}

export interface SpeechAdmitResult {
  readonly decision: SpeechAdmission
  readonly ledger: SpeechLedger
}

export function emptySpeechLedger(): SpeechLedger {
  return { byEcho: {} }
}

/**
 * Identical text inside the collapse window is one utterance.
 * A different text inside the gap is refused until the gap elapses.
 * Admitted calls replace that Echo's memory; refusals leave it as it was.
 */
export function admitSpeech(
  ledger: SpeechLedger,
  echoId: string,
  text: string,
  now: number,
): SpeechAdmitResult {
  const previous = ledger.byEcho[echoId]
  if (
    previous !== undefined &&
    previous.lastText === text &&
    now - previous.lastSpokenAt < SPEAK_COLLAPSE_MS
  ) {
    return { decision: 'collapsed', ledger }
  }
  if (previous !== undefined && now - previous.lastSpokenAt < SPEAK_MIN_GAP_MS) {
    return { decision: 'rate_limited', ledger }
  }
  return {
    decision: 'admit',
    ledger: {
      byEcho: {
        ...ledger.byEcho,
        [echoId]: { lastSpokenAt: now, lastText: text },
      },
    },
  }
}
