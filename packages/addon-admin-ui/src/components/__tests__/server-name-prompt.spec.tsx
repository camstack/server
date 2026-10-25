// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ServerNamePrompt (D861) visibility and behaviour:
 *   - shown for a signed-in ADMIN when the hub ANSWERED and the name is the
 *     hostname default (`isDefault: true`), prefilled with that hostname;
 *   - never for a non-admin, never once a name is set, never while the hub has
 *     not answered;
 *   - Save writes `{ name }` to the system-config settings, trimmed;
 *   - Later closes it for this browser session only (sessionStorage).
 */

const mutateAsync = vi.fn<(input: unknown) => Promise<unknown>>()
let authUser: { id: string; username: string; isAdmin: boolean } | null = null
let info: { name: string; isDefault: boolean } | null = null

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useAddonSettingsUpdateGlobalSettings: () => ({ mutateAsync, isPending: false }),
  }
})

vi.mock('../../hooks/use-server-name', () => ({
  useServerName: () => ({ info, isLoading: false }),
}))

vi.mock('../../contexts/auth-context', () => ({
  useAuth: () => ({ user: authUser }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

import {
  isServerNamePromptDismissed,
  ServerNamePrompt,
  shouldPromptForServerName,
} from '../system/ServerNamePrompt'

function renderPrompt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ServerNamePrompt />
    </QueryClientProvider>,
  )
}

const TITLE = 'Name this server'

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  authUser = { id: 'u-1', username: 'root', isAdmin: true }
  info = { name: 'nas', isDefault: true }
  mutateAsync.mockResolvedValue({})
})

afterEach(() => cleanup())

describe('shouldPromptForServerName (the isDefault gate)', () => {
  const base = { isAdmin: true, info: { name: 'nas', isDefault: true }, dismissed: false }

  it('prompts an admin on an unnamed hub', () => {
    expect(shouldPromptForServerName(base)).toBe(true)
  })

  it('does not prompt when the name is set (isDefault false)', () => {
    expect(shouldPromptForServerName({ ...base, info: { name: 'Casa', isDefault: false } })).toBe(
      false,
    )
  })

  it('does not prompt a non-admin, an unanswered hub, or a dismissed session', () => {
    expect(shouldPromptForServerName({ ...base, isAdmin: false })).toBe(false)
    expect(shouldPromptForServerName({ ...base, info: null })).toBe(false)
    expect(shouldPromptForServerName({ ...base, dismissed: true })).toBe(false)
  })
})

describe('ServerNamePrompt', () => {
  it('shows for an admin when the name is unset, prefilled with the hostname', () => {
    renderPrompt()
    expect(screen.getByText(TITLE)).toBeTruthy()
    expect((screen.getByLabelText('Server name') as HTMLInputElement).value).toBe('nas')
  })

  it('focuses the name input when it opens', () => {
    renderPrompt()
    expect(document.activeElement).toBe(screen.getByLabelText('Server name'))
  })

  it('does not show for a non-admin', () => {
    authUser = { id: 'u-2', username: 'viewer', isAdmin: false }
    renderPrompt()
    expect(screen.queryByText(TITLE)).toBeNull()
  })

  it('does not show once the name is set', () => {
    info = { name: 'Casa Napoli', isDefault: false }
    renderPrompt()
    expect(screen.queryByText(TITLE)).toBeNull()
  })

  it('does not show while the hub has not answered', () => {
    info = null
    renderPrompt()
    expect(screen.queryByText(TITLE)).toBeNull()
  })

  it('Save writes the trimmed name to the system-config settings', async () => {
    renderPrompt()
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: '  Casa Napoli  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({
      addonId: 'system-config',
      nodeId: 'hub',
      patch: { name: 'Casa Napoli' },
    })
  })

  it('refuses a name with control characters and writes nothing', async () => {
    renderPrompt()
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Casa\u0007' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/control characters/)).toBeTruthy()
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('shows the hub error when the save is refused', async () => {
    mutateAsync.mockRejectedValue(new Error('settings store is down'))
    renderPrompt()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('settings store is down')).toBeTruthy()
  })

  it('Later dismisses for this browser session only', () => {
    renderPrompt()
    expect(isServerNamePromptDismissed()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText(TITLE)).toBeNull()
    expect(isServerNamePromptDismissed()).toBe(true)
    expect(localStorage.length).toBe(0)
    expect(mutateAsync).not.toHaveBeenCalled()

    // A new session (empty sessionStorage) asks again.
    cleanup()
    sessionStorage.clear()
    renderPrompt()
    expect(screen.getByText(TITLE)).toBeTruthy()
  })

  it('stays away in a session that already dismissed it', () => {
    sessionStorage.setItem('camstack_server_name_prompt_dismissed', '1')
    renderPrompt()
    expect(screen.queryByText(TITLE)).toBeNull()
  })
})
