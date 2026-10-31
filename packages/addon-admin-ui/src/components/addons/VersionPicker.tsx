import { Check, Download, Loader2, Upload, X } from 'lucide-react'
import { useState } from 'react'

import { Button, useAddonsGetVersions } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'
import { hiddenOlderVersionCount, isDeprecatedVersion, versionsForPicker } from './visible-versions'
interface VersionPickerProps {
  packageName: string
  currentVersion: string
  /**
   * Where the currently-installed copy came from. When `'upload'` or
   * `'local'`, the picker still shows the Install button on the matching
   * npm version row — re-installing from npm is the canonical way to
   * "switch back" from a CLI-pushed / uploaded blob to the registry
   * release of the same number. Registry-sourced rows (npm or absent)
   * also offer Re-install on the current version.
   */
  installSource?: 'npm' | 'local' | 'upload'
  onInstall: (version: string) => void
  onClose: () => void
  /**
   * Selection mode (update flow): when set, clicking a row SELECTS the
   * version (reported via `onSelect`) instead of installing it — the
   * caller's adjacent "Update" button performs the install. `selectedVersion`
   * marks the currently-selected row.
   */
  onSelect?: (version: string) => void
  selectedVersion?: string
}

export function VersionPicker({
  packageName,
  currentVersion,
  installSource,
  onInstall,
  onClose,
  onSelect,
  selectedVersion,
}: VersionPickerProps) {
  const { t } = useTranslation()
  const isOverridden = installSource === 'upload' || installSource === 'local'
  const [showOlder, setShowOlder] = useState(false)
  const { data: versions, isLoading, isError } = useAddonsGetVersions({ name: packageName })
  const listed = versions ? versionsForPicker(versions, showOlder) : []
  const hiddenOlder = versions ? hiddenOlderVersionCount(versions) : 0

  return (
    <div
      className="fixed z-50 w-72 rounded-lg border border-border bg-surface shadow-xl overflow-hidden"
      style={{ top: 'auto', bottom: 'auto' }}
      ref={(el) => {
        if (!el) return
        const rect = el.parentElement?.getBoundingClientRect()
        if (!rect) return
        const spaceBelow = window.innerHeight - rect.bottom
        const spaceAbove = rect.top
        if (spaceBelow < 280 && spaceAbove > spaceBelow) {
          el.style.bottom = `${window.innerHeight - rect.top + 4}px`
          el.style.top = 'auto'
        } else {
          el.style.top = `${rect.bottom + 4}px`
          el.style.bottom = 'auto'
        }
        el.style.right = `${window.innerWidth - rect.right}px`
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle font-medium">
          {t('addons.versionPicker.versions', 'Versions')}
        </span>
        <Button
          variant="unstyled"
          type="button"
          onClick={onClose}
          className="text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Source banner — visible only when the installed copy bypassed
          the npm registry. The matching-version row below stays
          installable so the operator can swap back to the registry
          release without bumping the version number. */}
      {isOverridden && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-cyan-500/10 text-[10px]">
          <Upload className="h-3 w-3 mt-0.5 text-cyan-500 shrink-0" />
          <div className="text-cyan-700 dark:text-cyan-200">
            <span className="font-semibold">
              {t('addons.versionPicker.inPlace', {
                kind:
                  installSource === 'upload'
                    ? t('addons.versionPicker.uploadedCopy', 'Uploaded copy')
                    : t('addons.versionPicker.localCopy', 'Local copy'),
              })}
            </span>{' '}
            <Trans
              i18nKey="addons.versionPicker.reinstall"
              values={{ version: currentVersion }}
              components={{ mono: <span className="font-mono" /> }}
            />
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('addons.versionPicker.loadingVersions', 'Loading versions...')}
        </div>
      )}

      {isError && (
        <div className="px-3 py-4 text-center text-[10px] text-danger">
          {t('addons.versionPicker.registryError', 'Could not load versions from the registry.')}
        </div>
      )}

      {/* Version list — latest and non-deprecated rows. Older deprecated
          versions stay behind an explicit control so a rollback is still
          possible. */}
      {listed.length > 0 && (
        <div className="max-h-64 overflow-auto divide-y divide-border">
          {listed.map((v) => {
            const isCurrent = v.version === currentVersion
            const isSelected = onSelect !== undefined && v.version === selectedVersion
            const isPreRelease = /-(alpha|beta|rc|dev|canary|next)/i.test(v.version)
            const rowBody = (
              <>
                <span
                  className={`font-mono flex-1 text-left ${isCurrent ? 'text-primary font-semibold' : isPreRelease ? 'text-amber-400' : 'text-foreground'}`}
                >
                  {v.version}
                </span>
                {isCurrent && (
                  <span className="text-[9px] rounded-full px-1.5 py-0.5 font-medium bg-primary/10 text-primary">
                    {t('common.current')}
                  </span>
                )}
                {v.distTags.map((tag) => (
                  <span
                    key={tag}
                    className={`text-[9px] rounded-full px-1.5 py-0.5 font-medium ${
                      tag === 'latest'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : tag === 'beta'
                          ? 'bg-amber-500/15 text-amber-400'
                          : 'bg-gray-500/15 text-gray-400'
                    }`}
                  >
                    {tag}
                  </span>
                ))}
                {isDeprecatedVersion(v) && (
                  <span className="text-[9px] text-red-400 line-through">
                    {t('common.deprecated')}
                  </span>
                )}
                <span className="text-[9px] text-foreground-subtle shrink-0">
                  {new Date(v.publishedAt).toLocaleDateString()}
                </span>
              </>
            )
            // Selection mode: the whole row is the selection affordance —
            // the caller's Update button performs the install.
            if (onSelect) {
              return (
                <Button
                  variant="unstyled"
                  key={v.version}
                  type="button"
                  aria-label={t('addons.versionPicker.select', 'Select {{version}}', {
                    version: v.version,
                  })}
                  onClick={() => onSelect(v.version)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] ${isSelected ? 'bg-primary/5' : 'hover:bg-surface-hover'} transition-colors`}
                >
                  {rowBody}
                  {isSelected ? (
                    <Check className="h-3 w-3 text-primary shrink-0" />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                </Button>
              )
            }
            return (
              <div
                key={v.version}
                className={`flex items-center gap-2 px-3 py-2 text-[11px] ${isCurrent ? 'bg-primary/5' : 'hover:bg-surface-hover'} transition-colors`}
              >
                {rowBody}
                <Button
                  variant="unstyled"
                  type="button"
                  onClick={() => onInstall(v.version)}
                  className="shrink-0 rounded p-0.5 hover:bg-primary/20 text-foreground-subtle hover:text-primary transition-colors"
                  title={
                    isCurrent
                      ? t(
                          'addons.versionPicker.reInstallFromNpm',
                          'Re-install {{version}} from npm',
                          { version: v.version },
                        )
                      : t('addons.versionPicker.install', 'Install {{version}}', {
                          version: v.version,
                        })
                  }
                >
                  <Download className="h-3 w-3" />
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {!isLoading && !isError && versions && versions.length === 0 && (
        <div className="py-4 text-center text-[10px] text-foreground-subtle">
          {t('addons.versionPicker.noVersionsFound', 'No versions found')}
        </div>
      )}

      {hiddenOlder > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start rounded-none border-t border-border px-3 py-2 text-left text-[10px] font-normal text-foreground-subtle"
          onClick={() => setShowOlder((current) => !current)}
        >
          {showOlder
            ? t('addons.versionPicker.hideOlder', 'Hide older versions')
            : t('addons.versionPicker.showOlder', 'Show older versions ({{count}})', {
                count: hiddenOlder,
              })}
        </Button>
      )}
    </div>
  )
}
