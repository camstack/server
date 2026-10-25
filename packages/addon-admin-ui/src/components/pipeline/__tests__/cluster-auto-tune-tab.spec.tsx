/// <reference types="@testing-library/jest-dom" />
/**
 * D745, D755 — Cluster → Auto tune: the plan is shown, the confirmation
 * lists every write, Apply sends the plan's hash with the options it was
 * computed at (headroom, min sessions per device), and a `stale` answer
 * replaces the plan on screen instead of being written over.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { AutoTuneApplyResult, AutoTunePlan } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const mutate = vi.fn()
let planData: AutoTunePlan | undefined
let lastPlanInput: unknown
let onSuccess: ((r: AutoTuneApplyResult) => void) | undefined

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const Pass = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>
  return {
    ...actual,
    useClusterNodes: () => ({ nodes: [{ id: 'hub', name: 'Main hub', isOnline: true }] }),
    usePipelineOrchestratorPlanAutoTune: (input: unknown, opts: { enabled: boolean }) => {
      lastPlanInput = input
      return {
        data: opts.enabled ? planData : undefined,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      }
    },
    usePipelineOrchestratorApplyAutoTune: (opts: {
      onSuccess: (r: AutoTuneApplyResult) => void
    }) => {
      onSuccess = opts.onSuccess
      return { mutate, isPending: false }
    },
    Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogBody: Pass,
    DialogFooter: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
  }
})

import { ClusterAutoTuneTab } from '../tabs/ClusterAutoTuneTab'

function plan(hash: string, model: string): AutoTunePlan {
  return {
    planHash: hash,
    family: 'yolov9',
    headroom: 0.4,
    minSessionsPerDevice: 2,
    cameraFps: 10,
    generatedAt: 1,
    nodes: [
      {
        nodeId: 'hub',
        reachable: true,
        hardwareClass: 'intel-core-ultra',
        cpuModel: 'Intel(R) Core(TM) Ultra 7 265K',
        skipped: false,
        acceleratorModelId: model,
        reasons: [],
        devices: [
          {
            deviceKey: 'openvino:npu',
            accelerator: 'intel-npu',
            enabled: true,
            available: true,
            chosen: {
              modelId: model,
              p50Ms: 19.5,
              fps: 52,
              measured: true,
              capacitySessions: 3,
              personRecall: 0.85,
            },
            reasons: [{ kind: 'capacity', sessions: 3, minSessions: 2 }],
          },
        ],
      },
    ],
    nodeChanges: [
      {
        nodeId: 'hub',
        deviceKey: 'openvino:npu',
        madeExplicit: false,
        modelPins: [{ stepId: 'object-detection', before: 'yolov9m-320-int8', after: model }],
        thresholds: [{ stepId: 'object-detection', keys: ['minConfidencePerson'] }],
      },
    ],
    warnings: [],
  }
}

describe('ClusterAutoTuneTab', () => {
  beforeEach(() => {
    mutate.mockReset()
    planData = plan('h1', 'yolov9m-640-int8')
  })

  it('computes and shows the plan per node', () => {
    render(<ClusterAutoTuneTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Compute plan' }))
    const node = screen.getByTestId('auto-tune-node-hub')
    expect(within(node).getAllByText('yolov9m-640-int8').length).toBeGreaterThan(0)
    expect(node).toHaveTextContent('Capacity 3 sessions ≥ min 2.')
    expect(node).toHaveTextContent('3 sessions at 10 fps')
    // A node is named, never shown by its id.
    expect(within(node).getByRole('heading', { level: 3 })).toHaveTextContent('Main hub')
  })

  it('the minimum sessions per device is an option, sent with the plan and the apply', () => {
    render(<ClusterAutoTuneTab />)
    expect(lastPlanInput).toEqual({ headroom: 0.4, minSessionsPerDevice: 2 })
    fireEvent.change(screen.getByLabelText('Minimum parallel sessions per device'), {
      target: { value: '3' },
    })
    expect(lastPlanInput).toEqual({ headroom: 0.4, minSessionsPerDevice: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Compute plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(mutate).toHaveBeenCalledWith({ planHash: 'h1', headroom: 0.4, minSessionsPerDevice: 3 })
  })

  it('the confirmation lists every write, and Apply sends the plan hash', () => {
    render(<ClusterAutoTuneTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Compute plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }))
    const list = screen.getByTestId('auto-tune-change-list')
    expect(list).toHaveTextContent('object-detection: yolov9m-320-int8 → yolov9m-640-int8')
    expect(list).toHaveTextContent('reset minConfidencePerson to the model default')
    expect(list).toHaveTextContent('Main hub · openvino:npu — object-detection')
    // A camera carries no model or threshold (D927): nothing per camera is listed.
    expect(list).not.toHaveTextContent(/camera overrides/i)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(mutate).toHaveBeenCalledWith({ planHash: 'h1', headroom: 0.4, minSessionsPerDevice: 2 })
  })

  it('a stale answer replaces the plan on screen', () => {
    render(<ClusterAutoTuneTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Compute plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    act(() => onSuccess?.({ kind: 'stale', plan: plan('h2', 'yolov9s-640-int8') }))
    expect(screen.getByText(/configuration changed since the plan was shown/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(mutate).toHaveBeenLastCalledWith({
      planHash: 'h2',
      headroom: 0.4,
      minSessionsPerDevice: 2,
    })
  })
})
