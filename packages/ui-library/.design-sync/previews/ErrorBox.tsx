import type { ReactNode } from 'react'
import { ErrorBox } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Danger = () => (
  <Frame>
    <div className="w-96">
      <ErrorBox
        title="Connection failed"
        message="Could not reach the ONVIF instance at 192.168.10.10:5000. Verify the host is online."
      />
    </div>
  </Frame>
)

export const Warning = () => (
  <Frame>
    <div className="w-96">
      <ErrorBox
        variant="warning"
        title="Recording paused"
        message="The hub NVR is at 92% capacity. Older clips will be pruned soon."
      />
    </div>
  </Frame>
)

export const WithRetry = () => (
  <Frame>
    <div className="w-96">
      <ErrorBox
        title="Snapshot fetch failed"
        message="The Backyard camera did not return a frame within 10s."
        onRetry={() => {}}
      />
    </div>
  </Frame>
)

export const MessageOnly = () => (
  <Frame>
    <div className="w-96">
      <ErrorBox message="Invalid RTSP credentials for the Driveway camera." />
    </div>
  </Frame>
)
