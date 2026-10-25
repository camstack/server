import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
} from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ minHeight: 480 }}>
    {children}
  </div>
)

export const DeleteCameraConfirm = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>Delete camera</DialogTitle>
          <DialogDescription>
            This permanently removes “Front Door” (ONVIF) and all of its recordings. This action
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="danger" size="sm">
            Delete camera
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)

export const AddIntegrationForm = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
          <DialogDescription>Connect a new NVR or device provider to CamStack.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">Provider</span>
            <Input value="Hikvision" readOnly />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">Host</span>
            <Input value="192.168.10.50:11080" readOnly />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Add integration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)

export const WideContent = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="lg">
        <DialogHeader>
          <DialogTitle>Recording schedule — Backyard</DialogTitle>
          <DialogDescription>
            Detections from the last 24 hours: person ×12, car ×4, package ×1.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded border border-border p-3 text-xs text-foreground-muted">
          Continuous recording is active on the hub. 2560×1920 @ 15fps · 7-day retention.
        </div>
        <DialogFooter>
          <Button variant="secondary" size="sm">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
