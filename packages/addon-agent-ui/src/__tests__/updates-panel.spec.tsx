/**
 * The framework card offers "Update" only when the published release is newer
 * than the one running - never next to a running version that already equals it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdatesPanel } from '../updates-panel'

function stubServerUpdate(running: string, latest: string, updateAvailable: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        available: true,
        status: {
          packageName: '@camstack/server',
          runningVersion: running,
          latestVersion: latest,
          updateAvailable,
          updateState: 'idle',
          pendingVersion: null,
          bootMode: 'data-root',
          lastCheckedAtMs: 1,
        },
        lastCheckError: null,
        lastApply: null,
        applyInFlight: false,
      }),
    })),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mount = () => render(<UpdatesPanel locked={false} onUnauthorized={() => undefined} />)

describe('framework update button', () => {
  it('is absent when the published version is the running one', async () => {
    stubServerUpdate('1.2.680', '1.2.680', false)
    mount()
    await screen.findAllByText('1.2.680')
    expect(screen.queryByText(/^Update/)).toBeNull()
  })

  it('is offered when the published version is newer', async () => {
    stubServerUpdate('1.2.680', '1.2.681', true)
    mount()
    expect(await screen.findByText(/Update → v1\.2\.681/)).toBeTruthy()
  })
})
