/**
 * The Detection Pipeline tab's target: an image, a step tree, and the
 * `(node, deviceKey)` pair that will run it.
 *
 * Picking a camera is a means, not the goal: it is how the tab loads the
 * tree that REALLY runs, on the node and accelerator it really runs on
 * (`resolvePipeline` for the structure, `getCameraStatuses` for the live
 * placement, `getNodeInferenceDevices` for how that accelerator is spelled).
 * The run itself is still image-driven, and the operator can retarget the
 * node and the device explicitly — a camera's live placement is a starting
 * point, never a lock.
 *
 * ⚠️ Every composite this file renders is LOCAL to the benchmark package.
 * The page is a Module-Federation remote that declares `@camstack/ui-library`
 * with `import: false`, so it consumes the HOST's copy: a composite present
 * in this tree but absent from the DEPLOYED ui-library type-checks here and
 * is `undefined` at runtime. Adding one is a framework train, not an addon
 * deploy.
 */

import type { CameraStatus } from '@camstack/types'
import type { AddonPageProps } from '@camstack/ui-library'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  describeResolvedSteps,
  deviceKeyOf,
  type NodeDevice,
  type ResolvedStep,
} from '../camera-context.js'
import { useT } from '../i18n/index.js'
import { type DeviceOption, friendlyDeviceName, SingleDeviceSelector } from './DeviceSelector.js'
import { Select } from '@camstack/ui-library'

export interface CameraOption {
  readonly deviceId: number
  readonly name: string
}

/** What the tab needs in order to run: resolved tree plus the target pair. */
export interface ResolvedTarget {
  readonly deviceId: number
  readonly nodeId: string
  readonly steps: readonly ResolvedStep[]
  /** The accelerator the camera is LIVE on, spelled as its node spells it. */
  readonly liveDeviceKey: string | undefined
  /** Set when the camera's reported engine is not in the node's roster. */
  readonly liveDeviceUnmatched: boolean
  readonly detection: CameraStatus['detection']
}

interface RunTargetPickerProps {
  readonly trpc: AddonPageProps['trpc']
  /** The page-level node. Owned above; this component asks for changes. */
  readonly nodeId: string
  readonly onNodeChange: (nodeId: string) => void
  readonly deviceKey: string | null
  readonly onDeviceKeyChange: (deviceKey: string | null) => void
  readonly selectedDeviceId: number | null
  readonly onSelectCamera: (deviceId: number | null) => void
  readonly onResolved: (target: ResolvedTarget | null) => void
  readonly disabled: boolean
}

interface DeviceListEntry {
  readonly id: number
  readonly name: string
  readonly isCamera: boolean
}

export function RunTargetPicker({
  trpc,
  nodeId,
  onNodeChange,
  deviceKey,
  onDeviceKeyChange,
  selectedDeviceId,
  onSelectCamera,
  onResolved,
  disabled,
}: RunTargetPickerProps) {
  const { t } = useT()
  const [cameras, setCameras] = useState<readonly CameraOption[]>([])
  const [statuses, setStatuses] = useState<readonly CameraStatus[]>([])
  const [devices, setDevices] = useState<readonly NodeDevice[]>([])
  const [target, setTarget] = useState<ResolvedTarget | null>(null)
  const [resolveError, setResolveError] = useState('')

  // ── Camera roster: statuses (placement) + listAll (names) ─────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [rawStatuses, rawDevices] = await Promise.all([
          trpc.pipelineOrchestrator.getCameraStatuses.query({}),
          // `slim` skips the per-device settings read: this page needs
          // names and the camera flag, nothing that `sourceInfo` carries,
          // and the roster is ~1019 devices.
          //
          // The key is `projection: 'slim'`, NOT `slim: true`. It was written
          // `{ slim: true }` under this very comment, and Zod STRIPS an input
          // key the schema does not have rather than rejecting it — so the
          // comment described a narrowing that never happened and this call was
          // the FULL projection (5.6 s and every device's `config` blob) on
          // every mount. `check-fleet-query-defaults.ts` now fails on both
          // halves of that mistake.
          //
          // `isCamera: true` server-side is provably identical to the
          // `d.isCamera` filter kept below — the resolver applies exactly
          // `if (camerasOnly && !info.isCamera) continue`.
          trpc.deviceManager.listAll.query({ isCamera: true, projection: 'slim' }),
        ])
        if (cancelled) return
        const list = rawStatuses as readonly CameraStatus[]
        const nameById = new Map<number, string>(
          (rawDevices as readonly DeviceListEntry[])
            .filter((d) => d.isCamera)
            .map((d) => [d.id, d.name]),
        )
        setStatuses(list)
        setCameras(
          list
            .map((s) => ({
              deviceId: s.deviceId,
              name: nameById.get(s.deviceId) ?? `#${s.deviceId}`,
            }))
            .toSorted((a, b) => a.name.localeCompare(b.name)),
        )
      } catch (err: unknown) {
        if (!cancelled) setResolveError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trpc])

  // ── Device roster for the CURRENT node ────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await trpc.pipelineOrchestrator.getNodeInferenceDevices.query({ nodeId })
        if (!cancelled) setDevices(res.devices as readonly NodeDevice[])
      } catch {
        // A node without the orchestrator cap simply shows no chips and the
        // run goes out with no deviceKey — the node's default pool.
        if (!cancelled) setDevices([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trpc, nodeId])

  const deviceOptions: readonly DeviceOption[] = useMemo(
    () =>
      devices.map((d) => ({
        key: d.key,
        label: friendlyDeviceName(d),
        available: d.available,
        enabled: d.available,
      })),
    [devices],
  )

  // A deviceKey picked for a different node must not survive a node change:
  // running `edgetpu:usb` against a node that has no Coral is a run that
  // either fails or silently lands somewhere else.
  useEffect(() => {
    if (deviceKey && !devices.some((d) => d.key === deviceKey)) onDeviceKeyChange(null)
  }, [devices, deviceKey, onDeviceKeyChange])

  // ── Resolve the picked camera ─────────────────────────────────────────
  const resolveCamera = useCallback(
    async (deviceId: number): Promise<void> => {
      setResolveError('')
      const status = statuses.find((s) => s.deviceId === deviceId)
      const detection = status?.detection ?? null
      const liveNodeId = detection?.nodeId ?? nodeId
      try {
        const cfg = await trpc.pipelineOrchestrator.resolvePipeline.query({
          deviceId,
          agentNodeId: liveNodeId,
        })
        const roster =
          liveNodeId === nodeId
            ? devices
            : ((await trpc.pipelineOrchestrator.getNodeInferenceDevices
                .query({ nodeId: liveNodeId })
                .then((r) => r.devices as readonly NodeDevice[])
                .catch(() => [])) as readonly NodeDevice[])
        const liveDeviceKey = deviceKeyOf(detection?.engine, roster)
        const next: ResolvedTarget = {
          deviceId,
          nodeId: liveNodeId,
          steps: cfg.steps as readonly ResolvedStep[],
          liveDeviceKey,
          liveDeviceUnmatched:
            liveDeviceKey !== undefined && !roster.some((d) => d.key === liveDeviceKey),
          detection,
        }
        setTarget(next)
        onResolved(next)
        if (liveNodeId !== nodeId) onNodeChange(liveNodeId)
        onDeviceKeyChange(liveDeviceKey ?? null)
      } catch (err: unknown) {
        setTarget(null)
        onResolved(null)
        setResolveError(err instanceof Error ? err.message : String(err))
      }
    },
    [trpc, statuses, nodeId, devices, onResolved, onNodeChange, onDeviceKeyChange],
  )

  const handleSelect = (raw: string): void => {
    if (raw === '') {
      onSelectCamera(null)
      setTarget(null)
      onResolved(null)
      return
    }
    const deviceId = Number(raw)
    onSelectCamera(deviceId)
    void resolveCamera(deviceId)
  }

  const detection = target?.detection ?? null
  const resolvedLines = target ? describeResolvedSteps(target.steps) : []

  return (
    <div className="rounded-md border border-border bg-surface p-3 space-y-3">
      <div className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
        {t('runTarget.title')}
      </div>

      <label className="block text-xs">
        <span className="text-foreground-subtle">{t('runTarget.camera')}</span>
        <Select
          className="mt-1 w-full sm:py-1"
          value={selectedDeviceId === null ? '' : String(selectedDeviceId)}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={disabled}
        >
          <option value="">{t('runTarget.customTree')}</option>
          {cameras.map((c) => (
            <option key={c.deviceId} value={String(c.deviceId)}>
              {c.name} · #{c.deviceId}
            </option>
          ))}
        </Select>
      </label>

      {resolveError && (
        <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
          {resolveError}
        </div>
      )}

      {/* Resolved context, READ ONLY. This alone answers "why is 102 worse
          than 101" before a single bench run happens. */}
      {target && (
        <div className="rounded-md border border-border bg-background p-2 space-y-1 text-[11px] font-mono">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>
              {t('runTarget.node')}: <span className="text-primary">{target.nodeId}</span>
            </span>
            <span>
              {t('runTarget.device')}:{' '}
              <span className="text-primary">
                {target.liveDeviceKey ?? t('runTarget.notDispatched')}
              </span>
              {target.liveDeviceUnmatched && (
                <span className="ml-1 text-danger">{t('runTarget.notInRoster')}</span>
              )}
            </span>
            {detection && (
              <>
                <span>
                  {t('runTarget.phase')}: {detection.phase}
                </span>
                <span>fps: {detection.actualFps.toFixed(2)}</span>
                <span>
                  {t('runTarget.infer')}: {detection.avgInferenceMs.toFixed(1)} ms
                </span>
                <span>
                  {t('runTarget.queue')}: {detection.queueDepth}
                </span>
                <span>
                  {t('runTarget.provisioning')}: {detection.provisioning.state}
                </span>
              </>
            )}
          </div>
          {!detection && <div className="text-foreground-subtle">{t('runTarget.noDetection')}</div>}
        </div>
      )}

      {/* The tree resolvePipeline returned, verbatim. Models are never
          re-derived here: an absent modelId means the executing node picks
          its own format default, and it is shown as such. */}
      {target && (
        <div className="rounded-md border border-border bg-background p-2 space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
            {t('runTarget.resolvedTree')}
          </div>
          {resolvedLines.length === 0 ? (
            <div className="text-[11px] text-foreground-subtle">{t('runTarget.noSteps')}</div>
          ) : (
            resolvedLines.map((l, i) => (
              <div
                key={`${l.addonId}-${i}`}
                className={`text-[11px] font-mono ${l.enabled ? 'text-foreground' : 'text-foreground-subtle line-through'}`}
                style={{ paddingLeft: `${l.depth * 12}px` }}
              >
                {l.addonId} <span className="text-foreground-subtle">· {l.modelLabel}</span>
              </div>
            ))
          )}
        </div>
      )}

      <SingleDeviceSelector
        value={deviceKey}
        onChange={onDeviceKeyChange}
        devices={deviceOptions}
        disabled={disabled}
        liveKey={target?.liveDeviceKey}
      />
    </div>
  )
}
