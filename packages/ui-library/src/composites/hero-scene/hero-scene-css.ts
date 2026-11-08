/**
 * Scoped keyframes + helper classes for the hero scenes. transform/opacity
 * only (compositor-cheap), no colour: tint comes from `currentColor`, set by a
 * theme `text-<tone>` class on the backdrop. Positions and delays are
 * nth-child rules so no element carries an inline style.
 * The airflow / fan scenes reuse the `acv-*` keyframes of ac-panel.
 */
export const HERO_SCENE_CSS = `
.hs-fx { --hs-t: 2s; }
.hs-fx.hs-fast { --hs-t: 1s; }
.hs-fx.hs-slow { --hs-t: 3.6s; }
@keyframes hs-fall { 0%{transform:translateY(-130%);opacity:0} 20%,80%{opacity:.7} 100%{transform:translateY(900%);opacity:0} }
@keyframes hs-rise { 0%{transform:translateY(900%);opacity:0} 20%,80%{opacity:.7} 100%{transform:translateY(-130%);opacity:0} }
@keyframes hs-spin { to { transform:rotate(360deg) } }
@keyframes hs-ripple { 0%{transform:scale(.25);opacity:.7} 100%{transform:scale(1.7);opacity:0} }
@keyframes hs-sweep { 0%,100%{transform:translateX(-45%)} 50%{transform:translateX(45%)} }
@keyframes hs-bars { 0%,100%{transform:scaleY(.25)} 50%{transform:scaleY(1)} }
@keyframes hs-breathe { 0%,100%{opacity:.3;transform:scale(1)} 50%{opacity:.6;transform:scale(1.08)} }
@keyframes hs-draw { 0%{stroke-dashoffset:100} 70%,100%{stroke-dashoffset:0} }
@keyframes hs-scroll { 0%{transform:translateY(0)} 100%{transform:translateY(-50%)} }
@keyframes hs-shimmer { 0%,100%{opacity:.35} 50%{opacity:.8} }
.hs-p { position:absolute; top:0; border-radius:9999px; background:currentColor; opacity:0; animation-duration:var(--hs-t); animation-iteration-count:infinite; animation-timing-function:linear; }
.hs-fall .hs-p { animation-name:hs-fall }
.hs-rise .hs-p { animation-name:hs-rise }
.hs-p:nth-child(1){left:8%;animation-delay:0s}
.hs-p:nth-child(2){left:23%;animation-delay:.35s}
.hs-p:nth-child(3){left:38%;animation-delay:.7s}
.hs-p:nth-child(4){left:53%;animation-delay:.15s}
.hs-p:nth-child(5){left:68%;animation-delay:.55s}
.hs-p:nth-child(6){left:83%;animation-delay:.9s}
.hs-spin { animation:hs-spin calc(var(--hs-t) * 1.6) linear infinite; }
.hs-ring { position:absolute; left:50%; top:50%; border-radius:9999px; border:2px solid currentColor; opacity:0; animation:hs-ripple calc(var(--hs-t) * 1.5) ease-out infinite; }
.hs-ring:nth-child(2){animation-delay:.5s}
.hs-ring:nth-child(3){animation-delay:1s}
.hs-lane-dot { animation:hs-sweep var(--hs-t) ease-in-out infinite; }
.hs-lane:nth-child(2) .hs-lane-dot { animation-delay:.4s; animation-direction:reverse }
.hs-lane:nth-child(3) .hs-lane-dot { animation-delay:.8s }
.hs-bar { transform-origin:bottom; animation:hs-bars calc(var(--hs-t) * .5) ease-in-out infinite; }
.hs-bar:nth-child(2){animation-delay:.12s} .hs-bar:nth-child(3){animation-delay:.27s}
.hs-bar:nth-child(4){animation-delay:.05s} .hs-bar:nth-child(5){animation-delay:.33s}
.hs-bar:nth-child(6){animation-delay:.18s} .hs-bar:nth-child(7){animation-delay:.4s}
.hs-glow { animation:hs-breathe calc(var(--hs-t) * 1.6) ease-in-out infinite; }
.hs-draw { stroke-dasharray:100; animation:hs-draw calc(var(--hs-t) * 2) ease-out infinite; }
.hs-feed { animation:hs-scroll calc(var(--hs-t) * 3) linear infinite; }
.hs-orbit { animation:hs-spin calc(var(--hs-t) * 3) linear infinite; }
.hs-shimmer { animation:hs-shimmer calc(var(--hs-t) * 1.2) ease-in-out infinite; }
.hs-lv-0{--hs-lv:0} .hs-lv-1{--hs-lv:.1} .hs-lv-2{--hs-lv:.2} .hs-lv-3{--hs-lv:.3} .hs-lv-4{--hs-lv:.4}
.hs-lv-5{--hs-lv:.5} .hs-lv-6{--hs-lv:.6} .hs-lv-7{--hs-lv:.7} .hs-lv-8{--hs-lv:.8} .hs-lv-9{--hs-lv:.9} .hs-lv-10{--hs-lv:1}
.hs-slat-block { transform-origin:top; transform:scaleY(var(--hs-lv,1)); }
.hs-timer { transform-origin:left; transform:scaleX(var(--hs-lv,1)); }
@media (prefers-reduced-motion: reduce) {
  .hs-fx *, .hs-fx { animation: none !important; }
  .hs-p { opacity:.35 !important }
}
`

/** level 0..1 → the `hs-lv-N` class (ten steps). */
export function levelClass(level: number | undefined): string {
  const clamped = Math.min(1, Math.max(0, level ?? 1))
  return `hs-lv-${Math.round(clamped * 10)}`
}
