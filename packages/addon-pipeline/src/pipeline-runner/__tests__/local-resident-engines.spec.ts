/**
 * `pipelineRuntime` on an agent's `pipeline stats` line named the HUB's pools:
 * the runner asked `api.pipelineExecutor.listLoadedEngines` unpinned, and
 * `pipeline-executor` is a singleton cap, so the cluster-active provider (the
 * hub's) answered. agent-b, running `yolov9s-320-edgetpu` on `edgetpu:usb`,
 * printed `openvino/npu` and `yolov9m-640-int8`. The runner and the
 * detection-pipeline share the `detection` group, i.e. ONE process: the
 * provider in this process is the node's own, and it is the one to ask.
 */
import type { CapabilitiesAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NO_LOCAL_EXECUTOR, readLocalResidentEngines } from '../local-resident-engines.js'
import { buildRuntimeLabels } from '../runtime-labels.js'

const agentProvider = {
  listLoadedEngines: async () => [
    {
      engineKey: 'python/edgetpu/usb',
      engine: { runtime: 'python', backend: 'edgetpu', device: 'usb' },
      modelsLoaded: ['detect/yolov9s-320-edgetpu'],
      inUseByCameras: [],
      kind: 'runtime' as const,
      poolPid: 12,
      idleMs: null,
      idleTtlMs: null,
    },
  ],
}

function access(local: unknown): CapabilitiesAccess {
  return {
    getCollection: () => undefined,
    getCollectionEntries: () => undefined,
    get: <T>(name: string): T | undefined =>
      name === 'pipeline-executor' ? (local as T | undefined) : undefined,
  }
}

describe('readLocalResidentEngines', () => {
  it("reads THIS process's executor — the agent's Coral, not the hub's NPU", async () => {
    const read = await readLocalResidentEngines(access(agentProvider))
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(buildRuntimeLabels(read.engines)).toEqual({
      pipelineRuntime: 'edgetpu/usb',
      pipelineModels: ['detect/yolov9s-320-edgetpu'],
    })
  })

  it('no executor in this process is a named failure, never another node’s answer', async () => {
    expect(await readLocalResidentEngines(access(undefined))).toEqual({
      kind: 'failed',
      error: NO_LOCAL_EXECUTOR,
    })
    expect(await readLocalResidentEngines(undefined)).toEqual({
      kind: 'failed',
      error: NO_LOCAL_EXECUTOR,
    })
    expect(await readLocalResidentEngines(access({ somethingElse: 1 }))).toEqual({
      kind: 'failed',
      error: NO_LOCAL_EXECUTOR,
    })
  })

  it('a throwing provider is a failure with its message', async () => {
    const read = await readLocalResidentEngines(
      access({
        listLoadedEngines: async () => {
          throw new Error('pool not initialised')
        },
      }),
    )
    expect(read).toEqual({ kind: 'failed', error: 'pool not initialised' })
  })
})
