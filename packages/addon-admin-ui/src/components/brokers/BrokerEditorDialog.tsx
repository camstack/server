/**
 * `BrokerEditorDialog` is THE way a broker is created or edited. The
 * integration wizard, Connectivity's broker list and any dialog that needs a
 * broker mount this one component; there is no second add / edit / sign-in path.
 *
 *   - create (`broker` omitted): the kind (chosen only when more than one is on
 *     offer), a name prefilled from the kind, then the kind's own settings form;
 *   - edit (`broker` given): the stored settings in the same form;
 *   - a kind that declares an interactive sign-in gets it as the form's first
 *     and primary action (`BrokerForm` → `BrokerSignInPanel`); the technical
 *     fields it fills sit under "Advanced".
 *
 * `onSaved(brokerId)` fires once the broker exists (created, edited or
 * signed in); the caller decides what the dialog's closing means. The dialog
 * names no kind: everything kind-specific is the provider's schema and
 * descriptor.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  useBrokerAdd,
  useBrokerGetSettings,
  useBrokerList,
  useBrokerSetSettings,
} from '@camstack/ui-library'
import type { UnifiedBrokerInfo } from '@camstack/types'
import { FormBuilder } from '../form-builder/FormBuilder'
import { startBrokerInteractiveConnect } from '../../lib/broker-oauth-popup'
import { BrokerForm } from './BrokerForm'
import { asBrokerList, kindOptionKey, useBrokerKinds, type BrokerKindOption } from './broker-kinds'
import {
  IDENTITY_KIND,
  IDENTITY_NAME,
  IDENTITY_RESTORE,
  IDENTITY_RESTORE_ID,
  buildBrokerIdentitySchema,
  readBrokerIdentity,
} from './broker-identity-schema'

export interface BrokerEditorDialogProps {
  /** Edit this broker; omit to create one. */
  readonly broker?: UnifiedBrokerInfo
  /** Create only this kind (a wizard that needs one specific kind). */
  readonly kind?: string
  /** Create only kinds this provider serves (a provider-scoped list). */
  readonly addonId?: string
  readonly onClose: () => void
  /** The broker exists: created, edited or signed in. */
  readonly onSaved: (brokerId: string) => void
}

function Shell({
  title,
  subtitle,
  onClose,
  children,
}: {
  readonly title: string
  readonly subtitle?: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="space-y-3 pr-1">{children}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/** `<label>`, or `<label> 2`, `<label> 3` … the first name no broker already uses. */
export function suggestBrokerName(label: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!used.has(label.toLowerCase())) return label
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

export function BrokerEditorDialog(props: BrokerEditorDialogProps) {
  return props.broker !== undefined ? (
    <EditBroker {...props} broker={props.broker} />
  ) : (
    <CreateBroker {...props} />
  )
}

// ── Create ───────────────────────────────────────────────────────────

function CreateBroker({ kind, addonId, onClose, onSaved }: BrokerEditorDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { options, isLoading } = useBrokerKinds({
    ...(addonId !== undefined ? { addonId } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })
  const existing = useBrokerList({})
  const takenNames = useMemo(() => asBrokerList(existing.data).map((b) => b.name), [existing.data])

  const [identity, setIdentity] = useState<Record<string, unknown>>({
    [IDENTITY_NAME]: '',
    [IDENTITY_RESTORE]: false,
    [IDENTITY_RESTORE_ID]: '',
  })
  const [problem, setProblem] = useState<string | null>(null)

  const selected: BrokerKindOption | undefined =
    options.find((o) => kindOptionKey(o) === identity[IDENTITY_KIND]) ?? options[0]
  const selectedKey = kindOptionKey(selected)

  // Prefill the name from the kind until the operator types their own.
  const suggested = selected === undefined ? '' : suggestBrokerName(selected.label, takenNames)
  const lastSuggestion = useRef('')
  useEffect(() => {
    if (selectedKey === '') return
    setIdentity((prev) => {
      const current = typeof prev[IDENTITY_NAME] === 'string' ? prev[IDENTITY_NAME] : ''
      const untouched = current === '' || current === lastSuggestion.current
      lastSuggestion.current = suggested
      const name = untouched ? suggested : current
      if (prev[IDENTITY_KIND] === selectedKey && current === name) return prev
      return { ...prev, [IDENTITY_KIND]: selectedKey, [IDENTITY_NAME]: name }
    })
  }, [selectedKey, suggested])

  const identitySchema = useMemo(
    () =>
      buildBrokerIdentitySchema(
        options.map((o) => ({ key: kindOptionKey(o), label: o.label })),
        // A sign-in mints the broker under a fresh id, so "restore under its old id" does not apply.
        { allowRestore: selected?.signInBasePath === undefined },
      ),
    [options, selected?.signInBasePath],
  )

  const done = (id: string): void => {
    void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
    onSaved(id)
  }

  const add = useBrokerAdd({
    onSuccess: (created) => {
      const id =
        created !== null &&
        typeof created === 'object' &&
        typeof (created as { id?: unknown }).id === 'string'
          ? (created as { id: string }).id
          : null
      const connectPath = selected?.interactiveConnectPath
      if (id !== null && connectPath !== undefined) {
        startBrokerInteractiveConnect(connectPath, id, () => {
          void queryClient.invalidateQueries({
            queryKey: [['broker', 'list']],
          })
        })
      }
      if (id !== null) done(id)
    },
  })

  const read = readBrokerIdentity(identity)
  const name = read.ok ? read.identity.name : ''

  const handleSubmit = (settings: Record<string, unknown>): void => {
    if (selected === undefined) return
    if (!read.ok) {
      setProblem(read.problem)
      return
    }
    setProblem(null)
    add.mutate({
      kind: selected.kind,
      name: read.identity.name,
      settings,
      ...(read.identity.restoreId !== null ? { id: read.identity.restoreId } : {}),
      ...(selected.addonId !== undefined ? { addonId: selected.addonId } : {}),
    })
  }

  const busy = add.isPending
  return (
    <Shell
      title={t('brokers.editor.createTitle')}
      subtitle={t('brokers.editor.createSubtitle')}
      onClose={busy ? () => {} : onClose}
    >
      {isLoading && options.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('brokers.editor.loadingKinds')}
        </div>
      ) : selected === undefined ? (
        <ErrorBox message={t('brokers.editor.noProvider')} />
      ) : (
        <>
          <FormBuilder schema={identitySchema} values={identity} onChange={setIdentity} />
          {problem !== null && <ErrorBox message={problem} />}
          {add.isError && (
            <ErrorBox
              message={add.error instanceof Error ? add.error.message : String(add.error)}
            />
          )}
          <BrokerForm
            key={selectedKey}
            kind={selected.kind}
            {...(selected.addonId !== undefined ? { addonId: selected.addonId } : {})}
            onSubmit={handleSubmit}
            onCancel={onClose}
            submitLabel={busy ? t('brokers.editor.creating') : t('brokers.editor.create')}
            disabled={busy}
            {...(selected.signInBasePath !== undefined
              ? {
                  signIn: {
                    basePath: selected.signInBasePath,
                    name,
                    onSignedIn: done,
                  },
                }
              : {})}
          />
        </>
      )}
    </Shell>
  )
}

// ── Edit ─────────────────────────────────────────────────────────────

function EditBroker({
  broker,
  onClose,
  onSaved,
}: BrokerEditorDialogProps & { readonly broker: UnifiedBrokerInfo }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { options } = useBrokerKinds({
    addonId: broker.addonId,
    kind: broker.kind,
  })
  const signInBasePath = options.find((o) => o.kind === broker.kind)?.signInBasePath

  // id-keyed reads and writes go to the OWNING provider through the addonId selector.
  const settingsQuery = useBrokerGetSettings({
    id: broker.id,
    addonId: broker.addonId,
  })
  const setSettings = useBrokerSetSettings({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['broker', 'list']] })
      void queryClient.invalidateQueries({
        queryKey: [
          ['broker', 'getSettings'],
          { input: { id: broker.id, addonId: broker.addonId } },
        ],
      })
      onSaved(broker.id)
    },
  })

  const initialValues = useMemo<Record<string, unknown>>(() => {
    const raw = settingsQuery.data
    return raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
  }, [settingsQuery.data])

  const busy = setSettings.isPending
  return (
    <Shell
      title={t('brokers.brokerManager.edit', 'Edit {{name}}', {
        name: broker.name,
      })}
      subtitle={`${broker.kind} · ${broker.id}`}
      onClose={busy ? () => {} : onClose}
    >
      {settingsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{' '}
          {t('brokers.brokerManager.loadingSettings')}
        </div>
      ) : settingsQuery.isError ? (
        // Never a save-capable form over empty values: a Save would overwrite the
        // broker's real credentials with `{}`.
        <div className="space-y-3">
          <ErrorBox
            message={t('brokers.brokerManager.loadSettingsFailed', {
              message:
                settingsQuery.error instanceof Error
                  ? settingsQuery.error.message
                  : t('common.unknownError'),
            })}
          />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.close', 'Close')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {setSettings.isError && (
            <ErrorBox
              message={
                setSettings.error instanceof Error
                  ? setSettings.error.message
                  : String(setSettings.error)
              }
            />
          )}
          <BrokerForm
            kind={broker.kind}
            addonId={broker.addonId}
            brokerId={broker.id}
            initialValues={initialValues}
            onSubmit={(settings) =>
              setSettings.mutate({
                id: broker.id,
                settings,
                addonId: broker.addonId,
              })
            }
            onCancel={onClose}
            submitLabel={busy ? t('brokers.brokerManager.saving') : t('common.save', 'Save')}
            disabled={busy}
            {...(signInBasePath !== undefined
              ? {
                  signIn: {
                    basePath: signInBasePath,
                    name: broker.name,
                    brokerId: broker.id,
                    onSignedIn: (id: string) => {
                      void queryClient.invalidateQueries({
                        queryKey: [['broker', 'list']],
                      })
                      onSaved(id)
                    },
                  },
                }
              : {})}
          />
        </div>
      )}
    </Shell>
  )
}
