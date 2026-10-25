import { useState } from 'react'
import { StatusBadge } from '@camstack/ui-library'
import { CapabilityBadges } from '../components/shared/CapabilityBadges'
import { ProviderIcon } from '../components/shared/ProviderIcon'
import { FormBuilder } from '../components/form-builder/FormBuilder'
import type { ConfigUISchema } from '../types/config-ui'

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function ColorSwatch({ name, cssVar, hex }: { name: string; cssVar?: string; hex?: string }) {
  const bg = cssVar ? `var(${cssVar})` : hex
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="h-10 w-10 rounded-lg border border-border shadow-inner"
        style={{ backgroundColor: bg }}
      />
      <span className="text-[10px] text-foreground-subtle text-center leading-tight">{name}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Demo FormBuilder schema
// ---------------------------------------------------------------------------

const DEMO_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'demo',
      title: 'Demo Fields',
      columns: 2,
      fields: [
        { key: 'name', type: 'text', label: 'Name', placeholder: 'Enter name' },
        { key: 'count', type: 'number', label: 'Count', min: 0, max: 100, unit: 'items' },
        { key: 'enabled', type: 'boolean', label: 'Enabled' },
        {
          key: 'mode',
          type: 'select',
          label: 'Mode',
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        },
        {
          key: 'tags',
          type: 'tags',
          label: 'Tags',
          span: 2,
          suggestions: ['camera', 'zone', 'alert'],
        },
        {
          key: 'confidence',
          type: 'slider',
          label: 'Confidence',
          min: 0,
          max: 100,
          step: 5,
          unit: '%',
          span: 2,
        },
        {
          key: 'info',
          type: 'info',
          label: 'Note',
          content: 'This is an informational message for the user.',
          variant: 'info',
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ShowroomPage() {
  const [formValues, setFormValues] = useState<Record<string, unknown>>({
    name: 'Example',
    count: 10,
    enabled: true,
    mode: 'a',
    tags: ['camera'],
    confidence: 60,
  })

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-foreground">Component Showroom</h1>
        <p className="text-sm text-foreground-subtle mt-1">All UI components at a glance</p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 1. Typography */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Typography">
        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-foreground">Heading 1 — Display title</h1>
          <h2 className="text-xl font-semibold text-foreground">Heading 2 — Section title</h2>
          <h3 className="text-base font-semibold text-foreground">Heading 3 — Card title</h3>
          <h4 className="text-sm font-semibold text-foreground">Heading 4 — Sub-section</h4>
          <p className="text-sm text-foreground">
            Body text — Regular paragraph content goes here. It uses the foreground color.
          </p>
          <p className="text-sm text-foreground-subtle">
            Subtle text — Secondary/descriptive text with reduced emphasis.
          </p>
          <p className="text-xs text-foreground-subtle uppercase tracking-wider font-semibold">
            Label / Caption
          </p>
          <p className="text-xs text-foreground-disabled">Disabled / placeholder text</p>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 2. Colors */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Colors">
        <div className="flex flex-wrap gap-4">
          <ColorSwatch name="primary" cssVar="--color-primary" />
          <ColorSwatch name="background" cssVar="--color-background" />
          <ColorSwatch name="surface" cssVar="--color-surface" />
          <ColorSwatch name="foreground" cssVar="--color-foreground" />
          <ColorSwatch name="success" cssVar="--color-success" />
          <ColorSwatch name="warning" cssVar="--color-warning" />
          <ColorSwatch name="danger" cssVar="--color-danger" />
          <ColorSwatch name="info" cssVar="--color-info" />
          <ColorSwatch name="border" cssVar="--color-border" />
          <div className="w-px" />
          <ColorSwatch name="onvif" hex="#3b82f6" />
          <ColorSwatch name="hikvision" hex="#a855f7" />
          <ColorSwatch name="reolink" hex="#06b6d4" />
          <ColorSwatch name="ha" hex="#22d3ee" />
          <ColorSwatch name="rtsp" hex="#78716c" />
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 3. Buttons */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Buttons">
        <div className="flex flex-wrap gap-3">
          <button className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity">
            Primary
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-hover transition-colors">
            Secondary
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/20 transition-colors">
            Danger
          </button>
          <button
            disabled
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white opacity-40 cursor-not-allowed"
          >
            Disabled
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm font-medium text-warning hover:bg-warning/20 transition-colors">
            Warning
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-4 py-2 text-sm font-medium text-success hover:bg-success/20 transition-colors">
            Success
          </button>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 4. Inputs */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Inputs">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Text input</label>
            <input
              type="text"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              placeholder="Type something..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Number input</label>
            <input
              type="number"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              placeholder="0"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Password input</label>
            <input
              type="password"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Select</label>
            <select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/30">
              <option>Option A</option>
              <option>Option B</option>
              <option>Option C</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-foreground mb-1">Textarea</label>
            <textarea
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 resize-y min-h-[60px]"
              placeholder="Enter multi-line text..."
              rows={3}
            />
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-border accent-primary"
                defaultChecked
              />
              <span className="text-xs font-medium text-foreground">Checkbox (checked)</span>
            </label>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">Toggle switch</span>
              <ToggleDemo />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Slider</label>
            <input
              type="range"
              className="w-full h-1 accent-primary cursor-pointer"
              min={0}
              max={100}
              defaultValue={60}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Tags example</label>
            <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 min-h-[38px]">
              {['camera', 'zone', 'alert'].map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 5. Badges */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Badges">
        <div className="space-y-3">
          <div>
            <p className="text-xs text-foreground-subtle mb-2">StatusBadge</p>
            <div className="flex flex-wrap gap-2">
              {(['running', 'stopped', 'error', 'online', 'offline', 'idle'] as const).map((s) => (
                <StatusBadge key={s} status={s} />
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-foreground-subtle mb-2">CapabilityBadges</p>
            <CapabilityBadges capabilities={['streaming', 'detection', 'recording', 'audio']} />
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 6. Cards */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Cards">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg bg-surface p-4">
            <h3 className="text-sm font-semibold text-foreground mb-1">Surface card</h3>
            <p className="text-xs text-foreground-subtle">
              Uses `bg-surface`. Default card background.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-foreground mb-1">Bordered card</h3>
            <p className="text-xs text-foreground-subtle">
              Uses `border border-border bg-surface`.
            </p>
          </div>
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
            <h3 className="text-sm font-semibold text-primary mb-1">Accent card</h3>
            <p className="text-xs text-foreground-subtle">Highlighted with primary color.</p>
          </div>
          <div className="rounded-lg bg-background p-4">
            <h3 className="text-sm font-semibold text-foreground mb-1">Background card</h3>
            <p className="text-xs text-foreground-subtle">Uses `bg-background`. Inset card.</p>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 7. Provider Icons */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Provider Icons">
        <div className="flex flex-wrap gap-4">
          {(['onvif', 'hikvision', 'reolink', 'homeassistant', 'rtsp', 'onvif'] as const).map(
            (p) => (
              <ProviderIcon key={p} type={p} size="lg" showLabel />
            ),
          )}
        </div>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 8. Form Builder Demo */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Form Builder Demo">
        <FormBuilder schema={DEMO_SCHEMA} values={formValues} onChange={setFormValues} />
        <details className="mt-3">
          <summary className="text-[10px] text-foreground-subtle cursor-pointer hover:text-foreground">
            View current values
          </summary>
          <pre className="mt-2 rounded-md bg-background p-3 text-[10px] text-foreground-subtle overflow-auto">
            {JSON.stringify(formValues, null, 2)}
          </pre>
        </details>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* 9. Info Boxes */}
      {/* ------------------------------------------------------------------ */}
      <Section title="Info Boxes">
        <div className="space-y-2">
          {(
            [
              {
                variant: 'info',
                label: 'Info',
                content: 'This is an informational message. Use it for tips and hints.',
              },
              {
                variant: 'warning',
                label: 'Warning',
                content: 'This action may have side effects. Proceed with caution.',
              },
              {
                variant: 'success',
                label: 'Success',
                content: 'Operation completed successfully. All systems are green.',
              },
              {
                variant: 'danger',
                label: 'Danger',
                content: 'This operation is irreversible. Data will be permanently deleted.',
              },
            ] as const
          ).map(({ variant, label, content }) => {
            const STYLES = {
              info: { border: 'border-info', bg: 'bg-info/5', text: 'text-info' },
              warning: { border: 'border-warning', bg: 'bg-warning/5', text: 'text-warning' },
              success: { border: 'border-success', bg: 'bg-success/5', text: 'text-success' },
              danger: { border: 'border-danger', bg: 'bg-danger/5', text: 'text-danger' },
            }
            const s = STYLES[variant]
            return (
              <div
                key={variant}
                className={`rounded-md border-l-4 px-3 py-2.5 ${s.border} ${s.bg}`}
              >
                <p className={`text-xs font-semibold mb-0.5 ${s.text}`}>{label}</p>
                <p className="text-xs text-foreground-subtle leading-relaxed">{content}</p>
              </div>
            )
          })}
        </div>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Local ToggleDemo to avoid hook extraction issues
// ---------------------------------------------------------------------------

function ToggleDemo() {
  const [on, setOn] = useState(true)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setOn((v) => !v)}
      className={[
        'relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors duration-150 cursor-pointer',
        on ? 'bg-primary' : 'bg-foreground-subtle/30',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-150',
          on ? 'translate-x-4' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}
