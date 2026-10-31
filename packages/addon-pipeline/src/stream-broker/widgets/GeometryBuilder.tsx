import * as React from 'react'
import { useState } from 'react'
import { useT } from '../../i18n/index.js'
import { Button, Checkbox, Input, Select } from '@camstack/ui-library'

/**
 * Pure-UI geometry/zoom helper for the derived-stream transform editor.
 *
 * Composes ffmpeg `-vf` geometry filters (aspect correction, crop/zoom,
 * scale, rotate/flip) and writes them as a single `-vf` entry into the
 * existing `outputArgs`. There is NO new persisted data model — the only
 * output is `outputArgs` strings, upserted in place.
 */

export type TargetAspect = '16:9' | '4:3' | '1:1'
export type GeometryMode = 'crop' | 'pad'
export type RotateAngle = 0 | 90 | 180 | 270

export interface CropRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface GeometryOpts {
  targetAspect?: TargetAspect
  mode?: GeometryMode
  width?: number
  height?: number
  crop?: CropRect
  rotate?: RotateAngle
  hflip?: boolean
  vflip?: boolean
}

/**
 * Compose the `-vf` filter chain from the geometry options. Pure function.
 *
 * Ordering: crop/zoom first (operate on the source frame), then
 * aspect-correcting scale+pad/crop+setdar, then rotate/flip. `rotate: 180`
 * is expressed as `hflip,vflip`; the standalone hflip/vflip guards skip
 * re-emitting those when 180 already covers them.
 */
export function composeVfFilter(opts: GeometryOpts): string {
  const parts: string[] = []
  if (opts.crop) parts.push(`crop=${opts.crop.w}:${opts.crop.h}:${opts.crop.x}:${opts.crop.y}`)
  if (opts.targetAspect && opts.width !== undefined && opts.height !== undefined) {
    const dar = opts.targetAspect.replace(':', '/')
    if (opts.mode === 'pad') {
      parts.push(`scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease`)
      parts.push(`pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2`)
    } else {
      parts.push(`scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase`)
      parts.push(`crop=${opts.width}:${opts.height}`)
    }
    parts.push(`setdar=${dar}`)
  }
  if (opts.rotate === 90) parts.push('transpose=1')
  else if (opts.rotate === 270) parts.push('transpose=2')
  else if (opts.rotate === 180) parts.push('hflip', 'vflip')
  if (opts.hflip && opts.rotate !== 180) parts.push('hflip')
  if (opts.vflip && opts.rotate !== 180) parts.push('vflip')
  return parts.join(',')
}

/**
 * Upsert a `-vf <chain>` pair into an existing outputArgs array: any prior
 * `-vf` (and its value) is removed first, then the new chain is appended.
 * An empty chain removes the `-vf` pair entirely. Other args are preserved
 * in order. Pure function.
 */
export function upsertVfInOutputArgs(args: readonly string[], chain: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-vf') {
      i++ // drop the flag and skip its value
      continue
    }
    const arg = args[i]
    if (arg !== undefined) out.push(arg)
  }
  if (chain.length > 0) out.push('-vf', chain)
  return out
}

// ── Tailwind primitives matching FfmpegParamsField conventions ──────────
const inputCls =
  'rounded border border-border bg-surface-2 px-2 py-1 text-xs text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed'
const selectCls = inputCls + ' appearance-none pr-6'
const labelTextCls = 'text-[11px] uppercase tracking-wider text-foreground-subtle font-medium'

export interface GeometryBuilderProps {
  readonly outputArgs: readonly string[]
  readonly onChange: (next: string[]) => void
}

/**
 * Presentational geometry-builder control. Reads/writes only via props —
 * it persists nothing of its own. The "Apply geometry" button composes the
 * current local state into a `-vf` chain and upserts it into `outputArgs`.
 */
export function GeometryBuilder({
  outputArgs,
  onChange,
}: GeometryBuilderProps): React.ReactElement {
  const { t } = useT()
  const [targetAspect, setTargetAspect] = useState<TargetAspect | ''>('')
  const [mode, setMode] = useState<GeometryMode>('pad')
  const [width, setWidth] = useState<string>('1920')
  const [height, setHeight] = useState<string>('1080')
  const [cropOn, setCropOn] = useState(false)
  const [cropX, setCropX] = useState<string>('0')
  const [cropY, setCropY] = useState<string>('0')
  const [cropW, setCropW] = useState<string>('0')
  const [cropH, setCropH] = useState<string>('0')
  const [rotate, setRotate] = useState<RotateAngle>(0)
  const [hflip, setHflip] = useState(false)
  const [vflip, setVflip] = useState(false)

  const buildOpts = (): GeometryOpts => {
    const opts: GeometryOpts = { rotate, hflip, vflip }
    if (targetAspect !== '') {
      opts.targetAspect = targetAspect
      opts.mode = mode
      opts.width = Number(width)
      opts.height = Number(height)
    }
    if (cropOn) {
      opts.crop = { x: Number(cropX), y: Number(cropY), w: Number(cropW), h: Number(cropH) }
    }
    return opts
  }

  const preview = composeVfFilter(buildOpts())
  const apply = (): void => onChange(upsertVfInOutputArgs(outputArgs, preview))

  return (
    <div className="space-y-2 rounded border border-border/50 bg-surface-2/30 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className={labelTextCls}>
          {t('geometry.title')}
          <span className="ml-2 text-[10px] normal-case text-foreground-subtle italic">
            {t('geometry.hint')}
          </span>
        </span>
        <Button
          variant="unstyled"
          type="button"
          onClick={apply}
          className="rounded-md border border-border bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-surface-hover/70 transition-colors"
        >
          {t('geometry.apply')}
        </Button>
      </div>

      {/* Aspect correction */}
      <div className="flex flex-wrap items-center gap-2">
        <label className={labelTextCls} htmlFor="geom-aspect">
          {t('geometry.aspect')}
        </label>
        <Select
          wrapperClassName="inline-block w-auto"
          id="geom-aspect"
          value={targetAspect}
          onChange={(e) => setTargetAspect(e.target.value as TargetAspect | '')}
          className={selectCls + ' min-w-[90px]'}
        >
          <option value="">{t('geometry.none')}</option>
          <option value="16:9">16:9</option>
          <option value="4:3">4:3</option>
          <option value="1:1">1:1</option>
        </Select>
        {targetAspect !== '' && (
          <>
            <Select
              wrapperClassName="inline-block w-auto"
              aria-label={t('geometry.aspectMode')}
              value={mode}
              onChange={(e) => setMode(e.target.value as GeometryMode)}
              className={selectCls + ' min-w-[80px]'}
            >
              <option value="pad">{t('geometry.pad')}</option>
              <option value="crop">{t('geometry.crop')}</option>
            </Select>
            <Input
              type="number"
              aria-label={t('geometry.aspectWidth')}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              className={inputCls + ' w-20 text-right'}
            />
            <span className="text-[11px] text-foreground-subtle">×</span>
            <Input
              type="number"
              aria-label={t('geometry.aspectHeight')}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              className={inputCls + ' w-20 text-right'}
            />
          </>
        )}
      </div>

      {/* Crop / zoom rectangle */}
      <div className="flex flex-wrap items-center gap-2">
        <label className={labelTextCls + ' inline-flex items-center gap-1'}>
          <Checkbox checked={cropOn} onChange={(e) => setCropOn(e.target.checked)} />
          {t('geometry.cropZoom')}
        </label>
        {cropOn && (
          <>
            <Input
              type="number"
              aria-label={t('geometry.cropX')}
              value={cropX}
              onChange={(e) => setCropX(e.target.value)}
              className={inputCls + ' w-16 text-right'}
              placeholder="x"
            />
            <Input
              type="number"
              aria-label={t('geometry.cropY')}
              value={cropY}
              onChange={(e) => setCropY(e.target.value)}
              className={inputCls + ' w-16 text-right'}
              placeholder="y"
            />
            <Input
              type="number"
              aria-label={t('geometry.cropWidth')}
              value={cropW}
              onChange={(e) => setCropW(e.target.value)}
              className={inputCls + ' w-20 text-right'}
              placeholder="w"
            />
            <Input
              type="number"
              aria-label={t('geometry.cropHeight')}
              value={cropH}
              onChange={(e) => setCropH(e.target.value)}
              className={inputCls + ' w-20 text-right'}
              placeholder="h"
            />
          </>
        )}
      </div>

      {/* Rotate / flip */}
      <div className="flex flex-wrap items-center gap-2">
        <label className={labelTextCls} htmlFor="geom-rotate">
          {t('geometry.rotate')}
        </label>
        <Select
          wrapperClassName="inline-block w-auto"
          id="geom-rotate"
          value={String(rotate)}
          onChange={(e) => setRotate(Number(e.target.value) as RotateAngle)}
          className={selectCls + ' min-w-[80px]'}
        >
          <option value="0">0°</option>
          <option value="90">90°</option>
          <option value="180">180°</option>
          <option value="270">270°</option>
        </Select>
        <label className={labelTextCls + ' inline-flex items-center gap-1'}>
          <Checkbox checked={hflip} onChange={(e) => setHflip(e.target.checked)} />
          hflip
        </label>
        <label className={labelTextCls + ' inline-flex items-center gap-1'}>
          <Checkbox checked={vflip} onChange={(e) => setVflip(e.target.checked)} />
          vflip
        </label>
      </div>

      <div className="font-mono text-[10px] text-foreground-subtle break-all">
        -vf {preview.length > 0 ? preview : <span className="italic">{t('geometry.empty')}</span>}
      </div>
    </div>
  )
}
