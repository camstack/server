/**
 * D649 round 4: the towers' `failed` state is NODE-attributed. One provider per
 * node answers `getInfo`/`resetFailedModels`; before this the rows and the
 * reset result carried no node, so agent B's failure looked like health
 * whenever the hub answered.
 */
import { describe, expect, it } from 'vitest'
import { CrashBudget } from '../crash-budget.js'
import {
  clearFailedOnModelChange,
  type EncoderTowers,
  reportFailedModels,
  reportFailedRequirements,
  resetFailedModelsOn,
  type TowerBudgets,
} from '../failed-models-report.js'
import { PermanentRequirementsFailure, RequirementsGate } from '../model-requirements.js'

function towers(nodeId = 'agent-b'): TowerBudgets {
  const logger = { info: () => {}, error: () => {} }
  return {
    image: new CrashBudget({ tower: 'image', nodeId: () => nodeId, logger, maxCrashes: 1 }),
    text: new CrashBudget({ tower: 'text', nodeId: () => nodeId, logger, maxCrashes: 1 }),
  }
}

/** Budgets AND requirement gates — what the addon hands the report helpers. */
function encoderTowers(nodeId = 'agent-b'): EncoderTowers {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  return {
    budgets: towers(nodeId),
    requirements: {
      image: new RequirementsGate({ tower: 'image', nodeId: () => nodeId, logger, maxAttempts: 1 }),
      text: new RequirementsGate({ tower: 'text', nodeId: () => nodeId, logger, maxAttempts: 1 }),
    },
  }
}

describe('failed models, per node', () => {
  it('every row names the tower AND the node it failed on — stamped by the budget, not re-derived', () => {
    const t = towers('agent-b')
    t.image.record('siglip2-b16-224', 'process died after loading')
    t.text.record('test-clip-a', 'load failed: exited 1')
    expect(reportFailedModels(t)).toEqual([
      expect.objectContaining({ modelId: 'siglip2-b16-224', tower: 'image', nodeId: 'agent-b' }),
      expect.objectContaining({ modelId: 'test-clip-a', tower: 'text', nodeId: 'agent-b' }),
    ])
  })

  it('a node with the budget and nothing failed answers an EMPTY array — never undefined', () => {
    expect(reportFailedModels(towers())).toEqual([])
  })

  it('a reset names the node it cleared, and clears both towers of the named model', () => {
    const all = encoderTowers()
    const t = all.budgets
    t.image.record('siglip2-b16-224', 'x')
    t.text.record('siglip2-b16-224', 'x')
    t.text.record('test-clip-a', 'x')
    expect(resetFailedModelsOn('agent-b', all, 'siglip2-b16-224')).toEqual({
      cleared: ['siglip2-b16-224'],
      nodeId: 'agent-b',
    })
    expect(reportFailedModels(t).map((r) => r.modelId)).toEqual(['test-clip-a'])
    expect(resetFailedModelsOn('agent-b', all)).toEqual({
      cleared: ['test-clip-a'],
      nodeId: 'agent-b',
    })
    expect(resetFailedModelsOn('agent-b', all)).toEqual({ cleared: [], nodeId: 'agent-b' })
  })

  it('a model change clears ONLY the model the row now names — the one it left stays failed', () => {
    const all = encoderTowers()
    const t = all.budgets
    t.image.record('siglip2-b16-224', 'OOM on first inference')
    t.image.record('test-clip-a', 'OOM on first inference')
    // The operator rolls back to the first model: a fresh start for the first model…
    expect(clearFailedOnModelChange(all, 'test-clip-a')).toEqual(['test-clip-a'])
    // …and SigLIP2 keeps its state: a search still naming it is refused, not respawned.
    expect(reportFailedModels(t).map((r) => r.modelId)).toEqual(['siglip2-b16-224'])
    expect(() => t.image.check('siglip2-b16-224')).toThrow(/embedding-model-failed/)
    expect(() => t.image.check('test-clip-a')).not.toThrow()
  })

  it('a terminal requirements failure is reported beside failedModels with its node, and shares the exits', () => {
    const all = encoderTowers('agent-b')
    const permanent = new PermanentRequirementsFailure(
      'HTTP 404 downloading https://x/siglip2.onnx',
    )
    all.requirements.image.refuse('siglip2-b16-224', permanent) // maxAttempts 1: terminal at once
    all.requirements.text.refuse('siglip2-b16-224', permanent)
    all.requirements.text.refuse('test-clip-a', new Error('hub unreachable')) // cooldown only
    expect(reportFailedRequirements(all.requirements)).toEqual([
      expect.objectContaining({
        modelId: 'siglip2-b16-224',
        tower: 'image',
        nodeId: 'agent-b',
        attempts: 1,
      }),
      expect.objectContaining({
        modelId: 'siglip2-b16-224',
        tower: 'text',
        nodeId: 'agent-b',
        attempts: 1,
      }),
    ])
    expect(reportFailedModels(all.budgets)).toEqual([]) // it is not a crash
    // The same reset clears it and names it once.
    expect(resetFailedModelsOn('agent-b', all, 'siglip2-b16-224')).toEqual({
      cleared: ['siglip2-b16-224'],
      nodeId: 'agent-b',
    })
    expect(reportFailedRequirements(all.requirements)).toEqual([])
    // A model change clears the model it names, requirements included.
    all.requirements.image.refuse('siglip2-b16-224', permanent)
    all.requirements.image.refuse('test-clip-a', permanent)
    expect(clearFailedOnModelChange(all, 'test-clip-a')).toEqual(['test-clip-a'])
    expect(reportFailedRequirements(all.requirements).map((r) => r.modelId)).toEqual([
      'siglip2-b16-224',
    ])
  })
})
