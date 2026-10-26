import type { JSX } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useAddonsGetPackageDocs,
  useAddonsGetVersions,
} from '@camstack/ui-library'
import { AddonMarkdown } from './render-addon-markdown'
import {
  hiddenOlderVersionCount,
  isDeprecatedVersion,
  versionsForPicker,
  type VersionListEntry,
} from './visible-versions'

export interface InstallAddonTarget {
  readonly name: string
  readonly version: string
  readonly description: string
}

interface PackageDocBody {
  readonly status: 'ok' | 'missing' | 'error'
  readonly markdown?: string
  readonly message?: string
}

interface InstallAddonDialogProps {
  readonly target: InstallAddonTarget
  readonly installing: boolean
  readonly installError?: string | null
  readonly onClose: () => void
  readonly onInstall: (packageName: string, version: string) => void
}

function friendlyName(packageName: string): string {
  return packageName.replace(/^@camstack\/(addon-)?/, '')
}

function optionRows(
  versions: readonly VersionListEntry[],
  selected: string,
  showOlder: boolean,
): readonly VersionListEntry[] {
  const visible = versionsForPicker(versions, showOlder)
  if (visible.some((entry) => entry.version === selected)) return visible
  return [{ version: selected, distTags: [], deprecated: undefined }, ...visible]
}

function DocBody({
  pending,
  failed,
  body,
  missing,
}: {
  readonly pending: boolean
  readonly failed: boolean
  readonly body: PackageDocBody | undefined
  readonly missing: string
}): JSX.Element {
  const { t } = useTranslation()
  if (pending) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('addons.installDialog.loadingDocument', 'Loading…')}
      </div>
    )
  }
  if (failed || body === undefined) {
    return (
      <p className="py-4 text-xs text-danger">
        {t(
          'addons.installDialog.couldNotLoadDocument',
          'Could not load this file from the registry.',
        )}
      </p>
    )
  }
  if (body.status === 'ok' && body.markdown !== undefined) {
    return <AddonMarkdown markdown={body.markdown} />
  }
  if (body.status === 'error') {
    return (
      <p className="py-4 text-xs text-danger">
        {t('addons.installDialog.documentError', 'Could not load this file. {{message}}', {
          message: body.message ?? '',
        })}
      </p>
    )
  }
  return <p className="py-4 text-xs text-foreground-subtle">{missing}</p>
}

export function InstallAddonDialog({
  target,
  installing,
  installError,
  onClose,
  onInstall,
}: InstallAddonDialogProps): JSX.Element {
  const { t } = useTranslation()
  const [selectedVersion, setSelectedVersion] = useState(target.version)
  const [showOlder, setShowOlder] = useState(false)
  const versionsQuery = useAddonsGetVersions({ name: target.name })
  const docsQuery = useAddonsGetPackageDocs({ name: target.name, version: selectedVersion })
  const versions = versionsQuery.data ?? []
  const hidden = hiddenOlderVersionCount(versions)
  const rows = optionRows(versions, selectedVersion, showOlder)
  const docs = docsQuery.data

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('addons.installDialog.title', 'Install {{name}}', {
              name: friendlyName(target.name),
            })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="font-mono text-[10px] text-foreground-subtle">{target.name}</p>
          {target.description.length > 0 && (
            <p className="text-xs text-foreground">{target.description}</p>
          )}
          <div className="space-y-1.5">
            <span className="text-[10px] text-foreground-subtle">
              {t('addons.installDialog.version', 'Version')}
            </span>
            <Select
              aria-label={t('addons.installDialog.version', 'Version')}
              value={selectedVersion}
              options={rows.map((entry) => ({
                value: entry.version,
                label: isDeprecatedVersion(entry)
                  ? t('addons.installDialog.deprecatedVersion', '{{version}} (deprecated)', {
                      version: entry.version,
                    })
                  : entry.version,
              }))}
              onChange={(event) => setSelectedVersion(event.target.value)}
            />
            {versionsQuery.isError && (
              <p className="text-[10px] text-danger">
                {t(
                  'addons.versionPicker.registryError',
                  'Could not load versions from the registry.',
                )}
              </p>
            )}
            {hidden > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto justify-start px-0 text-[10px] font-normal text-foreground-subtle underline"
                onClick={() => setShowOlder((current) => !current)}
              >
                {showOlder
                  ? t('addons.versionPicker.hideOlder', 'Hide older versions')
                  : t('addons.versionPicker.showOlder', 'Show older versions ({{count}})', {
                      count: hidden,
                    })}
              </Button>
            )}
          </div>
          <Tabs defaultValue="readme">
            <TabsList>
              <TabsTrigger value="readme">{t('addons.installDialog.readme', 'README')}</TabsTrigger>
              <TabsTrigger value="changelog">
                {t('addons.installDialog.changelog', 'CHANGELOG')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="readme">
              <div className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3">
                <DocBody
                  pending={docsQuery.isPending}
                  failed={docsQuery.isError}
                  body={docs?.readme}
                  missing={t('addons.installDialog.missingReadme', 'This package has no README.')}
                />
              </div>
            </TabsContent>
            <TabsContent value="changelog">
              <div className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3">
                <DocBody
                  pending={docsQuery.isPending}
                  failed={docsQuery.isError}
                  body={docs?.changelog}
                  missing={t(
                    'addons.installDialog.missingChangelog',
                    'This package has no CHANGELOG.',
                  )}
                />
              </div>
            </TabsContent>
          </Tabs>
          {installError != null && installError.length > 0 && (
            <p className="text-xs text-danger">{installError}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={installing || selectedVersion.length === 0}
            onClick={() => onInstall(target.name, selectedVersion)}
          >
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t('addons.installDialog.install', 'Install')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
