/**
 * The one dialog to create or edit a Terminal instance.
 *
 * Create asks, in order: Name (required, prefilled `<profile> <node>`), Node
 * (only nodes that run a terminal provider), Profile and its settings. The
 * camera is not a field: the provider declares the instance's camera from the
 * instance itself, in the same call, named after it — so no camera can exist
 * before its terminal.
 */
import type { TerminalInstanceInfo, TerminalProfileInfo } from '@camstack/types'
import {
  Button,
  ConfigFormBuilder,
  FormField,
  Input,
  ItemFormDialog,
  Select,
  useTerminalSessionListProfiles,
} from '@camstack/ui-library'
import { Loader2, Terminal as TerminalIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultsFromSchema,
  defaultTerminalName,
  joinLines,
  profileSettingsSchema,
  spawnDraftFromProfile,
  splitLines,
} from './terminal-instance-form'

export interface TerminalNodeOption {
  readonly id: string
  readonly label: string
}

export interface TerminalInstanceValues {
  readonly name: string
  readonly nodeId: string
  readonly profileId: string
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: readonly string[]
  readonly profileSettings: Record<string, unknown>
}

export interface TerminalInstanceDialogProps {
  /** `null` creates a new instance; an instance edits it. */
  readonly instance: TerminalInstanceInfo | null
  /** Nodes that run a terminal provider — the only ones offered. */
  readonly nodes: readonly TerminalNodeOption[]
  readonly submitting: boolean
  readonly error: string | null
  readonly onClose: () => void
  readonly onSubmit: (values: TerminalInstanceValues) => void
}

const FIELD_LABEL = 'text-[10px] uppercase tracking-wide text-foreground-subtle'
const TEXTAREA =
  'rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-foreground'

export function TerminalInstanceDialog({
  instance,
  nodes,
  submitting,
  error,
  onClose,
  onSubmit,
}: TerminalInstanceDialogProps) {
  const { t } = useTranslation()
  const editing = instance !== null
  const [nodeId, setNodeId] = useState(instance?.nodeId ?? nodes[0]?.id ?? '')
  const [profileId, setProfileId] = useState(instance?.profileId ?? '')
  const [name, setName] = useState(instance?.name ?? '')
  const [nameTouched, setNameTouched] = useState(editing)
  const [spawn, setSpawn] = useState(() => ({
    executable: instance?.executable ?? '',
    args: joinLines(instance?.args),
    cwd: instance?.cwd ?? '',
    environment: joinLines(instance?.environment),
  }))
  const [settings, setSettings] = useState<Record<string, unknown>>(
    instance ? { ...instance.profileSettings } : {},
  )

  const nodeIsListed = nodes.some((node) => node.id === nodeId)
  const profilesQuery = useTerminalSessionListProfiles({ nodeId }, { enabled: nodeIsListed })
  const profiles: readonly TerminalProfileInfo[] = useMemo(
    () => (nodeIsListed ? (profilesQuery.data ?? []) : []),
    [nodeIsListed, profilesQuery.data],
  )
  const profile = profiles.find((candidate) => candidate.profileId === profileId)
  const schema = profileSettingsSchema(profile?.settingsSchema)
  const nodeLabel = nodes.find((node) => node.id === nodeId)?.label ?? nodeId

  // Create: follow the profile list of the chosen node.
  useEffect(() => {
    if (editing || profiles.length === 0) return
    if (!profiles.some((candidate) => candidate.profileId === profileId)) {
      setProfileId(profiles[0]?.profileId ?? '')
    }
  }, [editing, profiles, profileId])

  // Create: a new profile resets the spawn defaults and the settings.
  useEffect(() => {
    if (editing || !profile) return
    setSpawn(spawnDraftFromProfile(profile))
    setSettings(schema ? defaultsFromSchema(schema) : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the profile changes
  }, [editing, profile?.profileId])

  // Edit: fill the schema defaults under the stored values once.
  useEffect(() => {
    if (!editing || !schema) return
    setSettings((current) => ({ ...defaultsFromSchema(schema), ...current }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per schema
  }, [editing, profile?.profileId])

  // Create: the name follows `<profile> <node>` until the operator types one.
  useEffect(() => {
    if (editing || nameTouched || !profile) return
    setName(defaultTerminalName(profile.label, nodeLabel))
  }, [editing, nameTouched, profile, nodeLabel])

  const nodeOptions = useMemo(() => {
    const listed = nodes.map((node) => ({ value: node.id, label: node.label }))
    if (instance && !nodeIsListed && instance.nodeId === nodeId) {
      return [
        {
          value: nodeId,
          label: t('terminalPage.nodeGone', '{{node}} (not in cluster)', { node: nodeId }),
        },
        ...listed,
      ]
    }
    return listed
  }, [nodes, instance, nodeIsListed, nodeId, t])

  const nodeOk = editing ? nodeId === instance.nodeId || nodeIsListed : nodeIsListed
  const canSubmit = name.trim().length > 0 && profileId !== '' && nodeOk && !submitting
  const handleSubmit = (): void => {
    if (!canSubmit) return
    onSubmit({
      name: name.trim(),
      nodeId,
      profileId,
      executable: spawn.executable.trim(),
      args: splitLines(spawn.args),
      cwd: spawn.cwd.trim(),
      environment: splitLines(spawn.environment),
      profileSettings: settings,
    })
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={
        editing
          ? t('terminalPage.editTitle', 'Edit terminal')
          : t('terminalPage.newTitle', 'New terminal')
      }
      icon={TerminalIcon}
      error={error}
      width="lg"
      testId="terminal-instance-dialog"
      footer={
        <Button
          type="button"
          size="sm"
          onClick={handleSubmit}
          disabled={!canSubmit}
          data-testid="terminal-instance-submit"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {editing
            ? t('terminalPage.saveRestart', 'Save and restart')
            : t('terminalPage.create', 'Create terminal')}
        </Button>
      }
    >
      <div className="space-y-3">
        <FormField
          label={t('terminalPage.name', 'Name')}
          required
          {...(editing
            ? {}
            : {
                description: t(
                  'terminalPage.nameHint',
                  'The terminal and its camera share this name.',
                ),
              })}
        >
          <Input
            value={name}
            maxLength={160}
            onChange={(event) => {
              setName(event.target.value)
              setNameTouched(true)
            }}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label={t('terminalPage.node', 'Node')}>
            <Select
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
              options={nodeOptions}
            />
          </FormField>
          <FormField label={t('terminalPage.profile', 'Profile')}>
            {editing ? (
              <Input value={instance.profileLabel} readOnly />
            ) : (
              <Select
                value={profileId}
                disabled={profiles.length === 0}
                onChange={(event) => setProfileId(event.target.value)}
                options={profiles.map((candidate) => ({
                  value: candidate.profileId,
                  label: candidate.label,
                }))}
              />
            )}
          </FormField>
        </div>
        {profile?.description ? (
          <p className="text-[11px] text-foreground-subtle">{profile.description}</p>
        ) : null}
        <div className="grid w-full grid-cols-1 gap-2 md:grid-cols-2">
          <FormField label={t('terminalPage.executable', 'Executable')}>
            <Input
              value={spawn.executable}
              onChange={(event) => setSpawn({ ...spawn, executable: event.target.value })}
              className="font-mono"
            />
          </FormField>
          <FormField label={t('terminalPage.cwd', 'Working directory')}>
            <Input
              value={spawn.cwd}
              onChange={(event) => setSpawn({ ...spawn, cwd: event.target.value })}
              className="font-mono"
            />
          </FormField>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>
              {t('terminalPage.args', 'Arguments (one per line)')}
            </span>
            {/* ui-check-ok: multi-line argv list, no library multiline primitive */}
            <textarea
              value={spawn.args}
              onChange={(event) => setSpawn({ ...spawn, args: event.target.value })}
              rows={3}
              className={TEXTAREA}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>
              {t('terminalPage.env', 'Environment NAME=value (one per line)')}
            </span>
            {/* ui-check-ok: multi-line environment list, no library multiline primitive */}
            <textarea
              value={spawn.environment}
              onChange={(event) => setSpawn({ ...spawn, environment: event.target.value })}
              rows={3}
              className={TEXTAREA}
            />
          </label>
        </div>
        {schema ? (
          <ConfigFormBuilder schema={schema} values={settings} onChange={setSettings} />
        ) : null}
      </div>
    </ItemFormDialog>
  )
}
