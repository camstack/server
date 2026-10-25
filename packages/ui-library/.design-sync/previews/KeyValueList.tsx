import type { ReactNode } from 'react'
import { KeyValueList, StatusBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const DeviceInfo = () => (
  <Frame>
    <div className="w-80">
      <KeyValueList
        items={[
          { key: 'Provider', value: 'ONVIF NVR' },
          { key: 'Resolution', value: '2560×1920' },
          { key: 'Codec', value: 'H.265' },
          { key: 'IP address', value: '192.168.10.50' },
          { key: 'Firmware', value: 'v3.0.4' },
        ]}
      />
    </div>
  </Frame>
)

export const WithRichValues = () => (
  <Frame>
    <div className="w-80">
      <KeyValueList
        items={[
          { key: 'Status', value: <StatusBadge status="online" /> },
          { key: 'Camera', value: 'Backyard' },
          {
            key: 'Stream',
            value: <span className="text-success">WebRTC · restreamer</span>,
          },
          { key: 'Bitrate', value: '4.2 Mbps' },
        ]}
      />
    </div>
  </Frame>
)
