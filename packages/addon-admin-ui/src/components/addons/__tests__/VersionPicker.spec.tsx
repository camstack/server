/**
 * VersionPicker — same-version reinstall from npm (Task 9).
 */

import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockVersions: Array<{
  version: string
  publishedAt: string
  distTags: string[]
  deprecated?: string | boolean
}> = []

interface MockButtonProps {
  readonly children: ReactNode
  readonly onClick?: () => void
}

vi.mock('@camstack/ui-library', () => ({
  Button: ({ children, onClick }: MockButtonProps) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  useAddonsGetVersions: () => ({ data: mockVersions, isLoading: false }),
}))

import { VersionPicker } from '../VersionPicker'

describe('VersionPicker same-version reinstall', () => {
  beforeEach(() => {
    mockVersions = [
      { version: '1.0.0', publishedAt: '2026-05-01', distTags: ['latest'], deprecated: false },
      { version: '0.9.0', publishedAt: '2026-04-01', distTags: [], deprecated: false },
    ]
  })

  it('current npm-sourced row offers Re-install and calls onInstall with that version', () => {
    const onInstall = vi.fn()
    render(
      <VersionPicker
        packageName="@camstack/addon-a"
        currentVersion="1.0.0"
        installSource="npm"
        onInstall={onInstall}
        onClose={vi.fn()}
      />,
    )

    const reinstall = screen.getByTitle('Re-install 1.0.0 from npm')
    expect(reinstall).toBeTruthy()
    fireEvent.click(reinstall)
    expect(onInstall).toHaveBeenCalledWith('1.0.0')
  })

  it('current row with absent installSource still offers Re-install (registry default)', () => {
    const onInstall = vi.fn()
    render(
      <VersionPicker
        packageName="@camstack/addon-a"
        currentVersion="1.0.0"
        onInstall={onInstall}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('Re-install 1.0.0 from npm'))
    expect(onInstall).toHaveBeenCalledWith('1.0.0')
  })

  it('hides deprecated versions until the operator asks for older ones', () => {
    mockVersions = [
      { version: '2.0.0', publishedAt: '2026-10-01', distTags: ['latest'], deprecated: false },
      {
        version: '1.0.0',
        publishedAt: '2026-01-01',
        distTags: [],
        deprecated: 'please use latest',
      },
    ]
    render(
      <VersionPicker
        packageName="@camstack/addon-a"
        currentVersion="2.0.0"
        onInstall={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByText('1.0.0')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show older versions/i }))
    expect(screen.getByText('1.0.0')).toBeTruthy()
    expect(screen.getByText('deprecated')).toBeTruthy()
  })
})
