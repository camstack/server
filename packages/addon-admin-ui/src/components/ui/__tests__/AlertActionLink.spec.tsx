/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const startServerNavigation = vi.fn()
vi.mock('../../../lib/broker-oauth-popup', () => ({
  startServerNavigation: (...args: unknown[]) => startServerNavigation(...args),
}))

const custom = vi.fn()
vi.mock('../../../lib/mount', () => ({ hubPath: (path: string) => path }))
vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ trpcClient: { addons: { custom: { mutate: custom } } } }),
}))

import { hasUsableAction, isServerAlertAction } from '../critical-alerts'
import { AlertActionLink } from '../AlertActionLink'
import type { UsableAlertAction } from '../critical-alerts'

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderLink(action: UsableAlertAction) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AlertActionLink action={action} className="x" />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  startServerNavigation.mockClear()
  custom.mockReset()
})

describe('isServerAlertAction', () => {
  it('trusts the explicit navigation field', () => {
    expect(
      isServerAlertAction({
        label: 'x',
        href: '/anything',
        navigation: 'server',
      }),
    ).toBe(true)
    expect(
      isServerAlertAction({
        label: 'x',
        href: '/addon/a/oauth/start',
        navigation: 'app',
      }),
    ).toBe(false)
  })

  it('treats an addon OAuth route stored WITHOUT the field as a server route (alerts already persisted)', () => {
    expect(
      isServerAlertAction({
        label: 'x',
        href: '/addon/google-services/oauth/start?brokerId=google_001',
      }),
    ).toBe(true)
  })

  it('leaves admin pages and addon PAGES (/addon/:pagePath) to the router', () => {
    expect(isServerAlertAction({ label: 'x', href: '/system/integrations' })).toBe(false)
    expect(isServerAlertAction({ label: 'x', href: '/addon/model-studio' })).toBe(false)
  })
})

describe('AlertActionLink', () => {
  it('a server action leaves the SPA through the broker popup/navigation, not the router', () => {
    renderLink({
      label: 'Sign in again',
      href: '/addon/google-services/oauth/start?brokerId=google_001',
      navigation: 'server',
    })
    fireEvent.click(screen.getByRole('link', { name: 'Sign in again' }))
    expect(startServerNavigation).toHaveBeenCalledWith(
      '/addon/google-services/oauth/start?brokerId=google_001',
      expect.any(Function),
    )
    expect(screen.getByTestId('where')).toHaveTextContent('/start')
  })

  it('a stored alert with no navigation field still does a server navigation', () => {
    renderLink({
      label: 'Go',
      href: '/addon/google-services/oauth/start?brokerId=g',
    })
    fireEvent.click(screen.getByRole('link', { name: 'Go' }))
    expect(startServerNavigation).toHaveBeenCalledTimes(1)
  })

  it('an admin route is a client-side router link', () => {
    renderLink({ label: 'Open', href: '/devices' })
    fireEvent.click(screen.getByRole('link', { name: 'Open' }))
    expect(startServerNavigation).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/devices')
  })
})

describe('an invoke action', () => {
  const invoke = {
    addonId: 'pipeline-orchestrator',
    action: 'rebalanceNow',
    input: { a: 1 },
  }

  it('is a usable action even with no href, and an empty action is not', () => {
    expect(hasUsableAction({ label: 'Go', invoke })).toBe(true)
    expect(hasUsableAction({ label: 'Go' })).toBe(false)
    expect(hasUsableAction({ label: 'Go', href: '' })).toBe(false)
    expect(hasUsableAction(undefined)).toBe(false)
  })

  it('is a button that calls addons.custom with the producer fields, then refreshes alerts', async () => {
    custom.mockResolvedValue({ ok: true })
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AlertActionLink action={{ label: 'Rebalance now', invoke }} className="x" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rebalance now' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [['alerts']] }))
    expect(custom).toHaveBeenCalledWith(invoke)
    expect(startServerNavigation).not.toHaveBeenCalled()
  })

  it('shows the failure and does not refresh when the call rejects', async () => {
    custom.mockRejectedValue(new Error('runner offline'))
    renderLink({ label: 'Rebalance now', invoke })
    fireEvent.click(screen.getByRole('button', { name: 'Rebalance now' }))
    expect(await screen.findByText(/runner offline/)).toBeInTheDocument()
  })
})
