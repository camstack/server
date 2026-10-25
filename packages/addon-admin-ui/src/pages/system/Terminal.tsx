/**
 * System → Terminal — operator UI for the `terminal-session` capability.
 *
 * Phase 1 of docs/design/2026-07-26-terminal-session-design.md: open an
 * allowlisted profile (never a free-form command), run it in a real vt terminal
 * (xterm.js via `<TerminalPanel>`), resize it live, and close it. A list of
 * every live session is shown so an operator can reconnect to one opened
 * elsewhere (the pty outlives the browser tab) or close it.
 *
 * Lifecycle and terminal bytes flow through the capability so the same page
 * can target the hub or any online cluster agent.
 *
 * Admin-only: every capability method is `auth: 'admin'` and the route is
 * wrapped in `<ProtectedRoute requireAdmin>` in App.tsx.
 */

import type { ConfigUISchema, TerminalSessionInfo } from '@camstack/types'
import {
  ConfigFormBuilder,
  ErrorBox,
  NodePicker,
  useTerminalSessionAdoptLegacyMonitor,
  useTerminalSessionClose,
  useTerminalSessionCreateInstance,
  useTerminalSessionDeleteInstance,
  useTerminalSessionListInstances,
  useTerminalSessionListLegacyCameras,
  useTerminalSessionListProfiles,
  useTerminalSessionListSessions,
  useTerminalSessionOpenSession,
  useTerminalSessionSetInstanceEnabled,
  useTerminalSessionUpdateInstance,
} from '@camstack/ui-library'
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Power,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { NodeAddonsSettingsPanel } from '../../components/settings/NodeAddonsSettingsPanel'
import { TerminalPanel } from '../../components/TerminalPanel'
import { Trans, useTranslation } from 'react-i18next'

/**
 * Manifest id of `@camstack/addon-terminal`. The configuration rendered below
 * is the addon's own `globalSettingsSchema()` — this page declares no fields of
 * its own, so there is exactly one authority for "what a Terminal profile is"
 * and /system/settings and this page can never disagree.
 */
const TERMINAL_ADDON_ID = 'terminal'

// The terminal reflows to its actual pane size the moment `<TerminalPanel>`
// mounts (its FitAddon issues a `resize`), so these are only the initial grid
// the pty spawns with — the design's stated default.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

/**
 * Poll for the legacy automatic-camera migration list. See the call site for
 * why it is not the 5 s cadence the session/instance polls use.
 */
const LEGACY_CAMERA_POLL_INTERVAL_MS = 60_000

function formatStartedAt(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function joinLines(values: readonly string[] | undefined): string {
  return (values ?? []).join('\n')
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function profileSettingsSchema(raw: unknown): ConfigUISchema | null {
  if (!raw || typeof raw !== 'object' || !('sections' in raw)) return null
  const schema = raw as ConfigUISchema
  if (!Array.isArray(schema.sections) || schema.sections.length === 0) return null
  return schema
}

function defaultsFromSchema(schema: ConfigUISchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if ('key' in field && 'default' in field && field.default !== undefined) {
        out[field.key] = field.default
      }
    }
  }
  return out
}

function SpawnFields({
  executable,
  args,
  cwd,
  environment,
  onExecutable,
  onArgs,
  onCwd,
  onEnvironment,
}: {
  readonly executable: string
  readonly args: string
  readonly cwd: string
  readonly environment: string
  readonly onExecutable: (value: string) => void
  readonly onArgs: (value: string) => void
  readonly onCwd: (value: string) => void
  readonly onEnvironment: (value: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="grid w-full grid-cols-1 gap-2 md:grid-cols-2">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('systemPage.terminal.executable', 'Executable')}
        </span>
        <input
          value={executable}
          onChange={(e) => onExecutable(e.target.value)}
          placeholder="btm" // i18n-ignore: example executable name
          className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('systemPage.terminal.workingDirectory', 'Working directory')}
        </span>
        <input
          value={cwd}
          onChange={(e) => onCwd(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('systemPage.terminal.argumentsOnePerLine', 'Arguments (one per line)')}
        </span>
        <textarea
          value={args}
          onChange={(e) => onArgs(e.target.value)}
          rows={3}
          className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t(
            'systemPage.terminal.environmentNameValueOnePer',
            'Environment NAME=value (one per line)',
          )}
        </span>
        <textarea
          value={environment}
          onChange={(e) => onEnvironment(e.target.value)}
          rows={3}
          className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-foreground"
        />
      </label>
    </div>
  )
}

export function TerminalPage() {
  const { t } = useTranslation()
  const [selectedNodeId, setSelectedNodeId] = useState('hub')
  const profilesQuery = useTerminalSessionListProfiles({ nodeId: selectedNodeId })
  const sessionsQuery = useTerminalSessionListSessions(
    { nodeId: selectedNodeId },
    { refetchInterval: 5000 },
  )
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()
  const instancesQuery = useTerminalSessionListInstances(
    { nodeId: 'hub' },
    { refetchInterval: 5000 },
  )
  // Legacy automatic cameras — a MIGRATION leftover, not live state.
  //
  // The set changes on exactly two operator acts: adopting one (which refetches
  // this query directly, see `handleAdoptLegacyMonitor`) and deleting the
  // device (which the Refresh control below already covers). Nothing else moves
  // it, so the timer exists only to catch a change made in another tab.
  //
  // It is deliberately slower than the two polls above it. Those read the
  // addon's in-memory session/instance maps; this one resolves to
  // `deviceManager.listAll({ addonId })`, whose FULL projection reaches the
  // settings door for the whole `device-manager:` prefix of
  // `addon-device-settings` — every device on the hub, to answer about
  // Terminal's handful. That read cannot be narrowed from this side: the
  // legacy list is built out of the device's `config`
  // (`nodeId`/`profileId`/`profileLabel`), so `projection: 'slim'` would empty
  // the section rather than make it cheap. Until the prefix read is bounded,
  // the honest lever is the cadence, and it is sized to how the fact moves.
  const legacyCamerasQuery = useTerminalSessionListLegacyCameras(
    { nodeId: 'hub' },
    { refetchInterval: LEGACY_CAMERA_POLL_INTERVAL_MS },
  )
  const createInstance = useTerminalSessionCreateInstance()
  const updateInstance = useTerminalSessionUpdateInstance()
  const deleteInstance = useTerminalSessionDeleteInstance()
  const setInstanceEnabled = useTerminalSessionSetInstanceEnabled()
  const adoptLegacyMonitor = useTerminalSessionAdoptLegacyMonitor()

  const profiles = profilesQuery.data ?? []
  const listedSessions = sessionsQuery.data ?? []
  // Distinguish "still loading" from "this node genuinely has none" — a
  // loading spinner must not flash the configuration open.
  const hasNoProfiles = !profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0

  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [instanceName, setInstanceName] = useState('')
  const [draftExecutable, setDraftExecutable] = useState('')
  const [draftArgs, setDraftArgs] = useState('')
  const [draftCwd, setDraftCwd] = useState('')
  const [draftEnvironment, setDraftEnvironment] = useState('')
  const [draftProfileSettings, setDraftProfileSettings] = useState<Record<string, unknown>>({})
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editExecutable, setEditExecutable] = useState('')
  const [editArgs, setEditArgs] = useState('')
  const [editCwd, setEditCwd] = useState('')
  const [editEnvironment, setEditEnvironment] = useState('')
  const [editProfileSettings, setEditProfileSettings] = useState<Record<string, unknown>>({})
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [closedSessionIds, setClosedSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const showConfig = configOpen || hasNoProfiles
  const sessions = useMemo(
    () => listedSessions.filter((session) => !closedSessionIds.has(session.sessionId)),
    [listedSessions, closedSessionIds],
  )

  const handleNodeSelect = (nodeId: string) => {
    setSelectedNodeId(nodeId)
    setSelectedProfileId('')
    setActiveSessionId(null)
    setClosedSessionIds(new Set())
    setActionError(null)
  }

  const selectedProfile = profiles.find((p) => p.profileId === selectedProfileId)
  const selectedSettingsSchema = profileSettingsSchema(selectedProfile?.settingsSchema)

  useEffect(() => {
    if (!selectedProfileId && profiles.length > 0) {
      setSelectedProfileId(profiles[0].profileId)
    }
  }, [profiles, selectedProfileId])

  useEffect(() => {
    if (!selectedProfile) return
    setDraftExecutable(selectedProfile.executable ?? '')
    setDraftArgs(joinLines(selectedProfile.args))
    setDraftCwd(selectedProfile.cwd ?? '')
    setDraftEnvironment(joinLines(selectedProfile.environment))
    const schema = profileSettingsSchema(selectedProfile.settingsSchema)
    setDraftProfileSettings(schema ? defaultsFromSchema(schema) : {})
  }, [selectedProfile])

  // If the active session disappears from the live list (closed elsewhere, or
  // its pty exited), drop it so the panel unmounts and aborts its stream.
  useEffect(() => {
    if (activeSessionId && !sessions.some((s) => s.sessionId === activeSessionId)) {
      setActiveSessionId(null)
    }
  }, [sessions, activeSessionId])

  // Keep an explicit close hidden while a stale query response is in flight,
  // but forget its tombstone as soon as the server no longer reports it.
  useEffect(() => {
    const listedIds = new Set(listedSessions.map((session) => session.sessionId))
    setClosedSessionIds((current) => {
      const next = new Set([...current].filter((sessionId) => listedIds.has(sessionId)))
      return next.size === current.size ? current : next
    })
  }, [listedSessions])

  const activeSession = useMemo<TerminalSessionInfo | null>(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )

  const handleOpen = async () => {
    if (!selectedProfileId) return
    setActionError(null)
    try {
      const session = await openSession.mutateAsync({
        nodeId: selectedNodeId,
        profileId: selectedProfileId,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      })
      setActiveSessionId(session.sessionId)
      await sessionsQuery.refetch()
    } catch {
      setActionError('Failed to open the session.')
    }
  }

  const refreshInstances = async () => {
    await Promise.all([instancesQuery.refetch(), legacyCamerasQuery.refetch()])
  }

  const handleCreateInstance = async () => {
    if (!selectedProfileId) return
    setActionError(null)
    try {
      await createInstance.mutateAsync({
        nodeId: 'hub',
        targetNodeId: selectedNodeId,
        profileId: selectedProfileId,
        ...(instanceName.trim() ? { name: instanceName.trim() } : {}),
        executable: draftExecutable.trim(),
        args: splitLines(draftArgs),
        cwd: draftCwd.trim(),
        environment: splitLines(draftEnvironment),
        profileSettings: draftProfileSettings,
      })
      setInstanceName('')
      await refreshInstances()
    } catch {
      setActionError('Failed to create the Terminal instance.')
    }
  }

  const handleDeleteInstance = async (instanceId: string) => {
    setActionError(null)
    try {
      await deleteInstance.mutateAsync({ nodeId: 'hub', instanceId })
      await refreshInstances()
    } catch {
      setActionError('Failed to delete the Terminal instance.')
    }
  }

  const handleSetInstanceEnabled = async (instanceId: string, enabled: boolean) => {
    setActionError(null)
    try {
      await setInstanceEnabled.mutateAsync({ nodeId: 'hub', instanceId, enabled })
      await refreshInstances()
    } catch {
      setActionError('Failed to update the Terminal instance.')
    }
  }

  const handleSaveInstance = async (instanceId: string) => {
    setActionError(null)
    try {
      await updateInstance.mutateAsync({
        nodeId: 'hub',
        instanceId,
        name: editName.trim(),
        executable: editExecutable.trim(),
        args: splitLines(editArgs),
        cwd: editCwd.trim(),
        environment: splitLines(editEnvironment),
        profileSettings: editProfileSettings,
      })
      setEditingInstanceId(null)
      await refreshInstances()
    } catch {
      setActionError('Failed to update the Terminal instance.')
    }
  }

  const handleAdoptLegacyMonitor = async (stableId: string) => {
    setActionError(null)
    try {
      await adoptLegacyMonitor.mutateAsync({ nodeId: 'hub', stableId })
      await refreshInstances()
    } catch {
      setActionError('Failed to adopt the legacy BTM Terminal.')
    }
  }

  const handleClose = async (sessionId: string) => {
    setActionError(null)
    setClosedSessionIds((current) => new Set(current).add(sessionId))
    if (activeSessionId === sessionId) setActiveSessionId(null)
    try {
      await closeSession.mutateAsync({ nodeId: selectedNodeId, sessionId })
      await sessionsQuery.refetch()
    } catch {
      setClosedSessionIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      setActionError('Failed to close the session.')
    }
  }

  return (
    <AdminPage
      icon={TerminalIcon}
      title={t('systemPage.terminal.terminal', 'Terminal')}
      subtitle={t(
        'systemPage.terminal.openLiveSessionsOrExplicitly',
        'Open live sessions or explicitly create Terminal camera instances from available profiles.',
      )}
    >
      <div className="flex justify-end">
        <NodePicker selectedNodeId={selectedNodeId} onSelect={handleNodeSelect} alwaysShow />
      </div>

      {/*
        Terminal configuration lives HERE, not only in /system/settings, because
        every field is per-node and this page is where the operator has already
        chosen the node. The fields come from the addon's own schema via
        `NodeAddonsSettingsPanel` — nothing is re-declared locally.

        Collapsed by default so the session/instance workflow stays above the
        fold, and force-opened when the node offers no profile at all: an empty
        picker is exactly the moment the operator needs the configuration.
      */}
      <section className="rounded-lg border border-border bg-surface">
        <button
          onClick={() => setConfigOpen((open) => !open)}
          aria-expanded={showConfig}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          {showConfig ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          )}
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
              {t('systemPage.terminal.terminalConfiguration', 'Terminal configuration')}
            </span>
            <span className="block text-[11px] text-foreground-subtle">
              <Trans
                i18nKey="terminalPage.profilesNote"
                values={{ node: selectedNodeId }}
                components={{ mono: <span className="font-mono text-foreground" /> }}
              />
            </span>
          </span>
        </button>
        {showConfig && (
          <div className="border-t border-border p-3">
            {hasNoProfiles && (
              <p className="mb-3 text-[11px] text-amber-600">
                {t(
                  'systemPage.terminal.thisNodeOffersNoTerminal',
                  'This node offers no terminal profile. Enable BTM, Top or Glances below, or add a custom profile.',
                )}
              </p>
            )}
            <NodeAddonsSettingsPanel
              nodeId={selectedNodeId}
              addonIds={[TERMINAL_ADDON_ID]}
              level="global"
            />
          </div>
        )}
      </section>

      {profilesQuery.isError && (
        <ErrorBox
          title={t('systemPage.terminal.couldnTLoadProfiles', "Couldn't load profiles")}
          message={t(
            'systemPage.terminal.theTerminalSessionCapabilityMay',
            'The terminal-session capability may be disabled or unconfigured.',
          )}
          onRetry={() => void profilesQuery.refetch()}
        />
      )}

      {/* Profiles are templates. Opening a live session never creates a camera. */}
      <div className="flex items-end gap-2 flex-wrap rounded-lg border border-border bg-surface p-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
            {t('systemPage.terminal.availableTerminalProfile', 'Available terminal profile')}
          </span>
          <select
            value={selectedProfileId}
            onChange={(e) => setSelectedProfileId(e.target.value)}
            disabled={profiles.length === 0}
            className="min-w-[220px] rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
          >
            {profiles.length === 0 ? (
              <option value="">
                {t('systemPage.terminal.noProfilesAvailable', 'No profiles available')}
              </option>
            ) : (
              profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.label}
                </option>
              ))
            )}
          </select>
        </label>
        <button
          onClick={() => void handleOpen()}
          disabled={!selectedProfileId || openSession.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {openSession.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t('systemPage.terminal.openSession', 'Open session')}
        </button>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
            {t('systemPage.terminal.terminalName', 'Terminal name')}
          </span>
          <input
            value={instanceName}
            onChange={(event) => setInstanceName(event.target.value)}
            maxLength={160}
            placeholder={t('systemPage.terminal.optionalCameraName', 'Optional camera name')}
            className="min-w-[180px] rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-foreground focus:outline-none focus:border-primary/50"
          />
        </label>
        <button
          onClick={() => void handleCreateInstance()}
          disabled={!selectedProfileId || createInstance.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {createInstance.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t('systemPage.terminal.createTerminalCamera', 'Create Terminal camera')}
        </button>
        <div className="basis-full">
          <SpawnFields
            executable={draftExecutable}
            args={draftArgs}
            cwd={draftCwd}
            environment={draftEnvironment}
            onExecutable={setDraftExecutable}
            onArgs={setDraftArgs}
            onCwd={setDraftCwd}
            onEnvironment={setDraftEnvironment}
          />
        </div>
        {selectedSettingsSchema && (
          <div className="basis-full">
            <ConfigFormBuilder
              schema={selectedSettingsSchema}
              values={draftProfileSettings}
              onChange={setDraftProfileSettings}
            />
          </div>
        )}
        {selectedProfileId &&
          profiles.find((p) => p.profileId === selectedProfileId)?.description && (
            <p className="basis-full text-[11px] text-foreground-subtle">
              {profiles.find((p) => p.profileId === selectedProfileId)?.description}
            </p>
          )}
      </div>

      {actionError && <ErrorBox message={actionError} />}

      <section className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
            {t('systemPage.terminal.terminalInstances', 'Terminal instances')}
          </div>
          <p className="mt-0.5 text-[11px] text-foreground-subtle">
            {t(
              'systemPage.terminal.onlyTheseExplicitInstancesDeclare',
              'Only these explicit instances declare cameras. Closing a live session does not delete an instance.',
            )}
          </p>
        </div>
        {(instancesQuery.data ?? []).length === 0 ? (
          <p className="px-3 py-4 text-xs text-foreground-subtle">
            {t(
              'systemPage.terminal.noTerminalCamerasHaveBeen',
              'No Terminal cameras have been created.',
            )}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(instancesQuery.data ?? []).map((instance) => {
              const instanceSettingsSchema = profileSettingsSchema(
                profiles.find((profile) => profile.profileId === instance.profileId)
                  ?.settingsSchema,
              )
              return (
                <li key={instance.instanceId} className="px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{instance.name}</div>
                      <div className="font-mono text-foreground-subtle truncate">
                        {instance.nodeId} · {instance.profileLabel} · {instance.cameraStableId}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => {
                          setEditingInstanceId(instance.instanceId)
                          setEditName(instance.name)
                          setEditExecutable(instance.executable ?? '')
                          setEditArgs(joinLines(instance.args))
                          setEditCwd(instance.cwd ?? '')
                          setEditEnvironment(joinLines(instance.environment))
                          const schema = profileSettingsSchema(
                            profiles.find((profile) => profile.profileId === instance.profileId)
                              ?.settingsSchema,
                          )
                          setEditProfileSettings(
                            schema
                              ? {
                                  ...defaultsFromSchema(schema),
                                  ...(instance.profileSettings &&
                                  typeof instance.profileSettings === 'object'
                                    ? instance.profileSettings
                                    : {}),
                                }
                              : {},
                          )
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:border-primary/40 hover:text-primary"
                      >
                        <Pencil className="h-3 w-3" />
                        {t('common.edit', 'Edit')}
                      </button>
                      <button
                        onClick={() =>
                          void handleSetInstanceEnabled(instance.instanceId, !instance.enabled)
                        }
                        disabled={setInstanceEnabled.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:border-primary/40 hover:text-primary disabled:opacity-50"
                      >
                        <Power className="h-3 w-3" />
                        {instance.enabled
                          ? t('common.disable', 'Disable')
                          : t('common.enable', 'Enable')}
                      </button>
                      <button
                        onClick={() => void handleDeleteInstance(instance.instanceId)}
                        disabled={deleteInstance.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-danger hover:border-danger/40 disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        {t('systemPage.terminal.deleteTerminal', 'Delete Terminal')}
                      </button>
                    </div>
                  </div>
                  {editingInstanceId === instance.instanceId && (
                    <div className="mt-2 space-y-2 border-t border-border pt-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                          {t('systemPage.terminal.name', 'Name')}
                        </span>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
                        />
                      </label>
                      <SpawnFields
                        executable={editExecutable}
                        args={editArgs}
                        cwd={editCwd}
                        environment={editEnvironment}
                        onExecutable={setEditExecutable}
                        onArgs={setEditArgs}
                        onCwd={setEditCwd}
                        onEnvironment={setEditEnvironment}
                      />
                      {instanceSettingsSchema && (
                        <ConfigFormBuilder
                          schema={instanceSettingsSchema}
                          values={editProfileSettings}
                          onChange={setEditProfileSettings}
                        />
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => void handleSaveInstance(instance.instanceId)}
                          disabled={updateInstance.isPending}
                          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                        >
                          {t('systemPage.terminal.saveAndRestart', 'Save and restart')}
                        </button>
                        <button
                          onClick={() => setEditingInstanceId(null)}
                          className="rounded-md border border-border px-2.5 py-1 text-[11px]"
                        >
                          {t('common.cancel', 'Cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {(legacyCamerasQuery.data ?? []).length > 0 && (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-xs font-medium text-foreground">
            {t('systemPage.terminal.legacyAutomaticCameras', 'Legacy automatic cameras')}
          </div>
          <p className="mt-1 text-[11px] text-foreground-subtle">
            {t(
              'systemPage.terminal.theseCamerasPredateExplicitTerminal',
              'These cameras predate explicit Terminal instances. They are intentionally untouched: confirm each migration before deleting one. Only BTM cameras can retain their legacy identity by being adopted below; create new instances for Top or Glances first.',
            )}
          </p>
          <ul className="mt-2 divide-y divide-amber-500/20">
            {(legacyCamerasQuery.data ?? []).map((camera) => (
              <li key={camera.stableId} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate text-[11px] text-foreground-subtle">
                  {camera.name} · {camera.nodeId} · {camera.profileLabel}
                </span>
                {camera.adoptable && (
                  <button
                    onClick={() => void handleAdoptLegacyMonitor(camera.stableId)}
                    disabled={adoptLegacyMonitor.isPending}
                    className="shrink-0 rounded-md border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium text-amber-600 hover:bg-amber-500/10 disabled:opacity-50"
                  >
                    {t('systemPage.terminal.adoptBtm', 'Adopt BTM')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Active terminal */}
      {activeSession && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-xs text-foreground-subtle truncate">
              <span className="font-medium text-foreground">{activeSession.label}</span>
              <span className="mx-1.5">·</span>
              <span className="font-mono">{activeSession.sessionId}</span>
            </div>
            <button
              onClick={() => void handleClose(activeSession.sessionId)}
              disabled={closeSession.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:border-danger/40 hover:text-danger disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              {t('common.close', 'Close')}
            </button>
          </div>
          <TerminalPanel
            key={`${selectedNodeId}:${activeSession.sessionId}`}
            nodeId={selectedNodeId}
            sessionId={activeSession.sessionId}
            onExit={() => void sessionsQuery.refetch()}
          />
        </div>
      )}

      {/* Live sessions */}
      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
          {t('systemPage.terminal.liveSessions', 'Live sessions')}
        </div>
        {sessions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-foreground-subtle">
            {t(
              'systemPage.terminal.noSessionsRunningOpenOne',
              'No sessions running. Open one above to begin.',
            )}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId
              return (
                <li
                  key={session.sessionId}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{session.label}</span>
                      {isActive && (
                        <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t('systemPage.terminal.attached', 'Attached')}
                        </span>
                      )}
                    </div>
                    <div className="text-foreground-subtle font-mono truncate">
                      {session.sessionId} · {session.cols}×{session.rows} ·{' '}
                      {formatStartedAt(session.startedAt)}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {!isActive && (
                      <button
                        onClick={() => setActiveSessionId(session.sessionId)}
                        className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-foreground hover:border-primary/40 hover:text-primary"
                      >
                        {t('systemPage.terminal.attach', 'Attach')}
                      </button>
                    )}
                    <button
                      onClick={() => void handleClose(session.sessionId)}
                      disabled={closeSession.isPending}
                      className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-foreground hover:border-danger/40 hover:text-danger disabled:opacity-50"
                    >
                      {t('common.close', 'Close')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </AdminPage>
  )
}
