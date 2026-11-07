// @vitest-environment jsdom
/**
 * Persist-mode edits must keep the focused control enabled. Disabling the
 * form while `updateScopedSettings` runs blurred text inputs on every
 * keystroke (mobile keyboard closed) — Training Modal entry Name.
 */
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AddonScopedSettingsForm } from '../addon-scoped-settings-form'

const SCHEMA: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'main',
      title: 'Main',
      fields: [
        {
          type: 'text',
          key: 'displayName',
          label: 'Name',
          value: 'Default',
        },
      ],
    },
  ],
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('AddonScopedSettingsForm persist edits', () => {
  it('keeps the Name input enabled while a save is in flight', async () => {
    const gate = deferred<unknown>()
    let stored = SCHEMA
    const mutate = vi.fn(async (input: { patch: Record<string, unknown> }) => {
      stored = {
        ...SCHEMA,
        sections: SCHEMA.sections.map((s) => ({
          ...s,
          fields: s.fields.map((f) =>
            f.type === 'text' && f.key === 'displayName'
              ? { ...f, value: String(input.patch['displayName'] ?? '') }
              : f,
          ),
        })),
      }
      await gate.promise
    })
    const query = vi.fn(async () => stored)
    const trpc = {
      addonSettings: {
        getScopedSettings: { query },
        updateScopedSettings: { mutate },
      },
    }

    render(
      <AddonScopedSettingsForm
        trpc={trpc}
        addonId="training-modal"
        cap="training-provider"
        scope="cluster"
      />,
    )

    const input = (await screen.findByDisplayValue('Default')) as HTMLInputElement
    expect(input.disabled).toBe(false)

    fireEvent.change(input, { target: { value: 'Staging' } })

    await waitFor(() => expect(mutate).toHaveBeenCalled())
    expect(mutate).toHaveBeenCalledWith({
      addonId: 'training-modal',
      cap: 'training-provider',
      scope: 'cluster',
      patch: { displayName: 'Staging' },
    })
    expect(query).toHaveBeenCalledWith({
      addonId: 'training-modal',
      cap: 'training-provider',
      scope: 'cluster',
    })
    const duringSave = screen.getByDisplayValue('Staging') as HTMLInputElement
    expect(duringSave.disabled).toBe(false)
    expect(screen.getByText('Saving…')).toBeTruthy()

    await act(async () => {
      gate.resolve({})
    })
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull())
    expect((screen.getByDisplayValue('Staging') as HTMLInputElement).disabled).toBe(false)
  })
})

describe('AddonScopedSettingsForm target change', () => {
  it('does not show the previous node values under a node that answers nothing', async () => {
    const query = vi.fn(async (input: { nodeId?: string }) =>
      input.nodeId === 'node-a' ? SCHEMA : null,
    )
    const trpc = {
      addonSettings: {
        getScopedSettings: { query },
        updateScopedSettings: { mutate: vi.fn(async () => ({})) },
      },
    }
    const form = (nodeId: string) => (
      <AddonScopedSettingsForm
        trpc={trpc}
        addonId="terminal"
        cap="terminal-session"
        scope="node"
        nodeId={nodeId}
        bare
      />
    )
    const view = render(form('node-a'))
    expect(await screen.findByDisplayValue('Default')).toBeTruthy()

    view.rerender(form('node-b'))
    await waitFor(() => expect(screen.getByText(/not available/)).toBeTruthy())
    expect(screen.queryByDisplayValue('Default')).toBeNull()
  })

  it("shows the caller's unavailableText instead of the default when the addon answers nothing", async () => {
    const trpc = {
      addonSettings: {
        getScopedSettings: { query: vi.fn(async () => null) },
        updateScopedSettings: { mutate: vi.fn(async () => ({})) },
      },
    }
    render(
      <AddonScopedSettingsForm
        trpc={trpc}
        addonId="auth-webauthn"
        cap="login-method"
        scope="cluster"
        unavailableText="Custom unavailable line"
        bare
      />,
    )
    expect(await screen.findByText('Custom unavailable line')).toBeTruthy()
    expect(screen.queryByText(/not available\./)).toBeNull()
  })
})
