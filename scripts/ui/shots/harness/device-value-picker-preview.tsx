/**
 * Fixture page for the device → value picker. Not an admin route: `ui:shots`
 * mounts it for the path `/device-value-picker-preview`. `?variant=inline|popover`
 * picks the dropdown flavour, `?multi=1` the multi-select; shoot it with
 * `--step click:[data-testid=picker] button` to capture the open list.
 */
import { bridgeUiText } from '@admin/i18n/ui-text-bridge'
import i18n from '@admin/i18n'
import {
  DeviceValuePicker,
  type PickedValue,
  ThemeProvider,
  trpc,
  UiTextProvider,
} from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { fakeClient } from './stubs/transport'

const REQUIRES = { caps: ['temperature-sensor'] }

export function DeviceValuePickerPreview(): ReactElement {
  const params = new URLSearchParams(window.location.search)
  const variant = params.get('variant') === 'popover' ? 'popover' : 'inline'
  const multi = params.get('multi') === '1'
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  const [single, setSingle] = useState<PickedValue | null>(null)
  const [many, setMany] = useState<readonly PickedValue[]>([
    { deviceId: 2, cap: 'temperature-sensor', path: 'humidity' },
    { deviceId: 1, cap: 'temperature-sensor', path: 'temperature' },
    { deviceId: 99 },
  ])
  const theme = sessionStorage.getItem('ui-shots:theme') === 'dark' ? 'dark' : 'light'
  const trpcClient = fakeClient()
  return (
    <UiTextProvider t={bridgeUiText(i18n.t.bind(i18n))}>
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <main className={`${theme} min-h-screen bg-background p-4`}>
              <div data-testid="picker" className="mx-auto max-w-xl">
                {multi ? (
                  <DeviceValuePicker
                    multiple
                    requires={REQUIRES}
                    variant={variant}
                    contextDeviceId={1}
                    value={many}
                    onChange={setMany}
                  />
                ) : (
                  <DeviceValuePicker
                    requires={REQUIRES}
                    variant={variant}
                    contextDeviceId={1}
                    value={single}
                    onChange={setSingle}
                  />
                )}
              </div>
            </main>
          </ThemeProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </UiTextProvider>
  )
}
