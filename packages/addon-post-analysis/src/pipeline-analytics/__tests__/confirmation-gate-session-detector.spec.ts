/**
 * The birth gate re-judges a birth with the SESSION'S detector, at the GATE'S
 * bar (D925).
 *
 * Prod 2026-10-23, agent-b: a Coral session (`yolov9s-320-edgetpu`, model
 * floor 0.4) had its births re-judged by the node's global default
 * `yolov9t-320` (floor 0.55) on another pool — 2 459 suppressed births in the
 * fleet ledger, 9 with a score. These pin the matrix end to end through the
 * pure gate and the production re-detect wiring:
 *  - the session model on the session device, pinned to its node;
 *  - the gate's bar decides a box the detector's own floor refused;
 *  - a session device that cannot serve is NO evidence (defer, then admit) —
 *    never a re-judgement by another model.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type BirthCandidate,
  type ConfirmationDecision,
  type ConfirmationGateDeps,
  confirmBirths,
} from '../confirmation-gate.js'
import {
  CONFIRMATION_GATE_DEFAULTS,
  type ConfirmationGateSettings,
} from '../confirmation-gate-settings.js'
import type { ConfirmationRedetectResult } from '../confirmation-redetect-result.js'
import {
  redetectWithSessionDetector,
  type SessionDetector,
  type SessionRedetectRequest,
  sessionDetectorOf,
} from '../confirmation-session-detector.js'

const CROP = Buffer.from([0xff, 0xd8, 0xff])
const DEVICE_ID = 1439

const CORAL: SessionDetector = {
  stepId: 'object-detection',
  modelId: 'yolov9s-320-edgetpu',
  deviceKey: 'edgetpu:usb',
  nodeId: 'agent-b',
}

const settings: ConfirmationGateSettings = {
  ...CONFIRMATION_GATE_DEFAULTS,
  enabled: true,
  minConfidence: 0.4,
}

const person = (trackId = 't1'): BirthCandidate => ({
  trackId,
  className: 'person',
  bbox: { x: 10, y: 10, w: 200, h: 200 },
})

/** What a pinned executor answers: the stamps say what really ran. */
function ran(
  over: Partial<ConfirmationRedetectResult>,
  detector: SessionDetector = CORAL,
): ConfirmationRedetectResult {
  return {
    width: 320,
    height: 320,
    detections: [],
    rootModelId: detector.modelId,
    rootDeviceKey: detector.deviceKey,
    ...over,
  }
}

interface Judged {
  readonly decision: ConfirmationDecision
  readonly confirmed: boolean
  readonly undecided: boolean
  readonly requests: readonly { request: SessionRedetectRequest; nodeId: string }[]
}

async function judge(
  detector: SessionDetector | null,
  respond: (request: SessionRedetectRequest) => Promise<ConfirmationRedetectResult | null>,
  exhausted: ReadonlySet<string> = new Set(),
  over: Partial<ConfirmationGateDeps> = {},
): Promise<Judged> {
  const requests: { request: SessionRedetectRequest; nodeId: string }[] = []
  const decisions: ConfirmationDecision[] = []
  const outcome = await confirmBirths(
    [person()],
    settings,
    {
      fetchCrop: vi.fn(async () => CROP),
      redetect: async (crop) =>
        (
          await redetectWithSessionDetector(detector, crop, DEVICE_ID, async (request, nodeId) => {
            requests.push({ request, nodeId })
            return respond(request)
          })
        ).answer,
      onDecision: (d) => decisions.push(d),
      ...over,
    },
    exhausted,
  )
  return {
    decision: decisions[0]!,
    confirmed: outcome.confirmed.has('t1'),
    undecided: outcome.undecided.has('t1'),
    requests,
  }
}

describe('the session detector re-judges the birth (D925)', () => {
  it('a Coral session birth is re-judged by the Coral model on the Coral pool, on its node', async () => {
    const { requests } = await judge(CORAL, async () => ran({}))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.nodeId).toBe('agent-b')
    expect(requests[0]!.request).toMatchObject({
      steps: [{ addonId: 'object-detection', modelId: 'yolov9s-320-edgetpu', enabled: true }],
      deviceKey: 'edgetpu:usb',
      deviceId: DEVICE_ID,
      plane: 'frame',
    })
  })

  it('passes at 0.45 against the 0.4 bar even though the person floor (0.65) refused the box', async () => {
    const { decision, confirmed } = await judge(CORAL, async () =>
      ran({ discarded: [{ macroClass: 'person', score: 0.45, reason: 'below-threshold' }] }),
    )
    expect(confirmed).toBe(true)
    expect(decision.reason).toBe('confirmed')
    expect(decision.bestScore).toBe(0.45)
    expect(decision.appliedMinConfidence).toBe(0.4)
  })

  it('the bar decides, not the model floor: 0.38 under a 0.4 bar is suppressed with its score', async () => {
    const { decision, confirmed } = await judge(CORAL, async () =>
      ran({ discarded: [{ macroClass: 'person', score: 0.38, reason: 'below-threshold' }] }),
    )
    expect(confirmed).toBe(false)
    expect(decision.verdict).toBe('suppressed')
    expect(decision.reason).toBe('below-detector-floor')
    expect(decision.bestScore).toBe(0.38)
  })
})

describe('a session device that cannot serve is no evidence — never another model (D925)', () => {
  it('a device in backoff defers the birth, and asks nobody else', async () => {
    const { decision, undecided, requests } = await judge(CORAL, async () => {
      throw new Error(
        'inference device "edgetpu:usb" is backoff after 2 pool death(s): worker exited',
      )
    })
    expect(decision.verdict).toBe('undecided')
    expect(decision.reason).toBe('session-device-unavailable')
    expect(undecided).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('an executor that ran another pool (capability fallback) is not a measurement', async () => {
    const { decision, undecided } = await judge(CORAL, async () =>
      ran({
        rootDeviceKey: 'openvino:cpu',
        detections: [{ macroClass: 'person', score: 0.9 }],
      }),
    )
    expect(decision.reason).toBe('session-device-unavailable')
    expect(undecided).toBe(true)
  })

  it('an executor that substituted the model is not a measurement', async () => {
    const { decision } = await judge(CORAL, async () =>
      ran({ rootModelId: 'yolov9t-320', detections: [{ macroClass: 'person', score: 0.9 }] }),
    )
    expect(decision.reason).toBe('session-device-unavailable')
  })

  it('a frame that names no session detector asks no detector at all', async () => {
    const { decision, requests } = await judge(null, async () => ran({}))
    expect(decision.reason).toBe('session-device-unavailable')
    expect(requests).toHaveLength(0)
  })

  it('a carried crop on an unavailable device does not go on to fetch a native crop', async () => {
    const fetchCrop = vi.fn(async () => CROP)
    const decisions: ConfirmationDecision[] = []
    await confirmBirths([{ ...person(), evidenceCrop: CROP }], settings, {
      fetchCrop,
      redetect: async (crop) =>
        (await redetectWithSessionDetector(null, crop, DEVICE_ID, async () => ran({}))).answer,
      onDecision: (d) => decisions.push(d),
    })
    expect(decisions[0]!.reason).toBe('session-device-unavailable')
    expect(fetchCrop).not.toHaveBeenCalled()
  })

  it('an exhausted birth whose session device never came back is admitted', async () => {
    const { confirmed, undecided } = await judge(
      CORAL,
      async () => {
        throw new Error('inference device "edgetpu:usb" is failed after 5 pool death(s): gone')
      },
      new Set(['t1']),
    )
    expect(confirmed).toBe(true)
    expect(undecided).toBe(false)
  })

  it('an ordinary inference error stays `redetect-error`', async () => {
    const { decision } = await judge(CORAL, async () => {
      throw new Error('socket hang up')
    })
    expect(decision.reason).toBe('redetect-error')
  })
})

describe('sessionDetectorOf', () => {
  it('reads the session detector off the frame the birth rode', () => {
    expect(
      sessionDetectorOf(
        {
          rootStepId: 'object-detection',
          rootModelId: 'yolov9s-320-edgetpu',
          rootDeviceKey: 'edgetpu:usb',
        },
        'agent-b',
      ),
    ).toEqual(CORAL)
  })

  it('is null when any part is missing — an onboard frame names no detector', () => {
    expect(sessionDetectorOf({ rootModelId: 'yolov9s-320-edgetpu' }, 'agent-b')).toBeNull()
    expect(sessionDetectorOf({}, 'agent-b')).toBeNull()
  })
})
