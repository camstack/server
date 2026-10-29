/**
 * The desktop-app row: stale state is never "up to date", the install button
 * exists only for a downloaded update on a live app, and a refusal names its
 * reason.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const installSpy =
  vi.fn<(input: unknown) => Promise<{ accepted: boolean; reason: string | null }>>()

vi.mock('@camstack/ui-library', () => ({
  Button: (props: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children as never}
    </button>
  ),
  useServerManagementInstallDesktopUpdate: () => ({ mutateAsync: installSpy, isPending: false }),
  useConfirm: () => vi.fn().mockResolvedValue(true),
}))

import { type DesktopAppState, NodeDesktopAppRow } from '../NodeDesktopAppRow'

const NOW = Date.now()

function app(over: Partial<DesktopAppState> = {}): DesktopAppState {
  return {
    version: '1.0.0',
    update: { available: false, downloaded: false, version: null, checking: false, error: null },
    stateAtMs: NOW,
    stale: false,
    ...over,
  }
}

function ready(): DesktopAppState {
  return app({
    update: { available: true, downloaded: true, version: '1.1.0', checking: false, error: null },
  })
}

function renderRow(desktopApp: DesktopAppState) {
  return render(
    <NodeDesktopAppRow
      desktopApp={desktopApp}
      nodeName="Mac"
      routingInput={{ nodeId: 'mac' }}
      onSettled={vi.fn()}
    />,
  )
}

async function clickInstall(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Install update/ }))
  })
}

describe('NodeDesktopAppRow', () => {
  beforeEach(() => installSpy.mockReset())

  it('says "up to date" only for fresh state with nothing pending', () => {
    renderRow(app())
    expect(screen.getByText('up to date')).toBeTruthy()
  })

  it('never says "up to date" for stale state', () => {
    renderRow(app({ stale: true, stateAtMs: NOW - 3_600_000 }))
    expect(screen.queryByText('up to date')).toBeNull()
    expect(screen.getByText(/app state unknown/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows downloading without an install button', () => {
    renderRow(
      app({
        update: {
          available: true,
          downloaded: false,
          version: '1.1.0',
          checking: false,
          error: null,
        },
      }),
    )
    expect(screen.getByText(/1\.1\.0 available/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('installs a downloaded update and shows restarting', async () => {
    installSpy.mockResolvedValue({ accepted: true, reason: null })
    renderRow(ready())
    await clickInstall()
    expect(installSpy).toHaveBeenCalledWith({ nodeId: 'mac' })
    expect(screen.getByText(/restarting/)).toBeTruthy()
  })

  it('maps a refusal reason to a sentence', async () => {
    installSpy.mockResolvedValue({ accepted: false, reason: 'not-downloaded' })
    renderRow(ready())
    await clickInstall()
    expect(screen.getByText('No update is downloaded yet.')).toBeTruthy()
  })
})
