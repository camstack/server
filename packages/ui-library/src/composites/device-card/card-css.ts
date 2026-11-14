import { SCENE_COLUMN_PCT } from './shell/scene-layout'

/**
 * Layout and motion the device card cannot spell as utilities: the scene's
 * three-column grid areas (one stacked column once the card is under 18rem, so a
 * narrow column never cuts a scene) and the role animations behind a scene. Colours are
 * theme tokens only, taken through `currentColor` (the element carries a
 * `text-<token>` class). Injected once per card with `<style>`.
 */
export const DEVICE_CARD_CSS: string = `
.dc-scene{isolation:isolate;display:grid;grid-template-columns:${SCENE_COLUMN_PCT}% minmax(0,1fr) ${SCENE_COLUMN_PCT}%;grid-template-areas:"left img right" "bottom bottom bottom";align-items:center;justify-items:center}
.dc-scene[data-bottom="false"]{grid-template-areas:"left img right"}
.dc-scene[data-sides="0"]{grid-template-columns:minmax(0,1fr);grid-template-areas:"img" "bottom"}
.dc-scene[data-sides="0"][data-bottom="false"]{grid-template-areas:"img"}
.dc-left,.dc-right{justify-self:stretch;width:100%;min-width:0;max-width:100%;overflow:visible}
.dc-left{grid-area:left}
.dc-right{grid-area:right}
.dc-img{grid-area:img;justify-self:stretch}
.dc-bottom{grid-area:bottom;justify-self:stretch;min-width:0;max-width:100%;overflow-x:clip}
.dc-card{container-type:inline-size}
@container (max-width:18rem){.dc-scene,.dc-scene[data-bottom="false"]{grid-template-columns:minmax(0,1fr);grid-template-areas:"img" "left" "right" "bottom"}}
.dc-blocked .dc-gated{opacity:.45;pointer-events:none}
.dc-dial{touch-action:none;cursor:grab}
.dc-dial[aria-disabled="true"]{cursor:default}
.dc-dial circle{fill:none;stroke-linecap:round}
.dc-dial .dc-arc{transition:stroke-dasharray .2s}
.dc-fx{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;z-index:-1}
.dc-fx-layer{position:absolute;inset:0}
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
.dc-fx[data-pace="slow"] .dc-fx-air i{animation-duration:3.4s}
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
.dc-fx-wash{position:absolute;left:0;right:0;height:45%;animation:dc-warm 3s ease-in-out infinite}
.dc-fx-wash[data-from="bottom"]{bottom:0;background:linear-gradient(to top,currentColor,transparent)}
.dc-fx-wash[data-from="top"]{top:0;background:linear-gradient(to bottom,currentColor,transparent)}
@keyframes dc-warm{0%,100%{opacity:.08}50%{opacity:.2}}
.dc-fx-pipe{position:absolute;left:0;top:4%;width:100%;height:62%}
.dc-fx-serp{position:absolute;left:22%;bottom:8px;width:56%;height:44px}
.dc-fx-pipe path,.dc-fx-serp path{fill:none;stroke:currentColor;stroke-linecap:round}
.dc-fx-pipe .dc-p0{stroke-width:9;opacity:.07}
.dc-fx-pipe .dc-p1{stroke-width:3;opacity:.35;stroke-dasharray:8 16;animation:dc-flow 1.4s linear infinite}
.dc-fx[data-pace="slow"] .dc-fx-pipe .dc-p1{animation-duration:4s}
.dc-fx-serp .dc-p0{stroke-width:6;opacity:.14}
.dc-fx-serp .dc-p1{stroke-width:2.5;opacity:.5;stroke-dasharray:8 16;animation:dc-flow 1.4s linear infinite}
.dc-fx-unit{position:absolute;bottom:10px;left:50%;width:96px;margin-left:-48px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;opacity:.28}
.dc-fx-unit .dc-fx-coil{stroke-width:3;animation:dc-coil 1.6s ease-in-out infinite}
@keyframes dc-coil{0%,100%{opacity:.5}50%{opacity:1}}
.dc-fx[data-pace="slow"] .dc-fx-serp .dc-p1,.dc-fx[data-pace="slow"] .dc-fx-coil{animation:none}
@keyframes dc-flow{to{stroke-dashoffset:-48}}
.dc-flash{animation:dc-flash .25s ease-out}
@keyframes dc-flash{0%{opacity:.4}100%{opacity:1}}
.dc-fx-wash[data-low]{height:30%}
[data-speed="1"]{--dc-spin:1.8s}[data-speed="2"]{--dc-spin:1.45s}[data-speed="3"]{--dc-spin:1.05s}[data-speed="4"]{--dc-spin:.7s}[data-speed="5"]{--dc-spin:.4s}
.dc-fx-breeze i{position:absolute;left:-30%;height:2px;width:30%;border-radius:2px;background:currentColor;opacity:0;animation:dc-breeze var(--dc-spin,1.6s) linear infinite}
.dc-fx-breeze i:nth-child(1){top:22%}.dc-fx-breeze i:nth-child(2){top:40%;animation-delay:.4s}.dc-fx-breeze i:nth-child(3){top:58%;animation-delay:.9s}.dc-fx-breeze i:nth-child(4){top:76%;animation-delay:.2s}
@keyframes dc-breeze{0%{left:-30%;opacity:0}20%{opacity:.5}100%{left:110%;opacity:0}}
.dc-fan{perspective:320px}
.dc-fan svg{overflow:visible}
.dc-fan .dc-fan-blades{transform-box:view-box;transform-origin:60px 60px}
.dc-fan[data-spin="true"] .dc-fan-blades{animation:dc-spin var(--dc-spin,1.6s) linear infinite}
.dc-fan[data-reverse="true"] .dc-fan-blades{animation-direction:reverse}
.dc-fan[data-sway="true"] svg{animation:dc-fan-sway 3.5s ease-in-out infinite alternate}
.dc-fan-h,.dc-fan-v{transform-style:preserve-3d}
.dc-fan-h{transform:rotateY(var(--dc-af,0deg))}.dc-fan-v{transform:rotateX(var(--dc-af,0deg))}
.dc-fan-h[data-osc="true"]{animation:dc-axh 4.2s ease-in-out infinite alternate}
.dc-fan-v[data-osc="true"]{animation:dc-axv 2.8s ease-in-out infinite alternate}
@keyframes dc-spin{to{transform:rotate(360deg)}}
@keyframes dc-fan-sway{from{transform:rotateY(-38deg)}to{transform:rotateY(38deg)}}
@keyframes dc-axh{from{transform:rotateY(var(--dc-a0))}to{transform:rotateY(var(--dc-a1))}}
@keyframes dc-axv{from{transform:rotateX(var(--dc-a0))}to{transform:rotateX(var(--dc-a1))}}
.dc-heater[data-on="true"] .dc-heater-coil{animation:dc-pulse 2.4s ease-in-out infinite}
@keyframes dc-pulse{50%{opacity:.55}}
.dc-cover .dc-grip{cursor:grab;touch-action:none;outline:none}
.dc-cover .dc-grip:focus-visible .dc-pill{stroke:currentColor;stroke-width:2}
.dc-appl .dc-drum{transform-box:view-box;transform-origin:60px 74px}
.dc-appl[data-kind="dish"] .dc-drum{transform-origin:60px 106px}
.dc-appl .dc-ring{transition:stroke-dasharray .4s}
.dc-appl[data-run="true"] .dc-drum{animation:dc-spin 2.4s linear infinite}
.dc-appl[data-kind="dish"][data-run="true"] .dc-drum{animation:dc-sweep 1.2s ease-in-out infinite}
@keyframes dc-sweep{50%{transform:scaleX(.25)}}
.dc-robot .dc-r-mover{transform:translate(52px,64px)}
.dc-robot .dc-r-turret,.dc-robot .dc-r-bot,.dc-robot .dc-r-ping,.dc-robot .dc-r-bolt{transform-box:fill-box;transform-origin:center}
.dc-robot .dc-r-ping{opacity:0}
.dc-robot .dc-r-zzz,.dc-robot .dc-r-bolt{display:none}
.dc-robot[data-vst="clean"] .dc-r-mover{animation:dc-r-lanes 9s ease-in-out infinite}
.dc-robot[data-vst="clean"] .dc-r-turret,.dc-robot[data-vst="ret"] .dc-r-turret{animation:dc-spin 3s linear infinite}
.dc-robot[data-mow="true"][data-vst="clean"] .dc-r-turret{animation-duration:.5s}
.dc-robot[data-vst="clean"] .dc-r-ping{animation:dc-r-ping 1.6s ease-out infinite}
.dc-robot[data-vst="ret"] .dc-r-mover{animation:dc-r-home 3.2s ease-in-out forwards}
.dc-robot[data-vst="pause"] .dc-r-mover{transform:translate(110px,64px)}
.dc-robot[data-vst="sleep"] .dc-r-mover,.dc-robot[data-vst="charge"] .dc-r-mover{transform:translate(172px,65px)}
.dc-robot[data-vst="sleep"] .dc-r-bot{animation:dc-r-breathe 3.4s ease-in-out infinite}
.dc-robot[data-vst="sleep"] .dc-r-zzz{display:block}
.dc-robot[data-vst="sleep"] .dc-r-zzz text{animation:dc-r-zzz 3.4s ease-in-out infinite}
.dc-robot[data-vst="sleep"] .dc-r-zzz text:nth-child(2){animation-delay:.7s}.dc-robot[data-vst="sleep"] .dc-r-zzz text:nth-child(3){animation-delay:1.4s}
.dc-robot[data-vst="charge"] .dc-r-bolt{display:block;animation:dc-r-spark 1s ease-in-out infinite}
.dc-robot[data-vst="charge"] .dc-r-dock{animation:dc-r-pulse 1.2s ease-in-out infinite}
.dc-robot[data-vst="err"] .dc-r-mover{transform:translate(100px,94px)}
.dc-robot[data-vst="err"] .dc-r-bot{animation:dc-r-blink 1s steps(1) infinite}
@keyframes dc-r-lanes{0%{transform:translate(40px,34px)}22%{transform:translate(165px,34px)}30%{transform:translate(165px,64px)}52%{transform:translate(40px,64px)}60%{transform:translate(40px,94px)}82%{transform:translate(165px,94px)}100%{transform:translate(40px,34px)}}
@keyframes dc-r-ping{0%{transform:scale(.6);opacity:.5}100%{transform:scale(1.5);opacity:0}}
@keyframes dc-r-home{0%{transform:translate(90px,64px)}100%{transform:translate(172px,65px)}}
@keyframes dc-r-breathe{0%,100%{opacity:.78;transform:scale(1)}50%{opacity:1;transform:scale(1.05)}}
@keyframes dc-r-zzz{0%{opacity:0;transform:translateY(3px)}30%{opacity:.85}100%{opacity:0;transform:translateY(-9px)}}
@keyframes dc-r-spark{0%,100%{opacity:.25;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}
@keyframes dc-r-pulse{0%,100%{opacity:.35}50%{opacity:.85}}
@keyframes dc-r-blink{0%,49%{opacity:1}50%,100%{opacity:.3}}
.dc-hp-fan{transform-box:view-box;transform-origin:44px 44px}
.dc-hp[data-spin="true"] .dc-hp-fan{animation:dc-spin var(--dc-spin,1.6s) linear infinite}
.dc-tank-bubble{opacity:0}
.dc-tank[data-heat="true"] .dc-tank-bubble{animation:dc-bubble 2.6s ease-in infinite}
.dc-tank[data-heat="true"] .dc-tank-bubble:nth-of-type(2){animation-delay:.9s}
.dc-tank[data-heat="true"] .dc-tank-bubble:nth-of-type(3){animation-delay:1.7s}
@keyframes dc-bubble{0%{transform:translateY(0);opacity:0}20%{opacity:.8}100%{transform:translateY(-46px);opacity:0}}
.dc-energy-flow{stroke-dasharray:2 10;stroke-linecap:round}
.dc-energy[data-still="false"] .dc-energy-flow[data-live="true"]{animation:dc-energy-flow var(--dc-spin,1.6s) linear infinite}
@keyframes dc-energy-flow{to{stroke-dashoffset:-24}}
.dc-remote-dpad{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,44px);gap:6px}
.dc-remote-dpad>*{min-width:0;padding:0}
.dc-remote-dpad [data-pos="up"]{grid-area:1/2}.dc-remote-dpad [data-pos="left"]{grid-area:2/1}.dc-remote-dpad [data-pos="ok"]{grid-area:2/2;border-radius:9999px}
.dc-remote-dpad [data-pos="right"]{grid-area:2/3}.dc-remote-dpad [data-pos="down"]{grid-area:3/2}
.dc-lock-moving{animation:dc-wobble .7s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}
@keyframes dc-wobble{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
.dc-ring-pulse{animation:dc-ring-pulse 1.6s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes dc-ring-pulse{0%{transform:scale(.85);opacity:.7}100%{transform:scale(1.2);opacity:0}}
.dc-wave{animation:dc-wave 1s ease-in-out infinite}.dc-wave+.dc-wave{animation-delay:.25s}
@keyframes dc-wave{50%{opacity:.2}}
.dc-jet{animation:dc-jet 1.2s ease-in-out infinite;transform-box:fill-box}
@keyframes dc-jet{50%{transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.dc-lock-moving,.dc-ring-pulse,.dc-wave,.dc-jet{animation:none!important}}
@media (prefers-reduced-motion:reduce){.dc-fx *,.dc-fx{animation:none!important}.dc-fx-p,.dc-fx-air,.dc-fx-wisps,.dc-fx-draft,.dc-fx-breeze{display:none}.dc-fan *,.dc-fan,.dc-heater *,.dc-appl *,.dc-robot *,.dc-hp *,.dc-tank *,.dc-energy *{animation:none!important}}
`
