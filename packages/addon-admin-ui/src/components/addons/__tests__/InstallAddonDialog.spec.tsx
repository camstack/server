import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

interface PackageDocFixture {
  readonly status: 'ok' | 'missing' | 'error'
  readonly markdown?: string
  readonly message?: string
}

interface PackageDocsFixture {
  readonly name: string
  readonly version: string
  readonly readme: PackageDocFixture
  readonly changelog: PackageDocFixture
}

const docs: PackageDocsFixture = {
  name: '@camstack/addon-tailscale',
  version: '1.4.2',
  readme: { status: 'ok', markdown: '# Tailscale\n\nConnects the hub.' },
  changelog: { status: 'missing' },
}

let docsState: {
  data: PackageDocsFixture | undefined
  isPending: boolean
  isError: boolean
} = { data: docs, isPending: false, isError: false }

vi.mock('@camstack/ui-library', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Select: ({
    value,
    options,
    onChange,
    'aria-label': ariaLabel,
  }: {
    value: string
    options: readonly { value: string; label: string }[]
    onChange: (event: { target: { value: string } }) => void
    'aria-label': string
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAddonsGetVersions: () => ({
    data: [
      { version: '1.4.2', publishedAt: '2026-10-01', distTags: ['latest'] },
      { version: '1.0.0', publishedAt: '2026-01-01', distTags: [], deprecated: 'old' },
    ],
    isLoading: false,
    isError: false,
  }),
  useAddonsGetPackageDocs: () => docsState,
}))

import { InstallAddonDialog } from '../InstallAddonDialog'

const target = {
  name: '@camstack/addon-tailscale',
  version: '1.4.2',
  description: 'Tailnet client',
}

describe('InstallAddonDialog', () => {
  it('shows the readme and a missing changelog, and installs the selected version', () => {
    docsState = { data: docs, isPending: false, isError: false }
    const onInstall = vi.fn()
    render(
      <InstallAddonDialog
        target={target}
        installing={false}
        onClose={vi.fn()}
        onInstall={onInstall}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Tailscale' })).toBeTruthy()
    expect(screen.getByText('Connects the hub.')).toBeTruthy()
    expect(screen.getByText('This package has no CHANGELOG.')).toBeTruthy()
    expect(screen.queryByRole('option', { name: '1.0.0 (deprecated)' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show older versions (1)' }))
    expect(screen.getByRole('option', { name: '1.0.0 (deprecated)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(onInstall).toHaveBeenCalledWith('@camstack/addon-tailscale', '1.4.2')
  })

  it('shows a registry error on the document instead of an empty page', () => {
    docsState = {
      data: {
        ...docs,
        readme: { status: 'error', message: 'registry GET @camstack/addon-tailscale → 503' },
        changelog: { status: 'error', message: 'registry GET @camstack/addon-tailscale → 503' },
      },
      isPending: false,
      isError: false,
    }
    render(
      <InstallAddonDialog
        target={target}
        installing={false}
        onClose={vi.fn()}
        onInstall={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/registry GET @camstack\/addon-tailscale → 503/).length).toBe(2)
    expect(screen.queryByText('Connects the hub.')).toBeNull()
  })
})
