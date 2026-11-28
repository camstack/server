/**
 * The draft of the config extensions of a Customize tab (D1098, planning#675).
 * An extension keeps its configuration in the owning capability (the remote's
 * bindings, a fan's presets), and its editor is a modal of its own. The modal's
 * confirm no longer writes: it hands the edited configuration to this draft, the
 * Customize row shows it, and the tab's one Save bar writes it. Discard drops it.
 * A refusal the capability answers is shown by the bar and keeps the draft.
 */
import {
  coreBlockComposition,
  type DeviceInfo,
  type FanPreset,
  type RemoteConfig,
} from '@dominevo/types'
import {
  trpc,
  useCoreBlocksUpdateComposition,
  useFanPresetsSetPresets,
  useRemoteSetConfig,
} from '@dominevo/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { composedBlockIdOf, withMediaPlayerExtension } from '../../../remote/composed-remote'
import { useDraftSection } from '../customize-draft'

interface Held<T> {
  readonly device: DeviceInfo
  readonly value: T
}

export interface ConfigDraft {
  /** The remote configuration the operator edited and has not saved, or null. */
  readonly remote: RemoteConfig | null
  /** The presets list the operator edited and has not saved, or null. */
  readonly fanPresets: readonly FanPreset[] | null
  readonly setRemote: (device: DeviceInfo, config: RemoteConfig | null) => void
  readonly setFanPresets: (device: DeviceInfo, presets: readonly FanPreset[] | null) => void
}

const ConfigDraftContext = createContext<ConfigDraft | null>(null)

/** The config draft of the enclosing tab; null outside one (an editor then has nowhere to keep an edit). */
export function useConfigDraft(): ConfigDraft | null {
  return useContext(ConfigDraftContext)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ConfigDraftProviderProps {
  readonly children: ReactNode
}

/** Must sit inside the tab's `CustomizeDraftProvider`: it registers the two sections with its bar. */
export function ConfigDraftProvider({ children }: ConfigDraftProviderProps): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const utils = trpc.useUtils()
  const setRemoteConfig = useRemoteSetConfig()
  const setPresets = useFanPresetsSetPresets()
  const updateBlock = useCoreBlocksUpdateComposition()
  const [remote, setRemoteHeld] = useState<Held<RemoteConfig> | null>(null)
  const [presets, setPresetsHeld] = useState<Held<readonly FanPreset[]> | null>(null)

  /** A built player has no media-player cap until the remote gives it one (D1004). */
  const attachMediaPlayerFeature = async (device: DeviceInfo): Promise<void> => {
    const blockId = composedBlockIdOf(device)
    if (blockId === null) return
    const read = await utils.coreBlocks.getComposition.fetch({ blockId }, { staleTime: 0 })
    const view = read.state === 'loaded' ? read.view : null
    if (view === null) return
    const composition = coreBlockComposition(view.block)
    const next = composition === null ? null : withMediaPlayerExtension(composition)
    if (next === null) return
    await updateBlock.mutateAsync({
      blockId,
      expectedUpdatedAt: view.block.updatedAt,
      block: { composition: next },
    })
  }

  const saveRemote = async (): Promise<string | null> => {
    if (remote === null) return null
    try {
      const result = await setRemoteConfig.mutateAsync({
        deviceId: remote.device.id,
        config: remote.value,
      })
      if (result.status === 'refused') return result.detail
      await attachMediaPlayerFeature(remote.device)
      await queryClient.invalidateQueries({ queryKey: [['remote']] })
      setRemoteHeld(null)
      return null
    } catch (err: unknown) {
      return messageOf(err)
    }
  }
  const savePresets = async (): Promise<string | null> => {
    if (presets === null) return null
    try {
      const result = await setPresets.mutateAsync({
        deviceId: presets.device.id,
        presets: [...presets.value],
      })
      if (result.status === 'refused') return result.detail
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [['fanPresets']] }),
        queryClient.invalidateQueries({ queryKey: [['actions']] }),
      ])
      setPresetsHeld(null)
      return null
    } catch (err: unknown) {
      return messageOf(err)
    }
  }
  const saveRemoteRef = useRef(saveRemote)
  saveRemoteRef.current = saveRemote
  const savePresetsRef = useRef(savePresets)
  savePresetsRef.current = savePresets

  useDraftSection('config-remote', {
    label: t('customize.table.caps.remote'),
    pendingCount: remote === null ? 0 : 1,
    save: () => saveRemoteRef.current(),
    discard: () => setRemoteHeld(null),
  })
  useDraftSection('config-fan-presets', {
    label: t('customize.table.caps.fan-presets'),
    pendingCount: presets === null ? 0 : 1,
    save: () => savePresetsRef.current(),
    discard: () => setPresetsHeld(null),
  })

  const value: ConfigDraft = {
    remote: remote?.value ?? null,
    fanPresets: presets?.value ?? null,
    setRemote: (device, config) =>
      setRemoteHeld(config === null ? null : { device, value: config }),
    setFanPresets: (device, list) => setPresetsHeld(list === null ? null : { device, value: list }),
  }
  return <ConfigDraftContext.Provider value={value}>{children}</ConfigDraftContext.Provider>
}
