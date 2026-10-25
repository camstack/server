/**
 * ServerNamePrompt - the first-login "Name this server" dialog (D861).
 *
 * The hub has no human name until somebody gives it one, and nothing gives it
 * one by itself. After an ADMIN signs in and the name is still unset, this
 * asks once, prefilled with the machine hostname the hub falls back to:
 *
 *   - Save writes `server.name` through the same `system-config` settings
 *     write the System -> Settings form uses (one writer, one validation);
 *   - Later closes it for this browser session only (sessionStorage), so the
 *     next session asks again until a name exists.
 *
 * Visible only when ALL hold: a signed-in admin, the hub ANSWERED `system.info`,
 * and its name `isDefault`. An unanswered or failed query shows nothing - not
 * knowing the name is not the same as there being none.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  useAddonSettingsUpdateGlobalSettings,
} from '@camstack/ui-library'
import { SERVER_NAME_MAX_LENGTH, type ServerNameInfo, ServerNameSchema } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/auth-context'
import { useServerName } from '../../hooks/use-server-name'

/** The settings addon that owns `server.name`, and its hub node. */
const SYSTEM_CONFIG_ADDON_ID = 'system-config'
const HUB_NODE_ID = 'hub'
const DISMISS_KEY = 'camstack_server_name_prompt_dismissed'

export function isServerNamePromptDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function persistDismissal(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* storage unavailable - the dialog just asks again on the next page load */
  }
}

/** Should the dialog be offered? Pure, so the gate is testable on its own. */
export function shouldPromptForServerName(input: {
  readonly isAdmin: boolean
  readonly info: ServerNameInfo | null
  readonly dismissed: boolean
}): boolean {
  return input.isAdmin && input.info !== null && input.info.isDefault && !input.dismissed
}

export function ServerNamePrompt() {
  const { user } = useAuth()
  const { info } = useServerName()
  const [dismissed, setDismissed] = useState(isServerNamePromptDismissed)

  if (!shouldPromptForServerName({ isAdmin: user?.isAdmin === true, info, dismissed })) {
    return null
  }
  return (
    <ServerNameDialog
      suggestion={info?.name ?? ''}
      onLater={() => {
        persistDismissal()
        setDismissed(true)
      }}
    />
  )
}

function ServerNameDialog({
  suggestion,
  onLater,
}: {
  readonly suggestion: string
  readonly onLater: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const save = useAddonSettingsUpdateGlobalSettings()
  const [value, setValue] = useState(suggestion)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // showModal() (run by DialogContent's effect, a child of this one) focuses the
  // first focusable, the close X; this effect runs after it and moves focus to the input.
  useEffect(() => inputRef.current?.focus(), [])

  const submit = useCallback(async (): Promise<void> => {
    const parsed = ServerNameSchema.safeParse(value)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('serverName.invalid', 'Not a valid name'))
      return
    }
    setError(null)
    try {
      await save.mutateAsync({
        addonId: SYSTEM_CONFIG_ADDON_ID,
        nodeId: HUB_NODE_ID,
        patch: { name: parsed.data },
      })
      await queryClient.invalidateQueries({ queryKey: [['system', 'info']] })
      await queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
    } catch (err: unknown) {
      setError(err instanceof Error && err.message.length > 0 ? err.message : 'Could not save')
    }
  }, [queryClient, save, t, value])

  return (
    <Dialog open onOpenChange={(open) => !open && onLater()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!save.isPending) void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('serverName.title', 'Name this server')}</DialogTitle>
            <DialogDescription>
              {t(
                'serverName.description',
                'Pick a name for this hub. It shows in the admin UI and on the apps’ sign-in screen. You can change it later in System settings.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField
              label={t('serverName.label', 'Server name')}
              {...(error !== null ? { error } : {})}
            >
              <Input
                ref={inputRef}
                value={value}
                maxLength={SERVER_NAME_MAX_LENGTH}
                onChange={(e) => setValue(e.target.value)}
                state={error !== null ? 'error' : 'default'}
                aria-label={t('serverName.label', 'Server name')}
              />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onLater} disabled={save.isPending}>
              {t('serverName.later', 'Later')}
            </Button>
            <Button type="submit" disabled={save.isPending || value.trim().length === 0}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
