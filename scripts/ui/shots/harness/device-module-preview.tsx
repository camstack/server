/**
 * Fixture page for the device detail module: every mockup device of
 * `fixtures/hero-mockups.ts` drawn by the real `DeviceDetailModule` over the
 * fixture transport, one cell per device (`data-device-id`). Not an admin route:
 * `ui:shots` mounts it for the path `/device-module-preview`; `?ids=1,2` narrows it.
 * `hero-compare.ts` shoots each cell next to the operator's mockup.
 */
import { DeviceDetailModule } from '@admin/modules/device-detail'
import type { ReactElement } from 'react'
import { MOCKUP_IDS } from '../fixtures/hero-mockups'
import { fakeClient } from './stubs/transport'

export function DeviceModulePreview(): ReactElement {
  const wanted = new URLSearchParams(window.location.search).get('ids')
  const ids = wanted === null ? MOCKUP_IDS : wanted.split(',').map(Number)
  const theme = sessionStorage.getItem('ui-shots:theme') === 'dark' ? 'dark' : 'light'
  return (
    <main
      className={`${theme} flex min-h-screen flex-wrap content-start items-start gap-4 bg-background p-4`}
    >
      {ids.map((id) => (
        <div key={id} data-device-id={id} className="w-[416px] max-w-full">
          <DeviceDetailModule
            deviceId={id}
            trpcClient={fakeClient()}
            theme={theme}
            locale="it"
            canActuate
          />
        </div>
      ))}
    </main>
  )
}
