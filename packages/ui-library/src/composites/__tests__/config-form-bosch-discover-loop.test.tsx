// @vitest-environment jsdom
/**
 * Add integration → Bosch SHC. The discover select loads immediately, and the
 * parent (ProviderConfigForm) passes a new `onAction` every render because
 * the mutation's pending flag updates that parent. The effect must not treat
 * the new function as a reason to call the action again — that is React #185.
 *
 * Disarm: put `onAction` back in AddonActionSelectField's effect deps — this
 * throws "Maximum update depth exceeded".
 */
import type { ConfigField } from '@camstack/types'
import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { ConfirmDialogProvider } from '../confirm-dialog'
import { FormField } from '../config-form-field'

/**
 * The connection section from `addon-provider-bosch` `buildConnectionFormSchema`.
 * Inlined so this package's typecheck does not pull the addon into its program.
 */
const fields: readonly ConfigField[] = [
  {
    type: 'addon-action-select',
    addonId: 'bosch-shc',
    key: '__shc-discovered',
    writesKey: 'host',
    omitFromSettings: true,
    label: 'Controller',
    action: 'discoverController',
    mapOption: { value: 'host', label: 'name' },
    hideWhenFewerThan: 2,
    emptyResultsMessage: 'No controller found on the network.',
  },
  {
    type: 'text',
    key: 'host',
    label: 'Host',
    required: false,
    placeholder: '192.0.2.20',
  },
  {
    type: 'info',
    key: '__shc-pairing-hint',
    label: 'Pair with the controller',
    content:
      'Press the button on the controller until the LED blinks. Enter the password you created in the Bosch Smart Home app, not the code printed on the controller, then register.',
  },
  {
    type: 'password',
    key: 'systemPassword',
    label: 'System password',
    required: true,
    showToggle: true,
  },
  {
    type: 'addon-action-button',
    addonId: 'bosch-shc',
    key: '__shc-register',
    label: 'Client registration',
    buttonLabel: 'Register on controller',
    action: 'registerClient',
    variant: 'primary',
    paramsFromForm: { host: 'host', systemPassword: 'systemPassword' },
    assignResult: { sslCertificate: 'sslCertificate', sslKey: 'sslKey', token: 'token' },
    successMessage: '{summary}',
  },
  {
    type: 'group',
    key: '__shc-advanced',
    label: 'Advanced',
    style: 'accordion',
    defaultCollapsed: true,
    fields: [
      {
        type: 'secret-presence',
        key: '__shc-registered',
        label: 'Client registration',
        sourceKey: 'sslCertificate',
        yesLabel: 'Client registered: yes',
        noLabel: 'Client registered: no',
      },
      {
        type: 'addon-action-button',
        addonId: 'bosch-shc',
        key: '__shc-reregister',
        label: 'Register again',
        buttonLabel: 'Register again',
        action: 'registerClient',
        paramsFromForm: { host: 'host', systemPassword: 'systemPassword' },
        assignResult: { sslCertificate: 'sslCertificate', sslKey: 'sslKey', token: 'token' },
        successMessage: '{summary}',
      },
    ],
  },
  {
    type: 'password',
    key: 'token',
    label: 'Controller token',
    required: false,
    showToggle: false,
    showWhen: { field: 'host', equals: '__pairing_only__' },
  },
  {
    type: 'password',
    key: 'sslCertificate',
    label: 'Client certificate (PEM)',
    required: false,
    showToggle: true,
    showWhen: { field: 'host', equals: '__pairing_only__' },
  },
  {
    type: 'password',
    key: 'sslKey',
    label: 'Client private key (PEM)',
    required: false,
    showToggle: true,
    showWhen: { field: 'host', equals: '__pairing_only__' },
  },
]

interface CallCount {
  n: number
}

interface BoschCreateFormProps {
  readonly calls: CallCount
}

function BoschCreateForm({ calls }: BoschCreateFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  // Each action bumps a counter, the way a mutation goes pending then settles:
  // the update never bails out, so a new onAction every render re-enters the
  // effect forever unless the effect ignores the function's identity.
  const [, setTick] = useState(0)
  return (
    <>
      {fields.map((field) => (
        <FormField
          key={field.key}
          field={field}
          values={values}
          allFields={fields}
          onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
          onChangeMany={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
          onAction={async () => {
            calls.n += 1
            // Stop feeding the loop so a red run fails the assertion instead of
            // hanging. Production throws React #185; development only logs it
            // and keeps going.
            if (calls.n < 30) setTick((tick) => tick + 1)
            return { controllers: [{ host: '192.0.2.20', name: 'Lab controller' }] }
          }}
        />
      ))}
    </>
  )
}

describe('Bosch SHC create form', () => {
  it('discovers once and fills the single controller host', async () => {
    const calls = { n: 0 }
    render(
      <ConfirmDialogProvider>
        <BoschCreateForm calls={calls} />
      </ConfirmDialogProvider>,
    )
    await waitFor(() => expect(screen.getByDisplayValue('192.0.2.20')).toBeTruthy())
    expect(calls.n).toBeLessThanOrEqual(2)
    expect(screen.getByText('Host')).toBeTruthy()
  })
})
