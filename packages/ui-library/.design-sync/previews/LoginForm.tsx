import type { ReactNode } from 'react'
import { LoginForm } from '@camstack/ui-library'

// CamStack is dark-first; render inside the DS dark canvas so the form chrome
// (surface card, bordered inputs, primary button) reads correctly.
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground rounded-lg overflow-hidden">{children}</div>
)

const noop = async () => {
  await new Promise(() => {})
}

export const Hero = () => (
  <Frame>
    <LoginForm serverUrl="https://hub.camstack.local:8443" onLogin={noop} />
  </Frame>
)

export const WithError = () => (
  <Frame>
    <LoginForm
      serverUrl="https://hub.camstack.local:8443"
      error="Invalid username or password."
      onLogin={noop}
    />
  </Frame>
)
