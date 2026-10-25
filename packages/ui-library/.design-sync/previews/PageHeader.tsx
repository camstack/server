import type { ReactNode } from 'react'
import { PageHeader, Button, Badge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const WithActions = () => (
  <Frame>
    <div className="w-[34rem]">
      <PageHeader
        title="Cameras"
        subtitle="12 online · 2 offline · 1 degraded"
        actions={
          <>
            <Button variant="outline" size="sm">
              Discover
            </Button>
            <Button variant="primary" size="sm">
              Add camera
            </Button>
          </>
        }
      />
    </div>
  </Frame>
)

export const TitleOnly = () => (
  <Frame>
    <div className="w-[34rem]">
      <PageHeader title="Recording Nodes" />
    </div>
  </Frame>
)

export const WithSubtitle = () => (
  <Frame>
    <div className="w-[34rem]">
      <PageHeader title="ONVIF NVR" subtitle="192.168.10.10:5000 · v0.14.1 · connected" />
    </div>
  </Frame>
)

export const WithBadgeAction = () => (
  <Frame>
    <div className="w-[34rem]">
      <PageHeader
        title="Detection Pipeline"
        subtitle="arcface · 3 stages"
        actions={
          <>
            <Badge variant="success">Active</Badge>
            <Button variant="secondary" size="sm">
              Run once
            </Button>
          </>
        }
      />
    </div>
  </Frame>
)
