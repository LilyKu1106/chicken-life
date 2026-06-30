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
  { key:'egg',   label:'蛋',     minAge:-1, scale:0.5 },
  { key:'baby',  label:'幼雞',   minAge:0,  scale:0.6 },
  { key:'kid',   label:'小雞',   minAge:1,  scale:0.8 },
  { key:'teen',  label:'青年雞', minAge:3,  scale:1.0 },
  { key:'adult', label:'成年雞', minAge:7,  scale:1.15 },
  { key:'old',   label:'老雞',   minAge:15, scale:1.05 },
];

const DAY_LENGTH_MS = 60 * 1000;     // 遊戲內：現實 60 秒 = 1 天（方便展示成長系統）
const TICK_MS = 1000;                 // 數值每秒自然變化一次
const DECAY = { hunger:0.45, happy:0.35, energy:0.30, clean:0.30, sleep:0.0 };
const SAVE_KEY = 'chickenLife_save_v1';
let mainTickInterval = null; // 主數值衰減計時器的參照，死亡時會被清除

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

/** 將 canvas 內部解析度設定為固定值，CSS 再用 100% 撐滿，達到清晰縮放 */
function fitCanvas(canvas){
  canvas.width = 320;
  canvas.height = 180;
}
fitCanvas(chickCanvas);
fitCanvas(document.getElementById('bg-canvas'));

const avatarCanvas = document.getElementById('top-avatar-canvas');
const avatarCtx = avatarCanvas.getContext('2d');
avatarCtx.imageSmoothingEnabled = false;
fitCanvas(avatarCanvas); // 與主畫布共用同一份座標系（320x180），CSS 再縮小顯示即可

/**
 * 畫出小雞本體。state 決定表情/動作，frame 用來做幀間變化，stageScale 控制體型大小。
 * outfit: { hat, glasses, scarf, clothes, wings } 任一為 true 表示穿戴中。
 */
function drawChick(ctx, { state, frame, stageScale, outfit, sick }){
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const baseX = ctx.canvas.width / 2;
  const baseY = ctx.canvas.height / 2 + 20;
  const bob = Math.sin(frame / 8 * Math.PI * 2) * 4; // 待機浮動

  let offsetY = 0, squash = 1, eyeMode = 'normal', mouthOpen = false, tilt = 0;

  switch(state){
    case 'idle':
      offsetY = bob;
      break;
    case 'walk':
      offsetY = Math.abs(Math.sin(frame)) * 6 - 3;
      tilt = Math.sin(frame) * 4;
      break;
    case 'eat':
      mouthOpen = frame % 2 === 0;
      offsetY = bob * 0.4;
      break;
    case 'sleep':
      eyeMode = 'closed';
      offsetY = Math.sin(frame/8*Math.PI*2) * 1.5;
      squash = 0.96;
      break;
    case 'happy':
      eyeMode = 'happy';
      offsetY = -Math.abs(Math.sin(frame)) * 8;
      break;
    case 'sad':
      eyeMode = 'sad';
      offsetY = 4;
      squash = 0.95;
      break;
    case 'sick':
      eyeMode = 'sick';
      offsetY = bob * 0.5;
      break;
    case 'poop':
      squash = 0.85;
      offsetY = 4;
      break;
    case 'clean':
      offsetY = bob * 0.6;
      eyeMode = 'happy';
      break;
    case 'levelup':
      offsetY = -Math.abs(Math.sin(frame)) * 12;
      eyeMode = 'happy';
      break;
    case 'dead':
      squash = 0.55;
      tilt = 90;
      eyeMode = 'dead';
      offsetY = 30;
      break;
  }

  const cx = baseX;
  const cy = baseY + offsetY;
  const r = 34 * stageScale;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt * Math.PI/180);
  ctx.scale(1, squash);
  ctx.translate(-cx, -cy);

  const bodyColor = sick ? PALETTE.sick : PALETTE.bodyMain;

  // ---- 翅膀（裝扮：天使翅膀 或 一般小翅膀）----
  if (outfit.wings){
    fillPixelCircle(ctx, cx - r*0.95, cy, r*0.55, '#ffffff');
    fillPixelCircle(ctx, cx + r*0.95, cy, r*0.55, '#ffffff');
  } else {
    fillPixelCircle(ctx, cx - r*0.85, cy + r*0.15, r*0.4, PALETTE.bodyDark);
  }

  // ---- 身體 ----
  fillPixelCircle(ctx, cx, cy, r, bodyColor);
  fillPixelCircle(ctx, cx - r*0.3, cy - r*0.35, r*0.45, PALETTE.bodyLight);

  // ---- 雞冠（青年雞以上才有） ----
  if (stageScale >= 1.0){
    pxRect(ctx, cx-6, cy-r-10, 12, 10, PALETTE.comb);
  }

  // ---- 臉紅 ----
  fillPixelCircle(ctx, cx - r*0.55, cy + r*0.1, r*0.18, PALETTE.blush);
  fillPixelCircle(ctx, cx + r*0.55, cy + r*0.1, r*0.18, PALETTE.blush);

  // ---- 眼睛 ----
  const eyeOffsetX = r*0.35, eyeOffsetY = -r*0.05;
  drawEyes(ctx, cx, cy, eyeOffsetX, eyeOffsetY, r, eyeMode, frame);

  // ---- 嘴喙 ----
  ctx.fillStyle = PALETTE.beak;
  const beakW = mouthOpen ? 16 : 12;
  const beakH = mouthOpen ? 12 : 7;
  pxRect(ctx, cx - beakW/2, cy + r*0.18, beakW, beakH, PALETTE.beak);
  if (mouthOpen){
    pxRect(ctx, cx - beakW/2+2, cy + r*0.18+4, beakW-4, beakH-6, PALETTE.beakDark);
  }

  // ---- 腳 ----
  pxRect(ctx, cx - r*0.4 - 4, cy + r*0.85, 8, 8, PALETTE.feet);
  pxRect(ctx, cx + r*0.4 - 4, cy + r*0.85, 8, 8, PALETTE.feet);

  ctx.restore();

  // ---- 裝扮（不隨身體旋轉，畫在最上層）----
  drawOutfit(ctx, cx, cy - offsetY*0 + offsetY, r, outfit);

  // ---- 狀態特效（哭泣 / 生病 / 升級星星 / 睡覺Z / 天使光環）----
  drawStateFx(ctx, cx, cy + offsetY, r, state, frame);
}

function drawEyes(ctx, cx, cy, ox, oy, r, mode, frame){
  const ex1 = cx-ox, ex2 = cx+ox, ey = cy+oy;
  if (mode === 'closed' || mode === 'happy'){
    // 瞇眼／開心眼：用一條向上彎的線（以像素矩形堆疊模擬弧線）
    ['#2b2017'].forEach(c=>{
      pxRect(ctx, ex1-7, ey, 14, 3, c);
      pxRect(ctx, ex1-7, ey-3, 3, 3, c);
      pxRect(ctx, ex1+4, ey-3, 3, 3, c);
      pxRect(ctx, ex2-7, ey, 14, 3, c);
      pxRect(ctx, ex2-7, ey-3, 3, 3, c);
      pxRect(ctx, ex2+4, ey-3, 3, 3, c);
    });
    return;
  }
  if (mode === 'dead'){
    pxRect(ctx, ex1-6, ey-2, 12, 4, PALETTE.outline);
    pxRect(ctx, ex2-6, ey-2, 12, 4, PALETTE.outline);
    return;
  }
  if (mode === 'sick'){
    // 螺旋暈眩眼：用幾個交錯像素表示
    [[-6,-6],[ -2,-2],[2,2],[6,-6],[-6,2]].forEach(([dx,dy])=>{
      px(ctx, ex1+dx, ey+dy, PALETTE.outline);
      px(ctx, ex2+dx, ey+dy, PALETTE.outline);
    });
    return;
  }
  // normal / sad：白底黑眼珠
  fillPixelCircle(ctx, ex1, ey, 8, PALETTE.eyeWhite);
  fillPixelCircle(ctx, ex2, ey, 8, PALETTE.eyeWhite);
  const pupilDY = mode === 'sad' ? 3 : 0;
  fillPixelCircle(ctx, ex1, ey+pupilDY, 4, PALETTE.eyeBlack);
  fillPixelCircle(ctx, ex2, ey+pupilDY, 4, PALETTE.eyeBlack);
  if (mode === 'sad'){
    // 垂下的眉毛
    pxRect(ctx, ex1-8, ey-10, 14, 3, PALETTE.outline);
    pxRect(ctx, ex2-6, ey-10, 14, 3, PALETTE.outline);
  }
}

function drawOutfit(ctx, cx, cy, r, outfit){
  if (outfit.glasses){
    pxRect(ctx, cx - r*0.65, cy - r*0.12, r*0.45, r*0.3, 'rgba(40,40,40,.85)');
    pxRect(ctx, cx + r*0.2, cy - r*0.12, r*0.45, r*0.3, 'rgba(40,40,40,.85)');
    pxRect(ctx, cx - r*0.2, cy - r*0.02, r*0.4, 4, PALETTE.outline);
  }
  if (outfit.hat){
    pxRect(ctx, cx - r*0.55, cy - r*1.55, r*1.1, r*0.35, '#e8584a');
    pxRect(ctx, cx - r*0.75, cy - r*1.25, r*1.5, r*0.18, '#c2392c');
  }
  if (outfit.scarf){
    pxRect(ctx, cx - r*0.6, cy + r*0.55, r*1.2, r*0.3, '#6fc3df');
  }
  if (outfit.clothes){
    pxRect(ctx, cx - r*0.65, cy + r*0.3, r*1.3, r*0.55, '#b08bdb');
  }
}

let particles = [];
function drawStateFx(ctx, cx, cy, r, state, frame){
  if (state === 'sad'){
    if (frame % 8 < 4){
      pxRect(ctx, cx + r*0.4, cy + r*0.15, 4, 8, PALETTE.tear);
    }
  }
  if (state === 'sick'){
    pxRect(ctx, cx + r*0.6, cy - r*0.6, 6, 8, '#aee8ff');
  }
  if (state === 'sleep'){
    ctx.font = '12px monospace';
    ctx.fillStyle = PALETTE.outline;
    const zy = cy - r - 10 - (frame%8)*2;
    ctx.fillText('z', cx + r*0.5, zy);
  }
  if (state === 'levelup'){
    for (let i=0;i<5;i++){
      const a = (frame*0.4 + i*(Math.PI*2/5));
      const sx = cx + Math.cos(a)*r*1.4;
      const sy = cy + Math.sin(a)*r*1.4;
      px(ctx, sx, sy, PALETTE.bodyMain);
    }
  }
  if (state === 'clean'){
    for (let i=0;i<3;i++){
      const sy = cy - r - (frame*3 + i*10) % 40;
      px(ctx, cx - r*0.7 + i*r*0.7, sy, PALETTE.eyeWhite);
    }
  }
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
   6. SoundManager — 8-bit 音效合成（不需任何音檔）
   ============================================================================ */
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
  stage: 'baby',
  background: 'room',
  outfit: { hat:false, glasses:false, scarf:false, clothes:false, wings:false },
  inventory: { food_basic: 3, food_premium: 0, medicine: 0, soap: 0, toy: 0 },
  ownedWear: { hat:false, glasses:false, scarf:false, clothes:false },
  lastLoginDate: null,
  settings: { sfx: true },
  createdAt: Date.now(),
  poopCount: 0,

  ageDays(){ return this.ageMs / DAY_LENGTH_MS; },

  getStage(){
    const days = this.ageDays();
    let s = STAGES[0];
    for (const st of STAGES){ if (days >= st.minAge) s = st; }
    return s;
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
    }
  },

  addGold(n){ this.gold = Math.max(0, this.gold + n); },

  tick(){
    if (!this.alive) return;
    this.ageMs += TICK_MS;

    if (!this.isSleeping){
      this.hunger = clamp(this.hunger - DECAY.hunger);
      this.happy  = clamp(this.happy  - DECAY.happy);
      this.energy = clamp(this.energy - DECAY.energy);
      this.clean  = clamp(this.clean  - DECAY.clean);
      this.sleepStat = clamp(this.sleepStat - 0.25);
    } else {
      this.sleepStat = clamp(this.sleepStat + 4);
      this.energy = clamp(this.energy + 3);
      if (this.sleepStat >= 100) this.wake();
    }

    // 健康會被其他數值過低拖累，狀態良好則緩慢回復
    let healthDelta = 0.15;
    if (this.hunger < 20) healthDelta -= 0.5;
    if (this.happy  < 20) healthDelta -= 0.3;
    if (this.clean  < 30) healthDelta -= 0.3;
    if (this.sleepStat < 20) healthDelta -= 0.3;
    this.health = clamp(this.health + healthDelta);

    // 體重隨飢餓變化微調
    this.weight = clamp(this.weight + (this.hunger > 70 ? 0.05 : -0.03), 10, 99);

    // 經驗值隨時間自然小幅增加（陪伴成長）
    this.addExp(0.4);

    this.checkStage();
    this.checkAI();
    this.checkDeath();
  },

  checkStage(){
    const s = this.getStage();
    if (s.key !== this.stage){
      this.stage = s.key;
      UI.toast(`✨ 小雞長大了！現在是「${s.label}」`);
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
  },

  restart(){
    UI._deathShown = false;
    Object.assign(this, {
      name:'CHICK', alive:true, level:1, exp:0, gold:50, ageMs:0, weight:50,
      hunger:80, happy:80, health:100, energy:80, clean:80, sleepStat:80,
      isSleeping:false, stage:'baby', background:'room',
      outfit:{hat:false,glasses:false,scarf:false,clothes:false,wings:false},
      inventory:{food_basic:3, food_premium:0, medicine:0, soap:0, toy:0},
      ownedWear:{hat:false,glasses:false,scarf:false,clothes:false},
      poopCount:0,
    });
    UI.clearPoop();
    if (!mainTickInterval){
      mainTickInterval = setInterval(() => {
        GameState.tick();
        UI.updateStats();
        Save.persist();
      }, TICK_MS);
    }
    Save.persist();
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
  ],
  wear: [
    { id:'hat',     name:'帽子', icon:'🎩', price:30, desc:'時尚帽子裝扮' },
    { id:'glasses', name:'眼鏡', icon:'🕶️', price:25, desc:'酷酷的眼鏡' },
    { id:'scarf',   name:'圍巾', icon:'🧣', price:20, desc:'溫暖圍巾' },
    { id:'clothes', name:'服裝', icon:'👕', price:35, desc:'可愛小衣服' },
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

function scheduleRandomEvent(){
  const delay = randInt(60, 180) * 1000;
  setTimeout(() => {
    if (GameState.alive){
      const ev = choice(RANDOM_EVENTS);
      ev.fn();
      UI.toast(ev.text);
      UI.updateStats();
    }
    scheduleRandomEvent();
  }, delay);
}

/* ============================================================================
   10. Save — LocalStorage 存讀檔
   ============================================================================ */
const Save = {
  persist(){
    const data = {
      name: GameState.name, alive: GameState.alive, level: GameState.level,
      exp: GameState.exp, gold: GameState.gold, ageMs: GameState.ageMs,
      weight: GameState.weight, hunger: GameState.hunger, happy: GameState.happy,
      health: GameState.health, energy: GameState.energy, clean: GameState.clean,
      sleepStat: GameState.sleepStat, isSleeping: GameState.isSleeping,
      stage: GameState.stage, background: GameState.background,
      outfit: GameState.outfit, inventory: GameState.inventory,
      ownedWear: GameState.ownedWear, lastLoginDate: GameState.lastLoginDate,
      settings: GameState.settings, createdAt: GameState.createdAt,
      poopCount: GameState.poopCount,
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); }
    catch(e){ console.warn('存檔失敗', e); }
  },
  load(){
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      Object.assign(GameState, data);
      return true;
    } catch(e){ console.warn('讀檔失敗', e); return false; }
  },
  clear(){ localStorage.removeItem(SAVE_KEY); },
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
    document.getElementById('name-input').value = GameState.name;
    document.getElementById('chick-name').textContent = GameState.name;
    document.getElementById('sfx-toggle').checked = GameState.settings.sfx;

    animManager.register('chick', {
      fps: 8,
      frameCount: 8,
      draw: (frame) => {
        const stageInfo = STAGES.find(s => s.key === GameState.stage) || STAGES[1];
        const params = {
          state: this.activeState(),
          frame,
          stageScale: stageInfo.scale,
          outfit: GameState.outfit,
          sick: GameState.health < 20,
        };
        drawChick(chickCtx, params);
        // 頂部小頭像：同一份座標系（320x180），直接重用同一個繪製函式，
        // 即時同步顯示目前的成長階段與裝扮，CSS 再把畫布顯示縮小即可。
        drawChick(avatarCtx, { ...params, stageScale: params.stageScale * 0.85 });
      }
    });
    animManager.start();

    drawBackground(GameState.background);
  },

  bindButtons(){
    document.querySelectorAll('.action-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        SoundManager.click();
        const action = btn.dataset.action;
        switch(action){
          case 'feed': GameState.feed(); break;
          case 'water': GameState.water(); break;
          case 'play': GameState.play(); break;
          case 'bath': GameState.bath(); break;
          case 'sleep': GameState.sleepToggle(); break;
          case 'doctor': GameState.doctor(); break;
          case 'clean': GameState.clean_(); break;
          case 'daily': GameState.dailyReward(); break;
          case 'work': GameState.work(); break;
          case 'shop': this.openModal('shop-modal'); this.renderShop(); break;
          case 'settings': this.openModal('settings-modal'); break;
        }
        this.updateStats();
        Save.persist();
      });
    });

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
      Save.persist();
      this.toast('💾 已儲存！');
    });
    document.getElementById('reset-btn').addEventListener('click', () => {
      if (confirm('確定要清除存檔並重新開始嗎？')){
        Save.clear();
        GameState.restart();
        this.closeModal('settings-modal');
        this.updateStats();
      }
    });
    document.getElementById('restart-btn').addEventListener('click', () => {
      GameState.restart();
      this.closeModal('death-modal');
      this.updateStats();
    });
  },

  bindBgSwitcher(){
    document.querySelectorAll('.bg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        GameState.background = btn.dataset.bg;
        drawBackground(GameState.background);
        SoundManager.click();
        Save.persist();
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
    SHOP_ITEMS[tab].forEach(item => {
      const owned = tab === 'wear' ? GameState.ownedWear[item.id] : null;
      const row = document.createElement('div');
      row.className = 'shop-item';
      const countText = tab !== 'wear' ? ` (持有 ${GameState.inventory[item.id]||0})` : '';
      row.innerHTML = `
        <div class="shop-item-info">
          <span class="pixel-icon">${item.icon}</span>
          <div>
            <div>${item.name}${countText}</div>
            <div style="font-size:7px;color:#5c3b26;">${item.desc}</div>
          </div>
        </div>
        <button ${owned ? 'disabled' : ''}>${owned ? '已擁有' : `💰${item.price}`}</button>
      `;
      row.querySelector('button').addEventListener('click', () => Shop.buy(tab, item.id));
      list.appendChild(row);
    });
  },

  updateStats(){
    document.getElementById('stat-level').textContent = GameState.level;
    document.getElementById('stat-age').textContent = Math.floor(GameState.ageDays());
    document.getElementById('stat-gold').textContent = GameState.gold;
    const stageInfo = STAGES.find(s => s.key === GameState.stage) || STAGES[1];
    document.getElementById('stage-label').textContent = stageInfo.label;

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
   12. 啟動
   ============================================================================ */
function init(){
  const hadSave = Save.load();
  UI.init();
  UI.updateStats();
  UI.renderShop('food');

  if (!hadSave){
    GameState.dailyReward(); // 第一次遊玩直接送每日獎勵
  } else {
    const today = new Date().toDateString();
    if (GameState.lastLoginDate !== today){
      setTimeout(() => UI.toast('🎁 今天還沒領每日獎勵，記得點擊「每日獎勵」按鈕！'), 1200);
    }
  }

  mainTickInterval = setInterval(() => {
    GameState.tick();
    UI.updateStats();
    Save.persist();
  }, TICK_MS);

  scheduleRandomEvent();

  // 離開頁面前自動存檔
  window.addEventListener('beforeunload', () => Save.persist());
}

document.addEventListener('DOMContentLoaded', init);

})();
