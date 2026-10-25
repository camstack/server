import type { ReactNode } from 'react'
import { Button } from '@camstack/ui-library'

// CamStack is dark-first (admin-ui forces dark via ThemeProvider). The preview
// card chrome is light, so every story renders inside the DS dark canvas with
// the `dark` class active — otherwise light-foreground content washes out.
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Variants = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">Save changes</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="outline">Configure</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="danger">Delete camera</Button>
    </div>
  </Frame>
)

export const Sizes = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary">
        Small
      </Button>
      <Button size="md" variant="primary">
        Medium
      </Button>
      <Button size="lg" variant="primary">
        Large
      </Button>
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <Button variant="primary" disabled>
        Saving…
      </Button>
      <Button variant="outline" disabled>
        Unavailable
      </Button>
    </div>
  </Frame>
)
