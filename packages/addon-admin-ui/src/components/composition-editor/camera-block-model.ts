/**
 * Terminal camera blocks, read from the stored compositions (planning#580).
 * A Terminal shows on one block: the picker names the block that already has
 * it, and the Terminal page finds a terminal's camera the same way. A read that
 * has not answered is never "no camera" (D315).
 */
import { type CompositionListRead, coreBlockComposition } from '@camstack/types'

export interface TerminalCameraBlock {
  readonly blockId: string
  readonly name: string
  /** The camera row, once the composer answered for the block. */
  readonly deviceId: number | null
}

export type TerminalCameraIndex =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }
  | ReadyTerminalCameraIndex

export interface ReadyTerminalCameraIndex {
  readonly kind: 'ready'
  readonly byTerminal: ReadonlyMap<string, TerminalCameraBlock>
}

export interface TerminalOption {
  readonly id: string
  readonly name: string
}

export interface TerminalChoice extends TerminalOption {
  /** The name of the block that already shows this terminal, or null when it is free. */
  readonly takenBy: string | null
}

export function terminalCameraIndex(
  read: CompositionListRead | undefined,
  failed: boolean,
): TerminalCameraIndex {
  if (read === undefined) return failed ? { kind: 'unknown' } : { kind: 'pending' }
  if (read.state !== 'loaded') return { kind: 'unknown' }
  const byTerminal = new Map<string, TerminalCameraBlock>()
  for (const view of read.views) {
    const helper = coreBlockComposition(view.block)?.helper
    if (helper?.kind !== 'terminal' || byTerminal.has(helper.terminalId)) continue
    byTerminal.set(helper.terminalId, {
      blockId: view.block.id,
      name: view.block.name,
      deviceId: view.state.kind === 'answered' ? (view.state.state?.deviceId ?? null) : null,
    })
  }
  return { kind: 'ready', byTerminal }
}

/** Every terminal, each with the block that shows it — except the block being edited. */
export function terminalChoices(
  terminals: readonly TerminalOption[],
  index: ReadyTerminalCameraIndex,
  ownBlockId: string | null,
): readonly TerminalChoice[] {
  return terminals.map((terminal) => {
    const shown = index.byTerminal.get(terminal.id)
    const takenBy = shown === undefined || shown.blockId === ownBlockId ? null : shown.name
    return { id: terminal.id, name: terminal.name, takenBy }
  })
}
