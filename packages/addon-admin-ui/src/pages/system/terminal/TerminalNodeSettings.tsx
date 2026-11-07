/**
 * The Terminal addon's settings of one node: the `terminal-session` capability's `node` scope
 * (`TerminalAddon.scopedSettingsCapabilities()`), asked through the scoped read.
 */
import { AddonScopedSettingsForm, useSystem } from '@camstack/ui-library'

export const TERMINAL_ADDON_ID = 'terminal'
export const TERMINAL_SESSION_CAP = 'terminal-session'

interface TerminalNodeSettingsProps {
  readonly nodeId: string
}

export function TerminalNodeSettings({ nodeId }: TerminalNodeSettingsProps) {
  const system = useSystem()
  return (
    <AddonScopedSettingsForm
      trpc={system.trpcClient}
      addonId={TERMINAL_ADDON_ID}
      cap={TERMINAL_SESSION_CAP}
      scope="node"
      nodeId={nodeId}
    />
  )
}
