/**
 * The pie's motion: a breathing fill and one small animation per quantity, kept
 * inside its wedge by a clip path. Colours come through `currentColor` / theme
 * token classes on the elements; under `prefers-reduced-motion` nothing moves.
 */
export const SENSOR_PIE_CSS = `
.dc-pie-wedge{outline:none}
.dc-pie-wedge:focus-visible>path{stroke-width:3}
.dc-pie-empty{stroke-dasharray:4 4}
.dc-pie-breathe{animation:dc-pie-breathe 2.8s ease-in-out infinite}
@keyframes dc-pie-breathe{0%,100%{fill-opacity:.55}50%{fill-opacity:1}}
.dc-pie-ring{transform-box:fill-box;transform-origin:center;stroke-width:1.4;opacity:0;animation:dc-pie-ring 2.4s ease-out infinite}
@keyframes dc-pie-ring{0%{transform:scale(.4);opacity:.7}100%{transform:scale(5);opacity:0}}
.dc-pie-drop{opacity:0;animation:dc-pie-drop 2s linear infinite}
@keyframes dc-pie-drop{0%{transform:translateY(0);opacity:0}20%,70%{opacity:.7}100%{transform:translateY(56px);opacity:0}}
.dc-pie-wisp{stroke-width:1.4;stroke-linecap:round;opacity:0;animation:dc-pie-wisp 2.2s ease-out infinite}
@keyframes dc-pie-wisp{0%{transform:translateY(0);opacity:0}30%{opacity:.7}100%{transform:translateY(-26px);opacity:0}}
.dc-pie-flow{stroke-width:1.6;stroke-dasharray:5 6;opacity:.7;animation:dc-pie-flow 1.2s linear infinite}
@keyframes dc-pie-flow{to{stroke-dashoffset:-11}}
.dc-pie-step-1{animation-delay:.6s}
.dc-pie-step-2{animation-delay:1.2s}
@media (prefers-reduced-motion:reduce){.dc-pie-breathe,.dc-pie-ring,.dc-pie-drop,.dc-pie-wisp,.dc-pie-flow{animation:none!important}.dc-pie-ring,.dc-pie-drop,.dc-pie-wisp{opacity:.35}}
`
