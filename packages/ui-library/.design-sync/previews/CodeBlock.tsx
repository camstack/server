import type { ReactNode } from 'react'
import { CodeBlock } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const composeYaml = `mqtt:
  host: 192.168.10.10
  user: onvif
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://192.168.10.42:554/h264
          roles: [detect, record]
    detect:
      width: 2560
      height: 1920`

export const OnvifConfig = () => (
  <Frame>
    <div className="w-[28rem]">
      <CodeBlock>{composeYaml}</CodeBlock>
    </div>
  </Frame>
)

export const RtspUri = () => (
  <Frame>
    <div className="w-[28rem]">
      <CodeBlock>{'rtsp://admin:••••@192.168.10.42:554/Streaming/Channels/101'}</CodeBlock>
    </div>
  </Frame>
)

export const Scrolled = () => (
  <Frame>
    <div className="w-[28rem]">
      <CodeBlock maxHeight={120}>
        {Array.from(
          { length: 14 },
          (_, i) =>
            `2026-06-20T14:0${i % 10}:11Z [onvif] camera=Backyard event=motion zone=driveway`,
        ).join('\n')}
      </CodeBlock>
    </div>
  </Frame>
)

export const HikvisionSetup = () => (
  <Frame>
    <div className="w-[28rem]">
      <CodeBlock>
        {'curl -fsSL https://hikvision.app/install.sh | sh\nsudo systemctl enable --now hikvision'}
      </CodeBlock>
    </div>
  </Frame>
)
