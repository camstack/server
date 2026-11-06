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

describe('AddonGlobalSettingsForm narrowSchema', () => {
  const TWO_FIELDS: ConfigUISchemaWithValues = {
    sections: [
      {
        id: 'main',
        title: 'Main',
        fields: [
          { type: 'text', key: 'clusterKey', label: 'Cluster field', value: 'a' },
          { type: 'text', key: 'nodeKey', label: 'Node field', value: 'b' },
        ],
      },
    ],
  }
  const dropNodeField = (schema: ConfigUISchemaWithValues): ConfigUISchemaWithValues => ({
    ...schema,
    sections: schema.sections.map((s) => ({
      ...s,
      fields: s.fields.filter((f) => !('key' in f) || f.key !== 'nodeKey'),
    })),
  })

  it('draws only the fields the surface is entitled to, on read and re-read', async () => {
    const query = vi.fn(async () => TWO_FIELDS)
    const mutate = vi.fn(async () => ({}))
    const trpc = {
      addonSettings: { getGlobalSettings: { query }, updateGlobalSettings: { mutate } },
    }
    render(
      <AddonGlobalSettingsForm trpc={trpc} addonId="x" nodeId="hub" narrowSchema={dropNodeField} />,
    )
    const input = await screen.findByDisplayValue('a')
    expect(screen.queryByDisplayValue('b')).toBeNull()
    fireEvent.change(input, { target: { value: 'c' } })
    await waitFor(() => expect(mutate).toHaveBeenCalled())
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    expect(screen.queryByDisplayValue('b')).toBeNull()
  })
})
