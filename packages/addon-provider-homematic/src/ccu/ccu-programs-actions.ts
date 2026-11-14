import type { HmDevice, HmProgram } from 'nodehomematic'
import type { z } from 'zod'
import { hmKeyChannels } from '../devices/hm-key-vocabulary.js'
import { hmName } from '../devices/hm-name.js'
import {
  isCamStackKeyEventProgramName,
  isHmipDevice,
  keyEventProgramName,
} from './ccu-button-events.js'
import type { CcuActionDeps, CcuFacade } from './ccu-facade.js'
import { errorText } from './ccu-facade.js'
import type {
  CcuProgram,
  CcuProgramsResult,
  EnsureKeyEventProgramInputSchema,
  IntegrationRefSchema,
  OkResultSchema,
  ProgramChannel,
  ProgramIdInputSchema,
  ProgramKey,
  SetProgramActiveInputSchema,
} from './ccu-schemas.js'
import { channelNameLookup, deviceAddressOf } from './hm-channel-names.js'

type IntegrationRef = z.infer<typeof IntegrationRefSchema>
type ProgramIdInput = z.infer<typeof ProgramIdInputSchema>
type SetProgramActiveInput = z.infer<typeof SetProgramActiveInputSchema>
type EnsureKeyEventInput = z.infer<typeof EnsureKeyEventProgramInputSchema>
type OkResult = z.infer<typeof OkResultSchema>

/** A CCU program write the page refused before touching the CCU. `reason` is the stable name. */
export const PROGRAM_REFUSAL_REASONS = [
  'not-connected',
  'not-confirmed',
  'unknown-program',
  'internal',
  'not-hmip-key',
  'unknown-channel',
  'no-channels',
] as const

export type ProgramRefusalReason = (typeof PROGRAM_REFUSAL_REASONS)[number]

const REFUSAL_TEXT: Record<ProgramRefusalReason, string> = {
  'not-connected': 'The CCU is not connected',
  'not-confirmed': 'A CCU write needs the operator confirmation (confirmed: true)',
  'unknown-program': 'The CCU has no such program',
  internal: 'An internal CCU program cannot be deleted here',
  'not-hmip-key': 'A key-event program needs a HmIP button device',
  'unknown-channel': 'That channel is not a key of this device',
  'no-channels': 'A key-event program needs at least one key',
}

export class ProgramRefusalError extends Error {
  readonly reason: ProgramRefusalReason
  constructor(reason: ProgramRefusalReason, detail?: string) {
    super(detail ?? REFUSAL_TEXT[reason])
    this.name = 'ProgramRefusalError'
    this.reason = reason
  }
}

/** Last run as epoch ms. Missing, blank, and epoch 0 are `null` — never shown as a run. */
export function parseLastRun(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '0') return null
  const numeric = /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN
  const ms = Number.isFinite(numeric)
    ? Math.abs(numeric) < 1e12
      ? numeric * 1000
      : numeric
    : Date.parse(trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T'))
  if (!Number.isFinite(ms) || ms < 1000) return null
  return ms
}

function refuse(reason: ProgramRefusalReason, detail?: string): never {
  throw new ProgramRefusalError(reason, detail)
}

function requireWrite(confirmed: boolean): void {
  if (confirmed !== true) refuse('not-confirmed')
}

function connectedFacade(deps: CcuActionDeps, integrationId: string): CcuFacade {
  const facade = deps.facade(integrationId)
  if (facade === null) refuse('not-connected')
  return facade
}

function programById(facade: CcuFacade, programId: string): HmProgram {
  const found = facade.programs().find((program) => program.id === programId)
  if (found === undefined) refuse('unknown-program')
  return found
}

function channelRow(
  address: string,
  names: ReturnType<typeof channelNameLookup>,
  adopted: ReadonlyMap<string, number>,
  adoptedNames: ReadonlyMap<string, string>,
): ProgramChannel {
  const deviceAddress = deviceAddressOf(address)
  const ccu = names(address)
  const camstack = adoptedNames.get(deviceAddress)?.trim()
  return {
    address,
    channelName: ccu.channelName,
    deviceName: camstack !== undefined && camstack !== '' ? camstack : ccu.deviceName,
    deviceId: adopted.get(deviceAddress) ?? null,
  }
}

function keyRows(
  devices: readonly HmDevice[],
  adopted: ReadonlyMap<string, number>,
  adoptedNames: ReadonlyMap<string, string>,
): ProgramKey[] {
  const names = channelNameLookup(devices)
  return devices.filter(isHmipDevice).flatMap((device) =>
    hmKeyChannels(device).map((channel) => {
      const resolved = channelRow(channel.address, names, adopted, adoptedNames)
      return {
        address: channel.address,
        name: hmName(channel.name),
        deviceAddress: device.address,
        deviceName: resolved.deviceName,
        deviceType: device.type,
      }
    }),
  )
}

async function conditionsOf(
  deps: CcuActionDeps,
  integrationId: string,
  facade: CcuFacade,
  program: HmProgram,
  devices: readonly HmDevice[],
  adopted: ReadonlyMap<string, number>,
  adoptedNames: ReadonlyMap<string, string>,
): Promise<ProgramChannel[]> {
  if (!isCamStackKeyEventProgramName(program.name)) return []
  try {
    const found = await facade.getKeyEventProgram(program.name)
    const names = channelNameLookup(devices)
    return (found?.channelAddresses ?? []).map((address) =>
      channelRow(address, names, adopted, adoptedNames),
    )
  } catch (err: unknown) {
    const owner = devices.find((device) => keyEventProgramName(device) === program.name)
    const deviceId = owner === undefined ? undefined : adopted.get(owner.address)
    deps.logger.warn('Homematic key event program could not be read', {
      ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
      meta: { integrationId, programId: program.id, error: errorText(err) },
    })
    return []
  }
}

function toRow(program: HmProgram, channels: readonly ProgramChannel[]): CcuProgram {
  return {
    id: program.id,
    name: program.name,
    active: program.isActive,
    internal: program.isInternal,
    lastRunMs: parseLastRun(program.lastExecuteTime),
    createdByCamstack: isCamStackKeyEventProgramName(program.name),
    channels: [...channels],
  }
}

function deviceIdsOf(channels: readonly ProgramChannel[]): number[] {
  return [
    ...new Set(
      channels.flatMap((channel) => (channel.deviceId === null ? [] : [channel.deviceId])),
    ),
  ]
}

function logProgram(
  deps: CcuActionDeps,
  message: string,
  deviceIds: readonly number[],
  meta: Record<string, unknown>,
): void {
  if (deviceIds.length === 0) {
    deps.logger.info(message, { meta })
    return
  }
  for (const deviceId of deviceIds) {
    deps.logger.info(message, { tags: { deviceId }, meta })
  }
}

async function refreshPrograms(
  deps: CcuActionDeps,
  facade: CcuFacade,
  integrationId: string,
): Promise<void> {
  try {
    await facade.refreshHub()
  } catch (err: unknown) {
    deps.logger.warn('Homematic: program list could not be refreshed', {
      meta: { integrationId, error: errorText(err) },
    })
  }
  deps.ccuChanged(integrationId)
}

/** The Programs tab: list every CCU program, and the key-event program CamStack can write. */
export function buildCcuProgramHandlers(deps: CcuActionDeps) {
  return {
    listCcuPrograms: async (input: IntegrationRef): Promise<CcuProgramsResult> => {
      const facade = connectedFacade(deps, input.integrationId)
      const devices = facade.devices()
      const [adopted, adoptedNames] = await Promise.all([
        deps.adoptedAddresses(input.integrationId),
        deps.adoptedNames(input.integrationId),
      ])
      const programs: CcuProgram[] = []
      for (const program of facade.programs()) {
        const channels = await conditionsOf(
          deps,
          input.integrationId,
          facade,
          program,
          devices,
          adopted,
          adoptedNames,
        )
        programs.push(toRow(program, channels))
      }
      return { programs, keys: keyRows(devices, adopted, adoptedNames) }
    },

    runCcuProgram: async (input: ProgramIdInput): Promise<OkResult> => {
      requireWrite(input.confirmed)
      const facade = connectedFacade(deps, input.integrationId)
      const program = programById(facade, input.programId)
      await facade.runProgram(program.id)
      const adopted = await deps.adoptedAddresses(input.integrationId)
      const names = await deps.adoptedNames(input.integrationId)
      const channels = await conditionsOf(
        deps,
        input.integrationId,
        facade,
        program,
        facade.devices(),
        adopted,
        names,
      )
      logProgram(deps, 'Homematic: program run', deviceIdsOf(channels), {
        integrationId: input.integrationId,
        programId: program.id,
        name: program.name,
      })
      await refreshPrograms(deps, facade, input.integrationId)
      return { ok: true }
    },

    setCcuProgramActive: async (input: SetProgramActiveInput): Promise<OkResult> => {
      requireWrite(input.confirmed)
      const facade = connectedFacade(deps, input.integrationId)
      const program = programById(facade, input.programId)
      await facade.setProgramActive(program.id, input.active)
      logProgram(deps, `Homematic: program ${input.active ? 'enabled' : 'disabled'}`, [], {
        integrationId: input.integrationId,
        programId: program.id,
        name: program.name,
      })
      await refreshPrograms(deps, facade, input.integrationId)
      return { ok: true }
    },

    deleteCcuProgram: async (input: ProgramIdInput): Promise<OkResult> => {
      requireWrite(input.confirmed)
      const facade = connectedFacade(deps, input.integrationId)
      const program = programById(facade, input.programId)
      if (program.isInternal) refuse('internal')
      const { removed } = await facade.deleteProgram(program.id)
      if (!removed) refuse('unknown-program')
      logProgram(deps, 'Homematic: program deleted', [], {
        integrationId: input.integrationId,
        programId: program.id,
        name: program.name,
      })
      await refreshPrograms(deps, facade, input.integrationId)
      return { ok: true }
    },

    ensureCcuKeyEventProgram: async (input: EnsureKeyEventInput): Promise<OkResult> => {
      requireWrite(input.confirmed)
      const facade = connectedFacade(deps, input.integrationId)
      const device = facade.devices().find((candidate) => candidate.address === input.deviceAddress)
      if (device === undefined || !isHmipDevice(device)) refuse('not-hmip-key')
      const keys = new Set(hmKeyChannels(device).map((channel) => channel.address))
      const wanted = [...new Set(input.channelAddresses)]
      if (wanted.length === 0) refuse('no-channels')
      const foreign = wanted.find((address) => !keys.has(address))
      if (foreign !== undefined) {
        refuse('unknown-channel', `Channel ${foreign} is not a key of this device`)
      }
      const name = keyEventProgramName(device)
      const { programId } = await facade.ensureKeyEventProgram({ name, channelAddresses: wanted })
      const deviceId = (await deps.adoptedAddresses(input.integrationId)).get(device.address)
      logProgram(
        deps,
        'Homematic: key event program ensured',
        deviceId === undefined ? [] : [deviceId],
        {
          integrationId: input.integrationId,
          programId,
          name,
          channels: wanted,
        },
      )
      await refreshPrograms(deps, facade, input.integrationId)
      return { ok: true }
    },
  }
}
