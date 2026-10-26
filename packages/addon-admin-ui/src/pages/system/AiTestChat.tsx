/**
 * AI → Test. A deliberately minimal chat against ONE named profile.
 *
 * ## What it is for
 *
 * Every consumer of the `llm` cap — the notification confirm gate, the scene
 * monitors, the summaries — fails the same way when a profile is wrong: it
 * fails somewhere else, hours later, as a `no-profile` / `unavailable` code in
 * a log. This tab is the place to find that out in five seconds, with the two
 * questions an operator actually has:
 *
 *   1. does this endpoint answer at all?
 *   2. can it READ A PICTURE from this install — a live camera frame, or the
 *      stored best-shot the pipeline kept for a track?
 *
 * ## What it deliberately is not
 *
 * No history, no saved conversations, no RAG, no tool calls. The transcript is
 * component state and dies with the tab — "Clear" is the only lifecycle it
 * has. Anything durable would need a store, a retention rule and a privacy
 * answer, and none of that is what a probe is for. The one lasting trace is
 * the `llm.getUsage` row the provider writes for every call, which is exactly
 * where a test call belongs.
 *
 * ## How it talks to the model
 *
 * `POST /addon/ai/test-chat`, an NDJSON STREAM off the addon's own HTTP data
 * plane — not tRPC. The first shape of this was an `addons.custom` action and
 * the operator's first real use failed with `UDS request timed out after
 * 60000ms`: a custom action rides UDS with a fixed 60 s bound and no per-call
 * override, and a cold LM Studio loading qwen3-vl into GPU goes straight past
 * it (the vision turn especially — it is the slower one). Tokens now arrive as
 * they are produced, which also means the FIRST TOKEN is the "model finished
 * loading" signal, and the page can say so instead of showing silence.
 *
 * Stop aborts the `fetch`; the hub tears down the upstream, the addon aborts
 * the provider call, and no orphan generation keeps a GPU warm.
 *
 * ## Where the image comes from
 *
 * The browser NEVER uploads bytes. It names a reference — `deviceId` for a
 * camera, `trackId` for a track — and the addon resolves it server-side
 * (snapshot wrapper / stored track media), attaches it to the vision call and
 * reports back in the `meta` event WHICH media it used and how old it was. A
 * requested picture that cannot be resolved ENDS the run with an error: a
 * vision question must never be answered text-only, which is exactly what a
 * silently-dropped attachment produced once. A 4 K JPEG through the msgpack
 * websocket is the mistake `useDeviceSnapshotImage` was rewritten to undo, and
 * this surface does not reintroduce it: the camera picker's own thumbnails come
 * off the snapshot data plane as ordinary browser-cached `<img>` requests.
 */
import type { DeviceInfo, LlmProfile, RecentTracksPage, Track } from '@camstack/types'
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  IconButton,
  Input,
  Label,
  SECTION_BODY,
  STACK_GAP,
  SectionCard,
  SegmentedChoice,
  Select,
  useDeviceLabel,
  useDeviceManagerListAll,
  useDeviceSnapshotImage,
  useSystem,
} from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import {
  Box,
  Camera,
  FlaskConical,
  Loader2,
  MessageSquarePlus,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PROFILES_KEY } from './ai-page.helpers'
import {
  type ChatTurn,
  describeAttachment,
  firstTokenBudgetFor,
  phaseLabel,
  readEvents,
  type StoredChat,
  TEST_CHAT_CHATS_URL,
  TEST_CHAT_URL,
  type TestChatAttachment,
  type TestChatImageRef,
  type TestChatPhase,
  thumbnailDataUrl,
  transcriptForRequest,
  turnsFromStoredChat,
} from './ai-test-chat.helpers'

const RECENT_TRACKS_KEY = ['pipelineAnalytics', 'listRecentTracks', 'ai-test'] as const
/** How far back the track picker looks. A test surface wants what just
 *  happened, not the archive. */
const TRACKS_WINDOW_MS = 6 * 60 * 60 * 1000
const TRACKS_LIMIT = 40
/** Snapshot thumbnails in the camera picker — a ladder rung, never the frame
 *  as captured (which is how a 28 px thumbnail once cost a megabyte). */
const PICKER_THUMB_W = 160

type AttachMode = 'none' | 'snapshot' | 'track'
type ChatMode = 'throwaway' | 'persistent'

interface ChatSummary {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
}

interface PendingAttachment {
  readonly ref: TestChatImageRef
  readonly label: string
}

/** What the run is doing right now, for the status line under the transcript. */
interface LiveState {
  readonly phase: TestChatPhase
  readonly firstTokenTimeoutMs: number
  /** Tokens received so far — rendered as a growing assistant bubble. */
  readonly text: string
  readonly mediaSent: TestChatAttachment | null
}

const INITIAL_LIVE: LiveState = {
  phase: 'connecting',
  firstTokenTimeoutMs: 0,
  text: '',
  mediaSent: null,
}

export function AiTestChatPage() {
  const { t } = useTranslation()
  const system = useSystem()

  const [profileId, setProfileId] = useState<string>('')
  const [systemPrompt, setSystemPrompt] = useState<string>('')
  const [draft, setDraft] = useState<string>('')
  const [turns, setTurns] = useState<readonly ChatTurn[]>([])
  const [pending, setPending] = useState<PendingAttachment | null>(null)
  const [attachMode, setAttachMode] = useState<AttachMode>('none')
  const [chatMode, setChatMode] = useState<ChatMode>('throwaway')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [savedChats, setSavedChats] = useState<readonly ChatSummary[]>([])
  const [transportError, setTransportError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // A run outlives a tab switch only if nobody stops it. Aborting on unmount is
  // what keeps a closed page from leaving a generation warming the GPU.
  useEffect(() => () => abortRef.current?.abort(), [])

  const refreshChats = useCallback(async (): Promise<void> => {
    const res = await fetch(TEST_CHAT_CHATS_URL, { credentials: 'same-origin' })
    if (!res.ok) return
    const json = (await res.json()) as { chats?: ChatSummary[] }
    setSavedChats(json.chats ?? [])
  }, [])

  useEffect(() => {
    if (chatMode === 'persistent') void refreshChats()
  }, [chatMode, refreshChats])

  const profilesQuery = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: (): Promise<readonly LlmProfile[]> => system.trpcClient.llm.listProfiles.query({}),
  })
  const profiles = useMemo(
    () => (profilesQuery.data ?? []).filter((p) => p.enabled),
    [profilesQuery.data],
  )
  // Never auto-pick a profile silently: `''` renders the placeholder option and
  // the send button stays disabled, so "which model answered" is always a
  // choice the operator made.
  const profile = profiles.find((p) => p.id === profileId) ?? null
  const running = live !== null

  /**
   * Drive one turn end to end over the NDJSON stream.
   *
   * Written as a plain async function rather than a react-query mutation: the
   * value here is not one result but a sequence of partial ones, and a mutation
   * has nowhere to put the tokens that arrive before the last.
   */
  const run = useCallback(
    async (
      messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[],
      ref: TestChatImageRef | undefined,
    ): Promise<void> => {
      const controller = new AbortController()
      abortRef.current = controller
      setTransportError(null)
      // Seeded from the profile, not left at 0. The addon announces
      // `first-token-wait` as soon as the SOCKET is up — before `meta`, and on
      // a cold box minutes before it — so the status line has to know the bound
      // it is counting against from the very first frame.
      const firstTokenTimeoutMs = firstTokenBudgetFor(profile ?? {})
      setLive({ ...INITIAL_LIVE, firstTokenTimeoutMs: firstTokenTimeoutMs ?? 0 })

      let text = ''
      let media: TestChatAttachment | null = null
      let model: string | undefined
      let failed: string | null = null
      let stats: { outputTokens: number; latencyMs: number } | null = null
      let persistedId: string | undefined

      try {
        const res = await fetch(TEST_CHAT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Same-origin, so the `camstack_session` cookie authenticates the
          // hub's data-plane gate — the same mechanism the snapshot `<img>`
          // requests already rely on.
          credentials: 'same-origin',
          signal: controller.signal,
          body: JSON.stringify({
            profileId,
            messages,
            ...(systemPrompt.trim() !== '' ? { system: systemPrompt.trim() } : {}),
            ...(ref !== undefined ? { attachment: ref } : {}),
            // The profile's OWN First token bound. Without this the field on
            // the Profiles tab changed nothing here, while the cold-load error
            // told the operator to go and raise it.
            ...(firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs } : {}),
            ...(chatMode === 'persistent'
              ? {
                  persist: true,
                  ...(conversationId !== null ? { conversationId } : {}),
                }
              : {}),
          }),
        })
        if (!res.ok || res.body === null) {
          // A 400 here is the addon REFUSING the request — `.strict()` names the
          // offending key rather than silently dropping it, so show what it said.
          const detail = await res.text().catch(() => '')
          throw new Error(detail.length > 0 ? detail : `HTTP ${String(res.status)}`)
        }

        for await (const event of readEvents(res.body)) {
          switch (event.kind) {
            case 'status':
              setLive((prev) => ({ ...(prev ?? INITIAL_LIVE), phase: event.phase }))
              break
            case 'meta':
              media = event.mediaSent
              model = event.model
              setLive((prev) => ({
                ...(prev ?? INITIAL_LIVE),
                firstTokenTimeoutMs: event.firstTokenTimeoutMs,
                mediaSent: event.mediaSent,
              }))
              break
            case 'token':
              text += event.text
              // The growing answer IS the progress indicator — no spinner can
              // say "the model is producing this" as well as the words.
              setLive((prev) => ({ ...(prev ?? INITIAL_LIVE), text }))
              break
            case 'done':
              stats = { outputTokens: event.outputTokens, latencyMs: event.latencyMs }
              persistedId = event.conversationId
              break
            case 'error':
              failed = `${event.code}: ${event.message}`
              break
          }
        }
      } catch (err: unknown) {
        // An abort is the operator pressing Stop, not a failure.
        if (!controller.signal.aborted) {
          setTransportError(err instanceof Error ? err.message : t('common.error', 'Error'))
        }
      } finally {
        abortRef.current = null
        setLive(null)
      }

      if (persistedId !== undefined) {
        setConversationId(persistedId)
        void refreshChats()
      }

      const partial = controller.signal.aborted && text.length > 0
      if (failed === null && text.length === 0 && !partial) return

      setTurns((prev) => [
        ...prev,
        {
          id: `a-${String(Date.now())}`,
          role: 'assistant',
          content: failed ?? text,
          ...(failed !== null ? { failed: true } : {}),
          ...(media !== null ? { attachment: media } : {}),
          ...(model !== undefined && failed === null ? { model } : {}),
          ...(stats !== null ? stats : {}),
        },
      ])
    },
    [chatMode, conversationId, profile, profileId, refreshChats, systemPrompt, t],
  )

  const submit = useCallback((): void => {
    const text = draft.trim()
    if (text === '' || profileId === '' || running) return
    const userTurn: ChatTurn = {
      id: `u-${String(Date.now())}`,
      role: 'user',
      content: text,
      // The operator's own words for what they attached. The server's report of
      // what it ACTUALLY sent lands on the assistant turn — two different claims,
      // two different fields.
      ...(pending !== null
        ? { attachmentLabel: pending.label, attachmentKind: pending.ref.kind }
        : {}),
    }
    const next = [...turns, userTurn]
    setTurns(next)
    setDraft('')
    const ref = pending?.ref
    setPending(null)
    setAttachMode('none')
    const messages =
      chatMode === 'persistent' && conversationId !== null
        ? [{ role: 'user' as const, content: text }]
        : transcriptForRequest(next)
    void run(messages, ref)
  }, [chatMode, conversationId, draft, pending, profileId, run, running, turns])

  const stop = (): void => abortRef.current?.abort()

  const clear = (): void => {
    abortRef.current?.abort()
    setTurns([])
    setPending(null)
    setDraft('')
    setTransportError(null)
    setLive(null)
    setConversationId(null)
  }

  const openSaved = async (id: string): Promise<void> => {
    abortRef.current?.abort()
    const res = await fetch(`${TEST_CHAT_CHATS_URL}/${id}`, { credentials: 'same-origin' })
    if (!res.ok) return
    const json = (await res.json()) as StoredChat
    setConversationId(id)
    setTurns(turnsFromStoredChat(json))
    setLive(null)
    setTransportError(null)
  }

  // Clear sits in the Conversation card's header — the section body is
  // embedded under SectionedPage, whose page header belongs to the page.
  return (
    <div className={STACK_GAP}>
      <SectionCard headingId="ai-test-setup" title={t('ai.testSetup', 'Setup')}>
        <div className={`${SECTION_BODY} space-y-3`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block" htmlFor="ai-test-profile">
                {t('ai.profile', 'Profile')}
              </Label>
              <Select
                id="ai-test-profile"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                options={[
                  { value: '', label: t('ai.selectProfile', 'Select a profile…') },
                  ...profiles.map((p) => ({
                    value: p.id,
                    label: `${p.name} · ${p.model}${p.supportsVision ? ' · vision' : ''}`,
                  })),
                ]}
              />
              {profiles.length === 0 && !profilesQuery.isLoading && (
                <p className="mt-1 text-xs text-foreground-subtle">
                  {t('ai.noEnabledProfiles', 'No enabled profile. Add one on the Profiles tab.')}
                </p>
              )}
            </div>
            <div>
              <Label className="mb-1 block" htmlFor="ai-test-system">
                {t('ai.systemPrompt', 'System prompt (optional)')}
              </Label>
              <Input
                id="ai-test-system"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('ai.systemPlaceholder', 'Answer in one short sentence.')}
              />
            </div>
          </div>

          <SegmentedChoice<ChatMode>
            label={t('ai.chatMode', 'Conversation mode')}
            value={chatMode}
            options={[
              { value: 'throwaway', label: t('ai.throwawayMode', 'Throwaway') },
              { value: 'persistent', label: t('ai.saveConversation', 'Save conversation') },
            ]}
            onChange={(next) => {
              setChatMode(next)
              if (next === 'throwaway') setConversationId(null)
            }}
          />

          {chatMode === 'persistent' && (
            <div className="space-y-2">
              <p className="text-xs text-foreground-subtle">
                {t(
                  'ai.testSubtitlePersistent',
                  'Conversations are saved for you and can be reopened. Throwaway mode is still available.',
                )}
              </p>
              <Button size="sm" variant="secondary" type="button" onClick={clear}>
                <MessageSquarePlus className="h-3.5 w-3.5" />
                {t('ai.newChat', 'New chat')}
              </Button>
              {savedChats.length > 0 && (
                <div className="max-h-36 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {savedChats.map((chat) => (
                    <button // ui-check-ok: full-row chat list hit target; Button chrome fights the row
                      key={chat.id}
                      type="button"
                      onClick={() => void openSaved(chat.id)}
                      className={`flex w-full px-2.5 py-1.5 text-left text-xs hover:bg-surface-hover ${
                        chat.id === conversationId ? 'bg-primary/10' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">{chat.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-foreground-subtle">
            {t(
              'ai.streamNote',
              'The answer streams as the model produces it. A cold model can take a while to load — the status line says which phase it is in.',
            )}
          </p>

          {profile !== null && !profile.supportsVision && (
            <p className="text-xs text-warning">
              {t(
                'ai.notVision',
                'This profile is not vision-capable — an attached image will be refused before anything is read.',
              )}
            </p>
          )}
        </div>
      </SectionCard>

      {transportError !== null && (
        <ErrorBox title={t('ai.chatFailed', 'The test call failed')} message={transportError} />
      )}

      <SectionCard
        headingId="ai-test-conversation"
        title={t('ai.testConversation', 'Conversation')}
        actions={
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={turns.length === 0 && pending === null}
            onClick={clear}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('ai.clearChat', 'Clear')}
          </Button>
        }
      >
        <Transcript turns={turns} live={live} />

        <div className={`${SECTION_BODY} space-y-2 border-t border-border`}>
          {pending !== null && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
              {pending.ref.kind === 'snapshot' ? (
                <Camera className="h-3.5 w-3.5 text-foreground-subtle" />
              ) : (
                <Box className="h-3.5 w-3.5 text-foreground-subtle" />
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {pending.label}
              </span>
              <IconButton
                size="sm"
                variant="ghost"
                type="button"
                icon={X}
                aria-label={t('ai.removeAttachment', 'Remove attachment')}
                onClick={() => setPending(null)}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={attachMode === 'snapshot' ? 'primary' : 'outline'}
              type="button"
              onClick={() => setAttachMode(attachMode === 'snapshot' ? 'none' : 'snapshot')}
            >
              <Camera className="h-3.5 w-3.5" />
              {t('ai.attachSnapshot', 'Camera snapshot')}
            </Button>
            <Button
              size="sm"
              variant={attachMode === 'track' ? 'primary' : 'outline'}
              type="button"
              onClick={() => setAttachMode(attachMode === 'track' ? 'none' : 'track')}
            >
              <Box className="h-3.5 w-3.5" />
              {t('ai.attachTrack', 'Recent track')}
            </Button>
          </div>

          {attachMode === 'snapshot' && (
            <CameraPicker
              onPick={(device, label) => {
                setPending({
                  ref: { kind: 'snapshot', deviceId: device.id },
                  label: t('ai.snapshotOf', 'Snapshot of {{name}}', { name: label }),
                })
                setAttachMode('none')
              }}
            />
          )}
          {attachMode === 'track' && (
            <TrackPicker
              onPick={(track, cameraName) => {
                setPending({
                  ref: { kind: 'track', trackId: track.trackId, deviceId: track.deviceId },
                  label: t('ai.trackOf', '{{class}} on {{name}}', {
                    class: track.label ?? track.className,
                    name: cameraName,
                  }),
                })
                setAttachMode('none')
              }}
            />
          )}

          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={t('ai.messagePlaceholder', 'Ask the model something…')}
              aria-label={t('ai.message', 'Message')}
            />
            {/* Stop ABORTS the fetch. The hub tears the upstream down, the addon
                aborts the provider call, and the half-answer already on screen
                stays — it is evidence, not scratch. */}
            {running ? (
              <Button size="sm" variant="secondary" type="button" onClick={stop}>
                <Square className="h-3.5 w-3.5" />
                {t('ai.stop', 'Stop')}
              </Button>
            ) : (
              <Button
                size="sm"
                type="button"
                disabled={draft.trim() === '' || profileId === ''}
                onClick={submit}
              >
                <Send className="h-3.5 w-3.5" />
                {t('ai.send', 'Send')}
              </Button>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

interface TranscriptProps {
  readonly turns: readonly ChatTurn[]
  readonly live: LiveState | null
}

function Transcript({ turns, live }: TranscriptProps) {
  const { t } = useTranslation()
  if (turns.length === 0 && live === null) {
    return (
      <EmptyState
        icon={FlaskConical}
        title={t('ai.chatEmptyTitle', 'No messages yet')}
        description={t(
          'ai.chatEmpty',
          'Pick a profile, optionally attach a camera snapshot or a recent track, and send a message. Nothing here is saved.',
        )}
      />
    )
  }
  return (
    // The transcript scrolls INSIDE its own box so the composer below it
    // never leaves the viewport — the same rule the admin tables follow.
    <div className={`max-h-[50vh] space-y-2 overflow-y-auto ${SECTION_BODY}`}>
      {turns.map((turn) => (
        <TurnBubble key={turn.id} turn={turn} />
      ))}
      {live !== null && (
        <div className="space-y-1">
          {live.mediaSent !== null && <AttachmentThumb attachment={live.mediaSent} />}
          {live.text.length > 0 && (
            <TurnBubble turn={{ id: 'live', role: 'assistant', content: live.text }} streaming />
          )}
          {/* And the phase, named. The original failure looked like a hang
              because a cold GPU load and a wedged transport are the same
              silence — this line is the difference. */}
          <div className="flex items-center gap-2 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {phaseLabel(live.phase, live.firstTokenTimeoutMs)}
          </div>
        </div>
      )}
    </div>
  )
}

function TurnBubble({
  turn,
  streaming = false,
}: {
  readonly turn: ChatTurn
  readonly streaming?: boolean
}) {
  const { t } = useTranslation()
  const isUser = turn.role === 'user'
  const tone = turn.failed === true ? 'border-danger/40 bg-danger/10' : 'border-border bg-surface'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 ${isUser ? 'border-primary/40 bg-primary/10' : tone}`}
      >
        <p className="whitespace-pre-wrap break-words text-xs text-foreground">
          {turn.content}
          {streaming && <span className="ml-0.5 animate-pulse text-primary">▌</span>}
        </p>
        {turn.attachment !== undefined && <AttachmentThumb attachment={turn.attachment} />}
        {turn.attachmentLabel !== undefined && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-foreground-subtle">
            {turn.attachmentKind === 'track' ? (
              <Box className="h-3 w-3" />
            ) : (
              <Camera className="h-3 w-3" />
            )}
            {turn.attachmentLabel}
          </p>
        )}
        {turn.attachment !== undefined && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-foreground-subtle">
            {turn.attachment.kind === 'snapshot' ? (
              <Camera className="h-3 w-3" />
            ) : (
              <Box className="h-3 w-3" />
            )}
            {describeAttachment(turn.attachment)}
          </p>
        )}
        {turn.model !== undefined && (
          <p className="mt-1 text-[10px] text-foreground-subtle">
            {t('system.aiTestChat.tokMs', '{{model}} · {{value2}} tok · {{value3}} ms', {
              model: turn.model,
              value2: String(turn.outputTokens ?? 0),
              value3: String(turn.latencyMs ?? 0),
            })}
          </p>
        )}
      </div>
    </div>
  )
}

function AttachmentThumb({ attachment }: { readonly attachment: TestChatAttachment }) {
  const { t } = useTranslation()
  const src = thumbnailDataUrl(attachment)
  if (src === null) return null
  return (
    <img
      src={src}
      alt={t('system.aiTestChat.sentToTheModel', 'sent to the model')}
      className="mt-1 max-h-32 rounded-md border border-border object-contain"
    />
  )
}

// ── Pickers ─────────────────────────────────────────────────────────

interface CameraPickerProps {
  readonly onPick: (device: DeviceInfo, label: string) => void
}

function CameraPicker({ onPick }: CameraPickerProps) {
  const { t } = useTranslation()
  // `isCamera` + `slim` server-side: 30 rows instead of 1 019, without the
  // `config`/`metadata` blobs this picker never reads. Through the GENERATED
  // hook, not the raw client: the private key `['deviceManager','listAll',
  // 'cameras']` matched neither the D274 window (registered on the tRPC key
  // prefix) nor the `[['deviceManager']]` invalidations, and this exact input
  // is already warm from the detection-intelligence and recordings sections.
  const camerasQuery = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const cameras = (camerasQuery.data ?? []).filter((d) => !d.disabled)

  if (camerasQuery.isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle" />
  }
  if (cameras.length === 0) {
    return (
      <p className="text-[11px] text-foreground-subtle">{t('ai.noCameras', 'No camera found.')}</p>
    )
  }
  return (
    <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4">
      {cameras.map((device) => (
        <CameraTile key={device.id} device={device} onPick={onPick} />
      ))}
    </div>
  )
}

function CameraTile({
  device,
  onPick,
}: {
  readonly device: DeviceInfo
  readonly onPick: (device: DeviceInfo, label: string) => void
}) {
  const { t } = useTranslation()
  const label = useDeviceLabel(device, 'compact')
  const { src } = useDeviceSnapshotImage(device.id, { width: PICKER_THUMB_W })
  return (
    <button // ui-check-ok: camera tile in the picker grid; Button chrome fights the card
      type="button"
      onClick={() => onPick(device, label)}
      className="overflow-hidden rounded-md border border-border bg-surface text-left transition-colors hover:border-primary/50"
    >
      <span className="block aspect-video w-full bg-background-elevated">
        {src !== null && (
          <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        )}
      </span>
      <span className="flex items-center gap-1 px-2 py-1">
        {!device.online && <Badge variant="warning">{t('common.off')}</Badge>}
        <span className="truncate text-[10px] text-foreground">{label}</span>
      </span>
    </button>
  )
}

interface TrackPickerProps {
  readonly onPick: (track: Track, cameraName: string) => void
}

function TrackPicker({ onPick }: TrackPickerProps) {
  const { t } = useTranslation()
  const system = useSystem()

  // Same hook, same input, same cache entry as `CameraPicker` above.
  const camerasQuery = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const deviceIds = useMemo(() => (camerasQuery.data ?? []).map((d) => d.id), [camerasQuery.data])
  const nameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const d of camerasQuery.data ?? []) m.set(d.id, d.name)
    return m
  }, [camerasQuery.data])

  const tracksQuery = useQuery({
    queryKey: [...RECENT_TRACKS_KEY, deviceIds.length],
    enabled: deviceIds.length > 0,
    queryFn: (): Promise<RecentTracksPage> =>
      system.trpcClient.pipelineAnalytics.listRecentTracks.query({
        deviceIds: [...deviceIds],
        since: Date.now() - TRACKS_WINDOW_MS,
        limit: TRACKS_LIMIT,
        // `slim` — this picker renders ids, class and time. The full projection
        // carries frame-rate position history per track: megabytes for a list.
        projection: 'slim',
      }),
  })

  if (camerasQuery.isLoading || tracksQuery.isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle" />
  }
  const tracks = tracksQuery.data?.tracks ?? []
  if (tracks.length === 0) {
    return (
      <p className="text-[11px] text-foreground-subtle">
        {t('ai.noTracks', 'No track in the last 6 hours.')}
      </p>
    )
  }
  return (
    <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
      {tracks.map((track) => (
        <button // ui-check-ok: full-row track list hit target; Button chrome fights the row
          key={track.trackId}
          type="button"
          onClick={() => onPick(track, nameById.get(track.deviceId) ?? String(track.deviceId))}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-surface-hover"
        >
          <Box className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {track.label ?? track.className}
          </span>
          <span className="shrink-0 text-foreground-subtle">
            {nameById.get(track.deviceId) ?? track.deviceId}
          </span>
          <span className="shrink-0 text-foreground-subtle">
            {new Date(track.lastSeen).toLocaleTimeString()}
          </span>
        </button>
      ))}
    </div>
  )
}
