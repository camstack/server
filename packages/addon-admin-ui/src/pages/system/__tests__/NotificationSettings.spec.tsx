/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const FORM: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'alerts',
      title: 'Alerts',
      fields: [{ type: 'text', key: 'digestTitle', label: 'Digest title', value: 'Daily digest' }],
    },
  ],
}
const query = vi.fn(async () => FORM)
const mutate = vi.fn(async () => ({ success: true }))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addonSettings: {
          getScopedSettings: { query },
          updateScopedSettings: { mutate },
        },
      },
    }),
  }
})

import { NotificationSettingsPage } from '../NotificationSettings'

describe('System → Notifications → Settings', () => {
  it("draws the alert center's cluster form, asked through the scoped read", async () => {
    render(<NotificationSettingsPage />)
    expect(await screen.findByDisplayValue('Daily digest')).toBeInTheDocument()
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith({
        addonId: 'alert-center',
        cap: 'alerts',
        scope: 'cluster',
      }),
    )
  })
})
