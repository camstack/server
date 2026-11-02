/**
 * "Keyboard shortcuts": the bindings currently registered with the hotkey
 * provider, read-only. There is no rebinding store — the list shows what the
 * app listens for, so the operator can find a shortcut, not change one.
 */
import type { ReactElement } from 'react'
import { Keyboard } from 'lucide-react'
import {
  EmptyState,
  SectionCard,
  SettingRow,
  detectPlatform,
  parseCombo,
  useRegisteredHotkeys,
  type HotkeyCombo,
  type HotkeyPlatform,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

const KEY_LABELS: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
}

/** `mod+shift+k` -> `⌘⇧K` on a Mac, `Ctrl+Shift+K` elsewhere. */
export function formatCombo(combo: HotkeyCombo, platform: HotkeyPlatform): string {
  const parsed = parseCombo(combo)
  const key = KEY_LABELS[parsed.key] ?? parsed.key.toUpperCase()
  if (platform === 'mac') {
    return `${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.mod ? '⌘' : ''}${key}`
  }
  const parts = [
    ...(parsed.mod ? ['Ctrl'] : []),
    ...(parsed.alt ? ['Alt'] : []),
    ...(parsed.shift ? ['Shift'] : []),
    key,
  ]
  return parts.join('+')
}

export function HotkeysCard(): ReactElement {
  const { t } = useTranslation()
  const hotkeys = useRegisteredHotkeys()
  const platform = detectPlatform()
  return (
    <SectionCard
      headingId="settings-hotkeys"
      title={t('systemPage.settings.hotkeys.title', 'Keyboard shortcuts')}
      icon={Keyboard}
      testId="settings-hotkeys"
    >
      <div className="space-y-2 p-3">
        <p className="text-xs text-foreground-subtle">
          {t(
            'systemPage.settings.hotkeys.description',
            'The shortcuts active on this page. They cannot be changed.',
          )}
        </p>
        {hotkeys.length === 0 ? (
          <EmptyState
            title={t('systemPage.settings.hotkeys.empty', 'No shortcuts are active on this page.')}
          />
        ) : (
          hotkeys.map((h) => (
            <SettingRow
              key={`${h.scope}|${h.combo}`}
              label={h.label ?? t('systemPage.settings.hotkeys.unnamed', 'Shortcut')}
            >
              <kbd className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-foreground">
                {formatCombo(h.combo, platform)}
              </kbd>
            </SettingRow>
          ))
        )}
      </div>
    </SectionCard>
  )
}
