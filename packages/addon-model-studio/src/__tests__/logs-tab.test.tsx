// @vitest-environment jsdom
/**
 * LogsTab mounts the shared LogStream scoped to model-studio.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LogsTab } from '../tabs/LogsTab.js'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    LogStream: ({ addonId }: { addonId: string }) => (
      <div data-testid="log-stream" data-addon-id={addonId} />
    ),
  }
})

afterEach(cleanup)

describe('LogsTab', () => {
  it('shows the model-studio addon log stream', () => {
    render(<LogsTab />)
    expect(screen.getByTestId('logs-tab')).toBeTruthy()
    const stream = screen.getByTestId('log-stream')
    expect(stream.getAttribute('data-addon-id')).toBe('model-studio')
  })
})
