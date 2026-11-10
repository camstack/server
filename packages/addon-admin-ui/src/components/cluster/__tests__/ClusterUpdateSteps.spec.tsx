import { render, screen } from '@testing-library/react'
import type { ClusterUpdateStep } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ClusterUpdateSteps } from '../ClusterUpdateSteps'

function step(
  overrides: Partial<ClusterUpdateStep> & Pick<ClusterUpdateStep, 'kind' | 'status' | 'detail'>,
): ClusterUpdateStep {
  return overrides
}

describe('ClusterUpdateSteps', () => {
  it('renders each step status and the typed failure reason', () => {
    const steps: readonly ClusterUpdateStep[] = [
      step({ kind: 'backup', status: 'ok', detail: 'Stored on the hub disk.' }),
      step({
        kind: 'hub-server',
        status: 'running',
        detail: 'Hub is restarting onto 1.2.900.',
      }),
      step({
        kind: 'agent-server',
        nodeId: 'garage-nuc',
        status: 'failed',
        detail: 'garage-nuc came back with no capabilities.',
        reason: 'node-capless',
      }),
      step({ kind: 'addons', status: 'pending', detail: 'Not reached.' }),
    ]
    render(
      <ClusterUpdateSteps
        steps={steps}
        restarting={false}
        targetVersion="1.2.900"
        skippedOffline={['shed-box']}
      />,
    )

    const list = screen.getByRole('list', { name: /cluster update steps/i })
    const rows = list.querySelectorAll('li')
    expect(rows).toHaveLength(4)
    expect(rows[0]?.getAttribute('data-status')).toBe('ok')
    expect(rows[1]?.getAttribute('data-status')).toBe('running')
    expect(rows[2]?.getAttribute('data-status')).toBe('failed')
    expect(rows[2]?.getAttribute('data-reason')).toBe('node-capless')
    expect(rows[2]?.textContent).toMatch(/no capabilities/i)
    expect(rows[2]?.textContent).toMatch(/registered no capabilities/i)
    expect(rows[3]?.getAttribute('data-status')).toBe('pending')
    expect(screen.getByText(/Target 1\.2\.900/)).toBeTruthy()
    expect(screen.getByText(/shed-box/)).toBeTruthy()
  })

  it('a failed read during the job is a restarting status, not an alert', () => {
    render(
      <ClusterUpdateSteps
        steps={[step({ kind: 'hub-server', status: 'running', detail: 'Restarting.' })]}
        restarting
        targetVersion="1.2.900"
        skippedOffline={[]}
      />,
    )
    expect(screen.getByRole('status').textContent).toMatch(/restarting/i)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('listitem').getAttribute('data-status')).toBe('running')
  })
})
