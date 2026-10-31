import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { RunnerBlock as RunnerBlockData } from '../build-cluster-graph'
import { RunnerBlock } from '../RunnerBlock'

// Shared spy so we can assert on mutateAsync calls across tests
const mutateAsyncSpy = vi.fn().mockResolvedValue({ success: true })

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    FloatingLogStream: ({
      addonId,
      agentId,
      onClose,
    }: {
      addonId?: string
      agentId: string
      onClose: () => void
    }) => (
      <div data-testid="log-stream" data-addon-id={addonId ?? ''} data-agent-id={agentId}>
        <button onClick={onClose}>close-log</button>
      </div>
    ),
    useNodesRestartAddon: () => ({
      mutateAsync: mutateAsyncSpy,
    }),
  }
})

const baseRunner: RunnerBlockData = {
  pid: 1234,
  name: 'stream-broker',
  addonId: 'addon-pipeline',
  cpu: 12.5,
  mem: 52428800, // 50 MB
  state: 'running',
  caps: [
    { name: 'stream-catalog', addonId: 'addon-pipeline' },
    { name: 'stream-params', addonId: 'addon-pipeline' },
  ],
}

describe('RunnerBlock', () => {
  it('renders process name, cpu%, and human-readable mem', () => {
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(screen.getByText('stream-broker')).toBeTruthy()
    expect(screen.getByText(/12\.5%/)).toBeTruthy()
    // 50 MB RSS
    expect(screen.getByText(/50(\.\d+)? MB/)).toBeTruthy()
  })

  it('renders a caps:N badge button', () => {
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /caps.*2/i })).toBeTruthy()
  })

  it('clicking the caps badge calls onToggleCaps with the runner pid', () => {
    const onToggleCaps = vi.fn()
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={onToggleCaps}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /caps.*2/i }))
    expect(onToggleCaps).toHaveBeenCalledTimes(1)
    expect(onToggleCaps).toHaveBeenCalledWith(baseRunner.pid)
  })

  it('does NOT show cap list when expanded=false', () => {
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(screen.queryByText('stream-catalog')).toBeNull()
  })

  it('shows cap list (name · addonId) when expanded=true', () => {
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={true}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(screen.getByText(/stream-catalog/)).toBeTruthy()
    expect(screen.getByText(/stream-params/)).toBeTruthy()
    // each entry includes the addonId
    const entries = screen.getAllByText(/addon-pipeline/)
    expect(entries.length).toBeGreaterThanOrEqual(2)
  })

  it('restart button calls mutateAsync with { nodeId, addonId }', async () => {
    mutateAsyncSpy.mockClear()
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /restart/i }))
    await vi.waitFor(() => {
      expect(mutateAsyncSpy).toHaveBeenCalledWith({ nodeId: 'hub', addonId: 'addon-pipeline' })
    })
  })

  it('logs button reveals the FloatingLogStream', () => {
    render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(screen.queryByTestId('log-stream')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /logs/i }))
    const logStream = screen.getByTestId('log-stream')
    expect(logStream.getAttribute('data-agent-id')).toBe('hub')
    expect(logStream.getAttribute('data-addon-id')).toBe('addon-pipeline')
  })

  it('status dot is success-coloured when state=running', () => {
    const { container } = render(
      <RunnerBlock
        runner={baseRunner}
        nodeId="hub"
        expanded={false}
        pid={baseRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    // The dot element must carry a success class (e.g. bg-success)
    expect(container.querySelector('[class*="success"]')).not.toBeNull()
  })

  it('status dot is muted/destructive when state=crashed', () => {
    const crashedRunner: RunnerBlockData = { ...baseRunner, state: 'crashed' }
    const { container } = render(
      <RunnerBlock
        runner={crashedRunner}
        nodeId="hub"
        expanded={false}
        pid={crashedRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(container.querySelector('[class*="destructive"]')).not.toBeNull()
  })

  it('handles a runner with zero caps: badge shows caps:0', () => {
    const noCapsRunner: RunnerBlockData = { ...baseRunner, caps: [] }
    render(
      <RunnerBlock
        runner={noCapsRunner}
        nodeId="hub"
        expanded={false}
        pid={noCapsRunner.pid}
        onToggleCaps={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /caps.*0/i })).toBeTruthy()
  })
})
