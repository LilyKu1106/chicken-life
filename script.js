/* ============================================================================
   Chicken Life — script.js
   ----------------------------------------------------------------------------
   一款使用 Vanilla JavaScript 撰寫的瀏覽器電子雞養成遊戲。
   全部美術皆以 Canvas 程序化繪製（低解析度 + 不平滑縮放）呈現像素風，
   不依賴外部圖片檔，因此沒有真正的 PNG Sprite Sheet，但 SpriteAnimationManager
   的介面設計成「之後要換成真正的 PNG Sprite Sheet 也完全相容」。

   檔案內容索引（方便之後擴充）：
     1. 全域設定 / 色票
     2. 工具函式（像素繪製）
     3. SpriteAnimationManager — 通用動畫管理器（角色 / NPC / 寵物皆可掛載）
     4. ChickActor — 小雞的繪製邏輯（依狀態 / 成長階段 / 裝扮繪製每一幀）
     5. BackgroundRenderer — 背景場景繪製
     6. SoundManager — Web Audio 8-bit 音效合成
     7. GameState — 小雞數值 / 存讀檔 / 成長 / AI 行為 / 死亡
     8. ShopSystem — 商店與背包
     9. EventSystem — 隨機事件 / 每日登入
    10. UIController — DOM 綁定、按鈕、Modal、狀態列更新
    11. 主迴圈啟動
   ============================================================================ */

(() => {
'use strict';

/* ============================================================================
   1. 全域設定 / 色票
   ============================================================================ */
const PALETTE = {
  bodyLight:  '#ffe27a',
  bodyMain:   '#ffd23f',
  bodyDark:   '#e8a800',
  bodyOld:    '#f2b84b',     // 老年雞身體偏橘
  beak:       '#ff8c3b',
  beakDark:   '#d9691f',
  feet:       '#ff8c3b',
  eyeWhite:   '#ffffff',
  eyeBlack:   '#2b2017',
  blush:      '#ff9fb2',
  outline:    '#2b2017',
  sick:       '#9bd17a',
  tear:       '#6fc3df',
  comb:       '#e8584a',
  poop:       '#7a5230',
};

const STAGES = [
  { key:'egg',   label:'蛋',     minAge: 0,    scale:0.5 },   // 0 天剛出生就是蛋
  { key:'baby',  label:'幼雞',   minAge: 0.05, scale:0.6 },   // 約 3 現實秒後破蛋
  { key:'kid',   label:'小雞',   minAge: 1,    scale:0.8 },
  { key:'teen',  label:'青年雞', minAge: 3,    scale:1.0 },
  { key:'adult', label:'成年雞', minAge: 7,    scale:1.15 },
  { key:'old',   label:'老雞',   minAge: 15,   scale:1.05 },
];

const DAY_LENGTH_MS = 60 * 1000;     // 遊戲內：現實 60 秒 = 1 天（方便展示成長系統）
const TICK_MS = 1000;                 // 數值每秒自然變化一次
const SLEEP_ENERGY_GAIN = 9;          // 睡眠時每秒恢復的活力（原本 3，需求提升為 3 倍）
const DECAY = { hunger:0.45, happy:0.35, energy:0.30, clean:0.30, sleep:0.0 };
const SAVE_KEY_PREFIX = 'chickenLife_slot_';   // + 1 / 2 / 3
const SAVE_KEY_LEGACY = 'chickenLife_save_v1'; // 舊版單一存檔（用於自動搬遷）
const SAVE_VERSION = 1;
let mainTickInterval = null; // 主數值衰減計時器的參照，死亡時會被清除
let currentSlot = 1;         // 目前作用中的存檔位（載入/儲存皆針對這一格）

const PX = 4; // 基礎像素單位（畫面內每個「像素方塊」實際佔的螢幕像素數）

/* ============================================================================
   2. 工具函式
   ============================================================================ */
function clamp(v, min=0, max=100){ return Math.max(min, Math.min(max, v)); }

function rand(min, max){ return Math.random() * (max - min) + min; }
function randInt(min, max){ return Math.floor(rand(min, max+1)); }
function choice(arr){ return arr[randInt(0, arr.length-1)]; }

/** 在畫布上以「像素網格」方式畫一個填滿的圓形（產生鋸齒感的像素圓，而非平滑圓）*/
function fillPixelCircle(ctx, cx, cy, r, color){
  ctx.fillStyle = color;
  for (let y = -r; y <= r; y += PX){
    for (let x = -r; x <= r; x += PX){
      if (x*x + y*y <= r*r){
        const px = Math.round((cx + x) / PX) * PX;
        const py = Math.round((cy + y) / PX) * PX;
        ctx.fillRect(px, py, PX, PX);
      }
    }
  }
}

/** 畫一個像素方塊 */
function px(ctx, gx, gy, color){
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(gx/PX)*PX, Math.round(gy/PX)*PX, PX, PX);
}

/** 畫一個像素矩形（以網格對齊） */
function pxRect(ctx, x, y, w, h, color){
  ctx.fillStyle = color;
  const gx = Math.round(x/PX)*PX, gy = Math.round(y/PX)*PX;
  const gw = Math.round(w/PX)*PX, gh = Math.round(h/PX)*PX;
  ctx.fillRect(gx, gy, gw, gh);
}

/* ============================================================================
   3. SpriteAnimationManager
   ----------------------------------------------------------------------------
   通用動畫管理器：可註冊任意「角色」（小雞 / 未來的 NPC、寵物、玩具…）。
   每個角色提供 { draw(ctx, frameIndex, time, ctxData), fps, frames } 等資訊。
   之後若要改用真正的 PNG Sprite Sheet，只要把 actor.draw 換成
   `ctx.drawImage(sheet, frameIndex*frameW, row*frameH, frameW, frameH, ...)` 即可，
   外部呼叫方式完全不需要改變。
   ============================================================================ */
class SpriteAnimationManager {
  constructor(){
    this.actors = new Map();
    this._raf = null;
    this._lastTime = 0;
  }

  /** 註冊一個可被驅動動畫的角色 */
  register(id, actor){
    this.actors.set(id, Object.assign({
      frame: 0,
      elapsed: 0,
      fps: 8,
    }, actor));
  }

  unregister(id){ this.actors.delete(id); }

  get(id){ return this.actors.get(id); }

  start(){
    if (this._raf) return;
    const loop = (t) => {
      const dt = t - (this._lastTime || t);
      this._lastTime = t;
      for (const actor of this.actors.values()){
        actor.elapsed += dt;
        const frameDur = 1000 / (actor.fps || 8);
        if (actor.elapsed >= frameDur){
          actor.elapsed = 0;
          actor.frame = (actor.frame + 1) % (actor.frameCount || 1);
        }
        if (typeof actor.draw === 'function'){
          actor.draw(actor.frame, t);
        }
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop(){
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}

const animManager = new SpriteAnimationManager();

/* ============================================================================
   4. ChickActor — 程序化繪製小雞
   ============================================================================ */
const chickCanvas = document.getElementById('chick-canvas');
const chickCtx = chickCanvas.getContext('2d');
chickCtx.imageSmoothingEnabled = false;

/**
 * 讓 canvas 的內部繪製解析度符合 #scene div 的實際像素尺寸。
 * 呼叫時機：初始化時 + 視窗尺寸改變時（ResizeObserver）。
 * 這樣無論場景是橫式（桌機）還是直式（手機），
 * canvas 的座標空間都和顯示空間一致，不會拉伸也不需要 letterbox。
 */
function fitCanvasToScene(){
  const scene = document.getElementById('scene');
  if (!scene) return;
  // devicePixelRatio 讓高密度螢幕（Retina/HDPI）也能清晰顯示
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.floor(scene.clientWidth  * dpr);
  const H = Math.floor(scene.clientHeight * dpr);
  if (W < 10 || H < 10) return;
  [chickCanvas,
   document.getElementById('bg-canvas'),
   document.getElementById('weather-canvas')
  ].forEach(c => {
    if (!c) return;
    if (c.width !== W || c.height !== H){
      c.width  = W;
      c.height = H;
      // imageSmoothingEnabled 在 resize 後會重置，需要重新關閉
      const ctx = c.getContext('2d');
      if (ctx) ctx.imageSmoothingEnabled = false;
    }
    // CSS 顯示尺寸固定為場景實際 CSS 大小（undoing dpr scaling for display）
    c.style.width  = scene.clientWidth  + 'px';
    c.style.height = scene.clientHeight + 'px';
  });
}

// 初始呼叫（DOMContentLoaded 之後、UI.init 之前可能 scene 還沒尺寸，
// 所以也在 startGameLoop 裡再呼叫一次確保正確）
function fitCanvas(canvas){ /* 舊介面保留，讓呼叫端不報錯 */ }
// 視窗 resize 時重新 fit
window.addEventListener('resize', () => {
  fitCanvasToScene();
  drawBackground(GameState.background);
});

/**
/**
 * 主繪製入口：依成長階段（stage）分發到各自的像素繪製函式。
 * 每個階段有獨特的體型比例、顏色、五官特徵和動畫表現。
 * outfit 和 sick 由上層傳入，統一在各子函式最後套用裝扮層。
 */
function drawChick(ctx, { state, frame, stage, outfit, sick, cx: cxOvr, cy: cyOvr }){
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const cx = cxOvr !== undefined ? cxOvr : ctx.canvas.width  / 2;
  const cy = cyOvr !== undefined ? cyOvr : ctx.canvas.height / 2 + 16;

  switch(stage){
    case 'egg':   drawEgg(ctx, cx, cy, state, frame); return;
    case 'baby':  drawBaby(ctx, cx, cy, state, frame, outfit, sick); return;
    case 'kid':   drawKid(ctx, cx, cy, state, frame, outfit, sick); return;
    case 'teen':  drawTeen(ctx, cx, cy, state, frame, outfit, sick); return;
    case 'adult': drawAdult(ctx, cx, cy, state, frame, outfit, sick); return;
    case 'old':   drawOldChick(ctx, cx, cy, state, frame, outfit, sick); return;
    default:      drawBaby(ctx, cx, cy, state, frame, outfit, sick);
  }
}

/* ─── 動畫工具：每個繪製函式都用這組工具解析 state/frame ─── */
function getMotionParams(state, frame){
  const bob  = Math.sin(frame / 8 * Math.PI * 2) * 4;
  let offsetY=0, squash=1, eyeMode='normal', mouthOpen=false, tilt=0;
  switch(state){
    case 'idle':    offsetY = bob; break;
    case 'walk':    offsetY = Math.abs(Math.sin(frame))*6-3; tilt=Math.sin(frame)*4; break;
    case 'eat':     mouthOpen = frame%2===0; offsetY = bob*0.4; break;
    case 'sleep':   eyeMode='closed'; offsetY=Math.sin(frame/8*Math.PI*2)*1.5; squash=0.96; break;
    case 'happy':   eyeMode='happy'; offsetY=-Math.abs(Math.sin(frame))*8; break;
    case 'sad':     eyeMode='sad'; offsetY=4; squash=0.95; break;
    case 'sick':    eyeMode='sick'; offsetY=bob*0.5; break;
    case 'poop':    squash=0.85; offsetY=4; break;
    case 'clean':   offsetY=bob*0.6; eyeMode='happy'; break;
    case 'levelup': offsetY=-Math.abs(Math.sin(frame))*12; eyeMode='happy'; break;
    case 'dead':    squash=0.55; tilt=90; eyeMode='dead'; offsetY=30; break;
  }
  return { offsetY, squash, eyeMode, mouthOpen, tilt };
}

/* ─── 眼睛（共用，各函式呼叫）─── */
function drawEyes(ctx, cx, cy, ox, oy, r, mode, frame){
  const ex1=cx-ox, ex2=cx+ox, ey=cy+oy;
  if (mode==='closed'||mode==='happy'){
    ['#2b2017'].forEach(()=>{
      pxRect(ctx,ex1-7,ey,14,3,'#2b2017'); pxRect(ctx,ex1-7,ey-3,3,3,'#2b2017'); pxRect(ctx,ex1+4,ey-3,3,3,'#2b2017');
      pxRect(ctx,ex2-7,ey,14,3,'#2b2017'); pxRect(ctx,ex2-7,ey-3,3,3,'#2b2017'); pxRect(ctx,ex2+4,ey-3,3,3,'#2b2017');
    });
    return;
  }
  if (mode==='dead'){
    pxRect(ctx,ex1-6,ey-2,12,4,PALETTE.outline); pxRect(ctx,ex2-6,ey-2,12,4,PALETTE.outline); return;
  }
  if (mode==='sick'){
    [[-6,-6],[-2,-2],[2,2],[6,-6],[-6,2]].forEach(([dx,dy])=>{ px(ctx,ex1+dx,ey+dy,PALETTE.outline); px(ctx,ex2+dx,ey+dy,PALETTE.outline); });
    return;
  }
  fillPixelCircle(ctx,ex1,ey,8,PALETTE.eyeWhite); fillPixelCircle(ctx,ex2,ey,8,PALETTE.eyeWhite);
  const pupilDY=mode==='sad'?3:0;
  fillPixelCircle(ctx,ex1,ey+pupilDY,4,PALETTE.eyeBlack); fillPixelCircle(ctx,ex2,ey+pupilDY,4,PALETTE.eyeBlack);
  if (mode==='sad'){ pxRect(ctx,ex1-8,ey-10,14,3,PALETTE.outline); pxRect(ctx,ex2-6,ey-10,14,3,PALETTE.outline); }
}

/* ─── 狀態特效（共用）─── */
function drawStateFx(ctx, cx, cy, r, state, frame){
  if (state==='sad'&&frame%8<4) pxRect(ctx,cx+r*0.4,cy+r*0.15,4,8,PALETTE.tear);
  if (state==='sick') pxRect(ctx,cx+r*0.6,cy-r*0.6,6,8,'#aee8ff');
  if (state==='sleep'){ ctx.font='12px monospace'; ctx.fillStyle=PALETTE.outline; ctx.fillText('z',cx+r*0.5,cy-r-10-(frame%8)*2); }
  if (state==='levelup'){ for(let i=0;i<5;i++){ const a=frame*0.4+i*(Math.PI*2/5); px(ctx,cx+Math.cos(a)*r*1.4,cy+Math.sin(a)*r*1.4,PALETTE.bodyMain); } }
}

/* ─── 裝扮（共用，Z-order: scarf/clothes → accessories → glasses → hats）─── */
function drawOutfit(ctx, cx, cy, r, outfit){
  if (outfit.scarf)   pxRect(ctx,cx-r*0.6,cy+r*0.55,r*1.2,r*0.3,'#6fc3df');
  if (outfit.clothes) pxRect(ctx,cx-r*0.65,cy+r*0.3,r*1.3,r*0.55,'#b08bdb');
  if (outfit.tie){    pxRect(ctx,cx-3,cy+r*0.5,6,r*0.5,'#c2392c'); pxRect(ctx,cx-6,cy+r*0.42,12,8,'#e8584a'); }
  if (outfit.backpack){ pxRect(ctx,cx+r*0.55,cy+r*0.1,r*0.4,r*0.55,'#8a5a3b'); pxRect(ctx,cx+r*0.6,cy+r*0.05,r*0.28,r*0.14,'#c2392c'); }
  if (outfit.bowtie){ pxRect(ctx,cx-10,cy+r*0.45,8,8,'#ff9fb2'); pxRect(ctx,cx+2,cy+r*0.45,8,8,'#ff9fb2'); pxRect(ctx,cx-2,cy+r*0.45+2,4,4,'#e8584a'); }
  if (outfit.headphones){ pxRect(ctx,cx-r*0.85,cy-r*0.15,8,r*0.5,'#2b2017'); pxRect(ctx,cx+r*0.85-8,cy-r*0.15,8,r*0.5,'#2b2017'); pxRect(ctx,cx-r*0.85,cy-r*0.55,r*1.7,8,'#2b2017'); }
  if (outfit.glasses){ pxRect(ctx,cx-r*0.65,cy-r*0.12,r*0.45,r*0.3,'rgba(40,40,40,.85)'); pxRect(ctx,cx+r*0.2,cy-r*0.12,r*0.45,r*0.3,'rgba(40,40,40,.85)'); pxRect(ctx,cx-r*0.2,cy-r*0.02,r*0.4,4,PALETTE.outline); }
  if (outfit.hat){    pxRect(ctx,cx-r*0.55,cy-r*1.55,r*1.1,r*0.35,'#e8584a'); pxRect(ctx,cx-r*0.75,cy-r*1.25,r*1.5,r*0.18,'#c2392c'); }
  if (outfit.crown){  pxRect(ctx,cx-r*0.5,cy-r*1.45,r*1.0,r*0.28,'#ffd23f'); px(ctx,cx-r*0.4,cy-r*1.6,'#ffd23f'); px(ctx,cx,cy-r*1.68,'#ffd23f'); px(ctx,cx+r*0.4,cy-r*1.6,'#ffd23f'); px(ctx,cx,cy-r*1.5,'#ff9fb2'); }
}

/* ════════════════════════════════════════════════════════
   🥚 蛋（Egg）— 橢圓蛋殼、搖晃、偶爾露出眼睛
   ════════════════════════════════════════════════════════ */
function drawEgg(ctx, cx, cy, state, frame){
  const wobble = Math.sin(frame/3*Math.PI*2)*5;
  const crack  = state==='levelup'||state==='happy';

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(wobble * Math.PI/180);
  ctx.translate(-cx, -cy);

  // 蛋身（細高橢圓）
  ctx.save();
  ctx.scale(1, 1.28);
  fillPixelCircle(ctx, cx, cy/1.28, 30, '#fff8e0');
  ctx.restore();

  // 蛋殼紋路
  pxRect(ctx, cx-4, cy-28, 8, 4, '#e8d8a0');
  pxRect(ctx, cx+10, cy-18, 5, 4, '#e8d8a0');
  pxRect(ctx, cx-14, cy-12, 5, 4, '#e8d8a0');

  // 蛋殼裂紋（快孵化時）
  if (crack){
    pxRect(ctx, cx-2, cy-32, 4, 12, '#c8b870');
    pxRect(ctx, cx+6, cy-28, 4, 8, '#c8b870');
  }

  // 偶爾眨眼（idle 時每 16 幀閃一次）
  if (state==='idle'&&frame%16<3){
    px(ctx, cx-6, cy-4, PALETTE.eyeBlack);
    px(ctx, cx+6, cy-4, PALETTE.eyeBlack);
  }
  ctx.restore();
}

/* ════════════════════════════════════════════════════════
   🐣 幼雞（Baby）— 超圓超小、毛絨感、大眼睛佔 40% 身體、無雞冠
   ════════════════════════════════════════════════════════ */
function drawBaby(ctx, cx, cy, state, frame, outfit, sick){
  const { offsetY, squash, eyeMode, mouthOpen, tilt } = getMotionParams(state, frame);
  const r = 22;
  const bodyColor = sick ? PALETTE.sick : '#ffe87a';
  ctx.save(); ctx.translate(cx,cy+offsetY); ctx.rotate(tilt*Math.PI/180); ctx.scale(1,squash); ctx.translate(-cx,-(cy+offsetY));

  // 超圓身體（幾乎是正圓）
  fillPixelCircle(ctx, cx, cy+offsetY, r, bodyColor);
  // 毛絨感：周圍小突起
  for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; fillPixelCircle(ctx,cx+Math.cos(a)*r*0.88,cy+offsetY+Math.sin(a)*r*0.88,5,bodyColor); }
  fillPixelCircle(ctx, cx-r*0.25, cy+offsetY-r*0.3, r*0.5, '#fff3a0');

  // 超大眼睛（佔身體比例非常大）
  drawEyes(ctx, cx, cy+offsetY, r*0.4, -r*0.08, r, eyeMode, frame);
  fillPixelCircle(ctx, cx-r*0.45, cy+offsetY+r*0.15, r*0.22, PALETTE.blush);
  fillPixelCircle(ctx, cx+r*0.45, cy+offsetY+r*0.15, r*0.22, PALETTE.blush);

  // 小橘嘴
  pxRect(ctx, cx-5, cy+offsetY+r*0.25, 10, mouthOpen?8:5, PALETTE.beak);

  // 小腳（非常小）
  pxRect(ctx, cx-r*0.5-2, cy+offsetY+r*0.82, 6, 6, PALETTE.feet);
  pxRect(ctx, cx+r*0.5-4, cy+offsetY+r*0.82, 6, 6, PALETTE.feet);

  ctx.restore();
  drawStateFx(ctx, cx, cy+offsetY, r, state, frame);
  if (outfit) drawOutfit(ctx, cx, cy+offsetY, r, outfit);
}

/* ════════════════════════════════════════════════════════
   🐤 小雞（Kid）— 標準比例、明黃色、有小翅膀、無雞冠
   ════════════════════════════════════════════════════════ */
function drawKid(ctx, cx, cy, state, frame, outfit, sick){
  const { offsetY, squash, eyeMode, mouthOpen, tilt } = getMotionParams(state, frame);
  const r = 30;
  const bodyColor = sick ? PALETTE.sick : PALETTE.bodyMain;
  ctx.save(); ctx.translate(cx,cy+offsetY); ctx.rotate(tilt*Math.PI/180); ctx.scale(1,squash); ctx.translate(-cx,-(cy+offsetY));

  // 小翅膀
  if(outfit?.wings){ fillPixelCircle(ctx,cx-r*0.95,cy+offsetY,r*0.5,'#ffffff'); fillPixelCircle(ctx,cx+r*0.95,cy+offsetY,r*0.5,'#ffffff'); }
  else { fillPixelCircle(ctx,cx-r*0.82,cy+offsetY+r*0.18,r*0.38,PALETTE.bodyDark); fillPixelCircle(ctx,cx+r*0.82,cy+offsetY+r*0.18,r*0.38,PALETTE.bodyDark); }

  fillPixelCircle(ctx, cx, cy+offsetY, r, bodyColor);
  fillPixelCircle(ctx, cx-r*0.28, cy+offsetY-r*0.32, r*0.42, PALETTE.bodyLight);
  fillPixelCircle(ctx, cx-r*0.5, cy+offsetY+r*0.1, r*0.16, PALETTE.blush);
  fillPixelCircle(ctx, cx+r*0.5, cy+offsetY+r*0.1, r*0.16, PALETTE.blush);
  drawEyes(ctx, cx, cy+offsetY, r*0.35, -r*0.05, r, eyeMode, frame);
  pxRect(ctx, cx-6, cy+offsetY+r*0.2, mouthOpen?14:10, mouthOpen?10:6, PALETTE.beak);
  if(mouthOpen) pxRect(ctx, cx-4, cy+offsetY+r*0.2+4, 8, 4, PALETTE.beakDark);
  pxRect(ctx, cx-r*0.4-3, cy+offsetY+r*0.84, 7, 7, PALETTE.feet);
  pxRect(ctx, cx+r*0.4-4, cy+offsetY+r*0.84, 7, 7, PALETTE.feet);
  ctx.restore();
  drawStateFx(ctx, cx, cy+offsetY, r, state, frame);
  if(outfit) drawOutfit(ctx, cx, cy+offsetY, r, outfit);
}

/* ════════════════════════════════════════════════════════
   🐔 青年雞（Teen）— 體型拉長、有雞冠（小）、翅膀更明顯
   ════════════════════════════════════════════════════════ */
function drawTeen(ctx, cx, cy, state, frame, outfit, sick){
  const { offsetY, squash, eyeMode, mouthOpen, tilt } = getMotionParams(state, frame);
  const r = 36;
  const bodyColor = sick ? PALETTE.sick : PALETTE.bodyMain;
  ctx.save(); ctx.translate(cx,cy+offsetY); ctx.rotate(tilt*Math.PI/180); ctx.scale(1,squash); ctx.translate(-cx,-(cy+offsetY));

  // 翅膀
  if(outfit?.wings){ fillPixelCircle(ctx,cx-r*0.9,cy+offsetY,r*0.52,'#ffffff'); fillPixelCircle(ctx,cx+r*0.9,cy+offsetY,r*0.52,'#ffffff'); }
  else { pxRect(ctx,cx-r*1.08,cy+offsetY,r*0.5,r*0.6,'#e8a800'); pxRect(ctx,cx+r*0.58,cy+offsetY,r*0.5,r*0.6,'#e8a800'); }

  // 身體（稍微拉長成橢圓）
  ctx.save(); ctx.scale(1,1.1);
  fillPixelCircle(ctx, cx, (cy+offsetY)/1.1, r, bodyColor);
  ctx.restore();
  fillPixelCircle(ctx, cx-r*0.25, cy+offsetY-r*0.3, r*0.4, PALETTE.bodyLight);

  // 小雞冠
  pxRect(ctx, cx-8, cy+offsetY-r*1.12, 16, 14, PALETTE.comb);
  pxRect(ctx, cx-4, cy+offsetY-r*1.22, 8, 8, '#c2392c');

  fillPixelCircle(ctx, cx-r*0.48, cy+offsetY+r*0.1, r*0.17, PALETTE.blush);
  fillPixelCircle(ctx, cx+r*0.48, cy+offsetY+r*0.1, r*0.17, PALETTE.blush);
  drawEyes(ctx, cx, cy+offsetY, r*0.35, -r*0.05, r, eyeMode, frame);
  pxRect(ctx, cx-7, cy+offsetY+r*0.18, mouthOpen?16:12, mouthOpen?11:7, PALETTE.beak);
  if(mouthOpen) pxRect(ctx, cx-5, cy+offsetY+r*0.18+4, 10, 5, PALETTE.beakDark);
  pxRect(ctx, cx-r*0.4-4, cy+offsetY+r*0.92, 9, 9, PALETTE.feet);
  pxRect(ctx, cx+r*0.4-5, cy+offsetY+r*0.92, 9, 9, PALETTE.feet);
  ctx.restore();
  drawStateFx(ctx, cx, cy+offsetY, r, state, frame);
  if(outfit) drawOutfit(ctx, cx, cy+offsetY, r, outfit);
}

/* ════════════════════════════════════════════════════════
   🦚 成年雞（Adult）— 最大最飽滿、大雞冠、羽毛紋路
   ════════════════════════════════════════════════════════ */
function drawAdult(ctx, cx, cy, state, frame, outfit, sick){
  const { offsetY, squash, eyeMode, mouthOpen, tilt } = getMotionParams(state, frame);
  const r = 42;
  const bodyColor = sick ? PALETTE.sick : PALETTE.bodyMain;
  ctx.save(); ctx.translate(cx,cy+offsetY); ctx.rotate(tilt*Math.PI/180); ctx.scale(1,squash); ctx.translate(-cx,-(cy+offsetY));

  if(outfit?.wings){ fillPixelCircle(ctx,cx-r*0.9,cy+offsetY,r*0.55,'#ffffff'); fillPixelCircle(ctx,cx+r*0.9,cy+offsetY,r*0.55,'#ffffff'); }
  else { pxRect(ctx,cx-r*1.1,cy+offsetY-r*0.05,r*0.52,r*0.7,'#e8a800'); pxRect(ctx,cx+r*0.58,cy+offsetY-r*0.05,r*0.52,r*0.7,'#e8a800'); }

  fillPixelCircle(ctx, cx, cy+offsetY, r, bodyColor);
  fillPixelCircle(ctx, cx-r*0.25, cy+offsetY-r*0.3, r*0.45, PALETTE.bodyLight);

  // 羽毛紋路
  for(let i=0;i<5;i++){ pxRect(ctx,cx-r*0.5+i*10,cy+offsetY+r*0.35,8,6,PALETTE.bodyDark); }

  // 大雞冠（三瓣）
  fillPixelCircle(ctx, cx-10, cy+offsetY-r*1.05, 10, PALETTE.comb);
  fillPixelCircle(ctx, cx,    cy+offsetY-r*1.18, 12, PALETTE.comb);
  fillPixelCircle(ctx, cx+10, cy+offsetY-r*1.05, 10, PALETTE.comb);

  // 肉垂
  fillPixelCircle(ctx, cx+4, cy+offsetY+r*0.22, 8, '#c2392c');

  fillPixelCircle(ctx, cx-r*0.48, cy+offsetY+r*0.08, r*0.17, PALETTE.blush);
  fillPixelCircle(ctx, cx+r*0.48, cy+offsetY+r*0.08, r*0.17, PALETTE.blush);
  drawEyes(ctx, cx, cy+offsetY, r*0.36, -r*0.06, r, eyeMode, frame);
  pxRect(ctx, cx-8, cy+offsetY+r*0.16, mouthOpen?18:14, mouthOpen?12:8, PALETTE.beak);
  if(mouthOpen) pxRect(ctx, cx-6, cy+offsetY+r*0.16+4, 12, 6, PALETTE.beakDark);
  pxRect(ctx, cx-r*0.42-4, cy+offsetY+r*0.9, 10, 10, PALETTE.feet);
  pxRect(ctx, cx+r*0.42-6, cy+offsetY+r*0.9, 10, 10, PALETTE.feet);
  ctx.restore();
  drawStateFx(ctx, cx, cy+offsetY, r, state, frame);
  if(outfit) drawOutfit(ctx, cx, cy+offsetY, r, outfit);
}

/* ════════════════════════════════════════════════════════
   👴 老雞（Old）— 偏灰白、雞冠下垂、眼睛半閉、步伐緩慢
   ════════════════════════════════════════════════════════ */
function drawOldChick(ctx, cx, cy, state, frame, outfit, sick){
  const { offsetY, squash, eyeMode, mouthOpen, tilt } = getMotionParams(state, frame);
  const r = 37;
  const bodyColor = sick ? PALETTE.sick : '#e8d090'; // 偏米白灰
  ctx.save(); ctx.translate(cx,cy+offsetY); ctx.rotate(tilt*Math.PI/180); ctx.scale(1,squash); ctx.translate(-cx,-(cy+offsetY));

  if(outfit?.wings){ fillPixelCircle(ctx,cx-r*0.9,cy+offsetY,r*0.5,'#ffffff'); fillPixelCircle(ctx,cx+r*0.9,cy+offsetY,r*0.5,'#ffffff'); }
  else { pxRect(ctx,cx-r*1.05,cy+offsetY,r*0.48,r*0.6,'#c8a860'); pxRect(ctx,cx+r*0.57,cy+offsetY,r*0.48,r*0.6,'#c8a860'); }

  fillPixelCircle(ctx, cx, cy+offsetY, r, bodyColor);
  fillPixelCircle(ctx, cx-r*0.22, cy+offsetY-r*0.28, r*0.4, '#f5eecc');

  // 下垂雞冠（老化後向右傾斜）
  pxRect(ctx, cx-4, cy+offsetY-r*1.05, 12, 12, '#c05050');
  pxRect(ctx, cx+4, cy+offsetY-r*1.0, 10, 8, '#c05050');

  // 皺紋線條
  pxRect(ctx, cx-r*0.3, cy+offsetY-r*0.22, 6, 2, '#c8a860');
  pxRect(ctx, cx+r*0.18, cy+offsetY-r*0.22, 6, 2, '#c8a860');

  // 老雞眼睛預設半閉（覆寫 eyeMode 為 closed 除非特殊狀態）
  const oldEyeMode = (eyeMode==='normal') ? 'closed' : eyeMode;
  fillPixelCircle(ctx, cx-r*0.46, cy+offsetY+r*0.08, r*0.16, PALETTE.blush);
  fillPixelCircle(ctx, cx+r*0.46, cy+offsetY+r*0.08, r*0.16, PALETTE.blush);
  drawEyes(ctx, cx, cy+offsetY, r*0.35, -r*0.06, r, oldEyeMode, frame);
  pxRect(ctx, cx-6, cy+offsetY+r*0.18, mouthOpen?14:10, mouthOpen?9:6, '#d4884a');
  pxRect(ctx, cx-r*0.38-3, cy+offsetY+r*0.88, 8, 8, '#d4884a');
  pxRect(ctx, cx+r*0.38-5, cy+offsetY+r*0.88, 8, 8, '#d4884a');
  ctx.restore();
  drawStateFx(ctx, cx, cy+offsetY, r, state, frame);
  if(outfit) drawOutfit(ctx, cx, cy+offsetY, r, outfit);
}

/* ---- 天使動畫（死亡後彈出視窗使用獨立小畫布） ---- */
function drawAngel(frame){
  const c = document.getElementById('angel-canvas');
  const actx = c.getContext('2d');
  actx.imageSmoothingEnabled = false;
  actx.clearRect(0,0,c.width,c.height);
  const cx = c.width/2, cy = c.height/2 + Math.sin(frame/8*Math.PI*2)*4;
  fillPixelCircle(actx, cx-26, cy, 16, '#ffffff');
  fillPixelCircle(actx, cx+26, cy, 16, '#ffffff');
  fillPixelCircle(actx, cx, cy, 26, PALETTE.bodyMain);
  fillPixelCircle(actx, cx, cy-26, 9, '#fff7cf');
  drawEyes(actx, cx, cy, 9, -3, 26, 'happy', frame);
  pxRect(actx, cx-6, cy+6, 12, 6, PALETTE.beak);
}

/* ============================================================================
   5. BackgroundRenderer
   ============================================================================ */
const bgCanvas = document.getElementById('bg-canvas');
const bgCtx = bgCanvas.getContext('2d');
bgCtx.imageSmoothingEnabled = false;

function drawBackground(key){
  const W = bgCanvas.width, H = bgCanvas.height;
  bgCtx.clearRect(0,0,W,H);
  const groundY = H*0.62;

  const scenes = {
    room(){
      pxRect(bgCtx, 0,0,W,groundY, '#f7e7c4');
      pxRect(bgCtx, 0,groundY,W,H-groundY, '#c89a63');
      pxRect(bgCtx, W*0.08,H*0.12,W*0.16,H*0.16,'#9fd6ef');
      pxRect(bgCtx, W*0.08,H*0.12,W*0.16,H*0.16,'rgba(255,255,255,.4)');
      pxRect(bgCtx, W*0.75,groundY-30,W*0.16,30,'#8a5a3b');   // 桌子
      pxRect(bgCtx, W*0.06,groundY-22,W*0.14,22,'#e8584a');   // 玩具箱
      pxRect(bgCtx, 0,groundY-6,W,6,'#a87b46');
    },
    grass(){
      pxRect(bgCtx, 0,0,W,groundY,'#bfe9ff');
      pxRect(bgCtx, 0,groundY,W,H-groundY,'#8fcf6a');
      for(let i=0;i<W;i+=12){ pxRect(bgCtx, i, groundY-4, 4, 6, '#6fae5a'); }
      fillPixelCircle(bgCtx, W*0.2,H*0.18,18,'#fff8e0');
    },
    farm(){
      pxRect(bgCtx, 0,0,W,groundY,'#bfe9ff');
      pxRect(bgCtx, 0,groundY,W,H-groundY,'#caa15f');
      for(let i=0;i<W;i+=16){ pxRect(bgCtx, i, groundY+6, 8, 4, '#a9824c'); }
      pxRect(bgCtx, W*0.7,groundY-40,W*0.22,40,'#c2392c');
      pxRect(bgCtx, W*0.7,groundY-50,W*0.22,12,'#5c3b26');
      for(let i=0;i<6;i++){ pxRect(bgCtx, i*36, groundY-14, 4, 14, '#caa15f'); }
    },
    forest(){
      pxRect(bgCtx, 0,0,W,groundY,'#bcd9c2');
      pxRect(bgCtx, 0,groundY,W,H-groundY,'#7a9e63');
      for(let i=0;i<5;i++){
        const x = 20 + i*60;
        pxRect(bgCtx, x-4, groundY-30, 8, 30, '#6b4326');
        fillPixelCircle(bgCtx, x, groundY-46, 22, '#4d8a45');
      }
    },
    snow(){
      pxRect(bgCtx, 0,0,W,groundY,'#dcebf5');
      pxRect(bgCtx, 0,groundY,W,H-groundY,'#ffffff');
      for(let i=0;i<40;i++){
        px(bgCtx, (i*37)%W, (i*53)%groundY, '#ffffff');
      }
    },
    night(){
      pxRect(bgCtx, 0,0,W,groundY,'#1c2240');
      pxRect(bgCtx, 0,groundY,W,H-groundY,'#2a2f1f');
      for(let i=0;i<24;i++){
        px(bgCtx, (i*53)%W, (i*29)%(groundY-10), '#ffe9b8');
      }
      fillPixelCircle(bgCtx, W*0.78,H*0.18,14,'#fff8e0');
    },
  };
  (scenes[key] || scenes.room)();
}

/* ============================================================================
   5b. WeatherSystem
   ----------------------------------------------------------------------------
   天氣是獨立於「場景背景」的另一條軸線：場景（room/farm/forest...）是玩家自己
   切換的地點，天氣（sunny/rain/night/snow/storm）則由排程器每 3 分鐘現實時間
   自動輪替，影響數值衰減速度與生病機率，並在 #weather-canvas 疊加對應的
   像素粒子特效（雨滴/雪花/暴風雨的變暗+閃電/夜晚的星空濾鏡）。
   ============================================================================ */
const WEATHER_TYPES = {
  sunny: { icon:'☀️', label:'晴天',
    decay:{ hunger:1.0, happy:1.0, energy:1.0, clean:1.0 }, sickChance:1.0 },
  rain:  { icon:'🌧️', label:'雨天',
    decay:{ hunger:1.0, happy:0.9, energy:1.0, clean:1.4 }, sickChance:1.3 },
  night: { icon:'🌙', label:'夜晚',
    decay:{ hunger:0.9, happy:1.0, energy:1.2, clean:1.0 }, sickChance:1.0 },
  snow:  { icon:'❄️', label:'雪天',
    decay:{ hunger:1.1, happy:1.0, energy:1.1, clean:1.0 }, sickChance:1.2 },
  storm: { icon:'⛈️', label:'暴風雨',
    decay:{ hunger:1.0, happy:1.0, energy:2.0, clean:2.0 }, sickChance:3.0 },
};
const WEATHER_CYCLE_MS = 3 * 60 * 1000; // 每 3 分鐘現實時間切換一次

const weatherCanvas = document.getElementById('weather-canvas');
const weatherCtx = weatherCanvas.getContext('2d');
weatherCtx.imageSmoothingEnabled = false;
// fitCanvasToScene() will size this along with the others on first render

// 粒子種子使用 0–1 的相對比例，乘以實際 canvas 尺寸時再換算，
// 這樣 resize 後粒子位置自動正確，不會全部擠在左上角的 320x180 範圍內。
const rainParticles = Array.from({length:44}, () => ({
  xR: Math.random(), yR: Math.random(), speed: rand(220,340), len: rand(8,16),
}));
const snowParticles = Array.from({length:34}, () => ({
  xR: Math.random(), yR: Math.random(), speed: rand(24,50), drift: rand(0.5,1.5), phase: rand(0,Math.PI*2),
}));
let lastLightning = 0;

function drawWeather(t){
  const W = weatherCanvas.width, H = weatherCanvas.height;
  weatherCtx.clearRect(0,0,W,H);
  const w = GameState.weather;

  if (w === 'rain' || w === 'storm'){
    weatherCtx.strokeStyle = 'rgba(180,220,255,0.55)';
    weatherCtx.lineWidth = Math.max(1, W/160);
    rainParticles.forEach(p => {
      const x = p.xR * W;
      const y = (p.yR * H + (t/1000)*p.speed) % (H+20) - 20;
      weatherCtx.beginPath();
      weatherCtx.moveTo(x, y);
      weatherCtx.lineTo(x - 3, y + p.len);
      weatherCtx.stroke();
    });
  }

  if (w === 'snow'){
    snowParticles.forEach(p => {
      const y = (p.yR * H + (t/1000)*p.speed) % (H+10) - 10;
      const x = p.xR * W + Math.sin(t/600 + p.phase) * 10 * p.drift;
      px(weatherCtx, x, y, 'rgba(255,255,255,0.9)');
    });
  }

  if (w === 'storm'){
    // 暴風雨整體變暗
    pxRect(weatherCtx, 0, 0, W, H, 'rgba(10,10,30,0.35)');
    // 偶發閃電：短暫全螢幕泛白
    if (t - lastLightning > randInt(2500, 6000)){
      lastLightning = t;
    }
    if (t - lastLightning < 90){
      pxRect(weatherCtx, 0, 0, W, H, 'rgba(255,255,255,0.5)');
    }
  }

  if (w === 'night'){
    pxRect(weatherCtx, 0, 0, W, H, 'rgba(10,15,40,0.3)');
    for (let i=0;i<16;i++){
      const sx = (i*53) % W, sy = (i*31) % (H*0.5);
      if (Math.sin(t/400 + i) > 0.3) px(weatherCtx, sx, sy, 'rgba(255,255,255,0.8)');
    }
  }
  // sunny：不畫任何濾鏡，維持晴朗清澈
}

/** 隨機挑一個跟目前不同的天氣，套用並記錄日記 */
function changeWeather(){
  const keys = Object.keys(WEATHER_TYPES).filter(k => k !== GameState.weather);
  GameState.weather = choice(keys);
  const info = WEATHER_TYPES[GameState.weather];
  UI.toast(`${info.icon} 天氣變成了「${info.label}」`);
  GameState.addDiary('weather', '天氣變化', `天空轉為${info.label}，環境對小雞的狀態產生了影響。`);
  UI.updateStats();
}

function scheduleWeather(){
  setTimeout(() => {
    if (GameState.alive) changeWeather();
    scheduleWeather();
  }, WEATHER_CYCLE_MS);
}

/* ============================================================================
   6. SoundManager — 8-bit 音效合成（不需任何音檔）
   ============================================================================ */
/* ============================================================================
   ChickWander — 自主漫步系統
   ----------------------------------------------------------------------------
   小雞在畫布上自主走動，而不是永遠站在正中央。
   狀態機：idle（待機）→ walk（走向目標）→ idle（到達後休息一下）→ ...
   - 行走方向會自動翻轉（用 ctx.scale(-1,1) 讓小雞面向前進方向）
   - 睡眠、生病、死亡時停止漫步，回到畫面中央
   - 靠近邊界時會轉身往回走
   - 漫步速度隨成長階段調整（老雞比幼雞慢）
   ============================================================================ */
const ChickWander = (() => {
  let x = 0.5, y = 0.5;      // 相對座標（0-1），乘以 canvas 尺寸即為像素座標
  let targetX = 0.5, targetY = 0.5;
  let phase = 'idle';          // 'idle' | 'walk'
  let idleRemain = 0;          // idle 剩餘幀數
  let facingRight = true;
  const SPEED_BASE = 0.0012;   // 每幀移動量（相對座標）
  const MARGIN = 0.14;         // 邊界留白（相對座標）

  const STAGE_SPEEDS = {
    egg:0, baby:0.7, kid:1.0, teen:1.15, adult:1.2, old:0.6,
  };

  function _pickTarget(){
    // 往目前位置的反方向偏一點，避免一直在同一個角落打轉
    const angle = Math.random() * Math.PI * 2;
    const dist  = 0.18 + Math.random() * 0.32;
    targetX = Math.max(MARGIN, Math.min(1-MARGIN, x + Math.cos(angle)*dist));
    targetY = Math.max(0.52, Math.min(0.82, y + Math.sin(angle)*dist*0.4));
    // 水平移動方向決定小雞面向
    facingRight = targetX >= x;
    phase = 'walk';
  }

  /** 每幀呼叫（由 animManager chick actor 的 draw 觸發）。
      回傳 { wx, wy, isWalking, facingRight }。
      wx/wy 是畫布像素座標，外部傳給 drawChick 的 cx/cy。 */
  function tick(canvasW, canvasH){
    const stageKey = GameState.stage;
    // 蛋不動；睡眠/死亡時回中央
    if (stageKey === 'egg' || !GameState.alive){
      x = 0.5; y = 0.5; phase = 'idle';
      return { wx: canvasW*0.5, wy: canvasH*0.5 + 16, isWalking: false, facingRight: true };
    }
    if (GameState.isSleeping){
      // 睡覺時緩慢漂向右下角床邊
      x += (0.72 - x) * 0.005;
      y += (0.74 - y) * 0.005;
      return { wx: canvasW*x, wy: canvasH*y, isWalking: false, facingRight: true };
    }

    const speed = SPEED_BASE * (STAGE_SPEEDS[stageKey] ?? 1.0);

    if (phase === 'idle'){
      idleRemain--;
      if (idleRemain <= 0){
        // 20% 機率站久一點（假裝在吃東西或東張西望）
        if (Math.random() < 0.2){
          idleRemain = 60 + Math.floor(Math.random()*120);
        } else {
          _pickTarget();
        }
      }
    }

    if (phase === 'walk'){
      const dx = targetX - x, dy = targetY - y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < speed * 1.5){
        // 到達目標，切換到 idle
        x = targetX; y = targetY;
        phase = 'idle';
        idleRemain = 40 + Math.floor(Math.random() * 180);
      } else {
        x += (dx/dist) * speed;
        y += (dy/dist) * speed * 0.35;  // 垂直移動範圍較小，看起來更自然
        // 邊界反彈：靠近邊界時重新挑選目標
        if (x < MARGIN || x > 1-MARGIN || y < 0.5 || y > 0.84){
          x = Math.max(MARGIN+0.02, Math.min(1-MARGIN-0.02, x));
          y = Math.max(0.52, Math.min(0.82, y));
          _pickTarget();
        }
      }
    }

    return {
      wx: canvasW * x,
      wy: canvasH * y,
      isWalking: phase === 'walk',
      facingRight,
    };
  }

  /** 強制重置位置（場景切換、重新開始遊戲時呼叫）*/
  function reset(){
    x = 0.5; y = 0.68; targetX=0.5; targetY=0.68;
    phase='idle'; idleRemain=60; facingRight=true;
  }

  return { tick, reset };
})();

const SoundManager = (() => {
  let actx = null;
  function ensure(){ if (!actx) actx = new (window.AudioContext||window.webkitAudioContext)(); return actx; }
  function tone(freq, dur, type='square', delay=0, vol=0.06){
    if (!GameState.settings.sfx) return;
    const ctx = ensure();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur);
  }
  return {
    click: () => tone(520, 0.05),
    eat:   () => { tone(300,0.06); tone(420,0.06,'square',0.07); },
    sleep: () => tone(220,0.3,'sine'),
    levelup: () => { [523,659,784,1046].forEach((f,i)=>tone(f,0.12,'square',i*0.1)); },
    coin:  () => { tone(880,0.05); tone(1320,0.08,'square',0.05); },
    sick:  () => tone(160,0.25,'sawtooth'),
    death: () => { tone(300,0.4,'sine'); tone(200,0.5,'sine',0.2); },
    pop:   () => tone(700,0.04),
  };
})();

/* ============================================================================
   7. GameState — 數值 / 成長 / AI 行為 / 死亡 / 存讀檔
   ============================================================================ */
const GameState = {
  name: 'CHICK',
  alive: true,
  level: 1, exp: 0,
  gold: 50,
  ageMs: 0,                       // 累積遊戲內年齡（毫秒）
  weight: 50,
  hunger: 80, happy: 80, health: 100, energy: 80, clean: 80, sleepStat: 80,
  isSleeping: false,
  stage: 'egg',
  background: 'room',
  weather: 'sunny',               // 目前天氣：sunny / rain / night / snow / storm
  isDirty: false,                 // 是否有尚未手動存檔的變更
  diary: [],                      // 日記條目陣列，上限 500 筆
  outfit: { hat:false, glasses:false, scarf:false, clothes:false, wings:false,
             crown:false, bowtie:false, headphones:false, backpack:false, tie:false },
  inventory: { food_basic: 3, food_premium: 0, medicine: 0, soap: 0, toy: 0 },
  ownedWear: { hat:false, glasses:false, scarf:false, clothes:false,
               crown:false, bowtie:false, headphones:false, backpack:false, tie:false },
  lastLoginDate: null,
  settings: { sfx: true },
  createdAt: Date.now(),
  poopCount: 0,

  ageDays(){ return this.ageMs / DAY_LENGTH_MS; },

  getStage(){
    const days = this.ageDays();
    // 從最高階段往下找，傳回第一個「條件成立」的階段。
    // 用 <= 確保 days=0 時正確落在 'egg'（minAge:0），
    // days=0.05 時升到 'baby'（minAge:0.05），以此類推。
    let result = STAGES[0];
    for (const st of STAGES){
      if (days >= st.minAge) result = st;
    }
    return result;
  },

  addExp(n){
    this.exp += n;
    const need = this.level * 50;
    if (this.exp >= need){
      this.exp -= need;
      this.level++;
      UI.toast(`🎉 升級了！目前 Lv.${this.level}`);
      SoundManager.levelup();
      UI.playOneShot('levelup', 1600);
      this.addDiary('levelup', '升級了！', `小雞升上了 Lv.${this.level}，感覺更成熟了一些。`);
    }
  },

  addGold(n){ this.gold = Math.max(0, this.gold + n); },

  /** 標記「有未存檔的變更」。除了遊戲內顯性事件（升級、獲得道具等）之外，
      也在此統一設置，右上角會顯示閃爍的 ⚠️ UNSAVED 提示，直到玩家手動存檔。 */
  markDirty(){
    this.isDirty = true;
  },

  /** 新增一筆日記。結構：{ id, timestamp, gameDay, type, title, description }。
      陣列長度嚴格上限 500 筆，超過時剔除最舊的一筆，避免 LocalStorage 爆量。 */
  addDiary(type, title, description){
    this.diary.push({
      id: 'd' + Date.now() + Math.floor(Math.random()*1000),
      timestamp: Date.now(),
      gameDay: Math.floor(this.ageDays()),
      type, title, description,
    });
    if (this.diary.length > 500) this.diary.shift();
    this.markDirty();
  },

  /** 由主計時器呼叫：換算「距離上次真的執行過 tick 過了幾秒」，並且設定上限。
      瀏覽器分頁切到背景時，setInterval 常會被節流甚至完全暫停，重新回到前景時
      有可能一次補上一大段時間；如果直接把這段時間全部套用到數值衰減，
      小雞可能會在你切回分頁的瞬間「秒死」。這裡把單次套用的時間上限設為 60 秒，
      超過的部分不予補算（等同於離開很久只會讓小雞餓一點，不會不合理地暴斃）。 */
  simulate(){
    if (!this.alive) return;
    const now = Date.now();
    let elapsedSec = (now - (this.lastTickAt || now)) / 1000;
    this.lastTickAt = now;
    if (elapsedSec <= 0) return;
    elapsedSec = Math.min(elapsedSec, 60);
    this.tick(elapsedSec);
  },

  tick(elapsedSec = 1){
    if (!this.alive) return;
    this.ageMs += TICK_MS * elapsedSec;

    const wx = WEATHER_TYPES[this.weather].decay;

    if (!this.isSleeping){
      this.hunger = clamp(this.hunger - DECAY.hunger * wx.hunger * elapsedSec);
      this.happy  = clamp(this.happy  - DECAY.happy  * wx.happy  * elapsedSec);
      this.energy = clamp(this.energy - DECAY.energy * wx.energy * elapsedSec);
      this.clean  = clamp(this.clean  - DECAY.clean  * wx.clean  * elapsedSec);
      this.sleepStat = clamp(this.sleepStat - 0.25 * elapsedSec);
    } else {
      this.sleepStat = clamp(this.sleepStat + 4 * elapsedSec);
      // 睡眠是主要的活力來源：每秒恢復量提升為原本的 3 倍（3 -> 9）
      this.energy = clamp(this.energy + SLEEP_ENERGY_GAIN * elapsedSec);
      if (this.sleepStat >= 100) this.wake();
    }

    // 天氣造成的額外生病機率（暴風雨 sickChance 為晴天的 3 倍）
    const sickChance = WEATHER_TYPES[this.weather].sickChance;
    if (!this.isSleeping && Math.random() < 0.004 * sickChance * elapsedSec){
      const dmg = randInt(5, 15);
      this.health = clamp(this.health - dmg);
      const label = WEATHER_TYPES[this.weather].label;
      UI.toast(`🤒 因為${label}的關係，小雞著涼了...`);
      this.addDiary('sick', '著涼了', `受到${label}影響，小雞著涼了，健康下降 ${dmg} 點。`);
    }

    // 健康會被其他數值過低拖累，狀態良好則緩慢回復
    let healthDelta = 0.15;
    if (this.hunger < 20) healthDelta -= 0.5;
    if (this.happy  < 20) healthDelta -= 0.3;
    if (this.clean  < 30) healthDelta -= 0.3;
    if (this.sleepStat < 20) healthDelta -= 0.3;
    this.health = clamp(this.health + healthDelta * elapsedSec);

    // 體重隨飢餓變化微調
    this.weight = clamp(this.weight + (this.hunger > 70 ? 0.05 : -0.03) * elapsedSec, 10, 99);

    // 經驗值隨時間自然小幅增加（陪伴成長）
    this.addExp(0.4 * elapsedSec);

    this.checkStage();
    this.checkAI();
    this.checkDeath();
  },

  checkStage(){
    const s = this.getStage();
    if (s.key !== this.stage){
      this.stage = s.key;
      UI.toast(`✨ 小雞長大了！現在是「${s.label}」`);
      this.addDiary('growth', '長大了！', `小雞成長到了新的階段：${s.label}。`);
    }
  },

  checkAI(){
    // 依規格：各項數值過低時觸發對應提示 / 表情
    if (this.hunger < 20) UI.showBubble('🍗');
    else if (this.happy < 20) UI.showBubble('😢');
    else if (this.sleepStat < 20) UI.showBubble('🥱');
    else if (this.health < 20) UI.showBubble('🤒');
    else UI.hideBubble();

    if (this.clean < 30 && Math.random() < 0.02){
      this.poopCount++;
      UI.spawnPoop();
    }
  },

  checkDeath(){
    if (this.health <= 0 && this.alive){
      this.alive = false;
      // 防禦性處理：除了 tick() 開頭的 `if (!this.alive) return;` 之外，
      // 死亡當下立刻停掉主計時器，確保數值衰減與存檔迴圈不會在死亡後繼續跑。
      if (mainTickInterval){
        clearInterval(mainTickInterval);
        mainTickInterval = null;
      }
      this.addDiary('death', '小雞去了天堂', `在第 ${Math.floor(this.ageDays())} 天，健康耗盡，小雞安詳地離開了。`);
      UI.showDeath();
    }
  },

  currentDominantState(){
    if (!this.alive) return 'dead';
    if (this.isSleeping) return 'sleep';
    if (this.health < 20) return 'sick';
    if (this.hunger < 20 || this.happy < 20) return 'sad';
    return 'idle';
  },

  feed(){
    if (!this.alive) return;
    let amount = 18;
    if (this.inventory.food_premium > 0){
      this.inventory.food_premium--; amount = 32;
    } else if (this.inventory.food_basic > 0){
      this.inventory.food_basic--; amount = 22;
    }
    this.hunger = clamp(this.hunger + amount);
    this.weight = clamp(this.weight + 1, 10, 99);
    this.addExp(2);
    SoundManager.eat();
    UI.playOneShot('eat', 900);
  },

  water(){
    if (!this.alive) return;
    this.hunger = clamp(this.hunger + 6);
    this.clean = clamp(this.clean + 2);
    SoundManager.click();
    UI.playOneShot('idle', 400);
  },

  play(){
    if (!this.alive) return;
    let bonus = this.inventory.toy > 0 ? 30 : 18;
    if (this.inventory.toy > 0) this.inventory.toy--;
    this.happy = clamp(this.happy + bonus);
    this.energy = clamp(this.energy - 10);
    this.addExp(3);
    SoundManager.click();
    UI.playOneShot('happy', 1200);
  },

  bath(){
    if (!this.alive) return;
    this.clean = clamp(this.clean + 35);
    this.happy = clamp(this.happy + 3);
    this.poopCount = 0;
    UI.clearPoop();
    SoundManager.click();
    UI.playOneShot('clean', 1300);
  },

  sleepToggle(){
    if (!this.alive) return;
    this.isSleeping = !this.isSleeping;
    if (this.isSleeping){ SoundManager.sleep(); }
    else { UI.playOneShot('idle', 600); }
  },
  wake(){
    this.isSleeping = false;
    UI.toast('☀️ 小雞睡醒了！');
  },

  doctor(){
    if (!this.alive) return;
    if (this.inventory.medicine > 0){
      this.inventory.medicine--;
      this.health = clamp(this.health + 40);
      UI.toast('💊 吃藥了，健康恢復不少！');
    } else if (this.gold >= 20){
      this.gold -= 20;
      this.health = clamp(this.health + 25);
      UI.toast('💊 緊急買藥治療（花費 20 金幣）');
    } else {
      UI.toast('❌ 沒有藥也沒有錢，先去工作賺錢吧！');
      return;
    }
    SoundManager.click();
    UI.playOneShot('idle', 800);
  },

  clean_(){
    this.poopCount = 0;
    this.clean = clamp(this.clean + 15);
    UI.clearPoop();
    SoundManager.pop();
  },

  /** 手動使用背包中的消耗品（目前僅活力藥水，未來可依 id 擴充其他效果） */
  useItem(id){
    if (!this.alive) return;
    if ((this.inventory[id]||0) <= 0){ UI.toast('❌ 沒有這個道具，先去商店買一瓶吧！'); return; }
    this.inventory[id]--;
    if (id === 'energy_potion'){
      this.energy = clamp(100);
      UI.toast('🧪 活力藥水生效，活力已完全填滿！');
      this.addDiary('item', '使用活力藥水', '喝下活力藥水，精神百倍，活力瞬間填滿。');
    }
    SoundManager.click();
    this.markDirty();
    UI.updateStats();
  },

  work(){
    if (!this.alive) return;
    if (this.energy < 15){ UI.toast('😩 太累了，先休息一下吧！'); return; }
    const earn = randInt(8, 22);
    this.gold += earn;
    this.energy = clamp(this.energy - 18);
    this.happy = clamp(this.happy - 5);
    this.addExp(4);
    SoundManager.coin();
    UI.toast(`💼 工作完成，獲得 ${earn} 金幣！`);
    this.addDiary('work', '工作賺錢', `努力工作了一下，賺到了 ${earn} 金幣。`);
  },

  dailyReward(){
    const today = new Date().toDateString();
    if (this.lastLoginDate === today){
      UI.toast('📅 今天已經領過每日獎勵囉，明天再來！');
      return;
    }
    this.lastLoginDate = today;
    this.gold += 100;
    this.inventory.food_premium += 1;
    SoundManager.coin();
    UI.toast('🎁 每日登入獎勵：+100 金幣、特殊飼料 x1！');
    UI.playOneShot('levelup', 1500);
    this.addDiary('daily', '每日登入獎勵', '今天第一次上線，領到了 100 金幣和特殊飼料。');
  },

  restart(){
    UI._deathShown = false;
    Object.assign(this, {
      name:'CHICK', alive:true, level:1, exp:0, gold:50, ageMs:0, weight:50,
      hunger:80, happy:80, health:100, energy:80, clean:80, sleepStat:80,
      isSleeping:false, stage:'egg', background:'room', weather:'sunny',
      outfit:{hat:false,glasses:false,scarf:false,clothes:false,wings:false,
               crown:false,bowtie:false,headphones:false,backpack:false,tie:false},
      inventory:{food_basic:3, food_premium:0, medicine:0, soap:0, toy:0},
      ownedWear:{hat:false,glasses:false,scarf:false,clothes:false,
                 crown:false,bowtie:false,headphones:false,backpack:false,tie:false},
      poopCount:0, diary:[], isDirty:true, lastTickAt: Date.now(), lastLoginDate: null,
    });
    UI.clearPoop();
    ChickWander.reset();
    drawBackground(this.background);
    if (!mainTickInterval){
      mainTickInterval = setInterval(() => {
        GameState.simulate();
        UI.updateStats();
      }, TICK_MS);
    }
  },
};

/* ============================================================================
   8. ShopSystem
   ============================================================================ */
const SHOP_ITEMS = {
  food: [
    { id:'food_basic',   name:'普通飼料', icon:'🌾', price:5,  desc:'恢復飽食 +22' },
    { id:'food_premium', name:'高級飼料', icon:'🍗', price:15, desc:'恢復飽食 +32，額外經驗' },
  ],
  goods: [
    { id:'medicine', name:'藥品',     icon:'💊', price:20, desc:'治療生病，恢復健康 +40' },
    { id:'soap',     name:'清潔用品', icon:'🧼', price:8,  desc:'快速清潔（與洗澡同效）' },
    { id:'toy',      name:'玩具',     icon:'🧸', price:12, desc:'玩耍效果加倍' },
    { id:'energy_potion', name:'活力藥水', icon:'🧪', price:18, desc:'立即將活力完全填滿', usable:true },
  ],
  wear: [
    { id:'hat',        name:'帽子',     icon:'🎩', price:30, desc:'時尚帽子裝扮' },
    { id:'glasses',    name:'眼鏡',     icon:'🕶️', price:25, desc:'酷酷的眼鏡' },
    { id:'scarf',      name:'圍巾',     icon:'🧣', price:20, desc:'溫暖圍巾' },
    { id:'clothes',    name:'服裝',     icon:'👕', price:35, desc:'可愛小衣服' },
    { id:'crown',      name:'皇冠',     icon:'👑', price:60, desc:'尊貴皇冠，閃閃發亮' },
    { id:'bowtie',     name:'蝴蝶結',   icon:'🎀', price:18, desc:'俏皮蝴蝶結' },
    { id:'headphones', name:'耳機',     icon:'🎧', price:28, desc:'潮流耳機' },
    { id:'backpack',   name:'小背包',   icon:'🎒', price:22, desc:'可愛小背包' },
    { id:'tie',        name:'領帶',     icon:'👔', price:24, desc:'紳士領帶' },
  ],
};

const Shop = {
  buy(category, id){
    const item = SHOP_ITEMS[category].find(i => i.id === id);
    if (!item) return;
    if (GameState.gold < item.price){
      UI.toast('❌ 金幣不足！');
      return;
    }
    GameState.gold -= item.price;
    if (category === 'wear'){
      GameState.ownedWear[id] = true;
      GameState.outfit[id] = true; // 購買後直接穿上
    } else {
      GameState.inventory[id] = (GameState.inventory[id]||0) + 1;
    }
    SoundManager.coin();
    UI.toast(`✅ 購買成功：${item.name}`);
    GameState.addDiary('shop', '購物', `買了「${item.name}」。`);
    UI.renderShop();
    UI.updateStats();
  },
};

/* ============================================================================
   9. EventSystem — 隨機事件
   ============================================================================ */
const RANDOM_EVENTS = [
  { text:'🪙 小雞在地上找到了金幣！', fn:()=>{ GameState.addGold(randInt(5,25)); SoundManager.coin(); } },
  { text:'🐤 遇到了一隻朋友，心情變好了！', fn:()=>{ GameState.happy = clamp(GameState.happy+15); } },
  { text:'🎁 收到了一份神秘禮物！', fn:()=>{ GameState.inventory.food_premium++; } },
  { text:'🤒 著涼了，健康下降...', fn:()=>{ GameState.health = clamp(GameState.health-15); } },
  { text:'🍽️ 肚子突然餓得比較快...', fn:()=>{ GameState.hunger = clamp(GameState.hunger-15); } },
  { text:'😄 心情莫名變得超好！', fn:()=>{ GameState.happy = clamp(GameState.happy+20); } },
  { text:'🌦️ 天氣變化，活力受到影響。', fn:()=>{ GameState.energy = clamp(GameState.energy-10); } },
];

/* ============================================================================
   8.5. MiniGameSystem — 可玩的像素小遊戲
   ----------------------------------------------------------------------------
   架構：MiniGameSystem 是所有小遊戲的統一管理器，負責：
   - showMenu()：彈出遊戲選單讓玩家選擇
   - launch(id)：啟動指定遊戲（初始化 Canvas、鎖定主遊戲輸入、啟動 RAF 迴圈）
   - finish(result)：統一結算（計算金幣/飽食/心情獎勵、寫入日記、解除輸入鎖）
   每款遊戲是一個獨立的 object，實作 { start, stop, handleInput } 介面。
   ============================================================================ */
const MiniGameSystem = (() => {
  /* ---- DOM refs ---- */
  let overlay, mgCanvas, mgCtx, hud, quitBtn, resultDiv, resultTitle, resultMsg, resultReward, resultClose;
  let currentGame = null;
  let rafId = null;
  let inputLocked = false;     // 主遊戲輸入鎖（小遊戲進行中封鎖主界面按鈕點擊）
  let wheelUsedToday = null;   // 幸運轉盤每日限一次

  function init(){
    overlay      = document.getElementById('mg-overlay');
    mgCanvas     = document.getElementById('mg-canvas');
    mgCtx        = mgCanvas.getContext('2d');
    mgCtx.imageSmoothingEnabled = false;
    hud          = document.getElementById('mg-hud');
    quitBtn      = document.getElementById('mg-quit-btn');
    resultDiv    = document.getElementById('mg-result');
    resultTitle  = document.getElementById('mg-result-title');
    resultMsg    = document.getElementById('mg-result-msg');
    resultReward = document.getElementById('mg-result-reward');
    resultClose  = document.getElementById('mg-result-close');

    // 依可視視窗調整 canvas 尺寸（保持正方形 / 填滿短邊）
    const side = Math.min(window.innerWidth, window.innerHeight, 420);
    mgCanvas.width  = side;
    mgCanvas.height = side;

    quitBtn.addEventListener('click', () => finish(null));
    resultClose.addEventListener('click', () => {
      resultDiv.classList.add('hidden');
      hide();
    });
    document.querySelectorAll('.mg-select').forEach(btn => {
      btn.addEventListener('click', () => {
        UI.closeModal('minigame-menu-modal');
        launch(btn.dataset.game);
      });
    });
  }

  function showMenu(){
    UI.openModal('minigame-menu-modal');
  }

  function launch(id){
    overlay.classList.remove('hidden');
    inputLocked = true;
    if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
    // 移除舊的翻牌 DOM grid（如有殘留）
    const oldGrid = document.getElementById('mg-memory-grid');
    if (oldGrid) oldGrid.remove();

    switch(id){
      case 'catchfood': currentGame = CatchFoodGame; break;
      case 'bughunt':   currentGame = BugHuntGame;   break;
      case 'memory':    currentGame = MemoryGame;    break;
      case 'wheel':     currentGame = WheelGame;     break;
      case 'rps':       currentGame = RPSGame;       break;
      case 'chickenrun': currentGame = ChickenRunGame; break;
      case 'lanerun':   currentGame = LaneRunGame;   break;
      default: return;
    }
    // 凍結主遊戲數值衰減：清除主計時器，讓小雞在遊戲期間不餓死
    if (mainTickInterval){ clearInterval(mainTickInterval); mainTickInterval = null; }
    currentGame.start(mgCanvas, mgCtx, hud, () => finish(currentGame.getResult()));
    const loop = () => {
      if (!currentGame || currentGame.done) return;
      currentGame.update();
      currentGame.render(mgCtx);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function finish(result){
    if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
    if (currentGame){ currentGame.stop(); currentGame = null; }
    inputLocked = false;
    // 移除翻牌 DOM grid
    const oldGrid = document.getElementById('mg-memory-grid');
    if (oldGrid) oldGrid.remove();

    // 解凍主遊戲：重設 lastTickAt 為現在，這樣 simulate() 的 delta 從 0 重算，
    // 跑酷遊玩期間不會被算進「離線時間補償」造成小雞暴斃。
    GameState.lastTickAt = Date.now();
    if (!mainTickInterval){
      mainTickInterval = setInterval(() => { GameState.simulate(); UI.updateStats(); }, TICK_MS);
    }

    if (!result){ hide(); return; }

    // 套用獎勵
    if (result.gold)      GameState.addGold(result.gold);
    if (result.hunger)    GameState.hunger  = clamp(GameState.hunger  + result.hunger);
    // 玩遊戲不管成敗都給 +20 心情（玩耍本身就令小雞開心）
    const baseHappy = 20;
    GameState.happy = clamp(GameState.happy + baseHappy + (result.happy || 0) + (result.happyPen || 0));

    const rewardParts = [];
    if (result.gold > 0)  rewardParts.push(`+${result.gold} 💰`);
    if (result.hunger > 0) rewardParts.push(`+${result.hunger} 🍗`);
    const totalHappy = baseHappy + (result.happy || 0) + (result.happyPen || 0);
    rewardParts.push(`${totalHappy >= 0 ? '+' : ''}${totalHappy} 😊`);

    GameState.addDiary('minigame', result.gameName, result.summary + (rewardParts.length ? ` 獎勵：${rewardParts.join(' ')}` : ''));
    GameState.markDirty();
    UI.updateStats();

    resultTitle.textContent  = result.gameName;
    resultMsg.textContent    = result.summary;
    resultReward.textContent = rewardParts.length ? `獲得：${rewardParts.join('  ')}` : '這次沒有獎勵...';
    resultDiv.classList.remove('hidden');
  }

  function hide(){
    overlay.classList.add('hidden');
    mgCtx.clearRect(0, 0, mgCanvas.width, mgCanvas.height);
    hud.textContent = '';
  }

  /** 幸運轉盤專用啟動器：跳過小遊戲選單，也跳過 +20 baseHappy，
      轉盤自己的扇形決定所有獎懲，不屬於「玩耍」的情緒加成範疇。 */
  function launchWheel(){
    overlay.classList.remove('hidden');
    inputLocked = true;
    if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
    currentGame = WheelGame;
    currentGame.start(mgCanvas, mgCtx, hud, () => finishWheel());
    const loop = () => {
      if (!currentGame || currentGame.done) return;
      currentGame.update();
      currentGame.render(mgCtx);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  /** 幸運轉盤結算：WheelGame.settle() 已直接套用 GameState 數值，
      這裡只負責顯示結算訊息和寫日記，不再重複套用也不加 baseHappy。 */
  function finishWheel(){
    if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
    inputLocked = false;
    const result = WheelGame.getResult();
    if (!result){ hide(); return; }
    const rewardParts = [];
    if (result.gold > 0)   rewardParts.push(`+${result.gold} 💰`);
    if (result.hunger > 0) rewardParts.push(`+${result.hunger} 🍗`);
    if ((result.happy||0) !== 0) rewardParts.push(`${result.happy>0?'+':''}${result.happy} 😊`);
    GameState.addDiary('minigame', '幸運轉盤', result.summary + (rewardParts.length ? ` 獎勵：${rewardParts.join(' ')}` : ''));
    GameState.markDirty();
    UI.updateStats();
    resultTitle.textContent  = '幸運轉盤';
    resultMsg.textContent    = result.summary;
    resultReward.textContent = rewardParts.length ? `獲得：${rewardParts.join('  ')}` : '這次什麼都沒有...';
    resultDiv.classList.remove('hidden');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showMenu, launch, finish, launchWheel, isLocked: () => inputLocked };
})();

/* ============================================================================
   🍗 GAME 1：接飼料《飢餓大作戰》
   小雞左右移動，接住從天而降的食物，避開腐壞食物。
   操作：觸控左/右半邊點擊 或 鍵盤 ←→
   ============================================================================ */
const CatchFoodGame = (() => {
  let W, H, ctx, done, resultData, endCb, hud;
  let chickX, chickSpeed, score, misses, timeLeft, startT, lastT;
  let items = [], spawnTimer = 0;
  const GOOD  = ['🌽','🥚','🌾','🍠','🥕'];
  const BAD   = ['💀']; // 壞食物一律是骷髏，清晰易辨
  let keys = { left:false, right:false };
  let touchX = null;

  function start(canvas, c, hudEl, cb){
    W=canvas.width; H=canvas.height; ctx=c; hud=hudEl; endCb=cb;
    done=false; score=0; misses=0; timeLeft=30; startT=performance.now(); lastT=startT;
    chickX=W/2; chickSpeed=W/160;
    items=[]; spawnTimer=0; resultData=null;
    hud.textContent='⏱️ 30  🌽 0';

    const onKey = (e) => {
      if (e.type==='keydown'){ if(e.key==='ArrowLeft') keys.left=true; if(e.key==='ArrowRight') keys.right=true; }
      else { if(e.key==='ArrowLeft') keys.left=false; if(e.key==='ArrowRight') keys.right=false; }
    };
    const onTouch = (e) => { touchX = e.touches[0]?.clientX ?? null; };
    const onTouchEnd = () => { touchX = null; };
    document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKey);
    canvas.addEventListener('touchstart', onTouch, {passive:true});
    canvas.addEventListener('touchmove', onTouch, {passive:true});
    canvas.addEventListener('touchend', onTouchEnd);
    CatchFoodGame._cleanup = () => {
      document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKey);
      canvas.removeEventListener('touchstart', onTouch);
      canvas.removeEventListener('touchmove', onTouch);
      canvas.removeEventListener('touchend', onTouchEnd);
    };
  }

  function update(){
    if (done) return;
    const now = performance.now();
    const dt = Math.min((now - lastT)/1000, 0.1);
    lastT = now;
    timeLeft = Math.max(0, 30 - (now - startT)/1000);
    if (timeLeft <= 0){ endGame(); return; }

    // 小雞移動
    const speed = chickSpeed * W;
    if (keys.left) chickX = Math.max(24, chickX - speed * dt * 60);
    if (keys.right) chickX = Math.min(W-24, chickX + speed * dt * 60);
    if (touchX !== null){
      const rect = ctx.canvas.getBoundingClientRect();
      const tx = (touchX - rect.left) * (W / rect.width);
      chickX += (tx - chickX) * 0.18;
      chickX = clamp(chickX, 24, W-24);
    }

    // 生成食物
    spawnTimer -= dt;
    if (spawnTimer <= 0){
      spawnTimer = rand(0.4, 1.2);
      const isBad = Math.random() < 0.25;
      items.push({ x: rand(20, W-20), y: -20, speed: rand(H/5, H/3), emoji: isBad ? choice(BAD) : choice(GOOD), bad:isBad });
    }

    // 更新食物位置 + 碰撞
    items = items.filter(it => {
      it.y += it.speed * dt;
      if (it.y > H - 44 && Math.abs(it.x - chickX) < 36){
        if (it.bad){ score = Math.max(0, score-5); } else { score += 10; }
        return false;
      }
      if (it.y > H + 10){ if (!it.bad) misses++; return false; }
      return true;
    });
    if (misses >= 5){ endGame(); return; }
    hud.textContent = `⏱️ ${Math.ceil(timeLeft)}  🌽 ${score}  💔 ${misses}/5`;
  }

  function render(c){
    c.clearRect(0,0,W,H);
    // 背景
    pxRect(c,0,0,W,H*0.65,'#bfe9ff');
    pxRect(c,0,H*0.65,W,H*0.35,'#8fcf6a');
    pxRect(c,0,H-44,W,4,'#6fae5a');

    // 食物
    const efs = Math.round(W/13);
    c.font=`${efs}px serif`; c.textAlign='center'; c.textBaseline='middle';
    items.forEach(it => c.fillText(it.emoji, it.x, it.y));

    // 小雞（直接用 pxRect 畫簡易像素小雞，精確定位在 chickX）
    const cy = H - 40;
    const bob = Math.sin(performance.now()/200)*3;
    fillPixelCircle(c, chickX, cy+bob, 20, '#ffd23f');
    fillPixelCircle(c, chickX-5, cy-12+bob, 12, '#ffe87a');
    fillPixelCircle(c, chickX-8, cy+4+bob, 8, '#e8a800');
    fillPixelCircle(c, chickX+8, cy+4+bob, 8, '#e8a800');
    pxRect(c, chickX-4, cy+6+bob, 8, 5, '#ff8c3b');
    fillPixelCircle(c, chickX-7, cy-2+bob, 4, '#2b2017');
    fillPixelCircle(c, chickX+3, cy-2+bob, 4, '#2b2017');
    fillPixelCircle(c, chickX-6, cy+14+bob, 5, '#ff8c3b');
    fillPixelCircle(c, chickX+2, cy+14+bob, 5, '#ff8c3b');
  }

  function endGame(){
    if (done) return; done=true;
    const coins = Math.floor(score/5);
    const hungerGain = Math.min(25, Math.floor(score/4));
    const summary = score >= 80 ? '小雞吃得超級滿足！肚子圓滾滾的～' :
                    score >= 30 ? '還可以，小雞勉強填飽肚子。' :
                                  '小雞還是餓著肚子……下次要加油！';
    resultData = { gameName:'接飼料', gold:coins, hunger:hungerGain, happy:5, happyPen:0, summary };
    if (endCb) endCb();
  }

  function stop(){ if (CatchFoodGame._cleanup) CatchFoodGame._cleanup(); keys={left:false,right:false}; touchX=null; }
  function getResult(){ return resultData; }

  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

/* ============================================================================
   🐛 GAME 2：抓蟲大作戰
   點擊畫面上的蟲子，好蟲加分、毒蟲扣心情，30秒結算。
   ============================================================================ */
const BugHuntGame = (() => {
  let W, H, ctx, done, resultData, endCb, hud;
  let bugs=[], score=0, penalty=0, timeLeft, startT;
  const GOOD_BUGS = ['🪱','🐛','🦗','🐝','🦋'];
  const BAD_BUGS  = ['💀']; // 壞蟲一律是骷髏，讓玩家一眼就能分辨

  function spawnBug(){
    const isBad = Math.random() < 0.30;
    bugs.push({ x:rand(28,W-28), y:rand(60,H-60), emoji: isBad?choice(BAD_BUGS):choice(GOOD_BUGS), bad:isBad, ttl:rand(1.5,3.2), age:0, scale:1 });
  }

  function start(canvas, c, hudEl, cb){
    W=canvas.width; H=canvas.height; ctx=c; hud=hudEl; endCb=cb;
    done=false; score=0; penalty=0; timeLeft=30; startT=performance.now(); bugs=[];
    for(let i=0;i<5;i++) spawnBug();
    hud.textContent='🐛 0  ☠️ 0  ⏱️ 30';
    let lastTouchFired = false; // 防止 touchstart → 合成 click 雙重觸發
    const onClick = (e) => {
      if (e.type === 'touchstart') lastTouchFired = true;
      else if (lastTouchFired){ lastTouchFired = false; return; } // 跳過合成 click

      const rect = canvas.getBoundingClientRect();
      const src  = e.touches?.[0] ?? e;
      const mx = (src.clientX ?? 0) - rect.left;
      const my = (src.clientY ?? 0) - rect.top;
      // canvas 的 CSS 顯示尺寸與內部解析度可能不同（因為 dpr），要統一換算
      const scaleX = canvas.width  / rect.width;
      const scaleY = canvas.height / rect.height;
      const bx = mx * scaleX, by = my * scaleY;
      for(let i=bugs.length-1;i>=0;i--){
        const b=bugs[i];
        // 碰撞半徑改為相對畫布大小，避免大螢幕判定偏小
        const hitR = Math.max(28, canvas.width / 14);
        if(Math.abs(bx-b.x)<hitR && Math.abs(by-b.y)<hitR){
          if(b.bad){ penalty++; } else { score+=10; }
          bugs.splice(i,1);
          spawnBug();
          break;
        }
      }
    };
    canvas.addEventListener('touchstart', onClick, {passive:true});
    canvas.addEventListener('click', onClick);
    BugHuntGame._cleanup = () => {
      canvas.removeEventListener('touchstart', onClick);
      canvas.removeEventListener('click', onClick);
    };
  }

  function update(){
    if(done) return;
    const now = performance.now();
    timeLeft = Math.max(0, 30-(now-startT)/1000);
    if(timeLeft<=0){ endGame(); return; }
    const dt = 1/60;
    bugs.forEach(b => { b.age+=dt; b.scale = 1 + Math.sin(b.age*4)*0.08; });
    bugs = bugs.filter(b => { if(b.age>=b.ttl){ return false; } return true; });
    // 保持畫面上始終有 4~6 隻蟲子，無論玩家按多快或蟲子過期多快，
    // 都不會出現蟲子全消失、無法繼續遊戲的情況。
    const MIN_BUGS = 4, MAX_BUGS = 7;
    while(bugs.length < MIN_BUGS) spawnBug();
    // 蟲子過多時不再生（避免畫面太亂）
    if(bugs.length < MAX_BUGS && Math.random() < 0.02) spawnBug();
    hud.textContent=`🐛 ${score}  ☠️ ${penalty}  ⏱️ ${Math.ceil(timeLeft)}`;
  }

  function render(c){
    c.clearRect(0,0,W,H);
    pxRect(c,0,0,W,H,'#c8e8b0');
    for(let i=0;i<12;i++) fillPixelCircle(c,(i*83)%W,(i*61)%H+20,8,'#a8cc88');
    c.textAlign='center'; c.textBaseline='middle';
    bugs.forEach(b => {
      const fs = Math.round(W/11 * b.scale);
      c.font=`${fs}px serif`;
      c.fillText(b.emoji, b.x, b.y);
    });
  }

  function endGame(){
    if(done) return; done=true;
    const coins = Math.floor(score/4);
    const summary = score>=80 ? '抓得超厲害！小雞吃得非常飽！' :
                    score>=30 ? '還不錯，小雞抓到了一些食物。' :
                                '小雞抓蟲不太熟練……';
    resultData = { gameName:'抓蟲大作戰', gold:coins, hunger:Math.min(15,Math.floor(score/6)), happy: score>30?8:-5, happyPen: penalty*3>0?-penalty*3:0, summary };
    if(endCb) endCb();
  }
  function stop(){ if(BugHuntGame._cleanup) BugHuntGame._cleanup(); }
  function getResult(){ return resultData; }
  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

/* ============================================================================
   🃏 GAME 3：翻牌記憶《小雞記憶挑戰》
   4×4 DOM 翻牌，找出 8 對相同圖案，步數越少分越高。
   ============================================================================ */
const MemoryGame = (() => {
  let done, resultData, endCb, hud, steps, matched, firstCard, locked;
  const PAIRS = ['🐥','🥚','🌽','🌻','🍓','🥕','🌾','🦋'];

  function start(canvas, c, hudEl, cb){
    hud=hudEl; endCb=cb; done=false; resultData=null; steps=0; matched=0; firstCard=null; locked=false;
    hud.textContent='🃏 步數 0 / 配對 0/8';

    // 建立 DOM 網格覆蓋在 mg-overlay 上
    const grid = document.createElement('div');
    grid.id='mg-memory-grid';
    document.getElementById('mg-overlay').appendChild(grid);

    const shuffled = [...PAIRS, ...PAIRS].sort(()=>Math.random()-0.5);
    shuffled.forEach((emoji, i) => {
      const card = document.createElement('div');
      card.className='mg-card hidden-face';
      card.dataset.emoji = emoji;
      card.dataset.idx = i;
      card.addEventListener('click', () => onCardClick(card, emoji));
      grid.appendChild(card);
    });
    c.clearRect(0,0,canvas.width,canvas.height);
    pxRect(c,0,0,canvas.width,canvas.height,'#2b2017');
  }

  function onCardClick(card, emoji){
    if(locked||done||card.classList.contains('matched')||card.classList.contains('flipped')) return;
    card.classList.remove('hidden-face'); card.classList.add('flipped'); card.textContent=emoji;
    if(!firstCard){ firstCard=card; return; }
    steps++;
    if(firstCard.dataset.emoji === emoji && firstCard !== card){
      firstCard.classList.add('matched'); card.classList.add('matched');
      matched++; firstCard=null;
      hud.textContent=`🃏 步數 ${steps} / 配對 ${matched}/8`;
      if(matched>=8) endGame();
    } else {
      locked=true;
      const prev=firstCard; firstCard=null;
      setTimeout(()=>{
        prev.classList.remove('flipped'); prev.classList.add('hidden-face'); prev.textContent='';
        card.classList.remove('flipped'); card.classList.add('hidden-face'); card.textContent='';
        locked=false;
        hud.textContent=`🃏 步數 ${steps} / 配對 ${matched}/8`;
      }, 700);
    }
  }

  function endGame(){
    if(done) return; done=true;
    const coins = steps<=18 ? 30 : steps<=28 ? 15 : 5;
    const summary = steps<=18 ? '小雞驚訝地發現你比牠還會記東西！' :
                    steps<=28 ? '還不錯，小雞開始記得一些東西了。' :
                                '小雞忘光光了……但牠還是很努力！';
    resultData = { gameName:'翻牌記憶', gold:coins, hunger:0, happy:10, happyPen:0, summary };
    if(endCb) endCb();
  }

  function update(){} // DOM 驅動，不需要 RAF update
  function render(){} // DOM 驅動，不需要 Canvas render
  function stop(){ const g=document.getElementById('mg-memory-grid'); if(g) g.remove(); }
  function getResult(){ return resultData; }
  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

/* ============================================================================
   🎡 GAME 4：幸運轉盤（每日一轉）
   CSS/Canvas 動畫轉盤，停下來後給予隨機獎勵或負面事件。
   ============================================================================ */
const WheelGame = (() => {
  let W, H, ctx, done, resultData, endCb, hud;
  let angle=0, spinning=false, speed=0, targetSegment=-1, decelStart=0, started=false;
  const SEGMENTS = [
    { label:'+50 💰', color:'#ffd23f', reward:{ gold:50 } },
    { label:'+飼料', color:'#b6e3a1', reward:{ hunger:20 } },
    { label:'+20 💰', color:'#6fc3df', reward:{ gold:20 } },
    { label:'😊+心情', color:'#ff9fb2', reward:{ happy:25 } },
    { label:'☁️ 沒事', color:'#c9c9c9', reward:{} },
    { label:'💊 藥品', color:'#b08bdb', reward:{ inv_medicine:1 } },
    { label:'-心情', color:'#e8584a', reward:{ happy:-20 } },
    { label:'+100 💰', color:'#ffd23f', reward:{ gold:100 } },
  ];
  const N = SEGMENTS.length;
  const SEG = Math.PI*2/N;

  function start(canvas, c, hudEl, cb){
    W=canvas.width; H=canvas.height; ctx=c; hud=hudEl; endCb=cb;
    done=false; resultData=null; spinning=false; speed=0; started=false; angle=0;

    const today = new Date().toDateString();
    if (WheelGame.usedDay === today){
      hud.textContent='今天已經轉過了，明天再來！';
      resultData={ gameName:'幸運轉盤', gold:0, hunger:0, happy:0, happyPen:0, summary:'今天已經轉過幸運轉盤了，明天再來！' };
      done=true; if(endCb) setTimeout(endCb,1500); return;
    }
    hud.textContent='點擊轉盤開始旋轉！';
    canvas.addEventListener('click', onSpin);
    WheelGame._cleanup = () => canvas.removeEventListener('click', onSpin);
  }

  function onSpin(){
    if(spinning||started) return;
    spinning=true; started=true;
    speed = rand(8, 14);
    targetSegment = randInt(0, N-1);
    const targetAngle = -targetSegment*SEG - SEG/2 + Math.PI*2*randInt(3,6);
    decelStart = performance.now() + 1200;
    WheelGame._target = targetAngle;
    WheelGame._startSpeed = speed;
  }

  function update(){
    if(!spinning||done) return;
    const now = performance.now();
    if(now < decelStart){
      angle += speed * 0.04;
    } else {
      speed = Math.max(0, speed * 0.975);
      angle += speed * 0.04;
      if(speed < 0.04){ settle(); }
    }
  }

  function settle(){
    spinning=false; done=true;
    const seg = SEGMENTS[targetSegment];
    WheelGame.usedDay = new Date().toDateString();
    const r = seg.reward;
    if(r.gold) GameState.addGold(r.gold);
    if(r.hunger) GameState.hunger = clamp(GameState.hunger + r.hunger);
    if(r.happy)  GameState.happy  = clamp(GameState.happy  + r.happy);
    if(r.inv_medicine) GameState.inventory.medicine = (GameState.inventory.medicine||0)+1;
    const summary = `轉盤停在「${seg.label}」！`;
    resultData={ gameName:'幸運轉盤', gold:r.gold||0, hunger:r.hunger||0, happy:Math.max(0,r.happy||0), happyPen:Math.min(0,r.happy||0), summary };
    if(endCb) setTimeout(endCb, 800);
  }

  function render(c){
    c.clearRect(0,0,W,H);
    pxRect(c,0,0,W,H,'#2b2017');
    const cx=W/2, cy=H/2, r=Math.min(W,H)*0.38;
    // 轉盤扇形
    SEGMENTS.forEach((seg,i) => {
      const start=angle+i*SEG, end=start+SEG;
      c.beginPath(); c.moveTo(cx,cy);
      c.arc(cx,cy,r,start,end); c.closePath();
      c.fillStyle=seg.color; c.fill();
      c.strokeStyle='#2b2017'; c.lineWidth=3; c.stroke();
      // 文字
      c.save();
      c.translate(cx,cy);
      c.rotate(start+SEG/2);
      c.fillStyle='#2b2017'; c.font=`bold ${Math.round(r/8)}px monospace`;
      c.textAlign='right'; c.textBaseline='middle';
      c.fillText(seg.label, r*0.88, 0);
      c.restore();
    });
    // 中心圓
    c.beginPath(); c.arc(cx,cy,r*0.12,0,Math.PI*2);
    c.fillStyle='#fff8e0'; c.fill(); c.strokeStyle='#2b2017'; c.lineWidth=3; c.stroke();
    // 指針
    c.beginPath();
    c.moveTo(cx, cy-r-8);
    c.lineTo(cx-12, cy-r+16);
    c.lineTo(cx+12, cy-r+16);
    c.closePath();
    c.fillStyle='#e8584a'; c.fill();
    c.strokeStyle='#2b2017'; c.lineWidth=2; c.stroke();
  }

  function stop(){ if(WheelGame._cleanup) WheelGame._cleanup(); }
  function getResult(){ return resultData; }
  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

/* ============================================================================
   🎮 GAME 5：《小雞猜拳對決》Rock-Paper-Scissors
   ----------------------------------------------------------------------------
   架構完全符合 MiniGameBase 介面：start / update / render / stop / getResult
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  AI 行為邏輯                                                              │
   │  40% 純隨機                                                               │
   │  30% 歷史分析（讀玩家最近 6 次出拳中最常出的，然後出剋制它的）            │
   │  20% 連勝反制（玩家連勝 ≥ 2 時，偏向出剋制玩家上一手的拳）              │
   │  10% 情緒影響（心情高 → 主動攻擊；生病 → 隨機率大增）                   │
   └──────────────────────────────────────────────────────────────────────────┘
   ============================================================================ */
const RPSGame = (() => {
  /* ---- 常數 ---- */
  const CHOICES   = ['✊','✌️','✋'];   // 石頭、剪刀、布
  const NAMES     = ['石頭','剪刀','布'];
  const BEATS     = { '✊':'✌️', '✌️':'✋', '✋':'✊' }; // key 贏 value
  const COLORS    = { '✊':'#e8584a', '✌️':'#6fc3df', '✋':'#b6e3a1' };
  const ROUNDS    = 5;   // 一局 5 回合，多勝者獲勝

  /* ---- 遊戲狀態 ---- */
  let W, H, ctx, hudEl, endCb, done, resultData;
  let phase;     // 'intro' | 'choose' | 'thinking' | 'reveal' | 'roundover' | 'gameover'
  let playerHistory = [];   // 玩家每回合出的拳（最多保留 10 筆）
  let playerChoice, aiChoice;
  let roundResult;           // 'win'|'lose'|'draw'
  let streak = 0;            // 玩家當前連勝數（跨局累計）
  let wins = 0, losses = 0, draws = 0;
  let round = 0;
  let phaseTimer = 0;        // 目前 phase 已過的毫秒數
  let aiThinkDur;            // 本回合 AI 思考時長（1000~2000ms）
  let aiMood = 'neutral';    // 'happy'|'neutral'|'smug'|'shocked'|'thinking'
  let playerMood = 'neutral';
  let chickBob = 0;          // 動畫計時
  let hoverChoice = -1;      // 滑鼠懸停的按鈕 index（-1 = 無）
  let buttons = [];          // 出拳按鈕的 layout [{x,y,w,h,i}]
  let introAlpha = 0;        // 開場 fade-in

  /* ---- Web Audio 8-bit 音效（與 SoundManager 同源，局部合成）---- */
  let _actx = null;
  function ensure(){ if (!_actx) _actx = new (window.AudioContext||window.webkitAudioContext)(); return _actx; }
  function beep(freq, dur, type='square', vol=0.07, delay=0){
    if (!GameState.settings.sfx) return;
    try {
      const ac = ensure(), t = ac.currentTime + delay;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t+dur);
    } catch(e){}
  }
  const SFX = {
    punch:   () => { beep(180,0.06,'sawtooth'); beep(120,0.08,'square',0.05,0.04); },
    win:     () => { [523,659,784,1046].forEach((f,i)=>beep(f,0.12,'square',0.06,i*0.09)); },
    lose:    () => { beep(300,0.18,'sine'); beep(200,0.22,'sine',0.05,0.15); },
    draw:    () => { beep(440,0.08); beep(440,0.08,'square',0.05,0.12); },
    think:   () => beep(350,0.05,'sine',0.04),
    select:  () => beep(660,0.05,'square',0.06),
  };

  /* ════════════════════════════════════════════════════════
     AI 出拳決策引擎
     權重：40% 隨機 + 30% 歷史分析 + 20% 連勝反制 + 10% 情緒
     ════════════════════════════════════════════════════════ */
  function aiDecide(){
    const mood    = GameState.happy;
    const sick    = GameState.health < 25;
    const r       = Math.random();

    // 生病時隨機率大增（生病→邏輯混亂）
    if (sick && r < 0.65) return choice(CHOICES);

    // 10% 情緒影響：心情高 → 出剋制玩家上一手的拳（主動攻擊）
    if (!sick && mood > 70 && r < 0.10 && playerHistory.length > 0){
      const lastPlayer = playerHistory[playerHistory.length - 1];
      return Object.keys(BEATS).find(k => BEATS[k] === lastPlayer) ?? choice(CHOICES);
    }

    // 20% 連勝反制：玩家連勝 ≥ 2，AI 針對玩家上一手出剋制拳
    if (streak >= 2 && r < 0.30 && playerHistory.length > 0){
      const lastP = playerHistory[playerHistory.length - 1];
      return Object.keys(BEATS).find(k => BEATS[k] === lastP) ?? choice(CHOICES);
    }

    // 30% 歷史分析：統計玩家最常出的拳，出剋制它的
    if (playerHistory.length >= 3 && r < 0.70){
      const freq = {};
      CHOICES.forEach(c => freq[c] = 0);
      playerHistory.slice(-6).forEach(c => freq[c]++);
      const mostUsed = CHOICES.reduce((a,b) => freq[a] >= freq[b] ? a : b);
      return Object.keys(BEATS).find(k => BEATS[k] === mostUsed) ?? choice(CHOICES);
    }

    // 40% 純隨機（剩餘機率）
    return choice(CHOICES);
  }

  /* ════════════════════════════════════════════
     判定勝負
     ════════════════════════════════════════════ */
  function judge(p, a){
    if (p === a) return 'draw';
    return BEATS[p] === a ? 'win' : 'lose';
  }

  /* ════════════════════════════════════════════
     像素小雞繪製（局部版，在 RPS 畫布內使用 canvas translate 移位）
     ════════════════════════════════════════════ */
  function drawMiniChick(c, cx, cy, size, mood, frame){
    const r = size;
    const bob = Math.sin(frame * 0.08) * (mood==='shocked'?6:3);
    const squash = mood==='smug' ? 0.9 : 1;
    const tilt = mood==='smug' ? -8 : mood==='shocked' ? Math.sin(frame*0.3)*10 : 0;

    c.save();
    c.translate(cx, cy + bob);
    c.rotate(tilt * Math.PI/180);
    c.scale(1, squash);

    // 翅膀
    fillPixelCircle(c, -r*0.82, r*0.18, r*0.38, '#e8a800');
    fillPixelCircle(c, +r*0.82, r*0.18, r*0.38, '#e8a800');

    // 身體
    const bodyCol = GameState.health < 25 ? PALETTE.sick : PALETTE.bodyMain;
    fillPixelCircle(c, 0, 0, r, bodyCol);
    fillPixelCircle(c, -r*0.28, -r*0.3, r*0.42, PALETTE.bodyLight);

    // 雞冠（成年以上才有）
    if (['teen','adult','old'].includes(GameState.stage)){
      fillPixelCircle(c, -r*0.15, -r*1.05, r*0.22, PALETTE.comb);
      fillPixelCircle(c, r*0.05,  -r*1.18, r*0.26, PALETTE.comb);
      fillPixelCircle(c, r*0.22,  -r*1.08, r*0.2, PALETTE.comb);
    }

    // 臉紅
    fillPixelCircle(c, -r*0.5, r*0.1, r*0.16, PALETTE.blush);
    fillPixelCircle(c, +r*0.5, r*0.1, r*0.16, PALETTE.blush);

    // 眼睛（依心情）
    const ex1=-r*0.34, ex2=r*0.34, ey=-r*0.05;
    if (mood==='happy'||mood==='smug'){
      // 瞇眼笑
      pxRect(c,ex1-6,ey,12,3,'#2b2017'); pxRect(c,ex1-6,ey-2,2,3,'#2b2017'); pxRect(c,ex1+4,ey-2,2,3,'#2b2017');
      pxRect(c,ex2-6,ey,12,3,'#2b2017'); pxRect(c,ex2-6,ey-2,2,3,'#2b2017'); pxRect(c,ex2+4,ey-2,2,3,'#2b2017');
    } else if (mood==='shocked'){
      // 圓眼驚嚇
      fillPixelCircle(c,ex1,ey,9,PALETTE.eyeWhite); fillPixelCircle(c,ex2,ey,9,PALETTE.eyeWhite);
      fillPixelCircle(c,ex1,ey,5,PALETTE.eyeBlack); fillPixelCircle(c,ex2,ey,5,PALETTE.eyeBlack);
      fillPixelCircle(c,ex1+1,ey-1,2,'#ffffff');    fillPixelCircle(c,ex2+1,ey-1,2,'#ffffff');
    } else if (mood==='thinking'){
      // 斜眼思考
      fillPixelCircle(c,ex1,ey,7,PALETTE.eyeWhite); fillPixelCircle(c,ex2,ey,7,PALETTE.eyeWhite);
      fillPixelCircle(c,ex1+1,ey+2,4,PALETTE.eyeBlack); fillPixelCircle(c,ex2+1,ey+2,4,PALETTE.eyeBlack);
    } else {
      fillPixelCircle(c,ex1,ey,7,PALETTE.eyeWhite); fillPixelCircle(c,ex2,ey,7,PALETTE.eyeWhite);
      fillPixelCircle(c,ex1,ey,4,PALETTE.eyeBlack); fillPixelCircle(c,ex2,ey,4,PALETTE.eyeBlack);
    }

    // 嘴
    pxRect(c,-5,r*0.2,10,6,PALETTE.beak);
    if (mood==='shocked') pxRect(c,-4,r*0.2+3,8,5,PALETTE.beakDark);

    // 腳
    pxRect(c,-r*0.4,r*0.88,8,8,PALETTE.feet);
    pxRect(c,+r*0.25,r*0.88,8,8,PALETTE.feet);

    // 思考泡泡（thinking 時）
    if (mood==='thinking'){
      c.restore(); c.save(); c.translate(cx,cy+bob);
      fillPixelCircle(c, r*0.9, -r*1.1, 5, '#ffffff');
      fillPixelCircle(c, r*1.15,-r*1.35, 8, '#ffffff');
      fillPixelCircle(c, r*1.35,-r*1.6, 12, '#ffffff');
      pxRect(c, r*1.25,-r*1.72,22,16,'#ffffff');
      // 省略號
      const tx = r*1.28, ty = -r*1.68;
      pxRect(c,tx,ty,4,4,'#2b2017'); pxRect(c,tx+8,ty,4,4,'#2b2017'); pxRect(c,tx+16,ty,4,4,'#2b2017');
    }

    // 汗珠（thinking 時）
    if (mood==='thinking'){
      c.restore(); c.save(); c.translate(cx,cy+bob);
      px(c, r*0.75, -r*0.5, '#6fc3df');
      px(c, r*0.72, -r*0.38, '#6fc3df');
    }

    // 得意轉圈特效（smug 時在小雞旁轉星星）
    if (mood==='smug'){
      c.restore(); c.save(); c.translate(cx,cy+bob);
      for(let i=0;i<5;i++){
        const a = frame*0.06 + i*(Math.PI*2/5);
        const sx = Math.cos(a)*r*1.5, sy = Math.sin(a)*r*1.5;
        px(c,sx,sy,'#ffd23f'); px(c,sx+4,sy,'#ffd23f');
      }
    }

    c.restore();
  }

  /* ════════════════════════════════════════════
     start() — 初始化一局遊戲
     ════════════════════════════════════════════ */
  function start(canvas, c, h, cb){
    W = canvas.width; H = canvas.height;
    ctx = c; hudEl = h; endCb = cb;
    done = false; resultData = null;
    playerHistory = []; playerChoice = null; aiChoice = null;
    round = 0; wins = 0; losses = 0; draws = 0;
    phaseTimer = 0; chickBob = 0; introAlpha = 0;
    aiMood = 'neutral'; playerMood = 'neutral'; hoverChoice = -1;

    // 讀取跨局連勝數（保存在模組變數 RPSGame.streak 上）
    streak = RPSGame.streak || 0;

    phase = 'intro';
    _layoutButtons();

    // 滑鼠懸停偵測
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (W/rect.width);
      const my = (e.clientY - rect.top)  * (H/rect.height);
      hoverChoice = buttons.findIndex(b => mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h);
    };
    const onLeave = () => { hoverChoice = -1; };
    const onDown = (e) => {
      if (phase !== 'choose') return;
      const rect = canvas.getBoundingClientRect();
      const src  = e.touches?.[0] ?? e;
      const mx = (src.clientX - rect.left) * (W/rect.width);
      const my = (src.clientY - rect.top)  * (H/rect.height);
      const hit = buttons.findIndex(b => mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h);
      if (hit >= 0) _playerChoose(hit);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('click', onDown);
    canvas.addEventListener('touchstart', onDown, {passive:true});
    RPSGame._cleanup = () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('click', onDown);
      canvas.removeEventListener('touchstart', onDown);
    };
  }

  function _layoutButtons(){
    const bw = Math.round(W * 0.22), bh = Math.round(H * 0.14);
    const by = Math.round(H * 0.74);
    const spacing = Math.round((W - bw*3) / 4);
    buttons = CHOICES.map((_, i) => ({
      x: spacing + i*(bw+spacing), y: by, w: bw, h: bh, i,
    }));
  }

  /* ════════════════════════════════════════════
     玩家出拳
     ════════════════════════════════════════════ */
  function _playerChoose(idx){
    SFX.select();
    playerChoice = CHOICES[idx];
    playerHistory.push(playerChoice);
    if (playerHistory.length > 10) playerHistory.shift();
    aiThinkDur = randInt(900, 1900);
    aiMood = 'thinking';
    playerMood = 'neutral';
    phase = 'thinking';
    phaseTimer = 0;
    SFX.think();
  }

  /* ════════════════════════════════════════════
     update() — 每幀邏輯（由 MiniGameSystem RAF 迴圈呼叫）
     ════════════════════════════════════════════ */
  function update(){
    if (done) return;
    chickBob++;
    phaseTimer += 16; // 近似 1 幀 ≈ 16ms

    if (phase === 'intro'){
      introAlpha = Math.min(1, introAlpha + 0.03);
      if (phaseTimer > 1800) _toChoose();
    }

    if (phase === 'thinking'){
      if (phaseTimer % 300 < 16) SFX.think();
      if (phaseTimer >= aiThinkDur){
        aiChoice = aiDecide();
        SFX.punch();
        roundResult = judge(playerChoice, aiChoice);
        _applyRoundResult();
        phase = 'reveal';
        phaseTimer = 0;
      }
    }

    if (phase === 'reveal'){
      if (phaseTimer >= 2200) _toRoundOver();
    }

    if (phase === 'roundover'){
      if (phaseTimer >= 900) _nextRound();
    }
  }

  function _toChoose(){
    phase = 'choose';
    phaseTimer = 0;
    playerChoice = null; aiChoice = null;
    aiMood = 'neutral'; playerMood = 'neutral';
  }

  function _applyRoundResult(){
    if (roundResult === 'win'){
      wins++; streak++;
      aiMood = 'shocked'; playerMood = 'happy';
      SFX.win();
    } else if (roundResult === 'lose'){
      losses++; streak = 0;
      aiMood = 'smug'; playerMood = 'neutral';
      SFX.lose();
    } else {
      draws++;
      aiMood = 'neutral'; playerMood = 'neutral';
      SFX.draw();
    }
    RPSGame.streak = streak;
    hudEl.textContent = `回合 ${round+1}/${ROUNDS}  ✊玩家 ${wins}：${losses} AI🐔  🔥連勝 ${streak}`;
  }

  function _toRoundOver(){
    phase = 'roundover';
    phaseTimer = 0;
    round++;
    if (round >= ROUNDS) { _endGame(); return; }
  }

  function _nextRound(){
    _toChoose();
  }

  function _endGame(){
    if (done) return; done = true;
    const gameWon = wins > losses;
    const gameDraw= wins === losses;

    // 連勝金幣倍率
    let goldBase = gameWon ? 20 : gameDraw ? 5 : 0;
    let mult = 1;
    if (streak >= 5) mult = 1.5;
    else if (streak >= 3) mult = 1.2;
    else if (streak >= 2) mult = 1.1;
    const goldEarned = Math.round(goldBase * mult);

    const happyDelta = gameWon ? 15 : gameDraw ? 0 : -10;

    const summary = gameWon
      ? `你贏了！小雞不甘心地拍了拍翅膀！（${wins}勝${losses}負${draws}平）`
      : gameDraw
      ? `平手！小雞歪頭看著你，似乎不服氣。（${wins}勝${losses}負${draws}平）`
      : `小雞得意地跳了一下，好像在說：再來啊！（${wins}勝${losses}負${draws}平）`;

    resultData = {
      gameName:'猜拳對決',
      gold: goldEarned,
      hunger: 0,
      happy: happyDelta > 0 ? happyDelta : 0,
      happyPen: happyDelta < 0 ? happyDelta : 0,
      summary,
    };

    // 連勝提示
    if (streak >= 5 && gameWon) UI.toast(`🔥 連勝 ${streak}！金幣 x${mult}！AI 已進入認真模式！`);
    else if (streak >= 2 && gameWon) UI.toast(`🔥 連勝 ${streak}！金幣 +${Math.round((mult-1)*100)}%！`);

    if (endCb) endCb();
  }

  /* ════════════════════════════════════════════
     render() — 每幀畫面（純繪製，不含邏輯）
     ════════════════════════════════════════════ */
  function render(c){
    c.clearRect(0,0,W,H);

    // ---- 背景漸層（深色像素風）----
    pxRect(c,0,0,W,H,'#1a1a2e');
    for(let i=0;i<W;i+=16) pxRect(c,i,0,8,H,'rgba(255,255,255,0.015)');
    // 地板
    pxRect(c,0,H*0.82,W,H*0.18,'#2b2017');
    pxRect(c,0,H*0.82,W,4,'#5c3b26');

    // ---- 開場 intro ----
    if (phase === 'intro'){
      c.globalAlpha = introAlpha;
      c.fillStyle='#ffe9b8'; c.font=`bold ${Math.round(H*0.06)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      c.fillText('✊ 小雞猜拳對決 ✊', W/2, H*0.3);
      c.font=`${Math.round(H*0.04)}px monospace`;
      c.fillStyle='#b6e3a1';
      c.fillText('小雞想跟你來一場猜拳對決！', W/2, H*0.45);
      c.fillText('準備好接受挑戰了嗎？', W/2, H*0.54);
      c.font=`${Math.round(H*0.035)}px monospace`;
      c.fillStyle='#ffd23f';
      if (Math.floor(chickBob/30)%2===0) c.fillText('▶ 即將開始...', W/2, H*0.68);
      c.globalAlpha=1;
      // 兩隻小雞面對面
      drawMiniChick(c, W*0.25, H*0.62, H*0.1, 'neutral', chickBob);
      c.save(); c.scale(-1,1); drawMiniChick(c, -W*0.75, H*0.62, H*0.1, 'neutral', chickBob); c.restore();
      return;
    }

    // ---- 場景佈局（左 AI / 中 VS / 右玩家）----
    const chicSize = H * 0.13;
    const aiX = W * 0.22, aiY = H * 0.45;
    const plX = W * 0.78, plY = H * 0.45;

    // AI 小雞（鏡像，向右看）
    c.save(); c.scale(-1,1); drawMiniChick(c,-aiX,aiY,chicSize,aiMood,chickBob); c.restore();

    // 玩家小雞
    drawMiniChick(c, plX, plY, chicSize, playerMood, chickBob);

    // VS 標誌
    c.fillStyle='#ffd23f'; c.font=`bold ${Math.round(H*0.07)}px monospace`;
    c.textAlign='center'; c.textBaseline='middle';
    c.fillText('VS', W/2, H*0.42);

    // 分數欄
    c.fillStyle='#ffe9b8'; c.font=`${Math.round(H*0.038)}px monospace`;
    c.fillText(`🐔 ${losses}  —  ${wins} 🧑`, W/2, H*0.22);
    c.font=`${Math.round(H*0.028)}px monospace`;
    c.fillStyle='#b6e3a1';
    c.fillText(`回合 ${round+1}/${ROUNDS}`, W/2, H*0.3);
    if (streak >= 2){
      c.fillStyle='#ffd23f';
      c.fillText(`🔥 連勝 ${streak}`, W/2, H*0.36);
    }

    // ---- 出拳顯示（thinking / reveal 時）----
    if (phase === 'thinking' || phase === 'reveal' || phase === 'roundover'){
      const eSize = Math.round(H*0.09);
      c.font=`${eSize}px serif`; c.textBaseline='middle'; c.textAlign='center';

      // 玩家的選擇（立即顯示）
      c.fillText(playerChoice ?? '?', plX, H*0.66);

      // AI 的選擇（thinking 時顯示 ?）
      if (phase === 'thinking'){
        const dots = '.'.repeat((Math.floor(phaseTimer/300)%4));
        c.fillStyle='#ffe9b8'; c.font=`${Math.round(H*0.035)}px monospace`;
        c.fillText(`思考中${dots}`, aiX, H*0.66);
      } else {
        c.font=`${eSize}px serif`;
        c.fillText(aiChoice ?? '?', aiX, H*0.66);
      }
    }

    // ---- 結果字幕（reveal 時）----
    if ((phase === 'reveal' || phase === 'roundover') && roundResult){
      const resLabel = roundResult==='win' ? '🎉 你贏了！' : roundResult==='lose' ? '😤 AI贏了！' : '🤝 平手！';
      const resColor = roundResult==='win' ? '#b6e3a1' : roundResult==='lose' ? '#e8584a' : '#6fc3df';
      c.fillStyle=resColor;
      c.font=`bold ${Math.round(H*0.055)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      // 文字輕微浮動
      const labelY = H*0.58 + Math.sin(chickBob*0.15)*4;
      c.fillText(resLabel, W/2, labelY);

      // 顯示出拳名稱
      c.font=`${Math.round(H*0.032)}px monospace`;
      c.fillStyle='#ffe9b8';
      c.fillText(NAMES[CHOICES.indexOf(aiChoice)], aiX, H*0.74);
      c.fillText(NAMES[CHOICES.indexOf(playerChoice)], plX, H*0.74);
    }

    // ---- 出拳按鈕（choose 時才顯示）----
    if (phase === 'choose'){
      buttons.forEach((b, i) => {
        const isHover = hoverChoice === i;
        const scale = isHover ? 1.12 : 1;
        const bx = b.x + b.w/2, by = b.y + b.h/2;
        const bw = b.w * scale, bh = b.h * scale;

        // 按鈕背景
        const col = COLORS[CHOICES[i]];
        c.fillStyle = isHover ? '#fff8e0' : col;
        c.strokeStyle = '#2b2017';
        c.lineWidth = 3;
        c.fillRect(bx-bw/2, by-bh/2, bw, bh);
        c.strokeRect(bx-bw/2, by-bh/2, bw, bh);

        // 像素風內框（模擬 pixel border highlight）
        c.strokeStyle='rgba(255,255,255,0.4)'; c.lineWidth=2;
        c.strokeRect(bx-bw/2+3, by-bh/2+3, bw-6, bh-6);

        // Emoji
        const efs = Math.round(b.h * 0.44 * scale);
        c.font=`${efs}px serif`; c.textAlign='center'; c.textBaseline='middle';
        c.fillText(CHOICES[i], bx, by - b.h*0.05*scale);

        // 文字標籤
        c.fillStyle='#2b2017'; c.font=`bold ${Math.round(b.h*0.2*scale)}px monospace`;
        c.fillText(NAMES[i], bx, by + b.h*0.32*scale);

        // hover 放大提示
        if (isHover){
          c.fillStyle='rgba(255,255,255,0.15)';
          c.fillRect(bx-bw/2, by-bh/2, bw, bh);
        }
      });

      // 提示文字
      c.fillStyle='#ffe9b8'; c.font=`${Math.round(H*0.035)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      c.fillText('出拳！', W/2, H*0.66);
    }
  }

  /* ════════════════════════════════════════════
     介面方法
     ════════════════════════════════════════════ */
  function stop(){ if (RPSGame._cleanup) RPSGame._cleanup(); }
  function getResult(){ return resultData; }

  return {
    start, update, render, stop, getResult,
    get done(){ return done; },
    streak: 0,   // 跨局連勝計數（直接掛在 module object 上持久化）
  };
})();

/* ============================================================================
   🏃 GAME 6：小雞賽跑《Chicken Run》
   ----------------------------------------------------------------------------
   60 秒橫向捲軸跑酷遊戲。小雞自動向右跑，玩家點擊/觸控/空白鍵控制跳躍。
   障礙物從右側持續生成並向左滾動；碰到障礙物扣血條（3 血）而非直接結束，
   讓玩家撐過 60 秒或 3 次碰撞才結算。跑越遠、碰撞越少 → 金幣越多。
   ============================================================================ */
const ChickenRunGame = (() => {
  /* ---- 物理常數 ---- */
  // 所有物理量皆以「每秒」為單位，乘上 dt 後套用，確保不同 FPS 下行為一致。
  // GRAVITY：每秒向下加速度（相對座標/秒²）。原本是每幀 0.018，
  //   60fps 下等於每秒 1.08，下墜過快。改以合理的每秒值並乘 dt。
  const GRAVITY    = 1.6;    // 相對座標/秒²（原本幀相依版約等於 60*0.018=1.08，略微調低讓滯空更好）
  const JUMP_VY    = -0.80;  // 跳躍初速（相對座標/秒，向上為負）。原本 -0.052*60fps≈-3.12/秒太小，
                              // 現調至 -0.80/秒 × H 像素，約為原本的 1.45 倍（+45%），跳幅明顯提升。
  const GROUND_Y   = 0.4;   // 地面相對高度（不變）
  const CHICK_R    = 0.05;   // 小雞碰撞半徑（相對座標）
  const GAME_TIME  = 60;      // 遊戲時長（秒）
  const MAX_HP     = 3;       // 最大血量

  /* ---- 障礙物類型（寬、高、分類）----
     h 必須 < 0.20（跳躍最大高度），讓玩家必定跳得過。
     安全邊距：最高取 h=0.15，小雞頂端與障礙物頂端至少差 0.05。
     bird 已移除：無蹲下機制時空中障礙無合理迴避方式，留坑日後加。 */
  const OBS_TYPES = [
    { w:0.05, h:0.10, type:'stone',  label:'石頭',  color:'#9c8f7c', colorTop:'#c0b4a4', top:false },
    { w:0.05, h:0.14, type:'cactus', label:'仙人掌', color:'#4d8a45', colorTop:'#6aaa60', top:false },
    { w:0.05, h:0.07, type:'log',    label:'木頭',  color:'#8a5a3b', colorTop:'#b07a56', top:false },
    { w:0.05, h:0.12, type:'fence',  label:'柵欄',  color:'#c8a060', colorTop:'#e8c880', top:false },
  ];

  /* ---- 金幣物件（可收集）---- */
  const COIN_COLOR = '#ffd23f';

  /* ---- 狀態 ---- */
  let W, H, ctx, hudEl, endCb, done, resultData;
  let chickY, chickVY, isOnGround, isJumping;
  let hp, distance, coins, timeLeft, startT, lastT;
  let obstacles = [], coinObjs = [];
  let spawnTimer = 0, coinTimer = 0;
  let scrollSpeed;          // 畫面捲動速度（相對座標/幀），隨時間加快
  let hitFlash = 0;         // 受傷閃紅幀數
  let frame = 0;
  let bgLayers = [];        // 視差背景圖層 [{x, speed, items:[]}]
  let jumpPressed = false;  // 防止長按連跳

  /* ---- Web Audio ---- */
  let _actx = null;
  function _ac(){ if(!_actx) _actx=new(window.AudioContext||window.webkitAudioContext)(); return _actx; }
  function _beep(f,d,t='square',v=0.07,delay=0){
    if(!GameState.settings.sfx) return;
    try{
      const ac=_ac(), t0=ac.currentTime+delay;
      const o=ac.createOscillator(), g=ac.createGain();
      o.type=t; o.frequency.setValueAtTime(f,t0);
      g.gain.setValueAtTime(v,t0); g.gain.exponentialRampToValueAtTime(0.0001,t0+d);
      o.connect(g); g.connect(ac.destination); o.start(t0); o.stop(t0+d);
    }catch(e){}
  }
  const SFX = {
    jump: ()=>{ _beep(380,0.06,'square',0.07); _beep(520,0.05,'square',0.05,0.05); },
    hit:  ()=>{ _beep(180,0.12,'sawtooth',0.1); _beep(120,0.15,'sine',0.06,0.08); },
    coin: ()=>{ _beep(880,0.04,'square',0.05); _beep(1100,0.05,'square',0.04,0.04); },
    end:  ()=>{ [523,659,784].forEach((f,i)=>_beep(f,0.1,'square',0.06,i*0.08)); },
  };

  /* ════════════════════════════════
     建立視差背景圖層
     ════════════════════════════════ */
  function _buildBg(){
    bgLayers = [
      // 遠景：山丘輪廓
      { speed:0.2, items: Array.from({length:6}, (_,i)=>({ x:i/6, h:0.06+Math.random()*0.08, w:0.12+Math.random()*0.1 })) },
      // 中景：樹木
      { speed:0.5, items: Array.from({length:8}, (_,i)=>({ x:i/8+Math.random()*0.04, h:0.1+Math.random()*0.08 })) },
      // 近景：草叢
      { speed:0.85, items: Array.from({length:12}, (_,i)=>({ x:i/12, h:0.04+Math.random()*0.03 })) },
    ];
  }

  /* ════════════════════════════════
     start()
     ════════════════════════════════ */
  function start(canvas, c, h, cb){
    W=canvas.width; H=canvas.height; ctx=c; hudEl=h; endCb=cb;
    done=false; resultData=null;
    chickY=GROUND_Y; chickVY=0; isOnGround=true; isJumping=false;
    hp=MAX_HP; distance=0; coins=0; timeLeft=GAME_TIME;
    startT=lastT=performance.now();
    obstacles=[]; coinObjs=[]; spawnTimer=0; coinTimer=0; hitFlash=0; frame=0;
    scrollSpeed=0.004;
    jumpPressed=false;
    _buildBg();

    hudEl.textContent=`⏱ ${GAME_TIME}  ❤️❤️❤️  🪙 0`;

    // 輸入：點擊 / 觸控 / 空白鍵 → 跳躍
    const onJump = (e) => {
      if(done) return;
      if(e.type==='keydown' && e.code!=='Space') return;
      if(e.type==='keydown') e.preventDefault();
      if(!jumpPressed && isOnGround){
        chickVY = JUMP_VY;
        isOnGround = false;
        isJumping = true;
        jumpPressed = true;
        SFX.jump();
      }
    };
    const onRelease = (e) => {
      if(e.type==='keyup' && e.code!=='Space') return;
      jumpPressed = false;
    };
    canvas.addEventListener('touchstart', onJump, {passive:false});
    canvas.addEventListener('click', onJump);
    document.addEventListener('keydown', onJump);
    document.addEventListener('keyup', onRelease);

    ChickenRunGame._cleanup = () => {
      canvas.removeEventListener('touchstart', onJump);
      canvas.removeEventListener('click', onJump);
      document.removeEventListener('keydown', onJump);
      document.removeEventListener('keyup', onRelease);
    };
  }

  /* ════════════════════════════════
     update()
     ════════════════════════════════ */
  function update(){
    if(done) return;
    const now = performance.now();
    const dt  = Math.min((now - lastT)/1000, 0.05); // 最大步長 50ms 防止大跳
    lastT = now;
    timeLeft = Math.max(0, GAME_TIME - (now - startT)/1000);
    frame++;

    if(timeLeft <= 0){ _endGame(); return; }

    // scrollSpeed 定義為「每秒」移動量（相對座標/秒），這樣 dt 乘上去才是正確位移。
    // 0.24/s = 原本 0.004/幀×60fps；最高加速到 0.48/s。
    scrollSpeed = 0.24 + (GAME_TIME - timeLeft) / GAME_TIME * 0.24;

    // ── 物理：小雞垂直運動（dt-scaled，與 FPS 無關）──
    chickVY += GRAVITY * dt;
    chickY  += chickVY * dt;

    // 落地判定：先修正位置再歸零速度，防止浮點誤差穿地板。
    if(chickY >= GROUND_Y){
      chickY     = GROUND_Y;
      chickVY    = 0;
      isOnGround = true;
      isJumping  = false;
      jumpPressed = false;
    }

    // ── 距離累積（每秒推進 scrollSpeed × 畫面寬度）──
    distance += scrollSpeed * W * dt;

    // ── 視差背景捲動 ──
    bgLayers.forEach(layer => {
      layer.items.forEach(item => {
        item.x -= scrollSpeed * layer.speed * dt;
        if(item.x < -0.2) item.x += 1.2;
      });
    });

    // ── 生成障礙物 ──
    spawnTimer -= dt;
    if(spawnTimer <= 0){
      const type = OBS_TYPES[Math.floor(Math.random() * OBS_TYPES.length)];
      // o.y = 障礙物「頂端」的相對 Y 座標（GROUND_Y - h = 地面上方 h 高度處）
      obstacles.push({
        x:    1.05,
        y:    GROUND_Y - type.h,   // 頂端緊貼地面上方
        w:    type.w,
        h:    type.h,
        color:    type.color,
        colorTop: type.colorTop,
        type:     type.type,
        top:  false,
      });
      spawnTimer = 1.2 - (GAME_TIME - timeLeft)/GAME_TIME * 0.5 + Math.random()*0.6;
    }

    // ── 生成金幣 ──
    coinTimer -= dt;
    if(coinTimer <= 0){
      coinObjs.push({ x:0.92 + Math.random()*0.1, y: GROUND_Y - 0.08 - Math.random()*0.15, r:0.018, collected:false });
      coinTimer = 1.4 + Math.random()*0.8;
    }

    // ── 移動障礙物（每秒 scrollSpeed，與小雞物理同單位）──
    obstacles = obstacles.filter(o => {
      o.x -= scrollSpeed * dt;
      return o.x > -0.15;
    });

    // ── 移動金幣 ──
    coinObjs = coinObjs.filter(co => {
      co.x -= scrollSpeed * dt;
      return co.x > -0.1;
    });

    // ── 碰撞偵測：障礙物 ──
    if(hitFlash <= 0){
      const cx = 0.2, cy = chickY;
      const chickTop = cy - CHICK_R;     // 小雞最高點
      obstacles.forEach(o => {
        const obsTop    = o.y;           // 障礙物頂端（= o.y，top-edge 座標系）
        const obsCenterX = o.x + o.w/2;
        const obsCenterY = o.y + o.h/2;
        // 若小雞完全跳過障礙物頂端（含容錯 0.015），不判定碰撞
        if (chickTop < obsTop - 0.015) return;
        // AABB：X 和 Y 都在碰撞盒範圍內才判定
        if( Math.abs(cx - obsCenterX) < (CHICK_R + o.w/2) * 0.88 &&
            Math.abs(cy - obsCenterY) < (CHICK_R + o.h/2) * 0.88 ){
          hp--;
          hitFlash = 40;
          SFX.hit();
          if(hp <= 0){ _endGame(); }
        }
      });
    } else { hitFlash--; }

    // ── 碰撞偵測：金幣 ──
    coinObjs.forEach(c => {
      if(c.collected) return;
      if( Math.abs(0.2 - c.x) < CHICK_R + c.r &&
          Math.abs(chickY - c.y) < CHICK_R + c.r ){
        c.collected = true;
        coins++;
        SFX.coin();
      }
    });
    coinObjs = coinObjs.filter(c => !c.collected);

    // ── HUD ──
    const hpStr = '❤️'.repeat(hp) + '🖤'.repeat(MAX_HP - hp);
    hudEl.textContent = `⏱ ${Math.ceil(timeLeft)}  ${hpStr}  🪙 ${coins}  📏 ${Math.floor(distance)}m`;
  }

  /* ════════════════════════════════
     render()
     ════════════════════════════════ */
  function render(c){
    // 每幀先清除，防止殘影或 canvas context 狀態污染（在某些行動裝置瀏覽器上
    // 不 clearRect 直接疊畫會讓半透明像素累積，導致整個畫面逐漸變暗）
    c.clearRect(0, 0, W, H);
    const GY = Math.round(H * GROUND_Y);

    // ── 天空 ──
    pxRect(c, 0, 0, W, GY, '#bfe9ff');

    // ── 太陽 ──
    fillPixelCircle(c, W*0.88, H*0.1, H*0.055, '#ffe87a');

    // ── 視差背景 ──
    bgLayers.forEach((layer, li) => {
      const col = li===0 ? '#c8e0b0' : li===1 ? '#7ab86a' : '#5ca04a';
      layer.items.forEach(item => {
        const ix = Math.round(item.x * W);
        if(li < 2){
          // 山丘 / 樹（三角形 + 矩形）
          const ih = Math.round((item.h||0.08) * H);
          const iw = Math.round((item.w||0.08) * W);
          pxRect(c, ix, GY - ih, iw, ih, col);
          if(li===1) pxRect(c, ix + Math.round(iw*0.35), GY - ih - Math.round(ih*0.6), Math.round(iw*0.3), Math.round(ih*0.6), '#4d8a45');
        } else {
          // 草叢
          pxRect(c, ix, GY - Math.round(item.h*H), 8, Math.round(item.h*H), col);
        }
      });
    });

    // ── 地面 ──
    pxRect(c, 0, GY, W, H - GY, '#8fcf6a');
    pxRect(c, 0, GY, W, 6, '#6fae5a');

    // 地面條紋（跑動感），用 distance 驅動確保速度一致
    const stripeOff = Math.round(distance * 0.4) % 40;
    for(let sx = -40 + stripeOff; sx < W; sx += 40){
      pxRect(c, sx, GY + 8, 20, 3, 'rgba(255,255,255,0.15)');
    }

    // ── 障礙物 ──
    obstacles.forEach(o => {
      const ox  = Math.round(o.x * W);
      const oy  = Math.round(o.y * H);           // 頂端 Y（像素）
      const ow  = Math.round(o.w * W);
      const oh  = Math.round(o.h * H);

      // 主體
      pxRect(c, ox, oy, ow, oh, o.color);

      // 頂端高光條（顯示不同障礙物質感）
      const topH = Math.max(4, Math.round(oh * 0.28));
      pxRect(c, ox, oy, ow, topH, o.colorTop || '#ffffff');

      // 障礙物類型裝飾
      if (o.type === 'cactus'){
        // 仙人掌橫枝
        const armY = Math.round(oy + oh * 0.38);
        const armW = Math.round(ow * 0.36);
        const armH = Math.max(4, Math.round(oh * 0.18));
        pxRect(c, ox - armW, armY, armW, armH, o.color);
        pxRect(c, ox + ow,   armY, armW, armH, o.color);
      } else if (o.type === 'fence'){
        // 柵欄縱板
        const slats = 3;
        const sw = Math.max(4, Math.round(ow / (slats * 2 - 1)));
        for (let i = 0; i < slats; i++){
          pxRect(c, ox + Math.round(i * ow / slats), oy, sw, oh, o.colorTop || '#f0d890');
        }
      } else if (o.type === 'log'){
        // 木紋橫線
        for (let li = 1; li <= 2; li++){
          pxRect(c, ox + 3, Math.round(oy + oh * li / 3), ow - 6, 3, 'rgba(0,0,0,0.2)');
        }
      } else if (o.type === 'stone'){
        // 石頭高光點
        fillPixelCircle(c, ox + Math.round(ow * 0.3), oy + Math.round(oh * 0.3), 3, 'rgba(255,255,255,0.4)');
      }

      // ── 紅色外框（清楚標示碰撞範圍）──
      c.strokeStyle = '#e8584a';
      c.lineWidth   = 2;
      c.strokeRect(ox, oy, ow, oh);
    });

    // ── 金幣 ──
    coinObjs.forEach(coin => {
      fillPixelCircle(c, Math.round(coin.x*W), Math.round(coin.y*H), Math.round(coin.r*W), COIN_COLOR);
      fillPixelCircle(c, Math.round(coin.x*W)-2, Math.round(coin.y*H)-2, Math.round(coin.r*W*0.4), 'rgba(255,255,255,0.6)');
    });

    // ── 小雞（用 fillPixelCircle 繪製，位置依跳躍高度浮動）──
    const chicX  = Math.round(0.2  * W);
    const chicY  = Math.round(chickY * H);
    const chicR  = Math.round(CHICK_R * W);
    const squash = isOnGround ? 1.0 : (chickVY < 0 ? 0.85 : 1.08); // 落地前稍微拉長
    const flash  = hitFlash > 0 && Math.floor(hitFlash/4)%2===0;

    c.save();
    c.translate(chicX, chicY);
    c.scale(1, squash);

    const bodyCol = flash ? '#ff4444' : (GameState.health < 20 ? PALETTE.sick : PALETTE.bodyMain);
    // 翅膀（向後飄）
    fillPixelCircle(c, -chicR*0.85, chicR*0.18, Math.round(chicR*0.4), '#e8a800');
    // 身體
    fillPixelCircle(c, 0, 0, chicR, bodyCol);
    fillPixelCircle(c, -Math.round(chicR*0.28), -Math.round(chicR*0.3), Math.round(chicR*0.42), PALETTE.bodyLight);
    // 眼睛（跑步時興奮大眼）
    const ex = Math.round(chicR*0.32);
    fillPixelCircle(c, ex, -Math.round(chicR*0.06), Math.round(chicR*0.32), PALETTE.eyeWhite);
    fillPixelCircle(c, ex+2, -Math.round(chicR*0.06), Math.round(chicR*0.18), PALETTE.eyeBlack);
    // 嘴喙（向右）
    pxRect(c, Math.round(chicR*0.55), Math.round(chicR*0.12), Math.round(chicR*0.35), Math.round(chicR*0.2), PALETTE.beak);
    // 臉紅
    fillPixelCircle(c, Math.round(chicR*0.5), Math.round(chicR*0.2), Math.round(chicR*0.16), PALETTE.blush);
    // 雞冠（成年以上）
    if(['teen','adult','old'].includes(GameState.stage)){
      fillPixelCircle(c, -Math.round(chicR*0.1), -Math.round(chicR*1.08), Math.round(chicR*0.22), PALETTE.comb);
    }
    // 腳（跑步動畫：交替抬起）
    const legPhase = Math.sin(frame * 0.4);
    pxRect(c, -Math.round(chicR*0.3), Math.round(chicR*0.82+legPhase*4), 7, 7, PALETTE.feet);
    pxRect(c, Math.round(chicR*0.1),  Math.round(chicR*0.82-legPhase*4), 7, 7, PALETTE.feet);

    c.restore();

    // 跳躍時的速度線
    if(!isOnGround && chickVY < -0.01){
      c.strokeStyle='rgba(255,255,255,0.4)'; c.lineWidth=2;
      for(let i=1;i<=3;i++){
        c.beginPath();
        c.moveTo(chicX - chicR - i*8, chicY - chicR*0.5 + i*3);
        c.lineTo(chicX - chicR - i*8 - 12, chicY - chicR*0.5 + i*3);
        c.stroke();
      }
    }

    // ── 受傷提示 ──
    if(hitFlash > 30){
      c.fillStyle='rgba(255,0,0,0.18)';
      c.fillRect(0, 0, W, H);
      c.fillStyle='#ff4444'; c.font=`bold ${Math.round(H*0.06)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      c.fillText('OUCH!', W/2, H*0.35);
    }

    // ── 操作提示（前 3 秒）──
    const elapsed = GAME_TIME - timeLeft;
    if(elapsed < 3){
      c.globalAlpha = Math.max(0, 1 - elapsed/2.5);
      c.fillStyle='#ffe9b8'; c.font=`${Math.round(H*0.04)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      c.fillText('點擊 / 空白鍵 跳躍！', W/2, H*0.25);
      c.globalAlpha=1;
    }
  }

  /* ════════════════════════════════
     結算
     ════════════════════════════════ */
  function _endGame(){
    if(done) return; done=true;
    SFX.end();
    const dist = Math.floor(distance);
    // 金幣：基礎距離 + 收集到的金幣 + 存活加成（每剩餘 1 血 +5）
    const goldEarned = Math.floor(dist / 15) + coins * 3 + (hp * 5);

    const summary =
      dist >= 400 ? `跑了 ${dist}m！小雞衝向終點，觀眾瘋狂歡呼！` :
      dist >= 200 ? `跑了 ${dist}m，還不錯！小雞有點喘，但很開心。` :
                    `跑了 ${dist}m，小雞下次會更努力的！`;

    resultData = {
      gameName: '小雞賽跑',
      gold:    goldEarned,
      hunger:  0,
      happy:   hp > 0 ? 10 : 0,
      happyPen: 0,
      summary,
    };
    if(endCb) endCb();
  }

  function stop(){ if(ChickenRunGame._cleanup) ChickenRunGame._cleanup(); }
  function getResult(){ return resultData; }
  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

/* ============================================================================
   🛤️ LaneRunGame — 三跑道跑酷 Prototype
   ----------------------------------------------------------------------------
   縱向（Portrait）無盡跑酷。小雞在三條跑道上自動向前，玩家左右切換跑道、
   向上跳躍閃避障礙物並收集金幣。3 顆愛心，撞擊一次扣一顆，歸零結束。
   每 30 秒速度提升，設有上限。

   架構：
     Chicken        玩家物件（跑道/跳躍/動畫/hitbox）
     ObstaclePool   障礙物物件池（石頭/木箱/柵欄）
     CoinPool       金幣物件池
     LaneRenderer   背景 + 跑道繪製
     CollisionSystem 獨立碰撞函式（Swept AABB，防高速穿牆）
     InputManager   鍵盤 + 觸控解耦（輸入佇列，防連滑溢出）
   ============================================================================ */
const LaneRunGame = (() => {
  /* ──────────────────────────────────────────────
     常數
  ────────────────────────────────────────────── */
  const LANES       = 3;
  const LANE_XR     = [0.22, 0.50, 0.78];  // 各跑道中心 X（相對座標）
  const CHICK_YR    = 0.72;                 // 小雞站立時 Y（相對，從頂部算）
  const CHICK_W     = 0.10;                 // 碰撞寬（相對）
  const CHICK_H     = 0.10;                 // 碰撞高（相對）
  const JUMP_PEAK   = 0.20;                 // 跳躍最高點距地面（相對高度）
  const JUMP_DUR    = 0.55;                 // 跳躍總時長（秒）
  const LANE_LERP   = 12;                   // 跑道橫移平滑係數
  const BASE_SPEED  = 0.32;                 // 初始捲動速度（相對/秒）
  const SPEED_STEP  = 0.04;                 // 每 30 秒加速
  const MAX_SPEED   = BASE_SPEED * 3;       // 速度上限
  const COUNTDOWN   = 3;                    // 倒數秒數
  const MAX_HP      = 3;
  const HIT_INVULN  = 1.8;                  // 受傷後無敵秒數

  /* 障礙物類型 ── 未來在這裡加新種類即可 */
  const OBS_DEFS = [
    { id:'stone', label:'石頭', colorTop:'#b0a090', colorSide:'#8a7a6a', w:0.10, h:0.09 },
    { id:'crate', label:'木箱', colorTop:'#c8a86a', colorSide:'#8a5a3b', w:0.10, h:0.11 },
    { id:'fence', label:'柵欄', colorTop:'#e0c890', colorSide:'#a08040', w:0.10, h:0.13 },
  ];

  /* ──────────────────────────────────────────────
     遊戲狀態
  ────────────────────────────────────────────── */
  let W, H, ctx, hudEl, endCb, done, resultData;
  let phase;       // 'countdown' | 'playing' | 'dead' | 'gameover'
  let countdownT;  // 倒數計時開始時刻
  let startT, lastT;
  let score, distance, coinsEarned, hp, speed;
  let invuln;      // 無敵剩餘秒數
  let flashTimer;  // 受傷閃爍

  /* ──────────────────────────────────────────────
     Chicken 物件
  ────────────────────────────────────────────── */
  const Chicken = {
    lane:       1,       // 目前「邏輯跑道」（0/1/2），碰撞用這個
    targetLane: 1,       // 目標跑道（玩家輸入後立即更新）
    xR:         LANE_XR[1],  // 當前顯示 X（Lerp 後的值）
    yR:         CHICK_YR,    // 顯示 Y（跳躍時會變動）
    jumpT:      0,       // 跳躍計時（0=未跳，>0=跳躍中）
    isJumping:  false,
    animFrame:  0,       // 動畫幀（每 0.1 秒切換）
    animTimer:  0,

    reset(){
      this.lane = this.targetLane = 1;
      this.xR = LANE_XR[1];
      this.yR = CHICK_YR;
      this.jumpT = 0; this.isJumping = false;
      this.animFrame = 0; this.animTimer = 0;
    },

    jump(){
      if (!this.isJumping){
        this.isJumping = true;
        this.jumpT = 0;
      }
    },

    /** 每幀更新位置與動畫 */
    update(dt){
      // 跑道 Lerp：視覺跟隨 targetLane，邏輯用 lane（已在 InputManager 更新）
      const targetX = LANE_XR[this.lane];
      this.xR += (targetX - this.xR) * Math.min(1, LANE_LERP * dt);

      // 跳躍弧線：用 sin 曲線讓跳躍弧度自然
      if (this.isJumping){
        this.jumpT += dt;
        const t = this.jumpT / JUMP_DUR;
        if (t >= 1){
          this.isJumping = false; this.jumpT = 0; this.yR = CHICK_YR;
        } else {
          // sin(0→π) 產生 0→1→0 的弧線，乘以 JUMP_PEAK 得到相對高度
          this.yR = CHICK_YR - Math.sin(t * Math.PI) * JUMP_PEAK;
        }
      }

      // 走路動畫計時
      this.animTimer += dt;
      if (this.animTimer >= 0.1){ this.animTimer = 0; this.animFrame = (this.animFrame + 1) % 4; }
    },

    /** hitbox：中心 + 半寬半高（相對座標） */
    hitbox(){
      return { cx: this.xR, cy: this.yR, hw: CHICK_W/2, hh: CHICK_H/2 };
    },
  };

  /* ──────────────────────────────────────────────
     InputManager — 輸入佇列，防連滑溢出
  ────────────────────────────────────────────── */
  const InputMgr = (() => {
    let queue = [];    // 待處理輸入（'left'|'right'|'jump'）
    let touchStartX, touchStartY;
    const MIN_SWIPE = 28;   // 最小滑動距離（px）

    function _push(action){ queue.push(action); }

    function _onKey(e){
      if (phase !== 'playing') return;
      if (e.key==='ArrowLeft'  || e.key==='a' || e.key==='A') _push('left');
      if (e.key==='ArrowRight' || e.key==='d' || e.key==='D') _push('right');
      if (e.key==='ArrowUp'    || e.key==='w' || e.key==='W') _push('jump');
    }

    function _onTouchStart(e){
      e.preventDefault();
      const t = e.touches[0];
      touchStartX = t.clientX; touchStartY = t.clientY;
    }

    function _onTouchEnd(e){
      e.preventDefault();
      if (!touchStartX) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      touchStartX = touchStartY = null;
      if (phase !== 'playing') return;

      // 判斷主要方向：Y 向上大於閾值 → 跳躍；X 絕對值大於 Y → 切跑道
      if (Math.abs(dy) >= MIN_SWIPE && -dy > Math.abs(dx)){
        _push('jump');
      } else if (Math.abs(dx) >= MIN_SWIPE && Math.abs(dx) > Math.abs(dy)){
        _push(dx < 0 ? 'left' : 'right');
      }
      // 否則視為 tap，忽略（防止點擊重新開始時誤觸）
    }

    return {
      bind(canvas){
        document.addEventListener('keydown', _onKey);
        canvas.addEventListener('touchstart', _onTouchStart, { passive:false });
        canvas.addEventListener('touchend',   _onTouchEnd,   { passive:false });
      },
      unbind(canvas){
        document.removeEventListener('keydown', _onKey);
        canvas.removeEventListener('touchstart', _onTouchStart);
        canvas.removeEventListener('touchend',   _onTouchEnd);
      },
      /** 消費一個輸入（每幀呼叫，一次只處理一個） */
      consume(){
        return queue.shift() ?? null;
      },
      clear(){ queue = []; },
    };
  })();

  /* ──────────────────────────────────────────────
     CollisionSystem — 獨立 Swept AABB
  ────────────────────────────────────────────── */
  const Collision = {
    /**
     * 偵測小雞與障礙物是否碰撞。
     * 使用 Swept 判定：比較 prevY 到 currentY 的範圍，防止高速穿牆。
     * 邏輯跑道必須相同（或在跳躍高度以上）才判定碰撞。
     */
    checkObstacle(chick, obs){
      // 跑道不同 → 不碰
      if (chick.lane !== obs.lane) return false;
      // 小雞跳躍時 Y 較小（往上），障礙物 top 是 obs.y（相對），若小雞高於障礙物上緣則跳過
      const chickTop    = chick.yR - CHICK_H / 2;
      const obsBottom   = obs.y + obs.hh;      // obs.y 是障礙物中心
      if (chickTop < obs.y - obs.hh - 0.02) return false; // 完全跳過（有容錯）

      // X 用視覺 xR 做近似（跑道 Lerp 時可能短暫跨道，加容錯）
      const dx = Math.abs(chick.xR - LANE_XR[obs.lane]);
      if (dx > CHICK_W / 2 + obs.hw + 0.02) return false;

      // Y：Swept — 障礙物前一幀到這幀的 Y 範圍是否涵蓋小雞中心
      return obs.prevYR <= chick.yR + CHICK_H/2 &&
             obs.yR    >= chick.yR - CHICK_H/2;
    },

    checkCoin(chick, coin){
      if (coin.collected) return false;
      return Math.abs(chick.xR - coin.xR) < CHICK_W/2 + coin.r + 0.01 &&
             Math.abs(chick.yR - coin.yR) < CHICK_H/2 + coin.r + 0.01;
    },
  };

  /* ──────────────────────────────────────────────
     ObstaclePool
  ────────────────────────────────────────────── */
  const ObstaclePool = {
    items: [],
    spawnTimer: 0,

    reset(){ this.items = []; this.spawnTimer = 0; },

    /**
     * 每幀更新：移動 + 生成。
     * 防無解死局：每排最多塞 2 條跑道的障礙物，且至少留 1 條空。
     */
    update(dt, speed){
      // 移動（含 prevYR 記錄，供 Swept AABB 用）
      this.items = this.items.filter(o => {
        o.prevYR = o.yR;
        o.yR += speed * dt;
        return o.yR < 1.2; // 超出底部才刪除
      });

      // 生成
      this.spawnTimer -= dt;
      if (this.spawnTimer > 0) return;
      this._spawn(speed);
      // 間隔隨速度縮短，但設最小值
      this.spawnTimer = Math.max(0.45, 1.4 - (speed - BASE_SPEED) / BASE_SPEED * 0.5);
    },

    _spawn(speed){
      // 決定哪幾條跑道有障礙（至多 2 條，確保留 1 條空）
      const lanePerm = [0, 1, 2].sort(() => Math.random() - 0.5);
      const count = Math.random() < 0.35 ? 2 : 1; // 35% 機率雙障礙
      const usedLanes = lanePerm.slice(0, count);
      const spawnY = -0.12; // 從畫面頂端上方生成

      // 確認與既有障礙物不重疊（同跑道 Y 距離太近則跳過）
      for (const lane of usedLanes){
        const tooClose = this.items.some(o =>
          o.lane === lane && Math.abs(o.yR - spawnY) < 0.22
        );
        if (tooClose) continue;

        const def = OBS_DEFS[Math.floor(Math.random() * OBS_DEFS.length)];
        this.items.push({
          lane,
          xR: LANE_XR[lane],
          yR: spawnY, prevYR: spawnY - 0.01,
          hw: def.w / 2, hh: def.h / 2,
          def,
        });
      }
    },
  };

  /* ──────────────────────────────────────────────
     CoinPool
  ────────────────────────────────────────────── */
  const CoinPool = {
    items: [],
    spawnTimer: 0,

    reset(){ this.items = []; this.spawnTimer = 0.8; },

    update(dt, speed){
      this.items = this.items.filter(c => {
        c.yR += speed * dt;
        return c.yR < 1.15;
      });

      this.spawnTimer -= dt;
      if (this.spawnTimer > 0) return;
      this.spawnTimer = 0.6 + Math.random() * 0.8;

      const lane = Math.floor(Math.random() * LANES);
      const yR   = -0.08;
      // 不與障礙物重疊
      const blocked = ObstaclePool.items.some(o =>
        o.lane === lane && Math.abs(o.yR - yR) < 0.18
      );
      if (!blocked){
        this.items.push({ lane, xR: LANE_XR[lane], yR, r: 0.032, collected: false });
      }
    },
  };

  /* ──────────────────────────────────────────────
     LaneRenderer — 背景 + 跑道繪製（純視覺，不含邏輯）
  ────────────────────────────────────────────── */
  const LaneRenderer = {
    bgScrollY: 0,

    reset(){ this.bgScrollY = 0; },

    draw(c, speed, dt){
      this.bgScrollY = (this.bgScrollY + speed * dt * H) % H;

      // 天空漸層（用 pxRect 分段模擬）
      pxRect(c, 0, 0, W, Math.round(H*0.18), '#bfe9ff');
      pxRect(c, 0, Math.round(H*0.18), W, Math.round(H*0.22), '#d4f0ff');

      // 跑道背景（灰色路面）
      pxRect(c, 0, Math.round(H*0.28), W, Math.round(H*0.72), '#8a8070');

      // 跑道分隔線（捲動）
      for (let seg = -1; seg < Math.ceil(H / 48) + 1; seg++){
        const segY = Math.round(seg * 48 + this.bgScrollY * 0.5) % H;
        pxRect(c, Math.round(W*0.345)-2, segY, 4, 26, '#ffe9b8');
        pxRect(c, Math.round(W*0.655)-2, segY, 4, 26, '#ffe9b8');
      }

      // 側邊牆
      pxRect(c, 0,   Math.round(H*0.28), Math.round(W*0.06), Math.round(H*0.72), '#5c4a38');
      pxRect(c, Math.round(W*0.94), Math.round(H*0.28), Math.round(W*0.06), Math.round(H*0.72), '#5c4a38');

      // 路面磚紋（捲動）
      for (let seg = -1; seg < Math.ceil(H / 60) + 1; seg++){
        const segY = Math.round(seg * 60 + this.bgScrollY % 60);
        pxRect(c, Math.round(W*0.07), segY, Math.round(W*0.86), 3, 'rgba(0,0,0,0.1)');
      }
    },
  };

  /* ──────────────────────────────────────────────
     繪製函式
  ────────────────────────────────────────────── */

  /** 障礙物像素繪製（依類型區分顏色和輪廓） */
  function drawObstacle(c, obs){
    const px_ = Math.round(obs.xR * W);
    const py_ = Math.round(obs.yR * H);
    const pw  = Math.round(obs.hw * 2 * W);
    const ph  = Math.round(obs.hh * 2 * H);
    const def = obs.def;
    // 主體
    pxRect(c, px_-pw/2, py_-ph/2, pw, ph, def.colorSide);
    // 頂部高光
    pxRect(c, px_-pw/2, py_-ph/2, pw, Math.max(4, ph*0.25), def.colorTop);
    // 輪廓
    c.strokeStyle = PALETTE.outline; c.lineWidth = 2;
    c.strokeRect(Math.round((px_-pw/2)/PX)*PX, Math.round((py_-ph/2)/PX)*PX, Math.round(pw/PX)*PX, Math.round(ph/PX)*PX);
  }

  /** 金幣像素繪製 */
  function drawCoin(c, coin){
    const cx_ = Math.round(coin.xR * W);
    const cy_ = Math.round(coin.yR * H);
    const r_  = Math.round(coin.r  * W);
    fillPixelCircle(c, cx_, cy_, r_, '#ffd23f');
    fillPixelCircle(c, cx_-2, cy_-2, Math.max(2, r_*0.4), '#fff3a0');
  }

  /** 小雞像素繪製（inline，直接用 pxRect / fillPixelCircle） */
  function drawChicken(c, chick, flash){
    const cx_  = Math.round(chick.xR * W);
    const cy_  = Math.round(chick.yR * H);
    const r    = Math.round(W * 0.055);
    const leg  = chick.isJumping ? 0 : (chick.animFrame % 2 === 0 ? 4 : -4);

    if (flash && Math.floor(flash * 8) % 2 === 0) return; // 無敵閃爍

    // 翅膀
    fillPixelCircle(c, cx_ - Math.round(r*0.82), cy_ + Math.round(r*0.18), Math.round(r*0.36), '#e8a800');
    fillPixelCircle(c, cx_ + Math.round(r*0.82), cy_ + Math.round(r*0.18), Math.round(r*0.36), '#e8a800');

    // 身體
    const bodyCol = GameState.health < 20 ? PALETTE.sick : PALETTE.bodyMain;
    fillPixelCircle(c, cx_, cy_, r, bodyCol);
    fillPixelCircle(c, cx_ - Math.round(r*0.28), cy_ - Math.round(r*0.3), Math.round(r*0.42), PALETTE.bodyLight);

    // 眼睛
    const ex = Math.round(r*0.32), ey = -Math.round(r*0.06);
    fillPixelCircle(c, cx_-ex, cy_+ey, Math.round(r*0.3), PALETTE.eyeWhite);
    fillPixelCircle(c, cx_+ex, cy_+ey, Math.round(r*0.3), PALETTE.eyeWhite);
    fillPixelCircle(c, cx_-ex+1, cy_+ey+1, Math.round(r*0.16), PALETTE.eyeBlack);
    fillPixelCircle(c, cx_+ex+1, cy_+ey+1, Math.round(r*0.16), PALETTE.eyeBlack);

    // 嘴
    pxRect(c, cx_-4, cy_+Math.round(r*0.22), 8, 5, PALETTE.beak);

    // 臉紅
    fillPixelCircle(c, cx_-Math.round(r*0.5), cy_+Math.round(r*0.12), Math.round(r*0.15), PALETTE.blush);
    fillPixelCircle(c, cx_+Math.round(r*0.5), cy_+Math.round(r*0.12), Math.round(r*0.15), PALETTE.blush);

    // 腳（跑步動畫 or 跳躍縮腳）
    if (!chick.isJumping){
      pxRect(c, cx_-Math.round(r*0.32)+leg, cy_+Math.round(r*0.88), 7, 8, PALETTE.feet);
      pxRect(c, cx_+Math.round(r*0.12)-leg, cy_+Math.round(r*0.88), 7, 8, PALETTE.feet);
    } else {
      pxRect(c, cx_-Math.round(r*0.28), cy_+Math.round(r*0.75), 7, 6, PALETTE.feet);
      pxRect(c, cx_+Math.round(r*0.08), cy_+Math.round(r*0.75), 7, 6, PALETTE.feet);
    }
  }

  /* ──────────────────────────────────────────────
     HUD 繪製（分數 + 血量 + 距離）
  ────────────────────────────────────────────── */
  function drawHUD(c){
    const hpStr = '❤️'.repeat(hp) + '🖤'.repeat(MAX_HP - hp);
    hudEl.textContent = `${hpStr}  🪙 ${coinsEarned}  📏 ${Math.floor(distance)}m`;
  }

  function drawCountdown(c, elapsed){
    const n = COUNTDOWN - Math.floor(elapsed);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#ffe9b8';
    c.font = `bold ${Math.round(H*0.14)}px monospace`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(n > 0 ? String(n) : 'GO!', W/2, H/2);
  }

  function drawGameOver(c){
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(0, 0, W, H);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#e8584a';
    c.font = `bold ${Math.round(H*0.07)}px monospace`;
    c.fillText('GAME OVER', W/2, H*0.38);
    c.fillStyle = '#ffe9b8';
    c.font = `${Math.round(H*0.042)}px monospace`;
    c.fillText(`距離 ${Math.floor(distance)}m`, W/2, H*0.48);
    c.fillText(`金幣 +${coinsEarned} 🪙`, W/2, H*0.56);
    c.fillStyle = '#b6e3a1';
    c.font = `${Math.round(H*0.038)}px monospace`;
    c.fillText('▶ 點擊 / 按任意鍵 繼續', W/2, H*0.70);
  }

  /* ──────────────────────────────────────────────
     start() — MiniGameBase 介面
  ────────────────────────────────────────────── */
  function start(canvas, c, h, cb){
    W = canvas.width; H = canvas.height;
    ctx = c; hudEl = h; endCb = cb;
    done = false; resultData = null;
    score = 0; distance = 0; coinsEarned = 0;
    hp = MAX_HP; invuln = 0; flashTimer = 0;
    speed = BASE_SPEED;

    Chicken.reset();
    ObstaclePool.reset();
    CoinPool.reset();
    LaneRenderer.reset();
    InputMgr.clear();

    phase = 'countdown';
    countdownT = performance.now();
    lastT = countdownT;

    InputMgr.bind(canvas);

    // 遊戲結束後點擊畫布繼續
    const onClickEnd = () => {
      if (phase === 'gameover'){ _settle(); }
    };
    canvas.addEventListener('click', onClickEnd);
    document.addEventListener('keydown', onClickEnd);
    LaneRunGame._cleanup = () => {
      InputMgr.unbind(canvas);
      canvas.removeEventListener('click', onClickEnd);
      document.removeEventListener('keydown', onClickEnd);
    };
  }

  /* ──────────────────────────────────────────────
     update() — MiniGameBase 介面
  ────────────────────────────────────────────── */
  function update(){
    if (done) return;
    const now = performance.now();
    const dt  = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;

    // 倒數階段
    if (phase === 'countdown'){
      const elapsed = (now - countdownT) / 1000;
      if (elapsed >= COUNTDOWN + 0.6){
        phase = 'playing';
        lastT = performance.now();
      }
      return;
    }

    if (phase === 'gameover') return;

    // ── 輸入消費（輸入佇列，每幀最多一個） ──
    const input = InputMgr.consume();
    if (input === 'left')  Chicken.lane = Math.max(0, Chicken.lane - 1);
    if (input === 'right') Chicken.lane = Math.min(LANES-1, Chicken.lane + 1);
    if (input === 'jump')  Chicken.jump();

    // ── 物理更新 ──
    Chicken.update(dt);

    // ── 速度加速（每 30 秒）+ 上限 ──
    const elapsed = (performance.now() - (lastT - dt*1000 + dt*1000)) / 1000; // 近似
    speed = Math.min(MAX_SPEED, BASE_SPEED + Math.floor(distance / 60) * SPEED_STEP);

    // ── 物件更新 ──
    distance += speed * dt * H * 0.15; // 視覺距離換算為「公尺」用的係數
    ObstaclePool.update(dt, speed);
    CoinPool.update(dt, speed);
    LaneRenderer.bgScrollY = (LaneRenderer.bgScrollY + speed * dt * H) % H;

    // ── 碰撞偵測：金幣 ──
    CoinPool.items.forEach(coin => {
      if (Collision.checkCoin(Chicken, coin)){
        coin.collected = true;
        coinsEarned++;
        score += 10;
        _sfx('coin');
      }
    });
    CoinPool.items = CoinPool.items.filter(c => !c.collected);

    // ── 碰撞偵測：障礙物 ──
    if (invuln <= 0){
      for (const obs of ObstaclePool.items){
        if (Collision.checkObstacle(Chicken, obs)){
          hp--;
          invuln = HIT_INVULN;
          flashTimer = HIT_INVULN;
          _sfx('hit');
          if (hp <= 0){ _die(); return; }
          break;
        }
      }
    } else {
      invuln -= dt;
      flashTimer -= dt;
    }

    drawHUD(ctx);
  }

  /* ──────────────────────────────────────────────
     render() — MiniGameBase 介面
  ────────────────────────────────────────────── */
  function render(c){
    c.clearRect(0, 0, W, H);

    if (phase === 'countdown'){
      // 倒數時顯示靜止場景 + 數字
      LaneRenderer.draw(c, 0, 0);
      drawChicken(c, Chicken, 0);
      const elapsed = (performance.now() - countdownT) / 1000;
      drawCountdown(c, elapsed);
      return;
    }

    // 場景
    LaneRenderer.draw(c, speed, 1/60); // 背景捲動已在 update 算好，這裡傳 dt 近似
    ObstaclePool.items.forEach(obs => drawObstacle(c, obs));
    CoinPool.items.forEach(coin => drawCoin(c, coin));
    drawChicken(c, Chicken, flashTimer > 0 ? flashTimer : 0);

    if (phase === 'gameover') drawGameOver(c);
  }

  /* ──────────────────────────────────────────────
     內部工具
  ────────────────────────────────────────────── */
  function _die(){
    phase = 'gameover';
    _sfx('die');
  }

  function _settle(){
    if (done) return;
    done = true;
    const goldEarned = coinsEarned * 2 + Math.floor(distance / 30);
    resultData = {
      gameName: '三跑道跑酷',
      gold:    goldEarned,
      hunger:  0, happy: 5, happyPen: 0,
      summary: `跑了 ${Math.floor(distance)}m，收集 ${coinsEarned} 金幣，獲得 ${goldEarned} 💰！`,
    };
    if (endCb) endCb();
  }

  let _actx2 = null;
  function _sfx(type){
    if (!GameState.settings.sfx) return;
    try {
      if (!_actx2) _actx2 = new (window.AudioContext||window.webkitAudioContext)();
      const ac = _actx2, t0 = ac.currentTime;
      const o = ac.createOscillator(), g = ac.createGain();
      const cfg = type==='coin' ? [880,0.04,'square',0.05] :
                  type==='hit'  ? [160,0.15,'sawtooth',0.1] :
                                  [200,0.3,'sine',0.08];
      o.type = cfg[2]; o.frequency.setValueAtTime(cfg[0], t0);
      g.gain.setValueAtTime(cfg[3], t0); g.gain.exponentialRampToValueAtTime(0.0001, t0+cfg[1]);
      o.connect(g); g.connect(ac.destination); o.start(t0); o.stop(t0+cfg[1]);
    } catch(e){}
  }

  /* ──────────────────────────────────────────────
     MiniGameBase 介面
  ────────────────────────────────────────────── */
  function stop(){ if (LaneRunGame._cleanup) LaneRunGame._cleanup(); }
  function getResult(){ return resultData; }

  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

function scheduleRandomEvent(){
  const delay = randInt(60, 180) * 1000;
  setTimeout(() => {
    if (GameState.alive){
      const ev = choice(RANDOM_EVENTS);
      ev.fn();
      UI.toast(ev.text);
      GameState.addDiary('event', '隨機事件', ev.text.replace(/^\S+\s/, ''));
      UI.updateStats();
    }
    scheduleRandomEvent();
  }, delay);
}

/* ============================================================================
   10. Save — LocalStorage 存讀檔
   ============================================================================ */
const Save = {
  /** 組出目前完整可序列化的存檔內容（含日記、天氣等新欄位） */
  buildState(){
    return {
      name: GameState.name, alive: GameState.alive, level: GameState.level,
      exp: GameState.exp, gold: GameState.gold, ageMs: GameState.ageMs,
      weight: GameState.weight, hunger: GameState.hunger, happy: GameState.happy,
      health: GameState.health, energy: GameState.energy, clean: GameState.clean,
      sleepStat: GameState.sleepStat, isSleeping: GameState.isSleeping,
      stage: GameState.stage, background: GameState.background, weather: GameState.weather,
      outfit: GameState.outfit, inventory: GameState.inventory,
      ownedWear: GameState.ownedWear, lastLoginDate: GameState.lastLoginDate,
      settings: GameState.settings, createdAt: GameState.createdAt,
      poopCount: GameState.poopCount, diary: GameState.diary,
    };
  },

  slotKey(n){ return SAVE_KEY_PREFIX + n; },

  hasSlot(n){
    try { return !!localStorage.getItem(this.slotKey(n)); }
    catch(e){ return false; }
  },

  /** 只讀取 metadata（不套用到遊戲），用於在存檔列表顯示摘要 */
  readMeta(n){
    try {
      const raw = localStorage.getItem(this.slotKey(n));
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data.metadata || null;
    } catch(e){ return null; }
  },

  /** 實際寫入 LocalStorage。若目標格已有資料，呼叫端必須先跳二次確認彈窗。 */
  saveToSlot(n){
    const payload = {
      version: SAVE_VERSION,
      metadata: {
        name: GameState.name,
        level: GameState.level,
        ageDays: Math.floor(GameState.ageDays()),
        savedAt: Date.now(),
      },
      state: this.buildState(),
    };
    try {
      localStorage.setItem(this.slotKey(n), JSON.stringify(payload));
      GameState.isDirty = false;
      currentSlot = n;
      UI.toast(`💾 已存檔到 Slot ${n}`);
      UI.updateStats();
      UI.renderSaveSlots();
    } catch(e){
      console.warn('存檔失敗', e);
      UI.toast('❌ 存檔失敗（LocalStorage 可能已滿）');
    }
  },

  /** 讀取指定存檔位並套用到目前的 GameState。含最基本的 Schema Version 相容判斷。 */
  loadFromSlot(n){
    try {
      const raw = localStorage.getItem(this.slotKey(n));
      if (!raw){ UI.toast('❌ 這個存檔位是空的'); return false; }
      const data = JSON.parse(raw);
      if (data.version !== SAVE_VERSION){
        // Migration 占位：日後若 Schema 升版，可在此依 data.version 做欄位轉換
        console.warn(`存檔版本 ${data.version} 與目前版本 ${SAVE_VERSION} 不同，嘗試直接相容讀取`);
      }
      Object.assign(GameState, data.state);
      GameState.isDirty = false;
      currentSlot = n;
      UI.clearPoop();
      ChickWander.reset();
      for (let i=0;i<(GameState.poopCount||0);i++) UI.spawnPoop();
      drawBackground(GameState.background);
      UI.toast(`📂 已讀取 Slot ${n}`);
      UI.updateStats();
      return true;
    } catch(e){
      console.warn('讀檔失敗', e);
      UI.toast('❌ 讀檔失敗，存檔可能已損毀');
      return false;
    }
  },

  /** 舊版單一存檔（chickenLife_save_v1）自動搬遷到 Slot 1，避免舊玩家資料遺失。
      只在 Slot 1 目前是空的時候才搬，不會覆蓋玩家已經手動存過的新格式資料。 */
  migrateLegacyIfNeeded(){
    try {
      const legacy = localStorage.getItem(SAVE_KEY_LEGACY);
      if (legacy && !this.hasSlot(1)){
        const oldState = JSON.parse(legacy);
        const payload = {
          version: SAVE_VERSION,
          metadata: {
            name: oldState.name || 'CHICK',
            level: oldState.level || 1,
            ageDays: Math.floor((oldState.ageMs||0) / DAY_LENGTH_MS),
            savedAt: Date.now(),
          },
          state: Object.assign({ weather:'sunny', diary:[] }, oldState),
        };
        localStorage.setItem(this.slotKey(1), JSON.stringify(payload));
        localStorage.removeItem(SAVE_KEY_LEGACY);
      }
    } catch(e){ /* 搬遷失敗不影響新遊戲啟動，安靜忽略即可 */ }
  },
};

/* ============================================================================
   11. UIController
   ============================================================================ */
const UI = {
  toastTimer: null,

  init(){
    this.bindButtons();
    this.bindModals();
    this.bindBgSwitcher();

    // 捲動到底時隱藏右側 ▶ 提示
    const bar = document.getElementById('action-bar');
    const wrap = document.getElementById('action-bar-wrap');
    bar.addEventListener('scroll', () => {
      const atEnd = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 4;
      wrap.classList.toggle('scrolled-end', atEnd);
    });
    document.getElementById('name-input').value = GameState.name;
    document.getElementById('chick-name').textContent = GameState.name;
    document.getElementById('sfx-toggle').checked = GameState.settings.sfx;

    animManager.register('chick', {
      fps: 8,
      frameCount: 8,
      draw: (frame) => {
        const W = chickCtx.canvas.width, H = chickCtx.canvas.height;

        // 漫步系統：每幀計算小雞在畫布上的實際位置
        const wander = ChickWander.tick(W, H);

        // 決定動畫狀態：若漫步系統認為正在走路，強制使用 'walk' 動畫；
        // 否則交給 activeState() 依數值決定（睡眠/難過/生病等）。
        let state = this.activeState();
        if (wander.isWalking && state === 'idle') state = 'walk';

        const params = {
          state,
          frame,
          stage: GameState.stage,
          outfit: GameState.outfit,
          sick: GameState.health < 20,
          cx: wander.wx,
          cy: wander.wy,
        };

        if (!wander.facingRight){
          // 水平翻轉畫布讓小雞面向左方行走
          chickCtx.save();
          chickCtx.translate(W, 0);
          chickCtx.scale(-1, 1);
          // cx 需要鏡像換算：翻轉後 x' = W - x
          drawChick(chickCtx, { ...params, cx: W - wander.wx });
          chickCtx.restore();
        } else {
          drawChick(chickCtx, params);
        }
      }
    });
    // 天氣粒子動畫獨立成一個 actor：不依賴 frame 序號，直接用高解析度時間戳
    // 讓雨滴/雪花/閃電可以連續平滑地移動，不受小雞 8fps 的動畫格率限制。
    animManager.register('weather', {
      fps: 30,
      frameCount: 999999,
      draw: (frame, t) => drawWeather(t),
    });
    animManager.start();

    drawBackground(GameState.background);
  },

  bindButtons(){
    // 統一輸入鎖：部分行動裝置瀏覽器在特定情況下可能讓同一次點擊觸發兩次事件
    // （touch 合成 click 的邊緣情況），造成「點一次卻扣兩份飼料」的問題。
    // 這裡用一個極短的鎖定窗口（180ms）確保同一顆按鈕在鎖定期間內的重複觸發會被忽略。
    let inputLocked = false;
    const withInputLock = (fn) => {
      if (inputLocked) return;
      inputLocked = true;
      fn();
      setTimeout(() => { inputLocked = false; }, 180);
    };

    document.querySelectorAll('.action-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => withInputLock(() => {
        SoundManager.click();
        const action = btn.dataset.action;
        switch(action){
          case 'feed': GameState.feed(); break;
          case 'water': GameState.water(); break;
          case 'play':
            if (!GameState.alive){ UI.toast('😇 小雞已經去了天堂...'); return; }
            if (GameState.energy < 5){ UI.toast('😩 活力太低了，先補充能量再玩！'); return; }
            MiniGameSystem.showMenu(); return;
          case 'bath': GameState.bath(); break;
          case 'sleep': GameState.sleepToggle(); break;
          case 'doctor': GameState.doctor(); break;
          case 'clean': GameState.clean_(); break;
          case 'work': GameState.work(); break;
          case 'shop': this.openModal('shop-modal'); this.renderShop(); break;
          case 'diary': this.openModal('diary-modal'); this.renderDiary(); break;
          case 'settings': this.openModal('settings-modal'); this.renderSaveSlots(); break;
          case 'manual': this.openModal('manual-modal'); break;
        }
        GameState.markDirty(); // 任何互動都視為「有未存檔的變更」，需要玩家手動存檔
        this.updateStats();
      }));
    });

    // 每日獎勵按鈕已移到畫面左上角浮動按鈕，同樣套用輸入鎖
    document.getElementById('daily-reward-btn').addEventListener('click', () => withInputLock(() => {
      SoundManager.click();
      GameState.dailyReward();
      GameState.markDirty();
      this.updateStats();
    }));

    // 幸運轉盤浮動按鈕：直接啟動 WheelGame，跳過 showMenu()，
    // 且結算時不套用 +20 心情的 baseHappy（因為轉盤不是「玩耍」，
    // 而是每日一轉的運氣事件，獎懲完全由轉盤扇形決定）。
    document.getElementById('wheel-btn').addEventListener('click', () => withInputLock(() => {
      SoundManager.click();
      if (!GameState.alive){ UI.toast('😇 小雞已經去了天堂...'); return; }
      MiniGameSystem.launchWheel();
    }));

    chickCanvas.addEventListener('click', () => {
      GameState.happy = clamp(GameState.happy + 1);
      this.playOneShot('idle', 200);
    });
  },

  bindModals(){
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.tab-btn').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        this.renderShop(tab.dataset.tab);
      });
    });
    document.getElementById('save-btn').addEventListener('click', () => {
      GameState.name = document.getElementById('name-input').value.trim() || 'CHICK';
      GameState.settings.sfx = document.getElementById('sfx-toggle').checked;
      document.getElementById('chick-name').textContent = GameState.name;
      GameState.markDirty();
      this.toast('✅ 名稱／音效設定已套用（別忘了到下方存檔位存檔）');
      this.renderSaveSlots();
    });
    document.getElementById('reset-btn').addEventListener('click', () => {
      const msg = usingFileSystem
        ? '確定要重新開始嗎？目前資料夾內的存檔檔案不會被自動刪除，重新開始後記得手動存檔覆蓋它。'
        : '確定要清除全部 3 個存檔位並重新開始嗎？此動作無法復原。';
      this.confirmPixel(msg, () => {
        if (!usingFileSystem){
          for (let i=1;i<=3;i++) localStorage.removeItem(Save.slotKey(i));
        }
        GameState.restart();
        this.closeModal('settings-modal');
        this.updateStats();
        this.toast('🗑️ 已重新開始！');
      });
    });
    document.getElementById('restart-btn').addEventListener('click', () => {
      GameState.restart();
      this.closeModal('death-modal');
      this.updateStats();
    });
  },

  /** 通用像素風確認彈窗，取代原生 confirm()。用於存檔覆蓋、清除存檔等需要二次確認的操作。 */
  confirmPixel(message, onConfirm){
    document.getElementById('confirm-message').textContent = message;
    this.openModal('confirm-modal');
    const yesBtn = document.getElementById('confirm-yes');
    const noBtn = document.getElementById('confirm-no');
    // 用 cloneNode 換掉舊按鈕，避免每次呼叫疊加重複的事件監聽器
    const newYes = yesBtn.cloneNode(true);
    const newNo = noBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    noBtn.parentNode.replaceChild(newNo, noBtn);
    newYes.addEventListener('click', () => {
      this.closeModal('confirm-modal');
      onConfirm();
    });
    newNo.addEventListener('click', () => this.closeModal('confirm-modal'));
  },

  /** 存檔位列表：顯示 3 個 Slot 目前的內容摘要，並提供「存檔」／「讀取」按鈕。
      存到已有資料的格位時，會先跳出二次確認彈窗，避免誤蓋掉舊進度。 */
  renderSaveSlots(){
    const container = document.getElementById('save-slots');
    container.innerHTML = '';

    if (usingFileSystem){
      const row = document.createElement('div');
      row.className = 'save-slot';
      row.innerHTML = `
        <div class="save-slot-info">💾 存檔模式：資料夾檔案<br>檔名：${FS_SAVE_FILENAME}</div>
        <div class="save-slot-buttons">
          <button id="fs-save-btn">存檔</button>
        </div>
      `;
      row.querySelector('#fs-save-btn').addEventListener('click', async () => {
        const ok = await FileSave.writeSave();
        if (ok){
          GameState.isDirty = false;
          this.toast('💾 已存檔到資料夾！');
        } else {
          this.toast('❌ 存檔失敗，請確認資料夾權限是否仍然有效。');
        }
        this.updateStats();
      });
      container.appendChild(row);
      return;
    }

    for (let n=1; n<=3; n++){
      const meta = Save.readMeta(n);
      const row = document.createElement('div');
      row.className = 'save-slot';
      const info = meta
        ? `Slot ${n}：${meta.name} Lv.${meta.level} · 第${meta.ageDays}天<br>${new Date(meta.savedAt).toLocaleString()}`
        : `Slot ${n}：（空）`;
      row.innerHTML = `
        <div class="save-slot-info">${info}</div>
        <div class="save-slot-buttons">
          <button class="save-here-btn">存檔</button>
          <button class="load-btn" ${meta ? '' : 'disabled'}>讀取</button>
        </div>
      `;
      row.querySelector('.save-here-btn').addEventListener('click', () => {
        if (meta){
          this.confirmPixel(`Slot ${n} 已經有存檔（${meta.name} Lv.${meta.level}），確定要覆蓋嗎？`, () => {
            Save.saveToSlot(n);
          });
        } else {
          Save.saveToSlot(n);
        }
      });
      const loadBtn = row.querySelector('.load-btn');
      if (meta){
        loadBtn.addEventListener('click', () => {
          this.confirmPixel(`確定要讀取 Slot ${n} 嗎？目前尚未存檔的進度將會遺失。`, () => {
            Save.loadFromSlot(n);
            this.renderSaveSlots();
          });
        });
      }
      container.appendChild(row);
    }
  },

  /** 日記列表：新到舊排序，顯示每筆事件的類型 icon、標題、內容與遊戲天數 */
  renderDiary(){
    const list = document.getElementById('diary-list');
    list.innerHTML = '';
    if (GameState.diary.length === 0){
      list.innerHTML = `<p>📔 日記還是空的，跟小雞多互動一下，故事就會開始累積囉！</p>`;
      return;
    }
    const typeIcon = {
      levelup:'🎉', work:'💼', daily:'🎁', shop:'🛍️', growth:'✨',
      death:'😇', event:'🎲', weather:'🌦️', sick:'🤒',
    };
    [...GameState.diary].reverse().forEach(entry => {
      const row = document.createElement('div');
      row.className = 'diary-entry';
      row.innerHTML = `
        <div class="diary-entry-head">
          <span class="diary-entry-title">${typeIcon[entry.type]||'📝'} ${entry.title}</span>
          <span class="diary-entry-meta">第${entry.gameDay}天</span>
        </div>
        <div>${entry.description}</div>
      `;
      list.appendChild(row);
    });
  },

  bindBgSwitcher(){
    document.querySelectorAll('.bg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        GameState.background = btn.dataset.bg;
        drawBackground(GameState.background);
        SoundManager.click();
        GameState.markDirty();
      });
    });
  },

  openModal(id){ document.getElementById(id).classList.remove('hidden'); },
  closeModal(id){ document.getElementById(id).classList.add('hidden'); },

  renderShop(category){
    const tab = category || document.querySelector('.tab-btn.active')?.dataset.tab || 'food';
    const list = document.getElementById('shop-list');
    list.innerHTML = '';
    if (tab === 'bg'){
      list.innerHTML = `<p>🎨 背景已全部開放，於畫面右上角圖示即可切換：<br>🏠 房間 / 🌱 草地 / 🚜 農場 / 🌲 森林 / ❄️ 雪地 / 🌙 夜晚</p>`;
      return;
    }
    if (tab === 'closet'){
      this.renderCloset(list);
      return;
    }
    SHOP_ITEMS[tab].forEach(item => {
      const owned = tab === 'wear' ? GameState.ownedWear[item.id] : null;
      const row = document.createElement('div');
      row.className = 'shop-item';
      const held = GameState.inventory[item.id] || 0;
      const countText = tab !== 'wear' ? ` (持有 ${held})` : '';
      const useBtnHtml = item.usable ? `<button class="use-btn" ${held>0?'':'disabled'}>使用</button>` : '';
      row.innerHTML = `
        <div class="shop-item-info">
          <span class="pixel-icon">${item.icon}</span>
          <div>
            <div>${item.name}${countText}</div>
            <div style="font-size:7px;color:#5c3b26;">${item.desc}</div>
          </div>
        </div>
        <div style="display:flex; gap:4px;">
          ${useBtnHtml}
          <button class="buy-btn" ${owned ? 'disabled' : ''}>${owned ? '已擁有' : `💰${item.price}`}</button>
        </div>
      `;
      row.querySelector('.buy-btn').addEventListener('click', () => Shop.buy(tab, item.id));
      const useBtn = row.querySelector('.use-btn');
      if (useBtn){
        useBtn.addEventListener('click', () => {
          GameState.useItem(item.id);
          this.renderShop(tab);
        });
      }
      list.appendChild(row);
    });
  },

  /** 衣櫃：只列出「已購買」的裝扮，讓玩家自由穿脫、即時反映在小雞身上 */
  renderCloset(list){
    list.innerHTML = ''; // 修正複製 bug：先前只有「衣櫃是空的」分支會清空列表，
                          // 每次穿脫都呼叫 renderCloset() 重繪，導致舊列表沒清掉、
                          // 新的一份疊加上去，看起來就像裝扮被複製了。
    const ownedIds = SHOP_ITEMS.wear.filter(item => GameState.ownedWear[item.id]);
    if (ownedIds.length === 0){
      list.innerHTML = `<p>👕 衣櫃目前是空的，先到「裝扮」分頁購買一些行頭吧！</p>`;
      return;
    }
    ownedIds.forEach(item => {
      const wearing = !!GameState.outfit[item.id];
      const row = document.createElement('div');
      row.className = 'shop-item';
      row.innerHTML = `
        <div class="shop-item-info">
          <span class="pixel-icon">${item.icon}</span>
          <div>
            <div>${item.name} ${wearing ? '（穿戴中）' : ''}</div>
            <div style="font-size:7px;color:#5c3b26;">${item.desc}</div>
          </div>
        </div>
        <button>${wearing ? '脫下' : '穿上'}</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        GameState.outfit[item.id] = !GameState.outfit[item.id];
        SoundManager.click();
        this.renderCloset(list);
        GameState.markDirty();
      });
      list.appendChild(row);
    });
  },

  updateStats(){
    document.getElementById('stat-level').textContent = GameState.level;
    document.getElementById('stat-age').textContent = Math.floor(GameState.ageDays());
    document.getElementById('stat-gold').textContent = GameState.gold;
    const stageInfo = STAGES.find(s => s.key === GameState.stage) || STAGES[1];
    document.getElementById('stage-label').textContent = stageInfo.label;

    const weatherInfo = WEATHER_TYPES[GameState.weather] || WEATHER_TYPES.sunny;
    const weatherEl = document.getElementById('weather-label');
    weatherEl.textContent = weatherInfo.icon;
    weatherEl.title = `目前天氣：${weatherInfo.label}`;

    // 天氣影響提示：列出目前天氣讓哪些數值衰減變快（倍率 != 1 才顯示）
    const noteEl = document.getElementById('weather-effect-note');
    const statLabel = { hunger:'飽食', happy:'心情', energy:'活力', clean:'清潔' };
    const affected = Object.entries(weatherInfo.decay)
      .filter(([,mult]) => mult !== 1)
      .map(([k,mult]) => `${statLabel[k]} x${mult}`);
    if (affected.length > 0){
      noteEl.textContent = `${weatherInfo.icon} ${weatherInfo.label}影響中：${affected.join('、')} 衰減倍率`;
      noteEl.classList.remove('hidden');
    } else {
      noteEl.classList.add('hidden');
    }

    document.getElementById('dirty-flag').classList.toggle('hidden', !GameState.isDirty);

    const bars = {
      health: GameState.health, hunger: GameState.hunger, happy: GameState.happy,
      energy: GameState.energy, clean: GameState.clean, sleep: GameState.sleepStat,
    };
    for (const [key, val] of Object.entries(bars)){
      const el = document.getElementById('bar-' + key);
      el.style.width = val + '%';
      el.classList.toggle('low', val < 20);
    }
  },

  showBubble(emoji){
    const b = document.getElementById('bubble');
    b.textContent = emoji;
    b.classList.remove('hidden');
  },
  hideBubble(){
    document.getElementById('bubble').classList.add('hidden');
  },

  spawnPoop(){
    const layer = document.getElementById('poop-layer');
    if (layer.children.length >= 5) return;
    const el = document.createElement('div');
    el.className = 'poop-pixel';
    el.textContent = '💩';
    el.style.left = randInt(10, 85) + '%';
    el.style.top = randInt(60, 85) + '%';
    layer.appendChild(el);
  },
  clearPoop(){
    document.getElementById('poop-layer').innerHTML = '';
  },

  toast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      t.classList.add('hidden');
      t.classList.remove('show');
    }, 2600);
  },

  /** 目前要播放的動畫狀態：優先採用尚未過期的「暫時狀態」（吃東西/開心一下等動作），
      否則回到 GameState 依數值算出的自然狀態（idle / sleep / sad / sick / dead）。
      這個函式是唯一的狀態來源，不會像舊版那樣覆寫 GameState 本身的方法，
      因此「暫時狀態」不可能忘記復原而卡住動畫。 */
  activeState(){
    if (this._tempState && Date.now() < this._tempStateExpires){
      return this._tempState;
    }
    return GameState.currentDominantState();
  },

  /** 暫時切換動畫狀態幾百毫秒（例如吃東西、開心一下），到期後自動回到自然狀態。
      不需要也不接受「永久覆寫」(ms 為空) ——需要常駐狀態的情況（如睡眠）
      一律交給 GameState.currentDominantState() 依數值判斷，更不容易出錯。 */
  playOneShot(stateName, ms){
    if (!ms) return; // 不再支援「永久覆寫」，避免動畫卡死
    this._tempState = stateName;
    this._tempStateExpires = Date.now() + ms;
  },

  showDeath(){
    if (this._deathShown) return; // 防止任何情況下重複觸發死亡畫面
    this._deathShown = true;
    SoundManager.death();
    document.getElementById('death-stats').textContent =
      `存活了 ${Math.floor(GameState.ageDays())} 天 ・ 等級 Lv.${GameState.level}`;
    this.openModal('death-modal');
    let frame = 0;
    const angelAnim = setInterval(() => {
      if (document.getElementById('death-modal').classList.contains('hidden')){
        clearInterval(angelAnim); return;
      }
      drawAngel(frame++);
    }, 120);
  },
};

/* ============================================================================
   10b. FileSave — 檔案系統存檔（File System Access API）
   ----------------------------------------------------------------------------
   讓玩家指定電腦/手機上的實體資料夾作為存檔位置，遊戲存檔會直接寫成該資料夾內
   的一個 JSON 檔案（chicken_life_save.json）。

   重要限制：File System Access API（window.showDirectoryPicker）目前只有桌機版
   Chrome / Edge / Opera 支援，iOS Safari、Android 上的行動版瀏覽器都不支援。
   因此本模組會先做能力偵測（FS_SUPPORTED），啟動選單會依偵測結果顯示或隱藏
   對應的按鈕，並在不支援時提供「使用瀏覽器內建儲存空間」的備援路徑，
   確保遊戲在不支援的裝置上仍然完整可玩。

   規格要求「每次啟動都要在選單裡明確選擇」，所以這裡刻意不做資料夾授權的
   跨 session 持久化（不存 IndexedDB handle），每次啟動都需要玩家親自選擇一次
   資料夾——這同時也比較符合瀏覽器的安全模型（很多瀏覽器本來就不會讓網頁
   在沒有使用者手勢的情況下自動取得資料夾存取權）。
   ============================================================================ */
const FS_SAVE_FILENAME = 'chicken_life_save.json';
const FS_SUPPORTED = typeof window.showDirectoryPicker === 'function';
let fsDirHandle = null;   // 玩家選定的資料夾 FileSystemDirectoryHandle
let usingFileSystem = false; // true＝目前存檔目標是資料夾檔案；false＝瀏覽器內建儲存空間

const FileSave = {
  /** 跳出瀏覽器原生的資料夾選擇器，並直接請求讀寫權限。
      回傳 true 代表成功取得資料夾；使用者按取消（AbortError）則回傳 false。 */
  async pickFolder(){
    if (!FS_SUPPORTED) return false;
    try {
      fsDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      return true;
    } catch(e){
      if (e && e.name === 'AbortError') return false; // 使用者自己取消選擇，不算錯誤
      console.warn('選擇存檔資料夾失敗', e);
      return false;
    }
  },

  /** 將目前的完整遊戲狀態寫入資料夾內的存檔檔案。
      File System Access API 的 createWritable() 在瀏覽器層級本來就是「寫到暫存檔、
      close() 時才原子性地換上正式檔案」的設計，就算寫入過程中分頁被關閉，
      原本的存檔檔案也不會變成寫一半的損毀狀態，最壞情況只是這次的寫入沒生效。 */
  async writeSave(){
    if (!fsDirHandle) return false;
    try {
      const fileHandle = await fsDirHandle.getFileHandle(FS_SAVE_FILENAME, { create: true });
      const writable = await fileHandle.createWritable();
      const payload = {
        version: SAVE_VERSION,
        metadata: {
          name: GameState.name,
          level: GameState.level,
          ageDays: Math.floor(GameState.ageDays()),
          savedAt: Date.now(),
        },
        state: Save.buildState(),
      };
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
      return true;
    } catch(e){
      console.warn('寫入存檔資料夾失敗', e);
      return false;
    }
  },

  /** 讀取資料夾內的存檔檔案；資料夾內沒有存檔檔案時回傳 null（視為空資料夾）。 */
  async readSave(){
    if (!fsDirHandle) return null;
    try {
      const fileHandle = await fsDirHandle.getFileHandle(FS_SAVE_FILENAME);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text);
    } catch(e){
      return null; // 找不到檔案 / 檔案損毀，都當作「這個資料夾還沒有存檔」處理
    }
  },
};

/* ============================================================================
   11. 啟動選單 UI — 遊戲初始化前的強制選擇畫面
   ----------------------------------------------------------------------------
   規格要求：遊戲初始化時不可以直接載入舊存檔或直接進入畫面，必須先覆蓋一個
   啟動選單，讓玩家明確選擇 A.（資料夾）讀取 或 B.（資料夾）開始新遊戲。
   ============================================================================ */
let gameStarted = false; // 防止任何情況下 startGameLoop() 被重複呼叫兩次

function hideStartupMenu(){
  document.getElementById('startup-menu').classList.add('hidden');
}

function setupStartupMenu(){
  const loadBtn = document.getElementById('startup-load-folder');
  const newBtn  = document.getElementById('startup-new-folder');
  const note    = document.getElementById('fs-unsupported-note');

  if (!FS_SUPPORTED){
    loadBtn.disabled = true;
    newBtn.disabled = true;
    loadBtn.style.opacity = '0.4';
    newBtn.style.opacity = '0.4';
    note.classList.remove('hidden');
  }

  // A. 選擇存檔資料夾並讀取
  loadBtn.addEventListener('click', async () => {
    if (!FS_SUPPORTED) return;
    const ok = await FileSave.pickFolder();
    if (!ok) return; // 使用者取消了資料夾選擇，留在選單上讓他重新選

    const data = await FileSave.readSave();
    if (data){
      Object.assign(GameState, data.state);
      GameState.isDirty = false;
      GameState.lastTickAt = Date.now();
      usingFileSystem = true;
      hideStartupMenu();
      startGameLoop(false);
    } else {
      UI.confirmPixel(
        '這個資料夾裡沒有找到存檔，要以「新遊戲」開始，並在這個資料夾建立新的存檔檔案嗎？',
        () => {
          GameState.restart();
          usingFileSystem = true;
          hideStartupMenu();
          startGameLoop(true);
        }
      );
    }
  });

  // B. 選擇存檔資料夾並開始新遊戲
  newBtn.addEventListener('click', async () => {
    if (!FS_SUPPORTED) return;
    const ok = await FileSave.pickFolder();
    if (!ok) return;

    const data = await FileSave.readSave();
    const proceedNewGame = () => {
      GameState.restart();
      usingFileSystem = true;
      hideStartupMenu();
      startGameLoop(true);
    };
    if (data){
      UI.confirmPixel(
        `這個資料夾已經有存檔了（${data.metadata?.name || '小雞'} Lv.${data.metadata?.level || 1}），開始新遊戲將會覆蓋它，確定嗎？`,
        proceedNewGame
      );
    } else {
      proceedNewGame();
    }
  });

  // 備援：使用瀏覽器內建儲存空間（LocalStorage 3 Slot），不需要資料夾
  document.getElementById('startup-use-browser').addEventListener('click', () => {
    Save.migrateLegacyIfNeeded();
    const hadSave = Save.hasSlot(1);
    if (hadSave) Save.loadFromSlot(1);
    GameState.lastTickAt = Date.now();
    usingFileSystem = false;
    hideStartupMenu();
    startGameLoop(!hadSave);
  });
}

/* ============================================================================
   12. 啟動遊戲主迴圈（在啟動選單完成選擇後才會呼叫）
   ============================================================================ */
function startGameLoop(isNewGame){
  if (gameStarted) return; // 防禦性處理：確保 UI.init()／animManager.start() 不會被重複呼叫
  gameStarted = true;

  UI.init();
  // canvas 的尺寸必須在 #scene 已佔有真實空間之後才能正確計算；
  // UI.init() 裡的 animManager.start() 在第一幀之前這裡先同步 fit 一次。
  setTimeout(fitCanvasToScene, 0); // 等下一個 microtask，確保 flexbox layout 已完成
  setTimeout(() => drawBackground(GameState.background), 10);
  UI.updateStats();
  UI.renderShop('food');

  if (isNewGame){
    GameState.dailyReward(); // 新遊戲直接送每日登入獎勵
    GameState.isDirty = true; // 新遊戲尚未存檔，提醒玩家記得手動存檔
  } else {
    const today = new Date().toDateString();
    if (GameState.lastLoginDate !== today){
      setTimeout(() => UI.toast('🎁 今天還沒領每日獎勵，記得點擊左上角的每日獎勵按鈕！'), 1200);
    }
  }
  UI.updateStats();

  GameState.lastTickAt = Date.now();
  mainTickInterval = setInterval(() => {
    GameState.simulate();
    UI.updateStats();
  }, TICK_MS);

  // 分頁切到背景時（例如切到別的 App），瀏覽器常會節流甚至暫停 setInterval；
  // 切回前景的當下主動補跑一次 simulate()，讓「經過的時間」立刻依上限公平地補算，
  // 不必等到下一個整秒的 setInterval 才反應過來。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible'){
      GameState.simulate();
      UI.updateStats();
    }
  });

  scheduleRandomEvent();
  scheduleWeather();

  // 存檔改為全面手動觸發：離開頁面前若仍有未存檔的變更，跳出瀏覽器原生的離開提示，
  // 而不是悄悄自動存檔（那樣會讓「手動存檔」這個設計失去意義，且檔案系統模式下
  // 寫檔是非同步的，分頁關閉當下也無法保證能寫完）。
  window.addEventListener('beforeunload', (e) => {
    if (GameState.isDirty){
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

document.addEventListener('DOMContentLoaded', setupStartupMenu);

})();
