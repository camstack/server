import type { ReactNode } from 'react'
import { Select } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const providerOptions = [
  { value: 'onvif', label: 'ONVIF' },
  { value: 'hikvision', label: 'Hikvision' },
  { value: 'reolink', label: 'Reolink' },
  { value: 'rtsp', label: 'RTSP / HTTP' },
  { value: 'homeAssistant', label: 'Home Assistant' },
]

export const ProviderPicker = () => (
  <Frame>
    <div style={{ width: 280 }}>
      <label className="mb-1 block text-xs font-medium text-foreground-muted">
        Camera provider
      </label>
      <Select options={providerOptions} defaultValue="onvif" />
    </div>
  </Frame>
)

export const ResolutionPicker = () => (
  <Frame>
    <div style={{ width: 280 }}>
      <label className="mb-1 block text-xs font-medium text-foreground-muted">
        Stream resolution
      </label>
      <Select
        options={[
          { value: '2560x1920', label: '2560 × 1920 (5MP)' },
          { value: '1920x1080', label: '1920 × 1080 (1080p)' },
          { value: '1280x720', label: '1280 × 720 (720p)' },
          { value: '640x480', label: '640 × 480 (SD)' },
        ]}
        defaultValue="1920x1080"
      />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <div style={{ width: 280 }}>
      <label className="mb-1 block text-xs font-medium text-foreground-muted">Recording node</label>
      <Select
        options={[{ value: 'hub', label: 'Hub (camstack-hub)' }]}
        defaultValue="hub"
        disabled
      />
    </div>
  </Frame>
)

export const InFormRow = () => (
  <Frame>
    <div className="flex flex-col gap-3" style={{ width: 320 }}>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-foreground">Provider</span>
        <div style={{ width: 180 }}>
          <Select options={providerOptions} defaultValue="hikvision" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-foreground">Detection mode</span>
        <div style={{ width: 180 }}>
          <Select
            options={[
              { value: 'person', label: 'Person' },
              { value: 'car', label: 'Car' },
              { value: 'package', label: 'Package' },
              { value: 'dog', label: 'Dog' },
            ]}
            defaultValue="person"
          />
        </div>
      </div>
    </div>
  </Frame>
)
