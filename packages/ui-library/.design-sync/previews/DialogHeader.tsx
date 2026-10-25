import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ minHeight: 480 }}>
    {children}
  </div>
)

// DialogHeader stacks title + description with bottom spacing. Shown in place
// inside an open dialog.
export const HeaderWithTitleAndDescription = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
          <DialogDescription>
            Connect ONVIF, Hikvision, Reolink or a generic RTSP source to this hub.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded border border-border p-3 text-xs text-foreground-muted">
          Step 1 of 3 — choose a provider.
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)

export const HeaderTitleOnly = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>Snapshot saved</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-foreground-muted">
          Front Door · 2560×1920 · saved to the media library.
        </p>
        <DialogFooter>
          <Button variant="primary" size="sm">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
