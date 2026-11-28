/**
 * The pie's own motion: a breathing fill on an active wedge. The reading's backdrop
 * motion is the single-reading card's (`MeasurementFx`), clipped to the wedge. Under
 * `prefers-reduced-motion` nothing moves.
 */
export const SENSOR_PIE_CSS = `
.dc-pie-wedge{outline:none}
.dc-pie-wedge:focus-visible>path{stroke-width:3}
.dc-pie-empty{stroke-dasharray:4 4}
.dc-pie-breathe{animation:dc-pie-breathe 2.8s ease-in-out infinite}
@keyframes dc-pie-breathe{0%,100%{fill-opacity:.55}50%{fill-opacity:1}}
@media (prefers-reduced-motion:reduce){.dc-pie-breathe{animation:none!important}}
`
