/**
 * NavigationPanel — the `navigation` cap's own panel (`host/navigation-panel`):
 * a drive pad, the data-driven action and sound buttons, the fill light.
 *
 * Nothing here knows a vendor: the buttons come from `listActions()` (enabled
 * entries only, icons mapped from the entry's lucide hint), the primitives
 * from `getFeatures()`, and the live chips from the `navigation` slice. Hold
 * a drive button to move — the hook nudges at 1 Hz and stops on release, like
 * the robot app's joystick. The manual level slider appears only in manual
 * mode, as the cap's own contract asks.
 */
import { type ComponentType, type JSX } from 'react'
import {
  ArrowUp,
  Bell,
  Cat,
  Clock,
  Crosshair,
  Dog,
  Droplets,
  Flashlight,
  FlashlightOff,
  Footprints,
  Hand,
  Home,
  type LucideProps,
  Navigation,
  Pause,
  PawPrint,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { NavigationActionEntry, NavigationActionId } from '@camstack/types'
import { NAVIGATION_LIGHT_LEVEL_MAX, NAVIGATION_LIGHT_LEVEL_MIN } from '@camstack/types'
import { useSystem } from '../../contexts/system-context'
import { useUiText } from '../../contexts/ui-text'
import { type NavigationDirection, useNavigation } from '../../hooks/use-navigation'
import { cn } from '../../lib/cn'
import { WidgetPanel } from '../widget-panel'
import type { CapSettingsComponentProps } from './index'

type Icon = ComponentType<LucideProps>

/** The cap's icon HINTS are lucide names; unknown hints fall back to a spark. */
const ICONS: Readonly<Record<string, Icon>> = {
  play: Play,
  pause: Pause,
  hand: Hand,
  home: Home,
  bell: Bell,
  crosshair: Crosshair,
  'paw-print': PawPrint,
  footprints: Footprints,
  droplets: Droplets,
  'trash-2': Trash2,
  flashlight: Flashlight,
  'flashlight-off': FlashlightOff,
  cat: Cat,
  dog: Dog,
  clock: Clock,
}

function iconFor(hint: string): Icon {
  return ICONS[hint] ?? Sparkles
}

interface DriveButtonSpec {
  readonly direction: NavigationDirection
  readonly labelKey: string
  readonly labelFallback: string
  readonly Icon: Icon
}

const DRIVE_BUTTONS: readonly DriveButtonSpec[] = [
  {
    direction: 'left',
    labelKey: 'uiLibrary.navigationPanel.turnLeft',
    labelFallback: 'Turn left',
    Icon: RotateCcw,
  },
  {
    direction: 'forward',
    labelKey: 'uiLibrary.navigationPanel.forward',
    labelFallback: 'Forward',
    Icon: ArrowUp,
  },
  {
    direction: 'right',
    labelKey: 'uiLibrary.navigationPanel.turnRight',
    labelFallback: 'Turn right',
    Icon: RotateCw,
  },
  {
    direction: 'spin',
    labelKey: 'uiLibrary.navigationPanel.turnAround',
    labelFallback: 'Turn around',
    Icon: Undo2,
  },
]

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-colors bg-surface-elevated/40 text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50'
const BUTTON_ON = 'bg-success/15 text-success hover:bg-success/25'

interface EntryButtonProps {
  readonly entry: NavigationActionEntry
  readonly disabled: boolean
  readonly onRun: (entry: NavigationActionEntry) => void
}

function EntryButton({ entry, disabled, onRun }: EntryButtonProps) {
  const Glyph = iconFor(entry.icon)
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={disabled}
      onClick={() => onRun(entry)}
      title={entry.label}
      aria-label={entry.label}
    >
      <Glyph className="h-3.5 w-3.5" />
      <span>{entry.label}</span>
    </button>
  )
}

export function NavigationPanel({ deviceId }: CapSettingsComponentProps): JSX.Element {
  const t = useUiText()
  const system = useSystem()
  const ready = Number.isFinite(deviceId)
  const nav = useNavigation(system.trpcClient, ready ? deviceId : 0, { enabled: ready })

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('uiLibrary.navigationPanel.notLoaded', 'Device #{{deviceId}} not loaded.', { deviceId })}
      </div>
    )
  }

  const features = nav.features
  const actions = nav.actions.filter((entry) => entry.enabled && entry.kind === 'action')
  const sounds = nav.actions.filter((entry) => entry.enabled && entry.kind === 'sound')
  const status = nav.status
  const manual = status?.lightMode === 'manual'

  const run = (entry: NavigationActionEntry): void => {
    if (entry.kind === 'sound') {
      if (entry.soundId !== undefined) void nav.playSound(entry.soundId)
      return
    }
    // The catalog's action ids ARE the cap's closed vocabulary; a stray id
    // would be rejected by the provider, never guessed at.
    void nav.runAction(entry.id as NavigationActionId)
  }

  return (
    <WidgetPanel
      title={t('uiLibrary.navigationPanel.title', 'Navigation')}
      icon={<Navigation className="h-3.5 w-3.5 text-foreground-subtle" />}
      bodyClassName="p-3 flex flex-col gap-3 overflow-y-auto"
    >
      {status && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="rounded-full bg-surface-elevated/60 px-2 py-0.5 text-foreground">
            {status.mode}
          </span>
          {status.following && (
            <span className="rounded-full bg-info/15 px-2 py-0.5 text-info">
              {t('uiLibrary.navigationPanel.following', 'following')}
            </span>
          )}
          {status.flash && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
              {t('uiLibrary.navigationPanel.lightOn', 'light on')}
            </span>
          )}
        </div>
      )}

      {features?.move && (
        <section className="flex flex-col gap-1.5">
          <span className="text-[10.5px] font-semibold text-foreground">
            {t('uiLibrary.navigationPanel.driveHold', 'Drive (hold)')}
          </span>
          <div className="grid grid-cols-4 gap-1.5">
            {DRIVE_BUTTONS.map(({ direction, labelKey, labelFallback, Icon }) => (
              <button
                key={direction}
                type="button"
                className={cn(
                  BUTTON,
                  'justify-center select-none',
                  nav.driving === direction && BUTTON_ON,
                )}
                aria-label={t(labelKey, labelFallback)}
                title={t(labelKey, labelFallback)}
                onPointerDown={() => nav.startDrive(direction)}
                onPointerUp={() => void nav.stopDrive()}
                onPointerLeave={() => {
                  if (nav.driving === direction) void nav.stopDrive()
                }}
                onPointerCancel={() => void nav.stopDrive()}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          {features.stop && (
            <button
              type="button"
              className={cn(BUTTON, 'justify-center')}
              onClick={() => void nav.stopDrive()}
            >
              <Hand className="h-3.5 w-3.5" />
              <span>{t('uiLibrary.navigationPanel.stop', 'Stop')}</span>
            </button>
          )}
        </section>
      )}

      {features?.runAction && actions.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <span className="text-[10.5px] font-semibold text-foreground">
            {t('uiLibrary.navigationPanel.actions', 'Actions')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {actions.map((entry) => (
              <EntryButton key={entry.id} entry={entry} disabled={nav.busy} onRun={run} />
            ))}
          </div>
        </section>
      )}

      {features?.playSound && sounds.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <span className="text-[10.5px] font-semibold text-foreground">
            {t('uiLibrary.navigationPanel.sounds', 'Sounds')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {sounds.map((entry) => (
              <EntryButton key={entry.id} entry={entry} disabled={nav.busy} onRun={run} />
            ))}
          </div>
        </section>
      )}

      {features?.light && (
        <section className="flex flex-col gap-1.5 border-t border-border/40 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] font-semibold text-foreground">
              {t('uiLibrary.navigationPanel.fillLight', 'Fill light')}
            </span>
            <button
              type="button"
              className={cn(BUTTON, status?.flash && BUTTON_ON)}
              aria-pressed={status?.flash === true}
              disabled={nav.busy}
              onClick={() => void nav.setLightOn(!(status?.flash === true))}
            >
              {status?.flash ? (
                <Flashlight className="h-3.5 w-3.5" />
              ) : (
                <FlashlightOff className="h-3.5 w-3.5" />
              )}
              {status?.flash
                ? t('uiLibrary.navigationPanel.on', 'On')
                : t('uiLibrary.navigationPanel.off', 'Off')}
            </button>
          </div>
          {features.lightMode && (
            <div className="flex items-center gap-2">
              <select
                aria-label={t('uiLibrary.navigationPanel.lightMode', 'Light mode')}
                className="rounded-md bg-surface-elevated/40 px-2 py-1 text-[10px] text-foreground"
                value={status?.lightMode ?? 'auto'}
                disabled={nav.busy}
                onChange={(event) => {
                  const mode = event.target.value === 'manual' ? 'manual' : 'auto'
                  void nav.setLightMode(mode, mode === 'manual' ? status?.lightLevel : undefined)
                }}
              >
                <option value="auto">{t('uiLibrary.navigationPanel.auto', 'Auto')}</option>
                <option value="manual">{t('uiLibrary.navigationPanel.manual', 'Manual')}</option>
              </select>
              {manual && (
                <input
                  type="range"
                  aria-label={t('uiLibrary.navigationPanel.lightLevel', 'Light level')}
                  className="flex-1"
                  min={NAVIGATION_LIGHT_LEVEL_MIN}
                  max={NAVIGATION_LIGHT_LEVEL_MAX}
                  step={1}
                  value={status?.lightLevel ?? NAVIGATION_LIGHT_LEVEL_MAX}
                  disabled={nav.busy}
                  onChange={(event) => void nav.setLightLevel(Number(event.target.value))}
                />
              )}
              {manual && (
                <span className="text-[10px] text-foreground-subtle w-8 text-right">
                  {status?.lightLevel ?? NAVIGATION_LIGHT_LEVEL_MAX}
                </span>
              )}
            </div>
          )}
        </section>
      )}

      {nav.error && <div className="text-[10px] text-danger">{nav.error}</div>}
    </WidgetPanel>
  )
}
