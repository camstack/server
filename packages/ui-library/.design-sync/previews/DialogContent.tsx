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

export const WidthSm = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>Reboot device</DialogTitle>
          <DialogDescription>Restart “Driveway” now? It will be offline ~30s.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Reboot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)

export const WidthMd = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>Rename camera</DialogTitle>
          <DialogDescription>
            Update the display name shown across grids and events.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded border border-border p-3 text-xs text-foreground-muted">
          Current name: Backyard · Provider: ONVIF · 1920×1080
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)

export const WidthLg = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="lg">
        <DialogHeader>
          <DialogTitle>Discovered devices</DialogTitle>
          <DialogDescription>
            3 ONVIF devices found on 192.168.10.0/24. Select which to import.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-xs">
          <div className="rounded border border-border px-3 py-2 text-foreground">
            Reolink RLC-810A · 192.168.10.42
          </div>
          <div className="rounded border border-border px-3 py-2 text-foreground">
            Front Door · 192.168.10.43
          </div>
          <div className="rounded border border-border px-3 py-2 text-foreground">
            Garage · 192.168.10.44
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Import 3
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
