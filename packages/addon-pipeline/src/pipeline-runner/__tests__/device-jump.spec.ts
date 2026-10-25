/**
 * Step-tree device jump (phase 1) — pure resolution core. Full decision-table
 * spec: no-jump when the current device runs it, weighted auto choice, manual
 * override wins, maxSessions gating, and the no-candidate WARN signal.
 */
import { describe, it, expect } from 'vitest'
import type {
  ModelFormat,
  PipelineStepInputOutput,
  RunnerInferenceDevice,
  StepDefinition,
} from '@camstack/types'
import {
  buildSubtreeCanRun,
  placeDetailStep,
  resolveStepDevice,
  type JumpCandidateDevice,
  type JumpSubtreeStep,
  type ResolveStepDeviceInput,
} from '../device-jump.js'
import { getStepDefinition } from '../../detection-pipeline/registry/step-definitions.js'

// deviceKey → format mirrors DEVICE_BACKEND_TO_FORMAT: edgetpu→tflite,
// openvino→openvino, coreml→coreml, cpu→onnx.
const EDGETPU = 'edgetpu:usb'
const NPU = 'openvino:npu'
const GPU = 'openvino:gpu'
const ANE = 'coreml:ane'

function dev(overrides: Partial<JumpCandidateDevice> & { deviceKey: string }): JumpCandidateDevice {
  return { weight: 1, maxSessions: null, attachedCameras: 0, ...overrides }
}

/** canRun predicate: the step's model builds for every listed format. */
function runsOn(...formats: ModelFormat[]): ResolveStepDeviceInput['canRun'] {
  return (f) => formats.includes(f)
}

describe('resolveStepDevice', () => {
  it('does NOT jump when the effective device can run the step', () => {
    const result = resolveStepDevice({
      effectiveDeviceKey: NPU,
      devices: [dev({ deviceKey: NPU }), dev({ deviceKey: EDGETPU })],
      canRun: runsOn('openvino', 'coreml'),
    })
    expect(result).toEqual({ kind: 'no-jump', deviceKey: NPU })
  })

  it('auto-jumps to the only runnable device when the effective format cannot run it', () => {
    // edgetpu root (tflite) with a face step that has no tflite build → jump to NPU.
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [dev({ deviceKey: EDGETPU }), dev({ deviceKey: NPU })],
      canRun: runsOn('openvino', 'coreml', 'onnx'),
    })
    expect(result).toEqual({ kind: 'jumped', deviceKey: NPU, reason: 'auto' })
  })

  it('auto-jump picks the weighted-least-loaded runnable device', () => {
    // NPU: load 4 / weight 1 = 4.0 ; GPU: load 6 / weight 3 = 2.0 → GPU wins.
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [
        dev({ deviceKey: EDGETPU }),
        dev({ deviceKey: NPU, weight: 1, attachedCameras: 4 }),
        dev({ deviceKey: GPU, weight: 3, attachedCameras: 6 }),
      ],
      canRun: runsOn('openvino'),
    })
    expect(result).toEqual({ kind: 'jumped', deviceKey: GPU, reason: 'auto' })
  })

  it('breaks equal-load ties deterministically by deviceKey', () => {
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [
        dev({ deviceKey: EDGETPU }),
        dev({ deviceKey: GPU, attachedCameras: 0 }),
        dev({ deviceKey: NPU, attachedCameras: 0 }),
      ],
      canRun: runsOn('openvino'),
    })
    // 'openvino:gpu' < 'openvino:npu' lexically → gpu.
    expect(result).toEqual({ kind: 'jumped', deviceKey: GPU, reason: 'auto' })
  })

  it('skips a runnable device that is at its maxSessions cap', () => {
    // NPU at cap (2/2) is excluded; ANE is the only remaining runnable.
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [
        dev({ deviceKey: EDGETPU }),
        dev({ deviceKey: NPU, maxSessions: 2, attachedCameras: 2 }),
        dev({ deviceKey: ANE, attachedCameras: 5 }),
      ],
      canRun: runsOn('openvino', 'coreml'),
    })
    expect(result).toEqual({ kind: 'jumped', deviceKey: ANE, reason: 'auto' })
  })

  it('manual override wins even when it is not the least-loaded runnable device', () => {
    // Auto would pick NPU (load 0); operator pinned ANE (load 9) → ANE.
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      manualJumpDeviceKey: ANE,
      devices: [
        dev({ deviceKey: EDGETPU }),
        dev({ deviceKey: NPU, attachedCameras: 0 }),
        dev({ deviceKey: ANE, attachedCameras: 9 }),
      ],
      canRun: runsOn('openvino', 'coreml'),
    })
    expect(result).toEqual({
      kind: 'jumped',
      deviceKey: ANE,
      reason: 'manual',
    })
  })

  it('manual override wins even when the effective device could also run the step', () => {
    const result = resolveStepDevice({
      effectiveDeviceKey: NPU,
      manualJumpDeviceKey: ANE,
      devices: [dev({ deviceKey: NPU }), dev({ deviceKey: ANE })],
      canRun: runsOn('openvino', 'coreml'),
    })
    expect(result).toEqual({
      kind: 'jumped',
      deviceKey: ANE,
      reason: 'manual',
    })
  })

  it('ignores a manual override that names an absent device and falls back to auto', () => {
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      manualJumpDeviceKey: 'openvino:missing',
      devices: [dev({ deviceKey: EDGETPU }), dev({ deviceKey: NPU })],
      canRun: runsOn('openvino'),
    })
    expect(result).toEqual({ kind: 'jumped', deviceKey: NPU, reason: 'auto' })
  })

  it('ignores a manual override whose device cannot run the step and falls back to auto', () => {
    // Operator pinned ANE but the step has no coreml build → ignore, auto to NPU.
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      manualJumpDeviceKey: ANE,
      devices: [dev({ deviceKey: EDGETPU }), dev({ deviceKey: NPU }), dev({ deviceKey: ANE })],
      canRun: runsOn('openvino'),
    })
    expect(result).toEqual({ kind: 'jumped', deviceKey: NPU, reason: 'auto' })
  })

  it('reports no-candidate (WARN signal) when NO device on the node can run the step', () => {
    // edgetpu root + a step with only openvino/coreml builds, and no other
    // enabled device can run it either (single-device node).
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [dev({ deviceKey: EDGETPU })],
      canRun: runsOn('openvino', 'coreml'),
    })
    expect(result).toEqual({ kind: 'no-candidate', deviceKey: EDGETPU })
  })

  it('reports no-candidate when other devices exist but none has a build either', () => {
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [dev({ deviceKey: EDGETPU }), dev({ deviceKey: 'cpu' })],
      // step only builds for openvino → neither tflite nor onnx can run it.
      canRun: runsOn('openvino'),
    })
    expect(result).toEqual({ kind: 'no-candidate', deviceKey: EDGETPU })
  })
})

// ---------------------------------------------------------------------------
// buildSubtreeCanRun — the enrichment step AND its enabled children ride the
// SAME runPipeline call (one pool, one format), so the jump predicate must
// cover the whole subtree. Uses the REAL catalog (the runner imports it the
// same way): face-embedding ships no tflite build, and face-detection's only
// tflite build is the LEGACY Coral face stub, which does not count (D657).
// ---------------------------------------------------------------------------

function realStepDef(addonId: string): StepDefinition | null {
  try {
    return getStepDefinition(addonId)
  } catch {
    return null
  }
}

/**
 * A (synthetic) legacy Coral face model — the catalog no longer ships one (the
 * SSD face stub was deleted), so the specs that need "a face-detection model
 * with a tflite build, reachable only when pinned" inject it into the REAL
 * face-detection definition. `legacy` keeps it out of the auto-pick, exactly
 * as the deleted stub was. The real models' own `tflite` builds are stripped
 * (YuNet has shipped one since D710): these specs pin the rule that a LEGACY
 * build alone does not make a format runnable, which needs a step whose only
 * tflite build is legacy.
 */
const CORAL_FACE_STUB = 'test-coral-face-edgetpu'

function catalogStepDef(addonId: string): StepDefinition | null {
  const real = realStepDef(addonId)
  if (real === null || addonId !== 'face-detection') return real
  const template = real.models[0]
  if (template === undefined) return real
  return {
    ...real,
    models: [
      ...real.models.map((m) => ({
        ...m,
        formats: Object.fromEntries(
          Object.entries(m.formats).filter(([format]) => format !== 'tflite'),
        ),
      })),
      {
        ...template,
        id: CORAL_FACE_STUB,
        legacy: true,
        formats: {
          tflite: {
            url: 'https://example.invalid/coral-face.tflite',
            sizeMB: 1,
          },
        },
      },
    ],
  }
}

const FACE_SUBTREE: JumpSubtreeStep = {
  addonId: 'face-detection',
  enabled: true,
  children: [{ addonId: 'face-embedding', enabled: true }],
}

describe('buildSubtreeCanRun', () => {
  it('a child with no build for the format blocks the whole subtree — the top alone would pass', () => {
    // The top PINNED to the Coral face stub runs on tflite (an explicit pin is
    // honoured); its face-embedding child vetoes the subtree all the same.
    const pinnedTop = {
      addonId: 'face-detection',
      enabled: true,
      modelId: CORAL_FACE_STUB,
    }
    const subtreeCanRun = buildSubtreeCanRun(
      { ...pinnedTop, children: FACE_SUBTREE.children },
      catalogStepDef,
    )
    expect(subtreeCanRun('tflite')).toBe(false)
    expect(subtreeCanRun('openvino')).toBe(true)
    expect(buildSubtreeCanRun(pinnedTop, catalogStepDef)('tflite')).toBe(true)
  })

  it('D657: a LEGACY build alone does not make a format runnable — face-detection unpinned cannot run on tflite', () => {
    // A Coral face model is legacy (no working postprocessor), out of
    // the auto-pick: an unpinned face-detection resolves to a model with no
    // tflite build. Counting the stub kept it on the Coral and doomed the load.
    const topOnly = buildSubtreeCanRun({ addonId: 'face-detection', enabled: true }, catalogStepDef)
    expect(topOnly('tflite')).toBe(false)
    expect(topOnly('openvino')).toBe(true)
  })

  it('a DISABLED child never gates the subtree', () => {
    const subtreeCanRun = buildSubtreeCanRun(
      {
        addonId: 'face-detection',
        enabled: true,
        modelId: CORAL_FACE_STUB,
        children: [{ addonId: 'face-embedding', enabled: false }],
      },
      catalogStepDef,
    )
    expect(subtreeCanRun('tflite')).toBe(true)
  })

  it('unknown/custom addonIds (no catalog) never block', () => {
    const subtreeCanRun = buildSubtreeCanRun(
      {
        addonId: 'face-detection',
        enabled: true,
        modelId: CORAL_FACE_STUB,
        children: [{ addonId: 'my-custom-step', enabled: true }],
      },
      catalogStepDef,
    )
    expect(subtreeCanRun('tflite')).toBe(true)
  })

  it('OPERATOR SCENARIO: Coral-elected camera — the face subtree auto-jumps to the least-loaded openvino device', () => {
    // Hub roster shape: edgetpu:usb enabled, openvino:gpu w50, openvino:npu
    // w50. Root object-detection stays on the Coral (frame-plane gate);
    // the face subtree cannot run tflite → jumps, and the NPU wins on load.
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      devices: [
        dev({ deviceKey: EDGETPU, weight: 50 }),
        dev({ deviceKey: GPU, weight: 50, attachedCameras: 2 }),
        dev({ deviceKey: NPU, weight: 50, attachedCameras: 1 }),
      ],
      canRun: buildSubtreeCanRun(FACE_SUBTREE, catalogStepDef),
    })
    expect(result).toEqual({ kind: 'jumped', deviceKey: NPU, reason: 'auto' })
  })

  it('OPERATOR SCENARIO: a manual jumpDeviceKey still wins over the auto choice', () => {
    const result = resolveStepDevice({
      effectiveDeviceKey: EDGETPU,
      manualJumpDeviceKey: GPU,
      devices: [
        dev({ deviceKey: EDGETPU, weight: 50 }),
        dev({ deviceKey: GPU, weight: 50, attachedCameras: 2 }),
        dev({ deviceKey: NPU, weight: 50, attachedCameras: 1 }),
      ],
      canRun: buildSubtreeCanRun(FACE_SUBTREE, catalogStepDef),
    })
    expect(result).toEqual({
      kind: 'jumped',
      deviceKey: GPU,
      reason: 'manual',
    })
  })
})

// ---------------------------------------------------------------------------
// D650 — placeDetailStep: the jump decision AND the provisioning the jumped
// subtree runs with. The roster is shaped exactly as the orchestrator attaches
// it (`inferenceDevices[].steps` = that device's base + the camera's override
// for it); the catalog is the REAL one. A jumped step must run the TARGET's
// model — never the elected device's.
// ---------------------------------------------------------------------------

const ELECTED_PROVISIONED_FACE: PipelineStepInputOutput = {
  addonId: 'face-detection',
  enabled: true,
  // What the ELECTED device's base/override put on the step.
  modelId: 'elected-pin',
  settings: { minFaceSize: 10, electedOnly: true },
  children: [
    {
      addonId: 'face-embedding',
      enabled: true,
      settings: { electedOnly: true },
    },
  ],
}

const CORAL_HUB_ROSTER: readonly RunnerInferenceDevice[] = [
  { deviceKey: EDGETPU, weight: 50, maxSessions: null, steps: {} },
  {
    deviceKey: GPU,
    weight: 50,
    maxSessions: null,
    steps: {
      'face-detection': {
        modelId: 'yunet-2023mar',
        settings: { minFaceSize: 40 },
      },
      'face-embedding': { modelId: 'auraface-r100' },
    },
  },
]

describe('placeDetailStep (D650)', () => {
  it('a jumped subtree runs the TARGET device provisioning, replacing the elected one', () => {
    const placement = placeDetailStep({
      step: ELECTED_PROVISIONED_FACE,
      effectiveDeviceKey: EDGETPU,
      roster: CORAL_HUB_ROSTER,
      attachedByKey: new Map(),
      getStepDef: catalogStepDef,
    })
    expect(placement.deviceKey).toBe(GPU)
    expect(placement.decision).toEqual({
      kind: 'jumped',
      deviceKey: GPU,
      reason: 'auto',
    })
    expect(placement.provisioned).toBe(true)
    expect(placement.step).toEqual({
      addonId: 'face-detection',
      enabled: true,
      modelId: 'yunet-2023mar',
      settings: { minFaceSize: 40 },
      children: [{ addonId: 'face-embedding', enabled: true, modelId: 'auraface-r100' }],
    })
  })

  it('a MANUAL jump also runs the target provisioning, and every other field travels as sent', () => {
    const manual: PipelineStepInputOutput = {
      ...ELECTED_PROVISIONED_FACE,
      jumpDeviceKey: GPU,
    }
    const placement = placeDetailStep({
      step: manual,
      // The NPU could run it — only the operator's key moves it.
      effectiveDeviceKey: NPU,
      roster: [...CORAL_HUB_ROSTER, { deviceKey: NPU, weight: 50, maxSessions: null, steps: {} }],
      attachedByKey: new Map(),
      getStepDef: catalogStepDef,
    })
    expect(placement.decision).toEqual({
      kind: 'jumped',
      deviceKey: GPU,
      reason: 'manual',
    })
    expect(placement.step.jumpDeviceKey).toBe(GPU)
    expect(placement.step.modelId).toBe('yunet-2023mar')
    expect(placement.step.settings).toEqual({ minFaceSize: 40 })
  })

  it('a roster from an orchestrator that predates D650 (no `steps`) leaves the step as sent', () => {
    const placement = placeDetailStep({
      step: ELECTED_PROVISIONED_FACE,
      effectiveDeviceKey: EDGETPU,
      roster: CORAL_HUB_ROSTER.map(({ steps: _steps, ...entry }) => entry),
      attachedByKey: new Map(),
      getStepDef: catalogStepDef,
    })
    expect(placement.deviceKey).toBe(GPU)
    expect(placement.step).toBe(ELECTED_PROVISIONED_FACE)
    expect(placement.provisioned).toBe(false)
  })

  it('a step the elected device CAN run stays there, with the elected provisioning, untouched', () => {
    // Provisioned for the ELECTED device, and the roster offers a DIFFERENT
    // provisioning on the GPU: a step that does not jump must keep its own.
    const step: PipelineStepInputOutput = {
      addonId: 'face-detection',
      enabled: true,
      modelId: 'npu-elected-pin',
      settings: { minFaceSize: 22 },
    }
    const placement = placeDetailStep({
      step,
      effectiveDeviceKey: NPU,
      roster: [...CORAL_HUB_ROSTER, { deviceKey: NPU, weight: 50, maxSessions: null, steps: {} }],
      attachedByKey: new Map(),
      getStepDef: catalogStepDef,
    })
    expect(placement.deviceKey).toBe(NPU)
    expect(placement.decision).toEqual({ kind: 'no-jump', deviceKey: NPU })
    expect(placement.step).toBe(step)
  })

  it('no roster ⇒ the elected device, no decision; no elected device ⇒ the default pool', () => {
    const step: PipelineStepInputOutput = {
      addonId: 'face-detection',
      enabled: true,
    }
    expect(
      placeDetailStep({
        step,
        effectiveDeviceKey: EDGETPU,
        roster: undefined,
        attachedByKey: new Map(),
        getStepDef: catalogStepDef,
      }),
    ).toEqual({ deviceKey: EDGETPU, step, decision: null, provisioned: false })
    expect(
      placeDetailStep({
        step,
        effectiveDeviceKey: undefined,
        roster: CORAL_HUB_ROSTER,
        attachedByKey: new Map(),
        getStepDef: catalogStepDef,
      }),
    ).toEqual({
      deviceKey: undefined,
      step,
      decision: null,
      provisioned: false,
    })
  })
})

// ---------------------------------------------------------------------------
// D657 fix round 1 — each candidate is judged with the model IT would run: its
// own roster entry, not the elected device's provisioning.
// ---------------------------------------------------------------------------

describe('placeDetailStep judges each candidate with its OWN provisioning (D657)', () => {
  // Elected on the GPU with YuNet (no tflite build). The operator jumps face
  // detection to the Coral, whose entry pins the Coral face stub (the one face
  // model with a tflite build — a legacy stub, so it counts only when named).
  const faceOnGpu: PipelineStepInputOutput = {
    addonId: 'face-detection',
    enabled: true,
    modelId: 'yunet-2023mar',
    jumpDeviceKey: EDGETPU,
  }
  const roster: readonly RunnerInferenceDevice[] = [
    { deviceKey: GPU, weight: 50, maxSessions: null, steps: {} },
    {
      deviceKey: EDGETPU,
      weight: 50,
      maxSessions: null,
      steps: { 'face-detection': { modelId: CORAL_FACE_STUB } },
    },
  ]

  it('the Coral can take the manual jump: it would run the stub it pins, which ships tflite', () => {
    const placement = placeDetailStep({
      step: faceOnGpu,
      effectiveDeviceKey: GPU,
      roster,
      attachedByKey: new Map(),
      getStepDef: catalogStepDef,
    })
    expect(placement.decision).toEqual({
      kind: 'jumped',
      deviceKey: EDGETPU,
      reason: 'manual',
    })
    expect(placement.step.modelId).toBe(CORAL_FACE_STUB)
  })

  it('without the Coral pin the manual jump is refused: YuNet cannot run on tflite', () => {
    const placement = placeDetailStep({
      step: faceOnGpu,
      effectiveDeviceKey: GPU,
      roster: roster.map((d) => (d.deviceKey === EDGETPU ? { ...d, steps: {} } : d)),
      attachedByKey: new Map(),
      getStepDef: catalogStepDef,
    })
    expect(placement.decision).toEqual({ kind: 'no-jump', deviceKey: GPU })
  })
})
