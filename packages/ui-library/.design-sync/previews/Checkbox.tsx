import type { ReactNode } from 'react'
import { Checkbox } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const Row = ({ children }: { children: ReactNode }) => (
  <label className="flex items-center gap-2 text-sm">{children}</label>
)

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-2">
      <Row>
        <Checkbox defaultChecked /> Record on motion
      </Row>
      <Row>
        <Checkbox /> Send push notification
      </Row>
      <Row>
        <Checkbox defaultChecked /> Detect person
      </Row>
    </div>
  </Frame>
)

export const States = () => (
  <Frame>
    <div className="flex flex-col gap-2">
      <Row>
        <Checkbox /> Unchecked
      </Row>
      <Row>
        <Checkbox defaultChecked /> Checked
      </Row>
      <Row>
        <Checkbox disabled /> Disabled
      </Row>
      <Row>
        <Checkbox defaultChecked disabled /> Checked + disabled
      </Row>
    </div>
  </Frame>
)
