/**
 * The single addon list (D841) and its hub-backed Update (D840): one row per
 * addon with its runner, shared runners shown as such, a runner without an
 * addon still listed, Update posted to the hub path, a refusal shown.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AddonRuntimeRow,
  type AddonUpdateRow,
  type AddonUpdatesResponse,
  AddonsPanel,
} from '../addons-panel'

const runner = (name: string, addonIds: string[], pid: number) => ({
  name,
  pid,
  state: 'running',
  groupId: name,
  cpuPercent: 2.5,
  memoryRss: 5 * 1024 * 1024,
  uptimeSeconds: 30,
  addonIds,
})

const ROWS: readonly AddonRuntimeRow[] = [
  {
    key: 'decoder',
    kind: 'addon',
    addonId: 'decoder',
    packageName: '@camstack/addon-d',
    version: '1.0.0',
    status: 'running',
    runner: runner('decoder', ['decoder'], 11),
  },
  {
    key: 'ml-a',
    kind: 'addon',
    addonId: 'ml-a',
    packageName: '@camstack/addon-ml',
    version: '2.0.0',
    status: 'running',
    runner: runner('ml', ['ml-a', 'ml-b'], 22),
  },
  {
    key: 'runner:ghost',
    kind: 'runner',
    addonId: null,
    packageName: null,
    version: null,
    status: 'running',
    runner: runner('ghost', ['gone'], 33),
  },
]

const updateRow = (over: Partial<AddonUpdateRow>): AddonUpdateRow => ({
  packageName: '@camstack/addon-d',
  installedVersion: '1.0.0',
  latestVersion: '1.0.0',
  updateAvailable: false,
  error: null,
  hubVersion: '1.0.0',
  behindHub: false,
  update: null,
  ...over,
})

function stub(updates: AddonUpdatesResponse, onPost?: (url: string, body: unknown) => unknown) {
  const post = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body)
        post(url, body)
        return { ok: true, status: 200, json: async () => onPost?.(url, body) ?? {} }
      }
      const body = url.includes('addon-runtime') ? ROWS : updates
      return { ok: true, status: 200, json: async () => body }
    }),
  )
  return post
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mount = () => render(<AddonsPanel locked={false} onUnauthorized={() => undefined} />)

describe('one addon list', () => {
  it('lists each addon with its runner, shared runners, and a runner with no addon', async () => {
    stub({ available: true, entries: [], error: null, hubVersions: 'known' })
    mount()
    await screen.findByText('ml-a')
    expect(screen.getByText('decoder')).toBeTruthy()
    expect(screen.getAllByText('ml · pid 22')).toHaveLength(1)
    expect(screen.getByText('shared with 1 other')).toBeTruthy()
    expect(screen.getByText('runner without a known addon')).toBeTruthy()
    expect(screen.getByText('ghost')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/No child processes/)
  })
})

describe('Update goes to the hub', () => {
  const behind = updateRow({ installedVersion: '1.0.0', hubVersion: '1.1.0', behindHub: true })

  it('offers it only where the hub is newer, and posts the package to the hub route', async () => {
    const post = stub({ available: true, entries: [behind], error: null, hubVersions: 'known' })
    mount()
    const button = await screen.findByText('Update to 1.1.0')
    expect(screen.queryAllByText(/Update to/)).toHaveLength(1)
    fireEvent.click(button)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/agent/addon-updates/update', {
        packageName: '@camstack/addon-d',
      }),
    )
  })

  it('shows why the hub refused', async () => {
    stub({
      available: true,
      entries: [
        {
          ...behind,
          update: {
            status: 'failed',
            targetVersion: '1.1.0',
            message: '"addons.updatePackage" is not on the remote privilege grant',
          },
        },
      ],
      error: null,
      hubVersions: 'known',
    })
    mount()
    await screen.findByText(/not on the remote privilege grant/)
  })

  it('shows a start refusal from the agent', async () => {
    stub({ available: true, entries: [behind], error: null, hubVersions: 'known' }, () => ({
      started: false,
      message: 'The hub does not install @camstack/addon-d',
    }))
    mount()
    fireEvent.click(await screen.findByText('Update to 1.1.0'))
    await screen.findByText('The hub does not install @camstack/addon-d')
  })

  it('says when the hub versions are unknown instead of showing aligned', async () => {
    stub({ available: true, entries: [], error: null, hubVersions: 'unanswered' })
    mount()
    await screen.findByText(
      'The hub did not answer, so the versions this node should run are unknown.',
    )
    expect(document.body.textContent).not.toMatch(/core-caps|not found on/)
  })

  it('an unpaired agent shows a neutral line, not a warning', async () => {
    stub({ available: true, entries: [], error: null, hubVersions: 'unpaired' })
    mount()
    await screen.findByText('Addon versions follow the hub once this agent is paired.')
    expect(document.body.textContent).not.toMatch(/did not answer/)
  })
})
