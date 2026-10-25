import { useState, useRef, useEffect, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSystem } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReplScope =
  | { type: 'system' }
  | { type: 'device'; deviceId: number }
  | { type: 'provider'; providerId: string }
  | { type: 'addon'; addonId: string }

interface TerminalLine {
  id: number
  kind: 'input' | 'result' | 'error' | 'info'
  text: string
}

export interface ReplTerminalProps {
  scope: ReplScope
  /** Greeting shown as first line */
  greeting?: string
  className?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let lineCounter = 0
function nextId() {
  return ++lineCounter
}

function scopeLabel(scope: ReplScope): string {
  switch (scope.type) {
    case 'system':
      return 'system'
    case 'device':
      return `#${scope.deviceId}`
    case 'provider':
      return scope.providerId
    case 'addon':
      return scope.addonId
  }
}

function helpLines(scope: ReplScope): string[] {
  const exampleByScope: Record<ReplScope['type'], string> = {
    system: '  sm.summary()                                          // fleet overview',
    device: '  device.state.battery.value?.sleeping                  // sync read',
    provider: '  devices.map(d => d.name)',
    addon: '  manifest.version',
  }
  const lines: string[] = [
    '',
    'Commands',
    '  help          Show this help',
    '  examples      Show usage examples for the current scope',
    '  context       Show every available variable + full API surface',
    '  clear         Clear terminal (also Ctrl+L)',
    '',
    'Shortcuts',
    '  Enter         Execute expression',
    '  Arrow Up/Down Navigate command history',
    '  Ctrl+L        Clear terminal',
    '',
    `Try: ${exampleByScope[scope.type]}`,
    '',
    'Top-level objects: sm (SystemMirror), DeviceType, Math, JSON, Date, …',
  ]
  return lines
}

/**
 * Curated, copy-pasteable examples per scope. Shorter than the full
 * `context` dump — designed to be the first thing you see.
 */
function examplesLines(scope: ReplScope): string[] {
  switch (scope.type) {
    case 'device':
      return [
        '',
        '── State (sync, zero round-trip) ─────────────────────────',
        '  device.state.battery.value',
        '  device.state.battery.value?.percentage',
        '  device.state.motion.value?.detected',
        '',
        '── Actions (async, through wrapper chain) ────────────────',
        '  await device.snapshot.getSnapshot({})',
        "  await device.ptz.move({ direction: 'left', steps: 1 })",
        '  await device.switch.setState({ on: true })',
        '',
        '── Wait for condition ───────────────────────────────────',
        "  await sm.waitForState(deviceId, 'battery', s => !s.sleeping, 30_000)",
        '',
        '── Subscribe to changes ─────────────────────────────────',
        '  const off = device.state.battery.subscribe(s => console.log(s))',
        '',
        '── Quick info ───────────────────────────────────────────',
        '  info.name             device name',
        '  info.addonId          owning addon',
        '  sm.dump(deviceId)     full debug dump',
      ]
    case 'system':
      return [
        '',
        '── Lookups ──────────────────────────────────────────────',
        '  sm.getDeviceById(8)',
        "  sm.getDeviceByName('Sala da pranzo')",
        "  sm.getDevicesByAddon('reolink')",
        '  sm.getDevicesByType(DeviceType.Camera)',
        '',
        '── Filters (typed query) ────────────────────────────────',
        "  sm.query({ addonId: 'reolink', online: true })",
        "  sm.query({ caps: ['battery', 'snapshot'] })",
        '  sm.query({ name: /^Cam-/ })',
        '',
        '── Cross-device ─────────────────────────────────────────',
        "  sm.whereState('battery', s => s.percentage < 20).length",
        "  sm.mapState('battery', s => s.percentage)",
        "  sm.countByCap('snapshot')",
        '',
        '── Batch action ─────────────────────────────────────────',
        "  await sm.invokeCap('snapshot', 'getSnapshot', {}, { parallelism: 4 })",
        '',
        '── Listen ───────────────────────────────────────────────',
        "  sm.listenCap('motion', (id, s) => console.log(id, s))",
        "  sm.onDeviceAdded((id, info) => console.log('+', info.name))",
        '',
        '── Diagnostics ──────────────────────────────────────────',
        '  sm.summary()',
        '  sm.dump(8)',
      ]
    case 'provider':
      return [
        '',
        '  devices.map(d => d.name)',
        '  await getIntegration()',
        "  sm.getDevicesByAddon('<this-addon-id>').length",
      ]
    case 'addon':
      return ['', '  manifest.name', '  manifest.version', '  declaration']
  }
}

function contextLines(scope: ReplScope): string[] {
  const common = ['', `Scope: ${scope.type}`, '']

  switch (scope.type) {
    case 'system':
      return [
        ...common,
        'Primary API — sm (SystemMirror):',
        '  sm.getDeviceById(id)             DeviceProxy | null   (sync)',
        '  sm.getDeviceByName(name)         DeviceProxy | null',
        '  sm.getDeviceByStableId(sid)      DeviceProxy | null',
        '  sm.getAllDevices()               readonly DeviceProxy[]',
        '  sm.getDeviceInfo(id)             DeviceInfo | null',
        '  sm.summary()                     fleet stats',
        '',
        'Filters — sm.query({...}):',
        "  sm.query({ addonId: 'reolink', online: true })",
        "  sm.query({ caps: ['battery', 'snapshot'] })   // ALL caps required",
        "  sm.query({ anyCap: ['ptz', 'motion'] })        // ANY cap",
        "  sm.query({ name: { contains: 'sala' } })       // case-insensitive",
        '  sm.query({ name: /^Cam-\\d+$/ })',
        '  sm.query({ type: DeviceType.Camera })',
        '  sm.query({ parentDeviceId: 8 })                  // accessories of cam 8',
        '  sm.query({ where: (info, dev) => dev.state.battery.value?.sleeping })',
        '',
        'State queries:',
        "  sm.whereState('battery', s => s.percentage < 20)",
        "  sm.mapState('battery', s => s.percentage)",
        "  sm.findState('motion', s => s.detected)",
        "  sm.countByCap('snapshot')",
        '',
        'Listeners (return unsubscribe fn):',
        '  sm.listen((id, cap, slice) => …)        // every state change',
        "  sm.listenCap('motion', (id, slice) => …)",
        '  sm.listenDevice(8, (id, cap, slice) => …)',
        '  sm.onDeviceAdded((id, info) => …)',
        '  sm.onDeviceRemoved((id, info) => …)',
        '',
        'Wait primitives:',
        "  await sm.waitForState(8, 'battery', s => !s.sleeping, 30_000)",
        '  await sm.waitForDevice(99, 30_000)',
        '',
        'Batch:',
        "  await sm.invokeCap('snapshot', 'getSnapshot', {}, { parallelism: 4 })",
        "  await sm.forEachCap('reboot', d => d.reboot.reboot({}))",
        '',
        'Diagnostics:',
        '  sm.dump(8)             debug dump (one device)',
        '  sm.dump()              full fleet dump',
        '  sm.summary()           breakdown by cap/addon/type',
        '',
        'Legacy: deviceRegistry, addonRegistry, eventBus, devices(), addons()',
      ]
    case 'device':
      return [
        ...common,
        'Pre-bound variables:',
        '  device             DeviceProxy for this device (sync state + async methods)',
        '  deviceId           number',
        '  info               DeviceInfo metadata (name, addonId, type, online, …)',
        '  sm                 SystemMirror (full cluster view)',
        '  rawDevice          legacy IDevice instance (escape hatch)',
        '',
        'Reactive state (sync, zero round-trip):',
        '  device.state.battery.value           BatteryStatus | undefined',
        '  device.state.battery.value?.sleeping',
        '  device.state.battery.value?.percentage',
        '  device.state.motion.value?.detected',
        '  device.state.switch.value?.on',
        '  device.state.brightness.value?.percentage',
        '  device.state.doorbell.value?.lastPressedAt',
        '',
        'Cap actions (async, through wrapper chain):',
        '  await device.snapshot.getSnapshot({})',
        "  await device.snapshot.getSnapshot({ streamId: 'high' })",
        "  await device.ptz.move({ direction: 'left', steps: 1 })",
        "  await device.ptz.goToPreset({ presetId: 'home' })",
        '  await device.switch.setState({ on: true })',
        '  await device.brightness.setBrightness({ percentage: 60 })',
        '  await device.reboot.reboot({})',
        '',
        'Subscribe to slice changes:',
        '  const off = device.state.battery.subscribe(s => console.log(s))',
        '  // off() to unsubscribe',
        '',
        'Wait for a state condition:',
        "  await sm.waitForState(deviceId, 'battery', s => !s.sleeping, 30_000)",
        '',
        'Diagnostics:',
        '  info.name              device name',
        '  info.addonId           which addon owns it',
        '  info.online            transport health',
        '  sm.dump(deviceId)      full debug dump (binding + state + info)',
      ]
    case 'provider':
      return [
        ...common,
        'Pre-bound variables:',
        '  devices            Devices belonging to this provider (raw IDevice[])',
        '  getIntegration()   Integration metadata',
        '',
        'For typed device access use the SystemMirror:',
        '  await getSystemMirror()',
        "  sm.getDevicesByAddon('this-addon-id')",
      ]
    case 'addon':
      return [
        ...common,
        'Pre-bound variables:',
        '  manifest           { name, version, ... }',
        '  declaration        addon declaration',
        '  source             addon source location',
        '',
        'Examples:',
        '  manifest.name',
        '  manifest.version',
      ]
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReplTerminal({ scope, greeting, className }: ReplTerminalProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [lines, setLines] = useState<TerminalLine[]>(() => {
    const initial: TerminalLine[] = []
    if (greeting) {
      initial.push({ id: nextId(), kind: 'info', text: greeting })
    }
    initial.push({
      id: nextId(),
      kind: 'info',
      text: `scope: ${scopeLabel(scope)}  —  type help or context for available commands`,
    })
    return initial
  })
  const [input, setInput] = useState('')
  const [historyStack, setHistoryStack] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Focus input when clicking anywhere in the terminal
  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  const evalMutation = useMutation({
    mutationFn: (code: string) => system.trpcClient.repl.execute.mutate({ code, scope }),
    onSuccess: (data) => {
      // Server returns ReplResult = { output, type, duration }. Only
      // `output` is meaningful for the chat — `type` ('value'/'void'/'error')
      // is already encoded by the line color, `duration` is debug.
      // Strip the wrapper so the user sees just the value, like a chat
      // reply, not a JSON dump of the envelope.
      const result = (data ?? {}) as { output?: unknown; type?: string }
      const raw =
        typeof result.output === 'string'
          ? result.output
          : data == null
            ? 'undefined'
            : typeof data === 'string'
              ? data
              : JSON.stringify(data, null, 2)
      const isError = result.type === 'error'
      setLines((prev) => [...prev, { id: nextId(), kind: isError ? 'error' : 'result', text: raw }])
    },
    onError: (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err)
      setLines((prev) => [...prev, { id: nextId(), kind: 'error', text }])
    },
  })

  function execute(code: string) {
    const trimmed = code.trim()
    if (!trimmed) return

    // Handle built-in commands
    if (trimmed === 'clear') {
      setLines([{ id: nextId(), kind: 'info', text: `scope: ${scopeLabel(scope)}` }])
      setInput('')
      return
    }

    if (trimmed === 'help') {
      setLines((prev) => [
        ...prev,
        { id: nextId(), kind: 'input', text: `> ${trimmed}` },
        ...helpLines(scope).map((text) => ({ id: nextId(), kind: 'info' as const, text })),
      ])
      setInput('')
      return
    }

    if (trimmed === 'context') {
      setLines((prev) => [
        ...prev,
        { id: nextId(), kind: 'input', text: `> ${trimmed}` },
        ...contextLines(scope).map((text) => ({ id: nextId(), kind: 'info' as const, text })),
      ])
      setInput('')
      return
    }

    if (trimmed === 'examples') {
      setLines((prev) => [
        ...prev,
        { id: nextId(), kind: 'input', text: `> ${trimmed}` },
        ...examplesLines(scope).map((text) => ({ id: nextId(), kind: 'info' as const, text })),
      ])
      setInput('')
      return
    }

    // Add to history
    setHistoryStack((prev) => [...prev, trimmed])
    setHistoryIndex(-1)

    // Echo input line
    setLines((prev) => [...prev, { id: nextId(), kind: 'input', text: `> ${trimmed}` }])

    setInput('')
    evalMutation.mutate(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      execute(input)
      return
    }

    // History navigation
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (historyStack.length === 0) return
      const newIndex = historyIndex === -1 ? historyStack.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(newIndex)
      setInput(historyStack[newIndex] ?? '')
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === -1) return
      const newIndex = historyIndex + 1
      if (newIndex >= historyStack.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(newIndex)
        setInput(historyStack[newIndex] ?? '')
      }
      return
    }

    // Ctrl+L = clear
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      setLines([{ id: nextId(), kind: 'info', text: `scope: ${scopeLabel(scope)}` }])
    }
  }

  // Explicit colors against the forced dark background (#0c0a09).
  // The theme's `text-foreground` flips dark in light themes, which
  // would render input as nearly-invisible black-on-black — pin to
  // zinc-100 so the terminal stays readable in any theme.
  const lineColor: Record<TerminalLine['kind'], string> = {
    input: 'text-zinc-300',
    result: 'text-emerald-300',
    error: 'text-red-300',
    info: 'text-zinc-400',
  }

  return (
    <div
      className={`flex flex-col bg-[#0c0a09] rounded-lg border border-border overflow-hidden font-mono text-xs ${className ?? ''}`}
      onClick={focusInput}
    >
      {/* Output area — chat-style: each entry is a single bubble. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1 min-h-[120px]">
        {lines.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap break-words leading-relaxed ${lineColor[line.kind]}`}
          >
            {line.text}
          </pre>
        ))}
        {evalMutation.isPending && (
          <span className="text-zinc-500 animate-pulse">
            {t('shared.replTerminal.thinking', '…thinking')}
          </span>
        )}
      </div>

      {/* Input line */}
      <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2 bg-[#0c0a09]">
        <span className="text-emerald-400 flex-shrink-0 select-none font-bold">
          {t('shared.replTerminal.text', '>')}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={evalMutation.isPending}
          placeholder="device.state.battery.value"
          autoFocus
          className="flex-1 bg-transparent text-zinc-100 placeholder:text-zinc-600 focus:outline-none caret-emerald-400 disabled:opacity-50"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
    </div>
  )
}
