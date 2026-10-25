import type { ReactNode } from 'react'
import { FormField, Input, Switch } from '@camstack/ui-library'

// CamStack is dark-first — render every story on the DS dark canvas.
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Vertical = () => (
  <Frame>
    <div className="w-80">
      <FormField
        label="Camera name"
        description="Shown across grids, events and notifications."
        required
      >
        <Input defaultValue="Front Door" placeholder="e.g. Driveway" />
      </FormField>
    </div>
  </Frame>
)

export const Horizontal = () => (
  <Frame>
    <div className="w-96">
      <FormField
        label="Recording enabled"
        description="Persist 24/7 clips to the hub NVR."
        orientation="horizontal"
      >
        <Switch defaultChecked />
      </FormField>
    </div>
  </Frame>
)

export const WithError = () => (
  <Frame>
    <div className="w-80">
      <FormField
        label="RTSP URL"
        description="restreamer source for the Backyard camera."
        required
        error="Connection refused — check host and port."
      >
        <Input defaultValue="rtsp://192.168.10.50:554/stream" />
      </FormField>
    </div>
  </Frame>
)

export const FieldStack = () => (
  <Frame>
    <div className="flex flex-col gap-4 w-80">
      <FormField label="Provider" description="Source integration type.">
        <Input defaultValue="ONVIF NVR" />
      </FormField>
      <FormField label="Resolution">
        <Input defaultValue="2560×1920" />
      </FormField>
      <FormField label="Motion zones" orientation="horizontal">
        <Switch defaultChecked />
      </FormField>
    </div>
  </Frame>
)
