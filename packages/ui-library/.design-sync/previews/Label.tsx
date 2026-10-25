import type { ReactNode } from 'react'
import { Label, Input } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="rtsp-url">RTSP URL</Label>
      <Input id="rtsp-url" defaultValue="rtsp://192.168.10.50:554/stream" className="w-72" />
    </div>
  </Frame>
)

export const FormGroup = () => (
  <Frame>
    <div className="flex flex-col gap-4 w-72">
      <div className="flex flex-col gap-1.5">
        <Label>Camera name</Label>
        <Input defaultValue="Front Door" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Provider</Label>
        <Input defaultValue="ONVIF" />
      </div>
    </div>
  </Frame>
)

export const Standalone = () => (
  <Frame>
    <div className="flex flex-col gap-2">
      <Label>Detection zones</Label>
      <Label>Resolution</Label>
      <Label>Stream quality</Label>
    </div>
  </Frame>
)
