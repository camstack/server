import type { ReactNode } from 'react'
import { EmptyState, Button } from '@camstack/ui-library'
import { Camera, VideoOff, Bell } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const NoCameras = () => (
  <Frame>
    <div className="w-96">
      <EmptyState
        icon={Camera}
        title="No cameras yet"
        description="Add your first camera from ONVIF, Hikvision or a generic RTSP source to start streaming."
        action={<Button variant="primary">Add camera</Button>}
      />
    </div>
  </Frame>
)

export const NoEvents = () => (
  <Frame>
    <div className="w-96">
      <EmptyState
        icon={Bell}
        title="No events in this range"
        description="Try widening the time window or clearing detection filters."
      />
    </div>
  </Frame>
)

export const StreamOffline = () => (
  <Frame>
    <div className="w-96">
      <EmptyState
        icon={VideoOff}
        title="Stream unavailable"
        description="The Backyard camera is offline. Check the device connection and try again."
        action={<Button variant="outline">Retry connection</Button>}
      />
    </div>
  </Frame>
)
