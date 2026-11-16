/**
 * Terminal cameras are core blocks (planning#580).
 *
 * A Terminal camera block names one terminal (`TerminalHelperSpec.terminalId`).
 * The composer owns its camera row `composed-<blockId>` and its name; this
 * engine builds a `TerminalCameraDevice` ON that row (`loadContext`, D677) and
 * serves the camera caps there as a cross-addon native (D663). It keeps no list
 * of its own (D3): each pass reads the blocks and the composer's rows.
 *
 * - `not-loaded` or a failed read changes nothing; a hosted camera is withdrawn
 *   only after two consecutive trusted reads agree its block is gone (D49).
 * - A block whose terminal does not exist hosts nothing (the same gate withdraws
 *   one already hosted). A disabled terminal's camera stays hosted, offline.
 * - One terminal, one camera: a second block naming a taken terminal is refused
 *   by name, the first keeps it.
 * - Analysis is silenced the first time a device is hosted, and the fact is
 *   kept per device (the engine's device store, cleared with the device, D865).
 */
import {
  type ComposerDeviceRow,
  type CompositionListRead,
  type DeviceManagerApi,
  type EngineHostedBlock,
  errMsg,
  type HostedEngineDevice,
  HostedWithdrawalGate,
  hostEngineDevice,
  type IScopedLogger,
  selectEngineHostedBlocks,
  type TerminalHelperSpec,
} from '@camstack/types'
import { TerminalCameraDevice } from './terminal-camera-device.js'
import type { TerminalInstance } from './terminal-instances.js'

/** The per-device flag that analysis was silenced once. */
export const ANALYSIS_SILENCED_KEY = 'analysisSilenced'

/** What the camera device reads: the terminal it shows, where it runs, what it runs. */
export interface TerminalCameraConfig {
  readonly instanceId: string
  readonly nodeId: string
  readonly profileId: string
  readonly profileLabel: string
}

export interface TerminalCameraHostPorts {
  readonly logger: IScopedLogger
  readonly devices: DeviceManagerApi
  readonly readBlocks: () => Promise<CompositionListRead>
  readonly readComposerRows: () => Promise<readonly ComposerDeviceRow[]>
  readonly deleteBlock: (blockId: string) => Promise<void>
  readonly readDeviceFlags: (deviceId: number) => Promise<Readonly<Record<string, unknown>>>
  readonly writeDeviceFlags: (deviceId: number, patch: Record<string, unknown>) => Promise<void>
  /** Switch every analyzer off at its authority; throws when a bound one refused. */
  readonly silence: (deviceId: number) => Promise<void>
}

/** One pass: the terminals as last read, and whether a terminal's node and profile can serve now. */
export interface TerminalCameraPass {
  readonly terminals: readonly TerminalInstance[]
  readonly isLive: (terminal: TerminalInstance) => boolean
}

interface HostedTerminalCamera {
  readonly block: EngineHostedBlock<TerminalHelperSpec>
  readonly config: TerminalCameraConfig
  readonly hosted: HostedEngineDevice<TerminalCameraDevice>
}

function configOf(terminal: TerminalInstance): TerminalCameraConfig {
  return {
    instanceId: terminal.id,
    nodeId: terminal.nodeId,
    profileId: terminal.profileId,
    profileLabel: terminal.profileLabel,
  }
}

function sameConfig(a: TerminalCameraConfig, b: TerminalCameraConfig): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.nodeId === b.nodeId &&
    a.profileId === b.profileId &&
    a.profileLabel === b.profileLabel
  )
}

export class TerminalCameraHost {
  private hosted: ReadonlyMap<string, HostedTerminalCamera> = new Map()
  private readonly gate = new HostedWithdrawalGate()

  constructor(private readonly ports: TerminalCameraHostPorts) {}

  /** The camera device showing this terminal, if one is hosted. */
  deviceIdFor(terminalId: string): number | undefined {
    for (const camera of this.hosted.values()) {
      if (camera.config.instanceId === terminalId) return camera.block.deviceId
    }
    return undefined
  }

  async reconcile(pass: TerminalCameraPass): Promise<void> {
    const read = await this.readTerminalBlocks()
    if (read === null) return
    const terminalsById = new Map(pass.terminals.map((terminal) => [terminal.id, terminal]))
    const servable = this.servableBlocks(read, terminalsById)
    const { withdraw } = this.gate.judge(
      this.hosted.keys(),
      new Set(servable.map((block) => block.blockId)),
    )
    for (const blockId of withdraw) await this.unhost(blockId, 'its block or terminal is gone')
    for (const block of servable) {
      const terminal = terminalsById.get(block.spec.terminalId)
      if (terminal === undefined) continue
      const camera = await this.hostOne(block, configOf(terminal))
      camera?.hosted.device.setNodeOnline(terminal.enabled && pass.isLive(terminal))
    }
  }

  /** Delete every camera block naming this terminal (core-blocks delete). A blind read deletes nothing. */
  async deleteCamerasOf(terminalId: string): Promise<void> {
    const read = await this.readTerminalBlocks()
    if (read === null) {
      this.ports.logger.warn(
        'terminal: the camera blocks could not be read - the deleted terminal keeps its camera block',
        { meta: { terminalId } },
      )
      return
    }
    for (const block of read) {
      if (block.spec.terminalId !== terminalId) continue
      try {
        await this.ports.deleteBlock(block.blockId)
        this.ports.logger.info('terminal: camera block deleted with its terminal', {
          tags: { deviceId: block.deviceId },
          meta: { blockId: block.blockId, terminalId },
        })
      } catch (error: unknown) {
        this.ports.logger.error(
          'terminal: the camera block of a deleted terminal was not deleted',
          {
            tags: { deviceId: block.deviceId },
            meta: { blockId: block.blockId, terminalId, error: errMsg(error) },
          },
        )
      }
    }
  }

  async dispose(): Promise<void> {
    for (const blockId of [...this.hosted.keys()]) await this.unhost(blockId, 'shutdown')
  }

  /** The terminal blocks whose row exists, or `null` when the read cannot be trusted (D49). */
  private async readTerminalBlocks(): Promise<
    readonly EngineHostedBlock<TerminalHelperSpec>[] | null
  > {
    try {
      const read = selectEngineHostedBlocks(
        'terminal',
        await this.ports.readBlocks(),
        await this.ports.readComposerRows(),
      )
      if (read.kind === 'trusted') return read.blocks
      this.ports.logger.info('terminal: the blocks are not loaded yet - nothing changes', {
        meta: { reason: read.reason },
      })
      return null
    } catch (error: unknown) {
      this.ports.logger.warn('terminal: the camera blocks could not be read - nothing changes', {
        meta: { error: errMsg(error) },
      })
      return null
    }
  }

  /**
   * Enabled blocks whose terminal exists, one per terminal. A block that keeps
   * a terminal it already serves wins over a newer one naming the same terminal.
   */
  private servableBlocks(
    blocks: readonly EngineHostedBlock<TerminalHelperSpec>[],
    terminalsById: ReadonlyMap<string, TerminalInstance>,
  ): readonly EngineHostedBlock<TerminalHelperSpec>[] {
    const ordered = [...blocks].sort(
      (a, b) => Number(this.hosted.has(b.blockId)) - Number(this.hosted.has(a.blockId)),
    )
    const taken = new Set<string>()
    const servable: EngineHostedBlock<TerminalHelperSpec>[] = []
    for (const block of ordered) {
      if (!block.enabled) continue
      const terminalId = block.spec.terminalId
      if (!terminalsById.has(terminalId)) {
        this.ports.logger.warn('terminal: a camera block names a terminal that does not exist', {
          tags: { deviceId: block.deviceId },
          meta: { blockId: block.blockId, terminalId },
        })
        continue
      }
      if (taken.has(terminalId)) {
        this.ports.logger.warn('terminal: a camera block names a terminal another block shows', {
          tags: { deviceId: block.deviceId },
          meta: { blockId: block.blockId, terminalId },
        })
        continue
      }
      taken.add(terminalId)
      servable.push(block)
    }
    return servable
  }

  /** Build (or keep) one camera. A changed terminal is rebuilt; a failure leaves the previous state. */
  private async hostOne(
    block: EngineHostedBlock<TerminalHelperSpec>,
    config: TerminalCameraConfig,
  ): Promise<HostedTerminalCamera | null> {
    const previous = this.hosted.get(block.blockId)
    if (previous !== undefined) {
      if (previous.block.deviceId === block.deviceId && sameConfig(previous.config, config)) {
        const kept = { ...previous, block }
        this.hosted = new Map([...this.hosted, [block.blockId, kept]])
        return kept
      }
      await this.unhost(block.blockId, 'its terminal or row changed')
    }
    try {
      const hosted = await hostEngineDevice(
        this.ports.devices,
        { id: block.deviceId, stableId: block.stableId },
        { ...config },
        TerminalCameraDevice,
      )
      const camera: HostedTerminalCamera = { block, config, hosted }
      this.hosted = new Map([...this.hosted, [block.blockId, camera]])
      this.ports.logger.info('terminal: hosting a camera block on its camera row', {
        tags: { deviceId: block.deviceId },
        meta: { blockId: block.blockId, terminalId: config.instanceId, nodeId: config.nodeId },
      })
      await this.silenceOnce(block.deviceId)
      return camera
    } catch (error: unknown) {
      this.ports.logger.error('terminal: a camera block could not be hosted', {
        tags: { deviceId: block.deviceId },
        meta: { blockId: block.blockId, error: errMsg(error) },
      })
      return null
    }
  }

  private async unhost(blockId: string, reason: string): Promise<void> {
    const camera = this.hosted.get(blockId)
    if (camera === undefined) return
    const deviceId = camera.block.deviceId
    this.hosted = new Map([...this.hosted].filter(([id]) => id !== blockId))
    this.ports.logger.info('terminal: no longer hosting a camera block', {
      tags: { deviceId },
      meta: { blockId, reason },
    })
    camera.hosted.device.setNodeOnline(false)
    try {
      await camera.hosted.withdraw()
    } catch (error: unknown) {
      this.ports.logger.warn('terminal: withdrawing a camera device failed', {
        tags: { deviceId },
        meta: { blockId, error: errMsg(error) },
      })
    }
  }

  /**
   * A Terminal camera is a rendered screen: every analyzer on it finds nothing,
   * forever, at full cost (`silence-analysis.ts`). Silenced once per device, so
   * an operator who turns detection back on wins. A refusal is not marked, so
   * the next hosting asks again.
   */
  private async silenceOnce(deviceId: number): Promise<void> {
    const flags = await this.ports.readDeviceFlags(deviceId)
    if (flags[ANALYSIS_SILENCED_KEY] === true) return
    try {
      await this.ports.silence(deviceId)
      await this.ports.writeDeviceFlags(deviceId, { [ANALYSIS_SILENCED_KEY]: true })
    } catch (error: unknown) {
      this.ports.logger.error('terminal: a new Terminal camera could not be silenced', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
    }
  }
}
