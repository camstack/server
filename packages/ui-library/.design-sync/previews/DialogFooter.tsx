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

// DialogFooter right-aligns action buttons with top spacing. Shown in place
// inside an open dialog.
export const FooterConfirmActions = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>Delete camera</DialogTitle>
          <DialogDescription>Remove “Front Door” and its recordings?</DialogDescription>
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

export const FooterSingleAction = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>Integration added</DialogTitle>
          <DialogDescription>Hikvision at 192.168.10.50 is now connected.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="primary" size="sm">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
