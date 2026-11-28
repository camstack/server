/**
 * Editing an existing instance: the account-sign-in field's "Sign out" / "Sign in again" reach the
 * providing addon through `addons.custom`, naming the instance, exactly like the wizard's form.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { configure, fireEvent, getConfig, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../brokers/__tests__/setup'

const mutateAsync = vi.hoisted(() => vi.fn(async () => ({ signedOut: true, summary: 'ok' })))

const FORM = {
  sections: [
    {
      id: 'account',
      title: 'Account',
      columns: 1,
      fields: [
        {
          type: 'account-sign-in',
          addonId: 'bosch-homecom',
          key: '__homecom-sign-in',
          label: 'HomeCom',
          providerLabel: 'SingleKey ID',
          beginAction: 'beginSignIn',
          completeAction: 'finishSignIn',
          signOutAction: 'signOut',
          accountKey: 'accountLabel',
          secretKeys: ['token', 'refresh'],
        },
      ],
    },
  ],
}

vi.mock('@dominevo/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@dominevo/ui-library')>('@dominevo/ui-library')
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        addons: { custom: { mutate: mutateAsync } },
        integrationInstances: {
          instanceFormSchema: { query: async () => FORM },
          updateInstance: { mutate: async () => ({}) },
        },
      },
    }),
  }
})

import { InstanceEditorDialog } from '../InstanceEditorDialog'

/**
 * The dialog mounts after an async schema query and a large jsdom tree, and
 * `findByRole` walks the whole accessibility tree on every poll: under a
 * saturated machine (parallel verify lanes) one poll alone exceeds Testing
 * Library's 1 s default, so the wait gave up before the form had rendered. The
 * waits below resolve the moment their condition holds, so this ceiling only
 * bounds a real failure — it never slows a passing run.
 */
const ASYNC_UTIL_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 30_000
let previousAsyncUtilTimeout = 1000
beforeAll(() => {
  previousAsyncUtilTimeout = getConfig().asyncUtilTimeout
  configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS })
})
afterAll(() => {
  configure({ asyncUtilTimeout: previousAsyncUtilTimeout })
})

afterEach(() => {
  mutateAsync.mockClear()
})

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <InstanceEditorDialog
        addonId="bosch-homecom"
        providerName="Bosch HomeCom"
        description={{
          role: 'devices',
          instanceMode: 'multiple',
          kind: 'account',
          canTest: true,
          kinds: [],
        }}
        instance={{
          id: 'int_0040',
          name: 'Home',
          kind: 'connection',
          enabled: true,
          configured: true,
          status: { state: 'ok', label: 'Connected' },
          formValues: { accountLabel: 'me@example.com', token: 'set', refresh: 'set' },
        }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('InstanceEditorDialog — account sign-in on an existing instance', () => {
  it(
    'Sign out calls addons.custom on the providing addon, for this instance',
    async () => {
      renderDialog()
      fireEvent.click(await screen.findByRole('button', { name: /sign out/i }))
      await waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith({
          addonId: 'bosch-homecom',
          action: 'signOut',
          input: { integrationId: 'int_0040' },
        }),
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'Sign in again calls the begin action',
    async () => {
      renderDialog()
      fireEvent.click(await screen.findByRole('button', { name: /sign in again/i }))
      await waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith({
          addonId: 'bosch-homecom',
          action: 'beginSignIn',
          input: { integrationId: 'int_0040' },
        }),
      )
    },
    TEST_TIMEOUT_MS,
  )
})
