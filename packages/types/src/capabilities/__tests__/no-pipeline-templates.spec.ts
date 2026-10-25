import { describe, expect, it } from 'vitest'
import * as executorCap from '../pipeline-executor.cap.js'
import * as orchestratorCap from '../pipeline-orchestrator.cap.js'

/**
 * Pipeline templates are removed (D759): nothing created or applied one any
 * more, and no camera's pipeline is ever resolved from one. Neither cap may
 * grow the CRUD surface back, and no template schema may stay exported.
 */
const TEMPLATE_METHODS = ['listTemplates', 'saveTemplate', 'updateTemplate', 'deleteTemplate']

describe('pipeline templates are gone (D759)', () => {
  it('the orchestrator cap has no template methods', () => {
    const methods = Object.keys(orchestratorCap.pipelineOrchestratorCapability.methods)
    expect(methods.filter((m) => TEMPLATE_METHODS.includes(m))).toEqual([])
  })

  it('the executor cap has no template methods', () => {
    const methods = Object.keys(executorCap.pipelineExecutorCapability.methods)
    expect(methods.filter((m) => TEMPLATE_METHODS.includes(m))).toEqual([])
  })

  it('no template schema is exported', () => {
    const exported = [...Object.keys(executorCap), ...Object.keys(orchestratorCap)].filter((k) =>
      /PipelineTemplate/.test(k),
    )
    expect(exported).toEqual([])
  })
})
