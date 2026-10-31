/**
 * The per-node update surface must SHOW what the node answered.
 *
 * WHY THIS FILE EXISTS. `applyServerUpdate` returns
 * `{accepted, targetVersion, restarting, message}` and this component read
 * exactly one field:
 *
 *     const result = await applyMutation.mutateAsync(...)
 *     if (result.restarting) setRestarting(true)
 *
 * So all six server-side refusals — workspace boot mode, an operation in
 * flight, a version already staged, an unresolvable latest, the target already
 * running, missing dev-channel uploads — rendered as absolutely nothing: the
 * operator clicked, the button stayed put, and no line appeared anywhere
 * (the engine did not log them either; see `root-update-observability.spec.ts`).
 * On 2026-09-01 that is what "I ran it singly too, and nothing happened"
 * looked like.
 *
 * The other silent drop pinned here is the guard at the top of `handleUpdate`:
 * `if (status?.latestVersion == null) return` — a click that does not even
 * issue a request, and says so nowhere.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ServerPackageStatus, ServerUpdateActionResult } from '@camstack/types'

const applySpy = vi.fn<(input: unknown) => Promise<ServerUpdateActionResult>>()
const restartSpy = vi.fn<(input: unknown) => Promise<ServerUpdateActionResult>>()

/** Mutable across tests — read inside the hoisted `vi.mock` factory. */
const statusHolder = vi.hoisted(() => ({ current: null as unknown }))

function status(over: Partial<ServerPackageStatus> = {}): ServerPackageStatus {
  return {
    packageName: '@camstack/server',
    runningVersion: '1.2.201',
    nodeRuntimeVersion: 'v24.0.0',
    activeVersion: '1.2.201',
    previousVersion: null,
    seedVersion: '1.2.200',
    latestVersion: '1.2.205',
    updateAvailable: true,
    bootMode: 'data-root',
    updateState: 'idle',
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: 0,
    ...over,
  }
}

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
    useServerManagementGetServerPackageStatus: () => ({
      data: statusHolder.current,
      isLoading: false,
      isError: false,
    }),
    useServerManagementCheckServerUpdate: () => ({ mutate: vi.fn(), isPending: false }),
    useServerManagementApplyServerUpdate: () => ({ mutateAsync: applySpy, isPending: false }),
    useServerManagementRollbackServerUpdate: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useServerManagementRestartServer: () => ({ mutateAsync: restartSpy, isPending: false }),
    useConfirm: () => vi.fn().mockResolvedValue(true),
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

import { NodeServerManagementSection } from '../NodeServerManagementSection'

const HUB = {
  id: 'hub',
  name: 'Hub',
  isHub: true,
  isOnline: true,
  rootPackage: { name: '@camstack/server', version: '1.2.201' },
}

async function clickUpdate(): Promise<void> {
  const button = screen.getByRole('button', { name: /Update to/i })
  await act(async () => {
    fireEvent.click(button)
  })
}

describe('NodeServerManagementSection — the node answer reaches the screen', () => {
  beforeEach(() => {
    applySpy.mockReset()
    restartSpy.mockReset()
    statusHolder.current = status()
  })

  it('shows a REFUSAL message instead of doing nothing visible', async () => {
    applySpy.mockResolvedValue({
      accepted: false,
      targetVersion: '1.2.205',
      restarting: false,
      message: 'Refused: another operation is in flight (checking).',
    })
    render(<NodeServerManagementSection node={HUB} />)

    await clickUpdate()

    const outcome = screen.getByRole('status')
    expect(outcome.textContent).toContain('another operation is in flight')
  })

  it('shows the accepted message too, so a successful stage is not a blank screen', async () => {
    applySpy.mockResolvedValue({
      accepted: true,
      targetVersion: '1.2.205',
      restarting: true,
      message: 'Staged @camstack/server@1.2.205 — restarting to apply.',
    })
    render(<NodeServerManagementSection node={HUB} />)

    await clickUpdate()

    expect(screen.getByRole('status').textContent).toContain('Staged @camstack/server@1.2.205')
  })

  it('renders a staging FAILURE as an error, apart from a refusal', async () => {
    applySpy.mockResolvedValue({
      accepted: false,
      targetVersion: '1.2.353',
      restarting: false,
      message: 'Staging failed: npm error code ECONNRESET',
      outcome: 'failed',
      reason: 'staging-failed',
      error: 'npm error code ECONNRESET',
    })
    render(<NodeServerManagementSection node={HUB} />)

    await clickUpdate()

    const outcome = screen.getByRole('status')
    expect(outcome.textContent).toContain('ECONNRESET')
    expect(outcome.className).toContain('text-danger')
  })

  it('says a restart is required when the copy on disk is not the code running', () => {
    statusHolder.current = status({
      updateAvailable: false,
      installedVersion: '1.2.353',
      restartRequired: true,
    })
    render(<NodeServerManagementSection node={HUB} />)

    expect(screen.getByText(/restart required/i)).toBeTruthy()
    expect(screen.getByText('1.2.353')).toBeTruthy()
    expect(screen.queryByText(/up to date/i)).toBeNull()
  })

  it('reports a dropped call as UNKNOWN rather than swallowing it', async () => {
    applySpy.mockRejectedValue(new Error('Request is timed out'))
    render(<NodeServerManagementSection node={HUB} />)

    await clickUpdate()

    const outcome = screen.getByRole('status')
    expect(outcome.textContent).toMatch(/could not be confirmed|unknown/i)
    expect(outcome.textContent).toContain('Request is timed out')
  })

  it('never claims a restart the node did not report', async () => {
    applySpy.mockResolvedValue({
      accepted: false,
      targetVersion: null,
      restarting: false,
      message: 'Refused: running from a workspace checkout.',
    })
    render(<NodeServerManagementSection node={HUB} />)

    await clickUpdate()

    expect(screen.queryByText(/The node is restarting/i)).toBeNull()
  })

  it('says so when there is no version to update TO, instead of a dead click', async () => {
    // `updateAvailable` is true (the button renders) but `latestVersion` is
    // null — the guard used to `return` here with no request and no message.
    statusHolder.current = status({ latestVersion: null })
    render(<NodeServerManagementSection node={HUB} />)

    await clickUpdate()

    expect(applySpy).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toMatch(/no target version/i)
  })
})
