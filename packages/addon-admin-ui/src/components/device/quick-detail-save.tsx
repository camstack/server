/**
 * One Save for identity, display and any section that registers (the export
 * form). The quick-detail modal and the device Customize tab share it, so a
 * name, a room, a role and a display override are not written field by field.
 */
import {
  useDeviceManagerSetDisplay,
  useDeviceManagerSetLocation,
  useDeviceManagerSetName,
  useDeviceManagerSetRole,
  useDeviceManagerSetTags,
  useConfirm,
  Button,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  displayFormsEqual,
  identityDirty,
  identitySaveRefusal,
  identityWrites,
  quickDetailSaveState,
  tagListsEqual,
  seedIdentityDraft,
  type DisplayForm,
  type IdentityDraft,
  type IdentitySeed,
  type QuickDetailSlice,
} from './identity-draft'

export interface QuickDetailContribution extends QuickDetailSlice {
  readonly id: string
  readonly save: () => Promise<void>
  readonly discard: () => void
}

interface QuickDetailSaveApi {
  readonly identity: IdentityDraft | null
  readonly setIdentityName: (name: string) => void
  readonly setIdentityLocation: (location: string) => void
  readonly setIdentityRole: (role: string | null) => void
  readonly setIdentityTags: (tags: readonly string[]) => void
  readonly setIdentityDisplay: (patch: Partial<DisplayForm>) => void
  readonly register: (contribution: QuickDetailContribution) => () => void
  /** Go to the device page (asks first when edits are unsaved), then close the host. */
  readonly openDevicePage: () => void
}

const QuickDetailSaveContext = createContext<QuickDetailSaveApi | null>(null)

export function useQuickDetailSave(): QuickDetailSaveApi | null {
  return useContext(QuickDetailSaveContext)
}

export interface QuickDetailSaveProviderProps {
  readonly deviceId: number
  /** `null` until the device row has loaded. */
  readonly seed: IdentitySeed | null
  readonly onClose?: () => void
  readonly children: ReactNode
}

export function QuickDetailSaveProvider({
  deviceId,
  seed,
  onClose,
  children,
}: QuickDetailSaveProviderProps): ReactNode {
  const [identity, setIdentity] = useState<IdentityDraft | null>(null)
  const [contributions, setContributions] = useState<readonly QuickDetailContribution[]>([])
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const fns = useRef(new Map<string, Pick<QuickDetailContribution, 'save' | 'discard'>>())

  if (seed !== null) {
    const next = seedIdentityDraft(identity, seed)
    const changed =
      identity === null ||
      next.name !== identity.name ||
      next.location !== identity.location ||
      next.role !== identity.role ||
      !tagListsEqual(next.tags, identity.tags) ||
      !tagListsEqual(next.baseTags, identity.baseTags) ||
      !displayFormsEqual(next.display, identity.display) ||
      next.baseName !== identity.baseName ||
      next.baseLocation !== identity.baseLocation ||
      next.baseRole !== identity.baseRole ||
      !displayFormsEqual(next.baseDisplay, identity.baseDisplay) ||
      next.persistedDisplay !== identity.persistedDisplay
    if (changed) setIdentity(next)
  }

  const register = useCallback((contribution: QuickDetailContribution) => {
    fns.current.set(contribution.id, {
      save: contribution.save,
      discard: contribution.discard,
    })
    setContributions((prev) => {
      const existing = prev.find((item) => item.id === contribution.id)
      if (
        existing !== undefined &&
        existing.dirty === contribution.dirty &&
        existing.saving === contribution.saving &&
        existing.error === contribution.error
      ) {
        return prev
      }
      const rest = prev.filter((item) => item.id !== contribution.id)
      return [
        ...rest,
        {
          ...contribution,
          save: () => fns.current.get(contribution.id)?.save() ?? Promise.resolve(),
          discard: () => {
            fns.current.get(contribution.id)?.discard()
          },
        },
      ]
    })
    return () => {
      fns.current.delete(contribution.id)
      setContributions((prev) => prev.filter((item) => item.id !== contribution.id))
    }
  }, [])

  const dirty = quickDetailSaveState([
    { dirty: identityDirty(identity), saving: false, error: null },
    ...contributions,
  ]).dirty
  const openDevicePage = useCallback((): void => {
    void (async () => {
      if (dirty) {
        const ok = await confirm({
          title: t('deviceQuickDetail.leaveTitle', 'Discard unsaved changes?'),
          message: t(
            'deviceQuickDetail.leaveMessage',
            'Unsaved edits on this device will be discarded.',
          ),
          confirmLabel: t('deviceQuickDetail.discard', 'Discard'),
          variant: 'warning',
        })
        if (!ok) return
      }
      navigate(`/devices/${String(deviceId)}`)
      onClose?.()
    })()
  }, [dirty, confirm, t, navigate, deviceId, onClose])

  const api = useMemo<QuickDetailSaveApi>(
    () => ({
      identity,
      setIdentityName: (name: string) => {
        setIdentity((prev) => (prev === null ? prev : { ...prev, name }))
      },
      setIdentityLocation: (location: string) => {
        setIdentity((prev) => (prev === null ? prev : { ...prev, location }))
      },
      setIdentityRole: (role: string | null) => {
        setIdentity((prev) => (prev === null ? prev : { ...prev, role }))
      },
      setIdentityTags: (tags: readonly string[]) => {
        setIdentity((prev) => (prev === null ? prev : { ...prev, tags }))
      },
      setIdentityDisplay: (patch: Partial<DisplayForm>) => {
        setIdentity((prev) =>
          prev === null ? prev : { ...prev, display: { ...prev.display, ...patch } },
        )
      },
      register,
      openDevicePage,
    }),
    [identity, register, openDevicePage],
  )

  return (
    <QuickDetailSaveContext.Provider value={api}>
      <QuickDetailSaveBody
        deviceId={deviceId}
        identity={identity}
        contributions={contributions}
        onIdentitySaved={(next) => setIdentity(next)}
      >
        {children}
      </QuickDetailSaveBody>
    </QuickDetailSaveContext.Provider>
  )
}

function QuickDetailSaveBody({
  deviceId,
  identity,
  contributions,
  onIdentitySaved,
  children,
}: {
  readonly deviceId: number
  readonly identity: IdentityDraft | null
  readonly contributions: readonly QuickDetailContribution[]
  readonly onIdentitySaved: (next: IdentityDraft) => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <>
      {children}
      <QuickDetailSaveFooter
        deviceId={deviceId}
        identity={identity}
        contributions={contributions}
        onIdentitySaved={onIdentitySaved}
      />
    </>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function QuickDetailSaveFooter({
  deviceId,
  identity,
  contributions,
  onIdentitySaved,
}: {
  readonly deviceId: number
  readonly identity: IdentityDraft | null
  readonly contributions: readonly QuickDetailContribution[]
  readonly onIdentitySaved: (next: IdentityDraft) => void
}): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [localError, setLocalError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const setName = useDeviceManagerSetName()
  const setLocation = useDeviceManagerSetLocation()
  const setRole = useDeviceManagerSetRole()
  const setDisplay = useDeviceManagerSetDisplay()
  const setTags = useDeviceManagerSetTags()

  const identitySlice: QuickDetailSlice = {
    dirty: identityDirty(identity),
    saving: pending,
    error: localError,
  }
  const state = quickDetailSaveState([identitySlice, ...contributions])

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
  }

  const onDiscard = (): void => {
    if (identity !== null) {
      onIdentitySaved({
        ...identity,
        name: identity.baseName,
        location: identity.baseLocation,
        role: identity.baseRole,
        display: identity.baseDisplay,
        tags: identity.baseTags,
      })
    }
    for (const contribution of contributions) contribution.discard()
    setLocalError(null)
  }

  const onSave = (): void => {
    if (identity !== null && identityDirty(identity)) {
      const refusal = identitySaveRefusal(identity)
      if (refusal === 'name') {
        setLocalError(t('deviceQuickDetail.nameRequired', 'Name is required'))
        return
      }
    }
    setLocalError(null)
    setPending(true)
    void (async () => {
      try {
        const writes = identity !== null ? identityWrites(identity) : {}
        if (identity !== null && writes.name !== undefined) {
          await setName.mutateAsync({ deviceId, name: writes.name })
        }
        if (identity !== null && writes.location !== undefined) {
          await setLocation.mutateAsync({ deviceId, location: writes.location })
        }
        if (identity !== null && writes.role !== undefined) {
          await setRole.mutateAsync({ deviceId, role: writes.role })
        }
        if (identity !== null && writes.tags !== undefined) {
          await setTags.mutateAsync({ deviceId, tags: writes.tags })
        }
        if (identity !== null && writes.display !== undefined) {
          await setDisplay.mutateAsync({ deviceId, display: writes.display })
        }
        if (identity !== null) {
          const name = identity.name.trim()
          const location = identity.location.trim()
          onIdentitySaved({
            ...identity,
            name,
            location,
            baseName: name,
            baseLocation: location,
            baseRole: identity.role,
            baseDisplay: identity.display,
            baseTags: identity.tags,
            persistedDisplay:
              writes.display !== undefined
                ? (writes.display ?? undefined)
                : identity.persistedDisplay,
          })
        }
        for (const contribution of contributions) {
          if (contribution.dirty) await contribution.save()
        }
        invalidate()
      } catch (err: unknown) {
        setLocalError(messageOf(err))
      } finally {
        setPending(false)
      }
    })()
  }

  // Nothing to save, discard or report: the footer has no job.
  if (!state.dirty && !state.saving && state.error === null) return null

  return (
    <div className="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-t border-border bg-background px-1 pt-3">
      {state.error !== null && <p className="text-xs text-danger">{state.error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDiscard}
            disabled={!state.dirty || state.saving}
          >
            {t('deviceQuickDetail.discard', 'Discard')}
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={!state.dirty || state.saving}>
            {state.saving
              ? t('deviceQuickDetail.saving', 'Saving…')
              : t('deviceQuickDetail.save', 'Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
