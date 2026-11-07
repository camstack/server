/// <reference types="@testing-library/jest-dom" />
/**
 * The fixed settings mounts ask the scoped read for the exact `(addonId, cap, scope)` the owning
 * addon declares (`scopedSettingsCapabilities()`), and draw what it answers. A wrong cap or scope
 * answers `null` in production, so each pin below is what keeps the form from going blank.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const formOf = (sectionId: string, label: string): ConfigUISchemaWithValues => ({
  sections: [
    {
      id: sectionId,
      title: sectionId,
      fields: [{ type: 'text', key: `k-${sectionId}`, label, value: `value of ${label}` }],
    },
  ],
})

const query = vi.fn(async (input: { addonId: string }) => {
  if (input.addonId === 'local-network') return formOf('local-access', 'LAN field')
  if (input.addonId === 'terminal') return formOf('terminal', 'Terminal field')
  return {
    sections: [
      ...formOf('webauthn', 'Passkey field').sections,
      ...formOf('another-section', 'Other section field').sections,
    ],
  }
})
const mutate = vi.fn(async () => ({ success: true }))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: { getScopedSettings: { query }, updateScopedSettings: { mutate } },
      },
    }),
  }
})

import { PasskeyRelyingPartyCard } from '../Authentication'
import { LocalAccessPage } from '../LocalAccess'
import { TerminalNodeSettings } from '../terminal/TerminalNodeSettings'

afterEach(() => {
  cleanup()
  query.mockClear()
})

describe('fixed scoped settings mounts', () => {
  it('Local access: local-network, node scope, the hub node', async () => {
    render(
      <MemoryRouter>
        <LocalAccessPage />
      </MemoryRouter>,
    )
    expect(await screen.findByDisplayValue('value of LAN field')).toBeInTheDocument()
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith({
        addonId: 'local-network',
        cap: 'local-network',
        scope: 'node',
        nodeId: 'hub',
      }),
    )
  })

  it('Terminal configuration: terminal-session, node scope, the selected node', async () => {
    render(<TerminalNodeSettings nodeId="edge-1" />)
    expect(await screen.findByDisplayValue('value of Terminal field')).toBeInTheDocument()
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith({
        addonId: 'terminal',
        cap: 'terminal-session',
        scope: 'node',
        nodeId: 'edge-1',
      }),
    )
  })

  it('Passkey relying party: auth-webauthn login-method, cluster scope, the webauthn section only', async () => {
    render(<PasskeyRelyingPartyCard />)
    expect(await screen.findByDisplayValue('value of Passkey field')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('value of Other section field')).toBeNull()
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith({
        addonId: 'auth-webauthn',
        cap: 'login-method',
        scope: 'cluster',
      }),
    )
  })
})
