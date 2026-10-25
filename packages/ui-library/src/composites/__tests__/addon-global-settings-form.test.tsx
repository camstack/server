// @vitest-environment jsdom
/**
 * Persist-mode edits must keep the focused control enabled. Disabling the
 * form while `updateGlobalSettings` runs blurred text inputs on every
 * keystroke (mobile keyboard closed) — Training Modal entry Name.
 */
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AddonGlobalSettingsForm } from '../addon-global-settings-form'

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

describe('AddonGlobalSettingsForm persist edits', () => {
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
        getGlobalSettings: { query },
        updateGlobalSettings: { mutate },
      },
    }

    render(<AddonGlobalSettingsForm trpc={trpc} addonId="training-modal" nodeId="hub" />)

    const input = (await screen.findByDisplayValue('Default')) as HTMLInputElement
    expect(input.disabled).toBe(false)

    fireEvent.change(input, { target: { value: 'Staging' } })

    await waitFor(() => expect(mutate).toHaveBeenCalled())
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
