/**
 * The cell goes through the REAL `useSetInstanceEnabled` seam; only the generated tRPC hook under
 * it is replaced, so a mutation error travels the same path as in the app.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({ fail: null as string | null, calls: [] as unknown[] }))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useIntegrationInstancesSetInstanceEnabled: (o: {
    onSuccess?: () => void
    onError?: (e: Error) => void
  }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      lib.calls.push(input)
      if (lib.fail !== null) o.onError?.(new Error(lib.fail))
      else o.onSuccess?.()
    },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d: string, v?: Record<string, string>) =>
      Object.entries(v ?? {}).reduce((s, [k, x]) => s.replace(`{{${k}}}`, x), d),
  }),
}))

import { InstanceSwitchCell } from '../InstanceSwitchCell'

const row = {
  addonId: 'google-services',
  providerName: 'Google',
  id: 'cal_a',
  name: 'Work',
  enabled: false,
}

function mount(onChanged?: () => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <InstanceSwitchCell row={row} pinning={0} onChanged={onChanged} />
    </QueryClientProvider>,
  )
}

describe('InstanceSwitchCell', () => {
  it('shows the record state and writes the flipped value, then lets the page refresh', () => {
    lib.fail = null
    lib.calls = []
    const onChanged = vi.fn()
    mount(onChanged)
    const sw = screen.getByTestId('instance-switch-cal_a')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(lib.calls).toEqual([{ addonId: 'google-services', id: 'cal_a', enabled: true }])
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('a write error reaches the row message and the switch still shows the record', async () => {
    lib.fail = 'forbidden'
    const onChanged = vi.fn()
    mount(onChanged)
    fireEvent.click(screen.getByTestId('instance-switch-cal_a'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('forbidden'))
    expect(screen.getByTestId('instance-switch-cal_a').getAttribute('aria-checked')).toBe('false')
    expect(onChanged).not.toHaveBeenCalled()
  })
})
