/**
 * The `apple-foundation` editor: a node picker restricted to nodes that
 * REPORTED `available`, with every other node shown disabled next to its
 * reason — and an unanswered node shown as `unknown`, never as absent (D315).
 *
 * The picker is a PROVIDER widget (`ai/apple-node`) the descriptor names; the
 * editor itself has no Apple branch (D893). The descriptor below mirrors the
 * one addon-ai declares.
 */
import type { LlmProfile, LlmProfileKindDescriptor, LlmRuntimeNode } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

let mockNodes: LlmRuntimeNode[] = []

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}))

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        llm: { listRuntimeNodes: { query: vi.fn(() => Promise.resolve(mockNodes)) } },
      },
    }),
  }
})

const { ProfileEditorDialog } = await import('../AiProfileEditor')

const APPLE_KIND: LlmProfileKindDescriptor = {
  kind: 'apple-foundation',
  label: 'Apple on-device (Foundation Models)',
  icon: 'cpu',
  addonId: 'ai',
  connectionSchema: { sections: [] },
  features: { vision: false, tools: false, streaming: false },
  visionEditable: false,
  modelCatalog: 'static',
  staticModels: [{ id: 'apple-system', label: 'Apple on-device model' }],
  profileFields: ['temperature', 'topP', 'topK', 'maxTokens', 'systemPrompt', 'timeoutMs'],
  providerWidgets: [{ id: 'ai/apple-node', placement: 'connection', requires: ['nodeId'] }],
}

function stubDialog(): void {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
}

function renderEditor(onSave: (p: LlmProfile) => void): void {
  stubDialog()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ProfileEditorDialog
        kind={APPLE_KIND}
        existing={null}
        onSave={onSave}
        onCancel={() => undefined}
        saving={false}
        error={null}
      />
    </QueryClientProvider>,
  )
}

describe('ProfileEditorDialog — apple-foundation', () => {
  it('only an available Mac can be picked, and saving stores that node', async () => {
    mockNodes = [
      {
        nodeId: 'mac',
        reachable: true,
        apple: {
          state: 'available',
          osVersion: '26.3.1',
          contextSize: 4096,
          languages: ['it-IT'],
          imageInput: false,
        },
      },
      {
        nodeId: 'hub',
        reachable: true,
        apple: { state: 'unsupported-platform', platform: 'linux' },
      },
      { nodeId: 'silent', reachable: true },
    ]
    const onSave = vi.fn()
    renderEditor(onSave)

    const mac = await screen.findByRole('radio', { name: /mac/ })
    const hub = screen.getByRole('radio', { name: /hub/ })
    const silent = screen.getByRole('radio', { name: /silent/ })
    expect(hub).toBeDisabled()
    expect(hub.textContent).toContain('not a Mac')
    expect(silent).toBeDisabled()
    expect(silent.textContent).toContain('unknown')

    const create = screen.getByRole('button', { name: /Create profile/ })
    expect(create).toBeDisabled()
    fireEvent.click(mac)
    expect(create).not.toBeDisabled()
    fireEvent.click(create)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'apple-foundation',
        model: 'apple-system',
        providerConfig: { nodeId: 'mac' },
        supportsVision: false,
      }),
    )
  })
})
