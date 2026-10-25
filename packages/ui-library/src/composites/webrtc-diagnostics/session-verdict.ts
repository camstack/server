/**
 * Per-layer verdict for one hub session run.
 *
 * The layers are checked in the order media actually climbs them, and the
 * first one that did not hold is the verdict:
 *   ICE (a candidate pair) → DTLS (the keys) → RTP (bytes arrive) → decode.
 * A layer whose deciding number was not measured makes the verdict `unknown`
 * — a guessed verdict is the thing an operator trusts and stops measuring.
 */
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'
import type { HubReachabilityFlag } from './ice-candidates'

export type SessionVerdictLayer =
  | 'transport'
  | 'hub-dtls'
  | 'media-black-hole'
  | 'hub-not-sending'
  | 'loss-keyframe'
  | 'healthy'
  | 'unknown'

export interface SessionVerdict {
  readonly layer: SessionVerdictLayer
  readonly title: string
  readonly detail: string
}

export type DiagnosticIcePolicy = 'all' | 'relay'

export interface VerdictInput {
  readonly policy: DiagnosticIcePolicy
  readonly durationMs: number
  readonly iceConnected: boolean
  readonly iceFinalState: string | null
  readonly dtlsConnected: boolean
  readonly dtlsFinalState: string | null
  readonly hubFlag: HubReachabilityFlag
  readonly clientPacketsReceived: number | null
  readonly framesDecoded: number | null
  readonly serverPacketsSent: number | null
  readonly pliCount: number | null
  readonly freezeCount: number | null
  readonly lossPercent: number | null
}

/** PLIs the browser may send in one run before it counts as a storm: one at
 *  start-up plus one recovery is normal; three means keyframes keep breaking. */
export const PLI_STORM_COUNT = 3
/** Packet loss over the run above which a freeze is attributed to loss. */
export const LOSS_PERCENT_HIGH = 2

function transportDetail(input: VerdictInput, t: UiTextFn): string {
  const state = input.iceFinalState ?? t('uiLibrary.sessionVerdict.state.unknown', 'unknown')
  const vars = { state }
  if (input.hubFlag === 'unknown') {
    return t(
      'uiLibrary.sessionVerdict.transport.noAnswer',
      'ICE {{state}}; the hub never answered the offer, so no hub candidate was seen',
      vars,
    )
  }
  if (input.hubFlag === 'none') {
    return t(
      'uiLibrary.sessionVerdict.transport.noCandidate',
      'ICE {{state}}; the hub answered but offered no candidate',
      vars,
    )
  }
  if (input.policy === 'relay' && input.hubFlag === 'private-only') {
    return t(
      'uiLibrary.sessionVerdict.transport.relayPrivateOnly',
      'ICE {{state}}; this browser was limited to TURN relay candidates and the hub offered only LAN/Tailscale addresses (no srflx/relay) — a relayed client cannot reach it',
      vars,
    )
  }
  if (input.hubFlag === 'private-only') {
    return t(
      'uiLibrary.sessionVerdict.transport.privateOnly',
      'ICE {{state}}; the hub offered only LAN/Tailscale addresses (no srflx/relay) — reachable only from inside those networks',
      vars,
    )
  }
  return t(
    'uiLibrary.sessionVerdict.transport.noPair',
    'ICE {{state}}; no candidate pair between this browser and the hub succeeded',
    vars,
  )
}

function verdict(layer: SessionVerdictLayer, title: string, detail: string): SessionVerdict {
  return { layer, title, detail }
}

function signalValue(value: number | null, t: UiTextFn): string {
  return value === null ? t('uiLibrary.sessionVerdict.state.unknown', 'unknown') : String(value)
}

function mediaVerdict(input: VerdictInput, t: UiTextFn): SessionVerdict {
  const client = input.clientPacketsReceived
  const sent = input.serverPacketsSent
  if (client === null) {
    return verdict(
      'unknown',
      t('uiLibrary.sessionVerdict.mediaUnknown.title', 'Media unknown'),
      t(
        'uiLibrary.sessionVerdict.mediaUnknown.detail',
        'the browser reported no inbound video statistics',
      ),
    )
  }
  if (client === 0) {
    if (sent === null) {
      return verdict(
        'unknown',
        t('uiLibrary.sessionVerdict.nothingReceived.title', 'Nothing received'),
        t(
          'uiLibrary.sessionVerdict.nothingReceived.detail',
          "the browser received no packets and the hub's own count is unknown",
        ),
      )
    }
    if (sent > 0) {
      return verdict(
        'media-black-hole',
        t('uiLibrary.sessionVerdict.blackHole.title', 'Media black-hole'),
        t(
          'uiLibrary.sessionVerdict.blackHole.detail',
          'the hub sent {{sent}} RTP packets and this browser received none — media is lost between them after DTLS',
          { sent: String(sent) },
        ),
      )
    }
    return verdict(
      'hub-not-sending',
      t('uiLibrary.sessionVerdict.hubNotSending.title', 'Hub not sending'),
      t(
        'uiLibrary.sessionVerdict.hubNotSending.detail',
        'the session is connected but the hub sent no RTP — the source or the broker is not producing',
      ),
    )
  }
  if (input.framesDecoded === null) {
    return verdict(
      'unknown',
      t('uiLibrary.sessionVerdict.decodeUnknown.title', 'Decode unknown'),
      t(
        'uiLibrary.sessionVerdict.decodeUnknown.detail',
        'packets arrive; the browser reported no decode count',
      ),
    )
  }
  const lossKeyframeTitle = t('uiLibrary.sessionVerdict.lossKeyframe.title', 'Loss / keyframe size')
  if (input.framesDecoded === 0) {
    return verdict(
      'loss-keyframe',
      lossKeyframeTitle,
      t(
        'uiLibrary.sessionVerdict.lossKeyframe.noFrame',
        'packets arrive but no frame decoded — a keyframe never completes over this path',
      ),
    )
  }
  const { pliCount: pli, freezeCount: freezes, lossPercent: loss } = input
  const storm =
    (pli !== null && pli >= PLI_STORM_COUNT) ||
    (freezes !== null && freezes > 0) ||
    (loss !== null && loss >= LOSS_PERCENT_HIGH)
  const signals = t(
    'uiLibrary.sessionVerdict.signals',
    '{{pli}} PLI, {{freezes}} freezes, {{loss}} loss',
    {
      pli: signalValue(pli, t),
      freezes: signalValue(freezes, t),
      loss: loss === null ? signalValue(null, t) : `${loss.toFixed(1)}%`,
    },
  )
  if (storm) {
    return verdict(
      'loss-keyframe',
      lossKeyframeTitle,
      t(
        'uiLibrary.sessionVerdict.lossKeyframe.lossy',
        'frames decode but the path is lossy: {{signals}}',
        {
          signals,
        },
      ),
    )
  }
  if (pli === null && freezes === null && loss === null) {
    return verdict(
      'healthy',
      t('uiLibrary.sessionVerdict.decoding.title', 'Decoding'),
      t(
        'uiLibrary.sessionVerdict.decoding.detail',
        'frames decode; the browser reported no loss signal to judge',
      ),
    )
  }
  return verdict(
    'healthy',
    t('uiLibrary.sessionVerdict.healthy.title', 'Healthy'),
    t('uiLibrary.sessionVerdict.healthy.detail', 'connected, receiving and decoding: {{signals}}', {
      signals,
    }),
  )
}

export function classifySessionVerdict(
  input: VerdictInput,
  t: UiTextFn = defaultUiText,
): SessionVerdict {
  if (!input.iceConnected) {
    return verdict(
      'transport',
      t('uiLibrary.sessionVerdict.transport.title', 'Transport (ICE) failed'),
      transportDetail(input, t),
    )
  }
  if (!input.dtlsConnected && input.dtlsFinalState !== null) {
    return verdict(
      'hub-dtls',
      t('uiLibrary.sessionVerdict.dtls.title', 'DTLS stuck (hub side)'),
      t(
        'uiLibrary.sessionVerdict.dtls.detail',
        'ICE connected but DTLS stayed {{state}} — the hub never completed the handshake',
        { state: input.dtlsFinalState },
      ),
    )
  }
  return mediaVerdict(input, t)
}
