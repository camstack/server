/**
 * assignResult with two form keys must land in one parent update. FormBuilder
 * used to call onChange once per key from the same values snapshot; the second
 * setState won and dropped sslCertificate (Bosch SHC pairing).
 *
 * Disarm: revert FormBuilder batch onChangeMany — only sslKey survives.
 */
// @vitest-environment jsdom
import type { ConfigUISchema } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FormBuilder } from '../FormBuilder'

const schema: ConfigUISchema = {
  sections: [
    {
      id: 'pair',
      title: 'Pair',
      fields: [
        {
          type: 'addon-action-button',
          key: '__register',
          label: 'Register',
          addonId: 'bosch-shc',
          action: 'registerClient',
          buttonLabel: 'Register on controller',
          assignResult: { sslCertificate: 'sslCertificate', sslKey: 'sslKey' },
          successMessage: 'Registered.',
        },
      ],
    },
  ],
}

function PairingHarness() {
  const [values, setValues] = useState<Record<string, unknown>>({ host: '192.0.2.20' })
  const onAction = vi.fn(async () => ({
    sslCertificate: 'CERT',
    sslKey: 'KEY',
  }))
  return (
    <>
      <FormBuilder schema={schema} values={values} onChange={setValues} onAction={onAction} />
      <pre data-testid="values-json">{JSON.stringify(values)}</pre>
    </>
  )
}

describe('FormBuilder.assignResult batch', () => {
  it('keeps every assignResult string when two keys update at once', async () => {
    render(
      <ConfirmDialogProvider>
        <PairingHarness />
      </ConfirmDialogProvider>,
    )
    fireEvent.click(screen.getByText('Register on controller'))
    await waitFor(() => expect(screen.getByText('Registered.')).toBeInTheDocument())
    const parsed = JSON.parse(screen.getByTestId('values-json').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(parsed.sslCertificate).toBe('CERT')
    expect(parsed.sslKey).toBe('KEY')
  })
})
