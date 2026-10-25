/**
 * The camera Steps tree (D927): a camera turns steps on or off. Auto follows
 * the catalog default. An ancestor that is off idles its descendants. Root
 * detector "None" idles the whole video tree; "Camera onboard AI" idles only
 * the root step.
 */
import type { PipelineSlot } from '@camstack/types'
import type { StepTreeNode } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import { cameraStepRows } from '../camera-step-tree-model'

function step(
  addonId: string,
  slot: PipelineSlot,
  children: readonly StepTreeNode[] = [],
): StepTreeNode {
  return {
    addonId,
    addonName: addonId,
    slot,
    inputClasses: [],
    outputClasses: [],
    children,
  }
}

const TREE: readonly StepTreeNode[] = [
  step('object-detection', 'detector', [
    step('face-detection', 'cropper', [step('face-embedding', 'classifier')]),
    step('plate-detection', 'cropper'),
  ]),
]

const DEFAULTS_ON: Readonly<Record<string, boolean>> = {
  'object-detection': true,
  'face-detection': true,
  'face-embedding': true,
  'plate-detection': true,
}

function row(id: string, rows: ReturnType<typeof cameraStepRows>) {
  const found = rows.find((r) => r.stepId === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}

describe('cameraStepRows', () => {
  it('Auto follows the catalog default; On and Off are explicit', () => {
    const rows = cameraStepRows({
      tree: TREE,
      toggles: { 'face-detection': false, 'plate-detection': true },
      defaults: { ...DEFAULTS_ON, 'face-embedding': false },
      source: 'pipeline',
    })
    expect(row('object-detection', rows)).toMatchObject({
      choice: 'auto',
      ownOn: true,
      runs: true,
      blocked: null,
      depth: 0,
      kind: 'detector',
    })
    expect(row('face-detection', rows)).toMatchObject({ choice: 'off', ownOn: false, runs: false })
    expect(row('plate-detection', rows)).toMatchObject({ choice: 'on', ownOn: true, runs: true })
    expect(row('face-embedding', rows)).toMatchObject({ choice: 'auto', ownOn: false, runs: false })
  })

  it('a step whose ancestor is off does not run, whatever its own switch says', () => {
    const rows = cameraStepRows({
      tree: TREE,
      toggles: { 'object-detection': false, 'face-detection': true, 'face-embedding': true },
      defaults: DEFAULTS_ON,
      source: 'pipeline',
    })
    expect(row('object-detection', rows)).toMatchObject({
      choice: 'off',
      runs: false,
      blocked: null,
    })
    expect(row('face-detection', rows).blocked).toEqual({
      kind: 'parent',
      ancestorId: 'object-detection',
    })
    expect(row('face-detection', rows).runs).toBe(false)
    expect(row('face-embedding', rows).blocked).toEqual({
      kind: 'parent',
      ancestorId: 'object-detection',
    })
    expect(row('face-embedding', rows).choice).toBe('on')
    // A sibling whose parent is the off root is idle too; one whose parent runs is not.
    expect(row('plate-detection', rows).blocked).toEqual({
      kind: 'parent',
      ancestorId: 'object-detection',
    })
  })

  it('an Auto step that defaults off idles its children', () => {
    const rows = cameraStepRows({
      tree: TREE,
      toggles: {},
      defaults: { ...DEFAULTS_ON, 'face-detection': false },
      source: 'pipeline',
    })
    expect(row('face-detection', rows)).toMatchObject({ choice: 'auto', ownOn: false, runs: false })
    expect(row('face-embedding', rows).blocked).toEqual({
      kind: 'parent',
      ancestorId: 'face-detection',
    })
  })

  it('root detector None idles every step under the root', () => {
    const rows = cameraStepRows({
      tree: TREE,
      toggles: {
        'object-detection': true,
        'face-detection': true,
        'face-embedding': true,
        'plate-detection': true,
      },
      defaults: DEFAULTS_ON,
      source: 'none',
    })
    for (const id of ['object-detection', 'face-detection', 'face-embedding', 'plate-detection']) {
      expect(row(id, rows).runs).toBe(false)
      expect(row(id, rows).blocked).toEqual({ kind: 'source', source: 'none' })
    }
  })

  it('camera onboard AI idles only the root step', () => {
    const rows = cameraStepRows({
      tree: TREE,
      toggles: {},
      defaults: DEFAULTS_ON,
      source: 'onboard',
    })
    expect(row('object-detection', rows).blocked).toEqual({ kind: 'source', source: 'onboard' })
    expect(row('object-detection', rows).runs).toBe(false)
    expect(row('face-detection', rows)).toMatchObject({ runs: true, blocked: null })
    expect(row('face-embedding', rows).runs).toBe(true)
  })

  it('an unanswered root-detector pick suppresses nothing', () => {
    const rows = cameraStepRows({
      tree: TREE,
      toggles: {},
      defaults: DEFAULTS_ON,
      source: null,
    })
    expect(rows.every((r) => r.blocked === null && r.runs)).toBe(true)
  })

  it('keeps depth and the classes the step consumes and produces', () => {
    const tree: readonly StepTreeNode[] = [
      {
        addonId: 'object-detection',
        addonName: 'Object Detection',
        slot: 'detector',
        inputClasses: [],
        outputClasses: ['person', 'vehicle'],
        children: [
          {
            addonId: 'face-detection',
            addonName: 'Face Detection',
            slot: 'cropper',
            inputClasses: ['person'],
            outputClasses: ['face'],
            children: [],
          },
        ],
      },
    ]
    const rows = cameraStepRows({
      tree,
      toggles: {},
      defaults: DEFAULTS_ON,
      source: 'pipeline',
    })
    expect(row('object-detection', rows)).toMatchObject({
      name: 'Object Detection',
      depth: 0,
      inputs: [],
      outputs: ['person', 'vehicle'],
    })
    expect(row('face-detection', rows)).toMatchObject({
      depth: 1,
      kind: 'cropper',
      inputs: ['person'],
      outputs: ['face'],
    })
  })
})
