import type { IScopedLogger } from '@camstack/types'
import type { Homematic } from 'nodehomematic'
import type { CcuListItem } from './ccu-schemas.js'

/**
 * The slice of the nodehomematic facade the CCU management actions use. Real
 * sessions satisfy it; specs hand in a fake with only the calls under test.
 */
export type CcuFacade = Pick<
  Homematic,
  | 'ccuInfo'
  | 'listInterfaces'
  | 'serviceMessages'
  | 'acknowledgeServiceMessage'
  | 'devices'
  | 'customEntities'
  | 'groups'
  | 'createGroup'
  | 'updateGroup'
  | 'deleteGroup'
  | 'setInstallMode'
  | 'getInstallMode'
  | 'deleteDevice'
  | 'getConfigParams'
  | 'getConfig'
  | 'setConfig'
  | 'getChannelLinkState'
  | 'createCentralLink'
  | 'removeCentralLink'
  | 'ensureKeyEventProgram'
  | 'getKeyEventProgram'
  | 'removeKeyEventProgram'
  | 'programs'
  | 'runProgram'
  | 'setProgramActive'
  | 'refreshHub'
  | 'addLink'
  | 'removeLink'
  | 'listLinks'
  | 'setLinkProfile'
  | 'renameDevice'
  | 'renameChannel'
  | 'listRooms'
  | 'createRoom'
  | 'renameRoom'
  | 'deleteRoom'
  | 'addChannelToRoom'
  | 'removeChannelFromRoom'
  | 'setValue'
>

/** What every CCU action handler is built from. */
export interface CcuActionDeps {
  /** The live facade of an integration, or null when it is unknown or not connected. */
  readonly facade: (integrationId: string) => CcuFacade | null
  readonly integrations: () => readonly CcuListItem[]
  readonly logger: IScopedLogger
  /**
   * CCU device address → CamStack device id for containers adopted from this
   * integration. A missing address is not adopted.
   */
  readonly adoptedAddresses: (integrationId: string) => Promise<ReadonlyMap<string, number>>
  /** CCU address → CamStack device name, for the same containers as `adoptedAddresses`. */
  readonly adoptedNames: (integrationId: string) => Promise<ReadonlyMap<string, string>>
  /**
   * A CCU write landed: the adopted devices of this integration re-read what
   * they show (a key's central link, a name).
   */
  readonly ccuChanged: (integrationId: string) => void
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The facade of a connected integration, or a named refusal. */
export function requireFacade(deps: CcuActionDeps, integrationId: string): CcuFacade {
  const facade = deps.facade(integrationId)
  if (facade === null) {
    throw new Error(`Homematic integration ${integrationId} is not connected`)
  }
  return facade
}

/** A CCU write runs only behind the operator's explicit confirmation. */
export function requireConfirmed(confirmed: boolean): void {
  if (confirmed !== true) {
    throw new Error('A CCU write needs the operator confirmation (confirmed: true)')
  }
}
