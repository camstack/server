import type { ReactNode } from 'react'
import { FilterBar } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const CameraFilters = () => (
  <Frame>
    <div className="w-[40rem]">
      <FilterBar
        filters={[
          { type: 'search', key: 'q', placeholder: 'Search cameras…' },
          {
            type: 'select',
            key: 'provider',
            label: 'Provider',
            options: [
              { value: '', label: 'All providers' },
              { value: 'onvif', label: 'ONVIF' },
              { value: 'hikvision', label: 'Hikvision' },
              { value: 'reolink', label: 'Reolink' },
            ],
          },
          {
            type: 'badge-toggle',
            key: 'status',
            options: [
              { value: 'online', label: 'Online' },
              { value: 'offline', label: 'Offline' },
            ],
          },
        ]}
        values={{ q: 'Front', provider: 'onvif', status: 'online' }}
        onChange={noop}
      />
    </div>
  </Frame>
)

export const EventFilters = () => (
  <Frame>
    <div className="w-[40rem]">
      <FilterBar
        filters={[
          { type: 'search', key: 'q', placeholder: 'Search detections…' },
          {
            type: 'badge-toggle',
            key: 'label',
            options: [
              { value: 'person', label: 'Person' },
              { value: 'car', label: 'Car' },
              { value: 'package', label: 'Package' },
              { value: 'dog', label: 'Dog' },
            ],
          },
        ]}
        values={{ q: '', label: 'person' }}
        onChange={noop}
      />
    </div>
  </Frame>
)

export const SearchOnly = () => (
  <Frame>
    <div className="w-[40rem]">
      <FilterBar
        filters={[{ type: 'search', key: 'q', placeholder: 'Search zones…' }]}
        values={{ q: 'driveway' }}
        onChange={noop}
      />
    </div>
  </Frame>
)
