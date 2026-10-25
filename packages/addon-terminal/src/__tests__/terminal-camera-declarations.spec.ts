import {
  DeclaredDevices,
  type DeviceConstructor,
  type DeviceManagerApi,
  DeviceType,
  type IDevice,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  buildTerminalInstanceCameraDeclarations,
  declarationFromExistingTerminalCamera,
  needsTerminalCameraConfigMigration,
  type TerminalCameraDeclaration,
  terminalCameraReconciliationIndex,
} from '../terminal-camera-declarations.js'
import type { TerminalInstance } from '../terminal-instances.js'

const integrationId = 'terminal-integration'
const monitorInstance: TerminalInstance = {
  id: '018f5846-3ae2-7cb7-9a13-0800200c9a66',
  cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a66',
  nodeId: 'agent-a',
  profileId: 'monitor',
  profileLabel: 'BTM',
  name: 'Mac mini monitor',
  enabled: true,
  executable: '',
  args: [],
  cwd: '',
  environment: [],
  profileSettings: {},
}

class FakeTerminalCamera {
  constructor(readonly id: number) {}
}

const FakeTerminalCameraClass = FakeTerminalCamera as unknown as DeviceConstructor<IDevice>
const logger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
  withTags: () => logger,
}

async function reconcileDeclaredCameras(
  declarations: readonly TerminalCameraDeclaration[],
  initialRows: readonly { id: number; stableId: string; integrationId: string }[],
) {
  const rows = [...initialRows]
  const remove = vi.fn(async (id: number) => {
    const index = rows.findIndex((row) => row.id === id)
    if (index >= 0) rows.splice(index, 1)
  })
  const declared = new DeclaredDevices({
    logger,
    addonId: 'terminal',
    localNodeId: 'hub',
    devices: {
      create: vi.fn(async (stableId: string) => {
        const row = rows.find((candidate) => candidate.stableId === stableId)
        return new FakeTerminalCamera(row?.id ?? 999) as unknown as IDevice
      }),
      remove,
    } as unknown as DeviceManagerApi,
    getIntegration: async () => ({ id: integrationId, info: { fixed: true } }),
    createIntegration: async () => ({ id: integrationId }),
    updateIntegration: async () => {},
    listOwnDevices: async () => rows,
  })
  const result = await declared.reconcile({
    integrationName: 'Terminal',
    devices: declarations.map((declaration) => ({
      ...declaration,
      type: DeviceType.Camera,
      DeviceClass: FakeTerminalCameraClass,
    })),
  })
  return { result, remove, rows }
}

describe('Terminal camera declarations', () => {
  it('declares only enabled persisted instances and supports duplicate profiles on one node', () => {
    expect(
      buildTerminalInstanceCameraDeclarations([
        monitorInstance,
        {
          ...monitorInstance,
          id: '018f5846-3ae2-7cb7-9a13-0800200c9a67',
          cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a67',
          name: 'Mac mini monitor 2',
        },
        {
          ...monitorInstance,
          id: '018f5846-3ae2-7cb7-9a13-0800200c9a68',
          cameraStableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a68',
          profileId: 'top',
          profileLabel: 'Top',
          enabled: false,
        },
      ]),
    ).toEqual([
      {
        stableId: monitorInstance.cameraStableId,
        name: 'Mac mini monitor',
        config: {
          instanceId: monitorInstance.id,
          nodeId: 'agent-a',
          profileId: 'monitor',
          profileLabel: 'BTM',
        },
      },
      {
        stableId: 'terminal-camera-instance-018f5846-3ae2-7cb7-9a13-0800200c9a67',
        name: 'Mac mini monitor 2',
        config: {
          instanceId: '018f5846-3ae2-7cb7-9a13-0800200c9a67',
          nodeId: 'agent-a',
          profileId: 'monitor',
          profileLabel: 'BTM',
        },
      },
    ])
  })

  it('can explicitly adopt a legacy monitor identity and persist its missing fields', () => {
    const declaration = declarationFromExistingTerminalCamera(
      { id: 'agent-a', name: 'Mac mini', isHub: false },
      { stableId: 'terminal-camera-agent-a', config: { nodeId: 'agent-a' } },
    )!
    expect(declaration.config).toMatchObject({
      instanceId: 'legacy:terminal-camera-agent-a',
      profileId: 'monitor',
      profileLabel: 'BTM',
    })
    expect(needsTerminalCameraConfigMigration({ nodeId: 'agent-a' }, declaration)).toBe(true)
    expect(needsTerminalCameraConfigMigration(declaration.config, declaration)).toBe(false)
  })

  it('leaves current automatic legacy cameras out of the managed deletion index', () => {
    const declarations = buildTerminalInstanceCameraDeclarations([monitorInstance])
    const index = terminalCameraReconciliationIndex(
      [
        {
          id: 1,
          stableId: 'terminal-camera-agent-a',
          integrationId,
          config: { nodeId: 'agent-a' },
        },
        {
          id: 2,
          stableId: 'terminal-camera-agent-a-top',
          integrationId,
          config: { nodeId: 'agent-a', profileId: 'top' },
        },
        {
          id: 3,
          stableId: monitorInstance.cameraStableId,
          integrationId,
          config: {},
        },
        {
          id: 4,
          stableId: 'terminal-camera-instance-deleted',
          integrationId,
          config: {},
        },
      ],
      integrationId,
      declarations,
    )

    expect(index.map((row) => row.id)).toEqual([3, 4])
  })

  it('withdraws a deleted explicit instance idempotently', async () => {
    const declarations = buildTerminalInstanceCameraDeclarations([monitorInstance])
    const first = await reconcileDeclaredCameras(declarations, [
      { id: 1, stableId: monitorInstance.cameraStableId, integrationId },
      { id: 2, stableId: 'terminal-camera-instance-deleted', integrationId },
    ])
    expect(first.result.removed).toEqual([2])
    expect(first.remove).toHaveBeenCalledOnce()

    const second = await reconcileDeclaredCameras(declarations, first.rows)
    expect(second.result.removed).toEqual([])
    expect(second.remove).not.toHaveBeenCalled()
  })
})
