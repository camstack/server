/**
 * Backup page → Encryption (opt-in, operator decision 2026-10-09).
 *
 * The hub keeps a backup PUBLIC key and encrypts every archive to it, so
 * scheduled backups run unattended while only the operator's SECRET key opens
 * them — not the hub, not its database, not a copy of its volume. The secret
 * key is shown ONCE, here, when encryption is enabled or the key replaced; it
 * is never stored on the hub. Restore asks for it. Archives made with an older
 * key keep needing that key; archives made before encryption need none.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useBackupDisableEncryption,
  useBackupGetEncryption,
  useBackupSetupEncryption,
  useConfirm,
} from '@camstack/ui-library'
import { AlertTriangle, Copy, Download, Lock, LockOpen } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface RevealedKey {
  readonly keyId: string
  readonly secretKey: string
}

function when(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString()
}

function downloadKeyFile(key: RevealedKey): void {
  const blob = new Blob([`${key.secretKey}\n`], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `camstack-backup-key-${key.keyId}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

/** The one and only display of a new secret key. */
function SecretKeyDialog({
  revealed,
  onDone,
}: {
  readonly revealed: RevealedKey
  readonly onDone: () => void
}) {
  const { t } = useTranslation()
  const [stored, setStored] = useState(false)
  const [copied, setCopied] = useState(false)
  // Escape / dismiss only after the operator confirms they stored the key —
  // otherwise the controlled `open` stays true and the dialog re-opens.
  return (
    <Dialog open onOpenChange={(next) => !next && stored && onDone()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        scroll="body"
        className="border-danger/40"
        aria-labelledby="backup-key-title"
      >
        <DialogHeader>
          <DialogTitle id="backup-key-title">
            {t('backup.encryptionCard.yourKey', { keyId: revealed.keyId })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <span>
              {t(
                'backup.backupEncryptionCard.thisKeyIsShownOnly',
                'This key is shown only once. CamStack does not keep it — not the hub, not its database, not its backups. Without it, an encrypted backup cannot be restored by anyone, including you. Store it in a password manager or print it, away from this server.',
              )}
            </span>
          </p>
          <div className="break-all rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground select-all">
            {revealed.secretKey}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(revealed.secretKey).then(() => setCopied(true))
              }}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {copied
                ? t('backup.backupEncryptionCard.copied', 'Copied')
                : t('common.copy', 'Copy')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => downloadKeyFile(revealed)}>
              <Download className="mr-1 h-3.5 w-3.5" />
              {t('backup.backupEncryptionCard.downloadAsFile', 'Download as file')}
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={stored}
              onChange={(e) => setStored(e.target.checked)}
              className="accent-primary"
            />
            {t(
              'backup.backupEncryptionCard.iHaveStoredThisKey',
              'I have stored this key somewhere safe, off this server.',
            )}
          </label>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" disabled={!stored} onClick={onDone}>
            {t('backup.backupEncryptionCard.iHaveStoredIt', 'I have stored it')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BackupEncryptionCard() {
  const { t } = useTranslation()
  const status = useBackupGetEncryption()
  const setup = useBackupSetupEncryption()
  const disable = useBackupDisableEncryption()
  const confirm = useConfirm()
  const [revealed, setRevealed] = useState<RevealedKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const enabled = status.data?.enabled ?? false
  const active = status.data?.active ?? null
  const retired = (status.data?.keys ?? []).filter((k) => k.retiredAt !== null)

  const onSetup = async (): Promise<void> => {
    const ok = await confirm({
      title: enabled
        ? t('backup.backupEncryptionCard.replaceTheBackupKey', 'Replace the backup key')
        : t('backup.backupEncryptionCard.encryptBackups', 'Encrypt backups'),
      message: enabled
        ? t(
            'backup.backupEncryptionCard.aNewKeyIsGenerated',
            'A new key is generated and shown once; new backups are encrypted to it. Older backups keep needing the key they were made with — keep that one too.',
          )
        : t(
            'backup.backupEncryptionCard.aBackupKeyIsGenerated',
            'A backup key is generated and shown once. Every new backup is encrypted to it, and restoring one will ask for it. Existing backups stay as they are.',
          ),
      confirmLabel: enabled
        ? t('backup.backupEncryptionCard.generateANewKey', 'Generate a new key')
        : t('backup.backupEncryptionCard.generateTheKey', 'Generate the key'),
      variant: 'warning',
    })
    if (!ok) return
    setError(null)
    try {
      const result = await setup.mutateAsync({})
      setRevealed({ keyId: result.keyId, secretKey: result.secretKey })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDisable = async (): Promise<void> => {
    const ok = await confirm({
      title: t('backup.backupEncryptionCard.turnBackupEncryptionOff', 'Turn backup encryption off'),
      message: t(
        'backup.backupEncryptionCard.newBackupsWillBeWritten',
        'New backups will be written unencrypted. Existing encrypted backups still need their key to be restored.',
      ),
      confirmLabel: t('backup.backupEncryptionCard.turnOff', 'Turn off'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    try {
      await disable.mutateAsync({})
      void status.refetch()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {enabled ? (
            <Lock className="h-4 w-4 text-success" />
          ) : (
            <LockOpen className="h-4 w-4 text-foreground-subtle" />
          )}
          <h2 className="text-sm font-semibold text-foreground">
            {t('backup.backupEncryptionCard.encryption', 'Encryption')}
          </h2>
          <span className="text-xs text-foreground-subtle">
            {enabled && active !== null
              ? t(
                  'backup.backupEncryptionCard.onKeySince',
                  'On — key {{keyId}}, since {{value2}}',
                  { keyId: active.keyId, value2: when(active.createdAt) },
                )
              : t(
                  'backup.backupEncryptionCard.offBackupsAreNotEncrypted',
                  'Off — backups are not encrypted',
                )}
          </span>
        </div>
        <div className="flex gap-2">
          {enabled ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={setup.isPending}
                onClick={() => void onSetup()}
              >
                {t('backup.backupEncryptionCard.replaceKey', 'Replace key')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disable.isPending}
                onClick={() => void onDisable()}
              >
                {t('backup.backupEncryptionCard.turnOff', 'Turn off')}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={setup.isPending} onClick={() => void onSetup()}>
              {t('backup.backupEncryptionCard.enableEncryption', 'Enable encryption')}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-foreground-subtle">
        {t(
          'backup.backupEncryptionCard.archivesAreEncryptedOnThis',
          'Archives are encrypted on this server before they reach any destination. The server keeps only a public key, so it can encrypt scheduled backups but cannot decrypt them — only your backup key can. Covers the database snapshot, config.yaml, addon data (HomeKit pairing, Matter fabric, Tailscale state) and TLS.',
        )}
      </p>
      {retired.length > 0 && (
        <div className="text-xs">
          <p className="text-foreground-subtle">
            {t(
              'backup.backupEncryptionCard.olderKeysBackupsMadeWith',
              'Older keys (backups made with them still need them):',
            )}
          </p>
          <ul className="font-mono text-foreground">
            {retired.map((k) => (
              <li key={k.keyId}>
                {k.keyId} · {when(k.createdAt)} → {when(k.retiredAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error !== null && <p className="text-xs text-danger">{error}</p>}
      {revealed !== null && (
        <SecretKeyDialog
          revealed={revealed}
          onDone={() => {
            setRevealed(null)
            void status.refetch()
          }}
        />
      )}
    </div>
  )
}
