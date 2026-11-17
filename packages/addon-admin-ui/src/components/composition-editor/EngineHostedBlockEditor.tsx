/**
 * A camera block an engine hosts, edited on its block (planning#580). A grid
 * lays out its cells on the camera its block made, through that camera's own
 * `camera-grid-layout`; a Terminal camera changes which Terminal it shows,
 * through the block. Neither has members, so neither opens the helper wizard.
 */
import { type Composition, compileHelper, type EngineHostedHelperSpec } from '@camstack/types'
import { CameraGridLayoutEditor, ErrorBox } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TerminalCameraPicker } from './TerminalCameraPicker'

export interface EngineHostedBlockEditorProps {
  readonly blockId: string
  readonly helper: EngineHostedHelperSpec
  /** The camera the composer made for the block, null until it exists. */
  readonly deviceId: number | null
  readonly saving: boolean
  /** Write the block's new composition; a refusal throws. */
  readonly onWrite: (composition: Composition) => Promise<void>
}

/** The block's composition for another Terminal, or the compiler's refusal in words. */
function compiledComposition(terminalId: string): Composition | string {
  const compiled = compileHelper({ kind: 'terminal', terminalId })
  return compiled.ok ? compiled.composition : compiled.problems.map((p) => p.message).join('; ')
}

export function EngineHostedBlockEditor({
  blockId,
  helper,
  deviceId,
  saving,
  onWrite,
}: EngineHostedBlockEditorProps): ReactNode {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  if (helper.kind === 'grid') {
    if (deviceId === null) {
      return (
        <p
          role="status"
          className="text-xs text-foreground-muted"
          data-testid="grid-camera-pending"
        >
          {t('helper.grid.cameraPending')}
        </p>
      )
    }
    return <CameraGridLayoutEditor deviceId={deviceId} />
  }

  const change = async (terminalId: string): Promise<void> => {
    if (terminalId === helper.terminalId) return
    setError(null)
    const next = compiledComposition(terminalId)
    if (typeof next === 'string') {
      setError(next)
      return
    }
    try {
      await onWrite(next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-2" data-testid="terminal-camera-editor">
      <TerminalCameraPicker
        value={helper.terminalId}
        ownBlockId={blockId}
        disabled={saving}
        onChange={(terminalId) => void change(terminalId)}
      />
      {error !== null && <ErrorBox title={t('helper.terminal.saveFailed')} message={error} />}
    </div>
  )
}
