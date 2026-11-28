/**
 * What the "Found on the network" side of the Add device modal knows and does: the scan scoped to the
 * integration, the passive proposals, the devices the hub already holds, and the calls that add a
 * found device. One hook, so the standalone list and the single adoption list read and act on the same
 * state, whichever of them draws it.
 *
 * Every answer is kept apart from "nothing": a query that has not answered is `pending`, one that
 * failed is `failed`, and only an answered query that is empty may be shown as empty (D315).
 */
import {
  useDeviceManagerAdoptDevice,
  useDeviceManagerAdoptionStartJob,
  useDeviceManagerDiscoverProvider,
  useDeviceManagerListAll,
  useDeviceManagerListDiscoveryProposals,
  useDeviceManagerProviderDiscoveryParamsSchema,
} from '@dominevo/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import type { ConfigUISchema } from '../../types/config-ui'
import { needsIntegrationSetup } from './integration-setup-seed'
import {
  type AdoptionEntry,
  mergeNetworkCandidates,
  type NetworkCandidate,
} from './network-candidates'

type ScanData = NonNullable<ReturnType<typeof useDeviceManagerDiscoverProvider>['data']>
export type NetworkHit = ScanData['candidates'][number]
export type NetworkRow = NetworkCandidate<NetworkHit>

/** One query's answer: not asked yet, answered (possibly empty) or failed. */
export type AnswerState = 'pending' | 'answered' | 'failed'

export interface NetworkScan {
  /** One row per device, whichever of the adoption list, the scan and the proposals saw it. */
  readonly rows: readonly NetworkRow[]
  readonly scanParamsSchema: ConfigUISchema | null
  readonly scanParams: Record<string, unknown>
  readonly setScanParams: (values: Record<string, unknown>) => void
  readonly scanning: boolean
  readonly scanFailed: boolean
  /** A scan has run and returned (so "nothing responded" may be said). */
  readonly scanAnswered: boolean
  readonly runScan: () => void
  readonly proposals: AnswerState
  /** Which devices the hub already holds: unknown until it answers, so a row cannot yet read "not added". */
  readonly devices: AnswerState
  readonly busy: ReadonlySet<string>
  readonly added: ReadonlySet<string>
  readonly error: string | null
  readonly paramsFor: NetworkRow | null
  readonly setParamsFor: (row: NetworkRow | null) => void
  /** Add a row, or open its parameter step when it needs a value the provider cannot guess. */
  readonly pick: (row: NetworkRow) => void
  readonly addRow: (row: NetworkRow, config?: Readonly<Record<string, unknown>>) => Promise<void>
}

interface UseNetworkScanInput {
  readonly addonId: string
  readonly integrationId: string
  /** What the integration's own `device-adoption` provider lists, merged into the rows. */
  readonly adoption: readonly AdoptionEntry[]
  /** False draws nothing and asks nothing (an adoption integration that does not scan). */
  readonly enabled?: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function answerOf(query: { readonly isSuccess: boolean; readonly isError: boolean }): AnswerState {
  return query.isSuccess ? 'answered' : query.isError ? 'failed' : 'pending'
}

export function useNetworkScan({
  addonId,
  integrationId,
  adoption,
  enabled = true,
}: UseNetworkScanInput): NetworkScan {
  const queryClient = useQueryClient()

  const paramsSchemaQuery = useDeviceManagerProviderDiscoveryParamsSchema({ addonId }, { enabled })
  const scanParamsSchema = (paramsSchemaQuery.data ?? null) as ConfigUISchema | null
  const [scanParams, setScanParams] = useState<Record<string, unknown>>({})
  const scan = useDeviceManagerDiscoverProvider()

  const proposalsQuery = useDeviceManagerListDiscoveryProposals({}, { enabled })
  const devicesQuery = useDeviceManagerListAll({ projection: 'slim' }, { enabled })

  const adoptDevice = useDeviceManagerAdoptDevice()
  const startJob = useDeviceManagerAdoptionStartJob()
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [paramsFor, setParamsFor] = useState<NetworkRow | null>(null)

  const rows = useMemo<readonly NetworkRow[]>(() => {
    if (!enabled) return []
    // Inside an integration only devices of THIS integration are offered: a candidate that is an
    // integration to set up (a console, a host) belongs to the Integrations page, never here.
    const proposals = (proposalsQuery.data?.proposals ?? [])
      .filter((p) => p.addonId === addonId && !needsIntegrationSetup(p.candidate))
      .map((p) => ({ id: p.id, candidate: p.candidate }))
    const devices = devicesQuery.data ?? []
    return mergeNetworkCandidates<NetworkHit>({
      adoption,
      scan: (scan.data?.candidates ?? []).filter((c) => !needsIntegrationSetup(c)),
      proposals,
      existingStableIds: new Set(devices.map((d) => d.stableId)),
      existingDeviceIds: new Map(devices.map((d) => [d.stableId, d.id])),
    })
  }, [enabled, adoption, proposalsQuery.data, scan.data, devicesQuery.data, addonId])

  const runScan = useCallback(() => {
    setError(null)
    scan.mutate({ addonId, params: scanParams })
  }, [scan, addonId, scanParams])

  const withBusy = useCallback(
    async (key: string, work: () => Promise<void>) => {
      setBusy((prev) => new Set(prev).add(key))
      setError(null)
      try {
        await work()
        setAdded((prev) => new Set(prev).add(key))
        void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
        void queryClient.invalidateQueries({ queryKey: [['integrations']] })
      } catch (err) {
        setError(errorText(err))
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [queryClient],
  )

  const addRow = useCallback(
    async (row: NetworkRow, config?: Readonly<Record<string, unknown>>) => {
      const hit = row.hit
      if (hit !== null) {
        await withBusy(row.key, async () => {
          await adoptDevice.mutateAsync({
            addonId,
            integrationId,
            candidate: { ...hit, prefilledConfig: { ...hit.prefilledConfig, ...config } },
          })
          setParamsFor(null)
        })
        return
      }
      if (row.adoptionId !== null) {
        const childNativeId = row.adoptionId
        await withBusy(row.key, async () => {
          await startJob.mutateAsync({ addonId, integrationId, childNativeIds: [childNativeId] })
        })
      }
    },
    [adoptDevice, startJob, addonId, integrationId, withBusy],
  )

  const pick = useCallback(
    (row: NetworkRow) => {
      if (row.needsParams.length > 0 && row.hit !== null) {
        setError(null)
        setParamsFor(row)
        return
      }
      void addRow(row)
    },
    [addRow],
  )

  return {
    rows,
    scanParamsSchema,
    scanParams,
    setScanParams,
    scanning: scan.isPending,
    scanFailed: scan.isError,
    scanAnswered: scan.data !== undefined,
    runScan,
    proposals: enabled ? answerOf(proposalsQuery) : 'answered',
    devices: enabled ? answerOf(devicesQuery) : 'answered',
    busy,
    added,
    error,
    paramsFor,
    setParamsFor,
    pick,
    addRow,
  }
}
