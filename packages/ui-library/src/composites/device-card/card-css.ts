/**
 * Layout and motion the device card cannot spell as utilities: the scene's
 * three-column grid areas and the role animations behind a scene. Colours are
 * theme tokens only, taken through `currentColor` (the element carries a
 * `text-<token>` class). Injected once per card with `<style>`.
 */
export const DEVICE_CARD_CSS = `
.dc-scene{isolation:isolate;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);grid-template-areas:"left img right" "bottom bottom bottom";align-items:center;justify-items:center}
.dc-scene[data-bottom="false"]{grid-template-areas:"left img right"}
.dc-left{grid-area:left;justify-self:end}
.dc-right{grid-area:right;justify-self:start;max-width:100%}
.dc-img{grid-area:img}
.dc-bottom{grid-area:bottom}
.dc-blocked .dc-gated{opacity:.45;pointer-events:none}
.dc-dial{touch-action:none;cursor:grab}
.dc-dial[aria-disabled="true"]{cursor:default}
.dc-dial circle{fill:none;stroke-linecap:round}
.dc-dial .dc-arc{transition:stroke-dasharray .2s}
.dc-fx{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;z-index:-1}
.dc-fx[data-dim="true"]{opacity:.45}
.dc-fx-p i{position:absolute;top:0;width:4px;height:26px;border-radius:9px;background:currentColor;opacity:0;animation:dc-fall 2s linear infinite}
.dc-fx-p[data-dir="rise"] i{animation-name:dc-rise}
.dc-fx-p i:nth-child(1){left:8%}.dc-fx-p i:nth-child(2){left:23%;animation-delay:.35s}.dc-fx-p i:nth-child(3){left:38%;animation-delay:.7s}
.dc-fx-p i:nth-child(4){left:62%;animation-delay:.15s}.dc-fx-p i:nth-child(5){left:77%;animation-delay:.55s}.dc-fx-p i:nth-child(6){left:92%;animation-delay:.9s}
@keyframes dc-fall{0%{transform:translateY(-130%);opacity:0}20%,80%{opacity:.55}100%{transform:translateY(1400%);opacity:0}}
@keyframes dc-rise{0%{transform:translateY(1400%);opacity:0}20%,80%{opacity:.55}100%{transform:translateY(-130%);opacity:0}}
.dc-fx-breathe{position:absolute;left:50%;top:50%;width:200px;height:200px;margin:-100px;border-radius:50%;background:currentColor;filter:blur(40px);animation:dc-breathe 3.2s ease-in-out infinite}
@keyframes dc-breathe{0%,100%{opacity:.12;transform:scale(1)}50%{opacity:.25;transform:scale(1.08)}}
.dc-fx-air{position:absolute;top:28px;left:50%;width:150px;margin-left:-75px;height:75%}
.dc-fx-air[data-sway="true"]{animation:dc-sway 4s ease-in-out infinite}
.dc-fx-air i{position:absolute;top:0;width:3px;height:22px;border-radius:3px;background:currentColor;opacity:0;animation:dc-air 1.8s linear infinite}
.dc-fx-air[data-slow="true"] i{animation-duration:3.4s}
.dc-fx-air i:nth-child(1){left:6%}.dc-fx-air i:nth-child(2){left:24%;animation-delay:.4s}.dc-fx-air i:nth-child(3){left:42%;animation-delay:.8s}
.dc-fx-air i:nth-child(4){left:60%;animation-delay:.2s}.dc-fx-air i:nth-child(5){left:78%;animation-delay:.6s}.dc-fx-air i:nth-child(6){left:94%;animation-delay:1s}
@keyframes dc-air{0%{transform:translateY(0);opacity:0}18%{opacity:.6}82%{opacity:.6}100%{transform:translateY(200px);opacity:0}}
@keyframes dc-sway{0%,100%{transform:translateX(-12%)}50%{transform:translateX(12%)}}
.dc-fx-wisps i{position:absolute;bottom:66px;width:14px;height:22px;border:2px solid currentColor;border-color:currentColor transparent transparent currentColor;border-radius:50% 0 50% 0;opacity:0;animation:dc-heat 2.2s ease-out infinite}
.dc-fx-wisps[data-at="floor"] i:nth-child(1){left:10%}.dc-fx-wisps[data-at="floor"] i:nth-child(2){left:30%;animation-delay:.5s}.dc-fx-wisps[data-at="floor"] i:nth-child(3){left:50%;animation-delay:1s}
.dc-fx-wisps[data-at="floor"] i:nth-child(4){left:70%;animation-delay:.3s}.dc-fx-wisps[data-at="floor"] i:nth-child(5){left:88%;animation-delay:.8s}
.dc-fx-wisps[data-at="unit"] i{bottom:70px}
.dc-fx-wisps[data-at="unit"] i:nth-child(1){left:calc(50% - 40px)}
.dc-fx-wisps[data-at="unit"] i:nth-child(2){left:calc(50% - 7px);animation-delay:.6s}
.dc-fx-wisps[data-at="unit"] i:nth-child(3){left:calc(50% + 26px);animation-delay:1.2s}
@keyframes dc-heat{0%{transform:translateY(0);opacity:0}30%{opacity:.6}100%{transform:translateY(-60px);opacity:0}}
.dc-fx-draft i{position:absolute;left:0;height:2px;width:60px;border-radius:2px;background:currentColor;opacity:0;animation:dc-draft 2.4s linear infinite}
.dc-fx-draft i:nth-child(1){top:22%}.dc-fx-draft i:nth-child(2){top:40%;animation-delay:.6s}.dc-fx-draft i:nth-child(3){top:58%;animation-delay:1.2s}.dc-fx-draft i:nth-child(4){top:76%;animation-delay:1.8s}
@keyframes dc-draft{0%{transform:translateX(-70px);opacity:0}15%,85%{opacity:.6}100%{transform:translateX(420px);opacity:0}}
.dc-fx-glow{position:absolute;left:0;right:0;bottom:0;height:45%;background:linear-gradient(to top,currentColor,transparent);animation:dc-warm 3s ease-in-out infinite}
.dc-fx-glow[data-low="true"]{height:30%}
@keyframes dc-warm{0%,100%{opacity:.08}50%{opacity:.2}}
.dc-fx-pipe{position:absolute;left:0;top:4%;width:100%;height:62%}
.dc-fx-pipe path{fill:none;stroke:currentColor;stroke-linecap:round}
.dc-fx-pipe .dc-p0{stroke-width:9;opacity:.07}
.dc-fx-pipe .dc-p1{stroke-width:3;opacity:.35;stroke-dasharray:8 16;animation:dc-flow 1.4s linear infinite}
.dc-fx-pipe[data-slow="true"] .dc-p1{animation-duration:4s}
@keyframes dc-flow{to{stroke-dashoffset:-48}}
.dc-flash{animation:dc-flash .25s ease-out}
@keyframes dc-flash{0%{opacity:.4}100%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dc-fx *,.dc-fx{animation:none!important}.dc-fx-p,.dc-fx-air,.dc-fx-wisps,.dc-fx-draft{display:none}}
`
