/**
 * The Terminal addon's settings of one node: the `terminal-session` capability's `node` scope
 * (`TerminalAddon.scopedSettingsCapabilities()`), asked through the scoped read.
 */
import { AddonScopedSettingsForm, useSystem } from '@camstack/ui-library'
import { useInvalidateAddonSettings } from '../../../hooks/useInvalidateAddonSettings'

export const TERMINAL_ADDON_ID = 'terminal'
export const TERMINAL_SESSION_CAP = 'terminal-session'

interface TerminalNodeSettingsProps {
  readonly nodeId: string
  /** Called after a save, besides dropping every cached addon-settings read. */
  readonly onAfterChange?: () => void
}

export function TerminalNodeSettings({ nodeId, onAfterChange }: TerminalNodeSettingsProps) {
  const system = useSystem()
  const invalidate = useInvalidateAddonSettings()
  return (
    <AddonScopedSettingsForm
      trpc={system.trpcClient}
      addonId={TERMINAL_ADDON_ID}
      cap={TERMINAL_SESSION_CAP}
      scope="node"
      nodeId={nodeId}
      onAfterChange={() => {
        invalidate()
        onAfterChange?.()
      }}
    />
  )
}
