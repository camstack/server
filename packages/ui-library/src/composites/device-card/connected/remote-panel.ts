/**
 * The layout the device card's remote view draws. A saved template wins; while
 * that template is still loading the view waits. With no template, the preset
 * that covers the most bound roles — never the raw command ids.
 */
import type { MediaPlayerStatus, RemoteCommandList } from '@camstack/types'
import { layoutForRemoteCommands, layoutOf } from '../../remote'
import type { CardRemotePanel } from '../shell/model'

interface TemplateRow {
  readonly id: string
  readonly payload: unknown
}

export function remoteLayoutPending(
  commands: RemoteCommandList | null | undefined,
  templates: readonly TemplateRow[] | undefined,
  templateStatus: string,
): boolean {
  if (commands == null || commands.commands.length === 0) return false
  if (commands.layoutTemplateId === null) return false
  return templates === undefined && templateStatus !== 'error'
}

export function remotePanelOf(
  deviceId: number,
  commands: RemoteCommandList | null | undefined,
  templates: readonly TemplateRow[] | undefined,
  templateStatus: string,
  assumed: Pick<MediaPlayerStatus, 'source'> | null | undefined,
): CardRemotePanel | null {
  if (commands == null || commands.commands.length === 0) return null
  if (remoteLayoutPending(commands, templates, templateStatus)) return null
  const templateId = commands.layoutTemplateId
  const row = templateId === null ? undefined : templates?.find((item) => item.id === templateId)
  const parsed = row === undefined ? null : layoutOf(row.payload)
  const saved = parsed !== null && parsed.buttons.length > 0 ? parsed : null
  const layout = layoutForRemoteCommands(
    saved,
    commands.commands.map((command) => command.role),
  )
  if (layout === null) return null
  return {
    layout,
    boundRoles: commands.commands.map((command) => command.role),
    sources: commands.sources,
    currentSource: assumed?.source ?? '',
    deviceId,
  }
}
