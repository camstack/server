/**
 * A camera block an engine hosts, edited on its block (planning#580). A grid
 * lays out its cells on the camera its block made, through that camera's own
 * `camera-grid-layout`; a Terminal camera changes which Terminal it shows,
 * through the block; a crop camera redraws its rectangle on its source's
 * snapshot, through the block. None has members, so none opens the helper wizard.
 */
import {
  type Composition,
  compileHelper,
  type CropHelperSpec,
  type EngineHostedHelperSpec,
} from '@camstack/types'
import { Button, CameraGridLayoutEditor, ErrorBox } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CropCameraEditor, type CropValue } from './CropCameraEditor'
import { fleetRowOf } from './command-sources'
import { TerminalCameraPicker } from './TerminalCameraPicker'
import { useCandidateDevices } from '../device/customize/assignments/use-source-candidates'

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

  if (helper.kind === 'crop') {
    return <CropBlockEditor helper={helper} saving={saving} onWrite={onWrite} />
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

interface CropBlockEditorProps {
  readonly helper: CropHelperSpec
  readonly saving: boolean
  readonly onWrite: (composition: Composition) => Promise<void>
}

/**
 * An existing crop camera: the creation editor, opened on its stored rectangle.
 * Dragging only edits a local copy; Save writes the compiled block once. The
 * source camera is fixed — another source is another crop camera.
 */
function CropBlockEditor({ helper, saving, onWrite }: CropBlockEditorProps): ReactNode {
  const { t } = useTranslation()
  const fleet = useCandidateDevices(true)
  const [value, setValue] = useState<CropValue>({
    rect: helper.rect,
    aspect: helper.aspect,
  })
  const [error, setError] = useState<string | null>(null)
  const row = fleet.kind === 'known' ? fleetRowOf(fleet.value, helper.source) : null
  const changed = value.rect !== helper.rect || value.aspect !== helper.aspect

  const save = async (): Promise<void> => {
    setError(null)
    const compiled = compileHelper({ ...helper, ...value })
    if (!compiled.ok) {
      setError(compiled.problems.map((p) => p.message).join('; '))
      return
    }
    try {
      await onWrite(compiled.composition)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-2" data-testid="crop-block-editor">
      <CropCameraEditor
        sourceDeviceId={row === null ? null : row.id}
        value={value}
        reseedOnLoad={false}
        disabled={saving}
        onChange={setValue}
      />
      {error !== null && <ErrorBox title={t('helper.crop.saveFailed')} message={error} />}
      <div>
        <Button
          size="sm"
          disabled={saving || !changed}
          data-testid="crop-save"
          onClick={() => void save()}
        >
          {t('helper.crop.save')}
        </Button>
      </div>
    </div>
  )
}
