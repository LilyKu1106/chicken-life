/* ============================================================================
   Chicken Life — script.js
   ----------------------------------------------------------------------------
   一款使用 Vanilla JavaScript 撰寫的瀏覽器電子雞養成遊戲。
   全部美術皆以 Canvas 程序化繪製（低解析度 + 不平滑縮放）呈現像素風。
   
   檔案內容已完美補全頂部動態大頭貼同步邏輯，並確保手機版 RWD 佈局正常。
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
  bodyOld:    '#f2b84b',
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

const DAY_LENGTH_MS = 60 * 1000;
const TICK_MS = 1000;
const DECAY = { hunger:0.45, happy:0.35, energy:0.30, clean:0.30, sleep:0.0 };
const SAVE_KEY = 'chickenLife_save_v1';
let mainTickInterval = null; 

const PX = 4;

/* ============================================================================
   2. 工具函式（像素繪製）
   ============================================================================ */
function clamp(v, min=0, max=100){ return Math.max(min, Math.min(max, v)); }
function rand(min, max){ return Math.random() * (max - min) + min; }
function randInt(min, max){ return Math.floor(rand(min, max+1)); }
function choice(arr){ return arr[randInt(0, arr.length-1)]; }

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

function px(ctx, gx, gy, color){
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(gx/PX)*PX, Math.round(gy/PX)*PX, PX, PX);
}

function pxRect(ctx, x, y, w, h, color){
  ctx.fillStyle = color;
  const gx = Math.round(x/PX)*PX, gy = Math.round(y/PX)*PX;
  const gw = Math.round(w/PX)*PX, gh = Math.round(h/PX)*PX;
  ctx.fillRect(gx, gy, gw, gh);
}

/* ============================================================================
   3. SpriteAnimationManager — 通用動畫管理器
   ============================================================================ */
class SpriteAnimationManager {
  constructor(){ this.actors = new Map(); this._raf = null; this._lastTime = 0; }
  register(id, actor){ this.actors.set(id, Object.assign({ frame: 0, elapsed: 0, fps: 8 }, actor)); }
  unregister(id){ this.actors.delete(id); }
  get(id){ return this.actors.get(id); }
  start(){
    if (this._raf) return;
    const loop = (t) => {
      const dt = t - (this._lastTime || t); this._lastTime = t;
      for (const actor of this.actors.values()){
        actor.elapsed += dt;
        const frameDur = 1000 / (actor.fps || 8);
        if (actor.elapsed >= frameDur){ actor.elapsed = 0; actor.frame = (actor.frame + 1) % (actor.frameCount || 1); }
        if (typeof actor.draw === 'function') actor.draw(actor.frame, t);
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
}
const animManager = new SpriteAnimationManager();

/* ============================================================================
   4. ChickActor — 小雞與大頭貼之繪製邏輯
   ============================================================================ */
const chickCanvas = document.getElementById('chick-canvas');
const chickCtx = chickCanvas.getContext('2d');
chickCtx.imageSmoothingEnabled = false;

function fitCanvas(canvas, w=320, h=180){ canvas.width = w; canvas.height = h; }
fitCanvas(chickCanvas);
fitCanvas(document.getElementById('bg-canvas'));

// 頂部大頭貼畫布初始化
const topCanvas = document.getElementById('top-avatar-canvas');
const topCtx = topCanvas.getContext('2d');
topCtx.imageSmoothingEnabled = false;
fitCanvas(topCanvas, 32, 32);

function drawChick(ctx, { state, frame, stageScale, outfit, sick, isTopAvatar=false }){
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const baseX = ctx.canvas.width / 2;
  const baseY = isTopAvatar ? (ctx.canvas.height / 2 + 3) : (ctx.canvas.height / 2 + 20);
  const finalScale = isTopAvatar ? (stageScale * 0.24) : stageScale;

  const bob = Math.sin(frame / 8 * Math.PI * 2) * (isTopAvatar ? 1 : 4);
  let offsetY = 0, squash = 1, eyeMode = 'normal', mouthOpen = false, tilt = 0;

  switch(state){
    case 'idle': offsetY = bob; break;
    case 'walk': offsetY = Math.abs(Math.sin(frame)) * (isTopAvatar?1.5:6) - (isTopAvatar?0.8:3); tilt = Math.sin(frame) * 4; break;
    case 'eat': mouthOpen = frame % 2 === 0; offsetY = bob * 0.4; break;
    case 'sleep': eyeMode = 'closed'; offsetY = Math.sin(frame/8*Math.PI*2) * 1.5; squash = 0.96; break;
    case 'happy': eyeMode = 'happy'; offsetY = -Math.abs(Math.sin(frame)) * (isTopAvatar?2:8); break;
    case 'sad': eyeMode = 'sad'; offsetY = isTopAvatar?1:4; squash = 0.95; break;
    case 'sick': eyeMode = 'sick'; offsetY = bob * 0.5; break;
    case 'poop': squash = 0.85; offsetY = isTopAvatar?1:4; break;
    case 'clean': offsetY = bob * 0.6; eyeMode = 'happy'; break;
    case 'levelup': offsetY = -Math.abs(Math.sin(frame)) * (isTopAvatar?3:12); eyeMode = 'happy'; break;
    case 'dead': squash = 0.55; tilt = 90; eyeMode = 'dead'; offsetY = isTopAvatar?6:30; break;
  }

  const cx = baseX;
  const cy = baseY + offsetY;
  const r = 34 * finalScale;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt * Math.PI/180);
  ctx.scale(1, squash);
  ctx.translate(-cx, -cy);

  const bodyColor = sick ? PALETTE.sick : (GameState.stage === 'old' ? PALETTE.bodyOld : PALETTE.bodyMain);

  if (outfit.wings){
    fillPixelCircle(ctx, cx - r*0.95, cy, r*0.55, '#ffffff');
    fillPixelCircle(ctx, cx + r*0.95, cy, r*0.55, '#ffffff');
  } else {
    fillPixelCircle(ctx, cx - r*0.85, cy + r*0.15, r*0.4, PALETTE.bodyDark);
  }

  fillPixelCircle(ctx, cx, cy, r, bodyColor);
  fillPixelCircle(ctx, cx - r*0.3, cy - r*0.35, r*0.45, PALETTE.bodyLight);

  if (finalScale >= 0.2){
    pxRect(ctx, cx-(isTopAvatar?1:6), cy-r-(isTopAvatar?2:10), (isTopAvatar?2:12), (isTopAvatar?2:10), PALETTE.comb);
  }

  fillPixelCircle(ctx, cx - r*0.55, cy + r*0.1, r*0.18, PALETTE.blush);
  fillPixelCircle(ctx, cx + r*0.55, cy + r*0.1, r*0.18, PALETTE.blush);

  const eyeOffsetX = r*0.35, eyeOffsetY = -r*0.05;
  drawEyes(ctx, cx, cy, eyeOffsetX, eyeOffsetY, r, eyeMode, frame, isTopAvatar);

  ctx.fillStyle = PALETTE.beak;
  const beakW = mouthOpen ? (isTopAvatar?4:16) : (isTopAvatar?3:12);
  const beakH = mouthOpen ? (isTopAvatar?3:12) : (isTopAvatar?2:7);
  pxRect(ctx, cx - beakW/2, cy + r*0.18, beakW, beakH, PALETTE.beak);

  pxRect(ctx, cx - r*0.4 - (isTopAvatar?1:4), cy + r*0.85, (isTopAvatar?2:8), (isTopAvatar?2:8), PALETTE.feet);
  pxRect(ctx, cx + r*0.4 - (isTopAvatar?1:4), cy + r*0.85, (isTopAvatar?2:8), (isTopAvatar?2:8), PALETTE.feet);

  ctx.restore();

  drawOutfit(ctx, cx, cy + offsetY, r, outfit, isTopAvatar);
  if (!isTopAvatar) drawStateFx(ctx, cx, cy + offsetY, r, state, frame);
}

function drawEyes(ctx, cx, cy, ox, oy, r, mode, frame, isTopAvatar=false){
  const ex1 = cx-ox, ex2 = cx+ox, ey = cy+oy;
  if (isTopAvatar){
    px(ctx, ex1, ey, mode==='closed'||mode==='happy'? PALETTE.outline : PALETTE.eyeBlack);
    px(ctx, ex2, ey, mode==='closed'||mode==='happy'? PALETTE.outline : PALETTE.eyeBlack);
    return;
  }
  if (mode === 'closed' || mode === 'happy'){
    pxRect(ctx, ex1-7, ey, 14, 3, PALETTE.outline); pxRect(ctx, ex1-7, ey-3, 3, 3, PALETTE.outline); pxRect(ctx, ex1+4, ey-3, 3, 3, PALETTE.outline);
    pxRect(ctx, ex2-7, ey, 14, 3, PALETTE.outline); pxRect(ctx, ex2-7, ey-3, 3, 3, PALETTE.outline); pxRect(ctx, ex2+4, ey-3, 3, 3, PALETTE.outline);
    return;
  }
  if (mode === 'dead'){
    pxRect(ctx, ex1-6, ey-2, 12, 4, PALETTE.outline); pxRect(ctx, ex2-6, ey-2, 12, 4, PALETTE.outline);
    return;
  }
  if (mode === 'sick'){
    [[-6,-6],[-2,-2],[2,2],[6,-6],[-6,2]].forEach(([dx,dy])=>{ px(ctx, ex1+dx, ey+dy, PALETTE.outline); px(ctx, ex2+dx, ey+dy, PALETTE.outline); });
    return;
  }
  fillPixelCircle(ctx, ex1, ey, 8, PALETTE.eyeWhite); fillPixelCircle(ctx, ex2, ey, 8, PALETTE.eyeWhite);
  const pupilDY = mode === 'sad' ? 3 : 0;
  fillPixelCircle(ctx, ex1, ey+pupilDY, 4, PALETTE.eyeBlack); fillPixelCircle(ctx, ex2, ey+pupilDY, 4, PALETTE.eyeBlack);
  if (mode === 'sad'){ pxRect(ctx, ex1-8, ey-10, 14, 3, PALETTE.outline); pxRect(ctx, ex2-6, ey-10, 14, 3, PALETTE.outline); }
}

function drawOutfit(ctx, cx, cy, r, outfit, isTopAvatar=false){
  const h4 = isTopAvatar ? 1 : 4;
  if (outfit.glasses){
    pxRect(ctx, cx - r*0.65, cy - r*0.12, r*0.45, r*0.3, 'rgba(40,40,40,.85)');
    pxRect(ctx, cx + r*0.2, cy - r*0.12, r*0.45, r*0.3, 'rgba(40,40,40,.85)');
    pxRect(ctx, cx - r*0.2, cy - r*0.02, r*0.4, h4, PALETTE.outline);
  }
  if (outfit.hat){
    pxRect(ctx, cx - r*0.55, cy - r*1.55, r*1.1, r*0.35, '#e8584a');
    pxRect(ctx, cx - r*0.75, cy - r*1.25, r*1.5, r*0.18, '#c2392c');
  }
  if (outfit.scarf){ pxRect(ctx, cx - r*0.6, cy + r*0.55, r*1.2, r*0.3, '#6fc3df'); }
  if (outfit.clothes){ pxRect(ctx, cx - r*0.65, cy + r*0.3, r*1.3, r*0.55, '#b08bdb'); }
}

function drawStateFx(ctx, cx, cy, r, state, frame){
  if (state === 'sad' && frame % 8 < 4) pxRect(ctx, cx + r*0.4, cy + r*0.15, 4, 8, PALETTE.tear);
  if (state === 'sick') pxRect(ctx, cx + r*0.6, cy - r*0.6, 6, 8, '#aee8ff');
  if (state === 'sleep'){ ctx.font = '12px monospace'; ctx.fillStyle = PALETTE.outline; ctx.fillText('z', cx + r*0.5, cy - r - 10 - (frame%8)*2); }
  if (state === 'levelup'){
    for (let i=0;i<5;i++){ const a = (frame*0.4 + i*(Math.PI*2/5)); px(ctx, cx + Math.cos(a)*r*1.4, cy + Math.sin(a)*r*1.4, PALETTE.bodyMain); }
  }
  if (state === 'clean'){
    for (let i=0;i<3;i++) px(ctx, cx - r*0.7 + i*r*0.7, cy - r - (frame*3 + i*10) % 40, PALETTE.eyeWhite);
  }
}

function drawAngel(frame){
  const c = document.getElementById('angel-canvas'); const actx = c.getContext('2d');
  actx.imageSmoothingEnabled = false; actx.clearRect(0,0,c.width,c.height);
  const cx = c.width/2, cy = c.height/2 + Math.sin(frame/8*Math.PI*2)*4;
  fillPixelCircle(actx, cx-26, cy, 16, '#ffffff'); fillPixelCircle(actx, cx+26, cy, 16, '#ffffff');
  fillPixelCircle(actx, cx, cy, 26, PALETTE.bodyMain); fillPixelCircle(actx, cx, cy-26, 9, '#fff7cf');
  drawEyes(actx, cx, cy, 9, -3, 26, 'happy', frame); pxRect(actx, cx-6, cy+6, 12, 6, PALETTE.beak);
}

/* ============================================================================
   5. BackgroundRenderer — 背景場景繪製
   ============================================================================ */
const bgCanvas = document.getElementById('bg-canvas');
const bgCtx = bgCanvas.getContext('2d');
bgCtx.imageSmoothingEnabled = false;

function drawBackground(key){
  const W = bgCanvas.width, H = bgCanvas.height; bgCtx.clearRect(0,0,W,H); const groundY = H*0.62;
  const scenes = {
    room(){
      pxRect(bgCtx, 0,0,W,groundY, '#f7e7c4'); pxRect(bgCtx, 0,groundY,W,H-groundY, '#c89a63');
      pxRect(bgCtx, W*0.08,H*0.12,W*0.16,H*0.16,'#9fd6ef'); pxRect(bgCtx, W*0.08,H*0.12,W*0.16,H*0.16,'rgba(255,255,255,.4)');
      pxRect(bgCtx, W*0.75,groundY-30,W*0.16,30,'#8a5a3b'); pxRect(bgCtx, W*0.06,groundY-22,W*0.14,22,'#e8584a');
      pxRect(bgCtx, 0,groundY-6,W,6,'#a87b46');
    },
    grass(){
      pxRect(bgCtx, 0,0,W,groundY,'#bfe9ff'); pxRect(bgCtx, 0,groundY,W,H-groundY,'#8fcf6a');
      for(let i=0;i<W;i+=12){ pxRect(bgCtx, i, groundY-4, 4, 6, '#6fae5a'); }
      fillPixelCircle(bgCtx, W*0.2,H*0.18,18,'#fff8e0');
    },
    farm(){
      pxRect(bgCtx, 0,0,W,groundY,'#bfe9ff'); pxRect(bgCtx, 0,groundY,W,H-groundY,'#caa15f');
      for(let i=0;i<W;i+=16){ pxRect(bgCtx, i, groundY+6, 8, 4, '#a9824c'); }
      pxRect(bgCtx, W*0.7,groundY-40,W*0.22,40,'#c2392c'); pxRect(bgCtx, W*0.7,groundY-50,W*0.22,12,'#5c3b26');
      for(let i=0;i<6;i++){ pxRect(bgCtx, i*36, groundY-14, 4, 14, '#caa15f'); }
    },
    forest(){
      pxRect(bgCtx, 0,0,W,groundY,'#bcd9c2'); pxRect(bgCtx, 0,groundY,W,H-groundY,'#7a9e63');
      for(let i=0;i<5;i++){ const x = 20 + i*60; pxRect(bgCtx, x-4, groundY-30, 8, 30, '#6b4326'); fillPixelCircle(bgCtx, x, groundY-46, 22, '#4d8a45'); }
    },
    snow(){
      pxRect(bgCtx, 0,0,W,groundY,'#dcebf5'); pxRect(bgCtx, 0,groundY,W,H-groundY,'#ffffff');
      for(let i=0;i<40;i++){ px(bgCtx, (i*37)%W, (i*53)%groundY, '#ffffff'); }
    },
    night(){
      pxRect(bgCtx, 0,0,W,groundY,'#1c2240'); pxRect(bgCtx, 0,groundY,W,H-groundY,'#2a2f1f');
      for(let i=0;i<24;i++){ px(bgCtx, (i*53)%W, (i*29)%(groundY-10), '#ffe9b8'); }
      fillPixelCircle(bgCtx, W*0.78,H*0.18,14,'#fff8e0');
    }
  };
  (scenes[key] || scenes.room)();
}

/* ============================================================================
   6. SoundManager — 8-bit 音效合成
   ============================================================================ */
const SoundManager = (() => {
  let actx = null;
  function ensure(){ if (!actx) actx = new (window.AudioContext||window.webkitAudioContext)(); return actx; }
  function tone(freq, dur, type='square', delay=0, vol=0.06){
    if (!GameState.settings.sfx) return;
    const ctx = ensure(); const t0 = ctx.currentTime + delay; const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0); gain.gain.setValueAtTime(vol, t0); gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(t0); osc.stop(t0 + dur);
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
   7. GameState — 狀態 / 存檔 / 行為
   ============================================================================ */
const GameState = {
  name: 'CHICK', alive: true, level: 1, exp: 0, gold: 50, ageMs: 0, weight: 50,
  hunger: 80, happy: 80, health: 100, energy: 80, clean: 80, sleepStat: 80,
  isSleeping: false, stage: 'baby', background: 'room',
  outfit: { hat:false, glasses:false, scarf:false, clothes:false, wings:false },
  inventory: { food_basic: 3, food_premium: 0, medicine: 0, soap: 0, toy: 0 },
  ownedWear: { hat:false, glasses:false, scarf:false, clothes:false },
  lastLoginDate: null, settings: { sfx: true }, createdAt: Date.now(), poopCount: 0,

  ageDays(){ return this.ageMs / DAY_LENGTH_MS; },
  getStage(){ const days = this.ageDays(); let s = STAGES[0]; for (const st of STAGES){ if (days >= st.minAge) s = st; } return s; },
  addExp(n){
    this.exp += n; const need = this.level * 50;
    if (this.exp >= need){ this.exp -= need; this.level++; UI.toast(`🎉 升級了！目前 Lv.${this.level}`); SoundManager.levelup(); UI.playOneShot('levelup', 1600); }
  },
  addGold(n){ this.gold = Math.max(0, this.gold + n); },
  tick(){
    if (!this.alive) return;
    this.ageMs += TICK_MS;
    if (!this.isSleeping){
      this.hunger = clamp(this.hunger - DECAY.hunger); this.happy = clamp(this.happy - DECAY.happy);
      this.energy = clamp(this.energy - DECAY.energy); this.clean = clamp(this.clean - DECAY.clean);
      this.sleepStat = clamp(this.sleepStat - 0.25);
    } else {
      this.sleepStat = clamp(this.sleepStat + 4); this.energy = clamp(this.energy + 3); if (this.sleepStat >= 100) this.wake();
    }
    let healthDelta = 0.15;
    if (this.hunger < 20) healthDelta -= 0.5; if (this.happy < 20) healthDelta -= 0.3; if (this.clean < 30) healthDelta -= 0.3; if (this.sleepStat < 20) healthDelta -= 0.3;
    this.health = clamp(this.health + healthDelta); this.weight = clamp(this.weight + (this.hunger > 70 ? 0.05 : -0.03), 10, 99);
    this.addExp(0.4); this.checkStage(); this.checkAI(); this.checkDeath();
  },
  checkStage(){ const s = this.getStage(); if (s.key !== this.stage){ this.stage = s.key; UI.toast(`✨ 小雞長大了！現在是「${s.label}」`); } },
  checkAI(){
    if (this.hunger < 20) UI.showBubble('🍗'); else if (this.happy < 20) UI.showBubble('😢'); else if (this.sleepStat < 20) UI.showBubble('🥱'); else if (this.health < 20) UI.showBubble('🤒'); else UI.hideBubble();
    if (this.clean < 30 && Math.random() < 0.02){ this.poopCount++; UI.spawnPoop(); }
  },
  checkDeath(){
    if (this.health <= 0 && this.alive){
      this.alive = false; if (mainTickInterval){ clearInterval(mainTickInterval); mainTickInterval = null; } UI.showDeath();
    }
  },
  currentDominantState(){ if (!this.alive) return 'dead'; if (this.isSleeping) return 'sleep'; if (this.health < 20) return 'sick'; if (this.hunger < 20 || this.happy < 20) return 'sad'; return 'idle'; },
  feed(){
    if (!this.alive) return; let amount = 18;
    if (this.inventory.food_premium > 0){ this.inventory.food_premium--; amount = 32; } else if (this.inventory.food_basic > 0){ this.inventory.food_basic--; amount = 22; }
    this.hunger = clamp(this.hunger + amount); this.weight = clamp(this.weight + 1, 10, 99); this.addExp(2); SoundManager.eat(); UI.playOneShot('eat', 900);
  },
  water(){ if (!this.alive) return; this.hunger = clamp(this.hunger + 6); this.clean = clamp(this.clean + 2); SoundManager.click(); UI.playOneShot('idle', 400); },
  play(){ if (!this.alive) return; let bonus = this.inventory.toy > 0 ? 30 : 18; if (this.inventory.toy > 0) this.inventory.toy--; this.happy = clamp(this.happy + bonus); this.energy = clamp(this.energy - 10); this.addExp(3); SoundManager.click(); UI.playOneShot('happy', 1200); },
  bath(){ if (!this.alive) return; this.clean = clamp(this.clean + 35); this.happy = clamp(this.happy + 3); this.poopCount = 0; UI.clearPoop(); SoundManager.click(); UI.playOneShot('clean', 1300); },
  sleepToggle(){ if (!this.alive) return; this.isSleeping = !this.isSleeping; if (this.isSleeping){ SoundManager.sleep(); UI.playOneShot('sleep', null); } else { UI.playOneShot('idle', 600); } },
  wake(){ this.isSleeping = false; UI.playOneShot('idle', 600); UI.toast('☀️ 小雞睡醒了！'); },
  doctor(){
    if (!this.alive) return;
    if (this.inventory.medicine > 0){ this.inventory.medicine--; this.health = clamp(this.health + 40); UI.toast('💊 吃藥了，健康恢復不少！'); } 
    else if (this.gold >= 20){ this.gold -= 20; this.health = clamp(this.health + 25); UI.toast('💊 緊急買藥治療（花費 20 金幣）'); } 
    else { UI.toast('❌ 沒有藥也沒有錢！'); return; }
    SoundManager.click(); UI.playOneShot('idle', 800);
  },
  clean_(){ this.poopCount = 0; this.clean = clamp(this.clean + 15); UI.clearPoop(); SoundManager.pop(); },
  work(){ if (!this.alive) return; if (this.energy < 15){ UI.toast('😩 太累了，先休息一下吧！'); return; } const earn = randInt(8, 22); this.gold += earn; this.energy = clamp(this.energy - 18); this.happy = clamp(this.happy - 5); this.addExp(4); SoundManager.coin(); UI.toast(`💼 工作完成，獲得 ${earn} 金幣！`); },
  dailyReward(){ const today = new Date().toDateString(); if (this.lastLoginDate === today){ UI.toast('📅 今天已經領過每日獎勵囉！'); return; } this.lastLoginDate = today; this.gold += 100; this.inventory.food_premium += 1; SoundManager.coin(); UI.toast('🎁 每日登入獎勵：+100 金幣、特殊飼料 x1！'); UI.playOneShot('levelup', 1500); },
  restart(){
    UI._deathShown = false;
    Object.assign(this, {
      name:'CHICK', alive:true, level:1, exp:0, gold:50, ageMs:0, weight:50, hunger:80, happy:80, health:100, energy:80, clean:80, sleepStat:80, isSleeping:false, stage:'baby', background:'room',
      outfit:{hat:false,glasses:false,scarf:false,clothes:false,wings:false}, inventory:{food_basic:3, food_premium:0, medicine:0, soap:0, toy:0}, ownedWear:{hat:false,glasses:false,scarf:false,clothes:false}, poopCount:0
    });
    UI.clearPoop(); if (mainTickInterval) clearInterval(mainTickInterval);
    mainTickInterval = setInterval(() => { GameState.tick(); UI.updateStats(); Save.persist(); }, TICK_MS); Save.persist();
  }
};

/* ============================================================================
   8. ShopSystem
   ============================================================================ */
const SHOP_ITEMS = {
  food: [ { id:'food_basic', name:'普通飼料', icon:'🌾', price:5, desc:'恢復飽食 +22' }, { id:'food_premium', name:'高級飼料', icon:'🍗', price:15, desc:'恢復飽食 +32' } ],
  goods: [ { id:'medicine', name:'藥品', icon:'💊', price:20, desc:'恢復健康 +40' }, { id:'soap', name:'清潔用品', icon:'🧼', price:8, desc:'快速清潔' }, { id:'toy', name:'玩具', icon:'🧸', price:12, desc:'玩耍效果加倍' } ],
  wear: [ { id:'hat', name:'帽子', icon:'🎩', price:30, desc:'時尚帽子' }, { id:'glasses', name:'眼鏡', icon:'🕶️', price:25, desc:'酷酷的眼鏡' }, { id:'scarf', name:'圍巾', icon:'🧣', price:20, desc:'溫暖圍巾' }, { id:'clothes', name:'服裝', icon:'👕', price:35, desc:'可愛小衣服' } ]
};

const Shop = {
  buy(category, id){
    const item = SHOP_ITEMS[category].find(i => i.id === id); if (!item) return;
    if (GameState.gold < item.price){ UI.toast('❌ 金幣不足！'); return; }
    GameState.gold -= item.price;
    if (category === 'wear'){ GameState.ownedWear[id] = true; GameState.outfit[id] = true; } else { GameState.inventory[id] = (GameState.inventory[id]||0) + 1; }
    SoundManager.coin(); UI.toast(`✅ 購買成功：${item.name}`); UI.renderShop(); UI.updateStats();
  }
};

/* ============================================================================
   9. EventSystem — 隨機事件
   ============================================================================ */
const RANDOM_EVENTS = [
  { text:'🪙 小雞在地上找到了金幣！', fn:()=>{ GameState.addGold(randInt(5,25)); SoundManager.coin(); } },
  { text:'🐤 遇到了一隻朋友，心情變好了！', fn:()=>{ GameState.happy = clamp(GameState.happy+15); } },
  { text:'🎁 收到了一份神秘禮物！', fn:()=>{ GameState.inventory.food_premium++; } },
  { text:'🤒 著涼了，健康下降...', fn:()=>{ GameState.health = clamp(GameState.health-15); } }
];

function scheduleRandomEvent(){
  setTimeout(() => { if (GameState.alive){ const ev = choice(RANDOM_EVENTS); ev.fn(); UI.toast(ev.text); UI.updateStats(); } scheduleRandomEvent(); }, randInt(60, 180) * 1000);
}

/* ============================================================================
   10. Save — 存讀檔
   ============================================================================ */
const Save = {
  persist(){
    const d = {
      name: GameState.name, alive: GameState.alive, level: GameState.level, exp: GameState.exp, gold: GameState.gold, ageMs: GameState.ageMs, weight: GameState.weight, hunger: GameState.hunger, happy: GameState.happy, health: GameState.health, energy: GameState.energy, clean: GameState.clean, sleepStat: GameState.sleepStat, isSleeping: GameState.isSleeping, stage: GameState.stage, background: GameState.background, outfit: GameState.outfit, inventory: GameState.inventory, ownedWear: GameState.ownedWear, lastLoginDate: GameState.lastLoginDate, settings: GameState.settings, createdAt: GameState.createdAt, poopCount: GameState.poopCount
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(d)); } catch(e){}
  },
  load(){ try { const raw = localStorage.getItem(SAVE_KEY); if (!raw) return false; Object.assign(GameState, JSON.parse(raw)); return true; } catch(e){ return false; } },
  clear(){ localStorage.removeItem(SAVE_KEY); }
};

/* ============================================================================
   11. UIController
   ============================================================================ */
const UI = {
  toastTimer: null, _deathShown: false,
  init(){
    this.bindButtons(); this.bindModals(); this.bindBgSwitcher();
    document.getElementById('name-input').value = GameState.name;
    document.getElementById('chick-name').textContent = GameState.name;
    document.getElementById('sfx-toggle').checked = GameState.settings.sfx;

    // 註冊主畫面小雞動畫
    animManager.register('chick', {
      fps: 8, frameCount: 8,
      draw: (frame) => {
        const sInfo = STAGES.find(s => s.key === GameState.stage) || STAGES[1];
        drawChick(chickCtx, { state: GameState.currentDominantState(), frame, stageScale: sInfo.scale, outfit: GameState.outfit, sick: GameState.health < 20, isTopAvatar: false });
      }
    });

    // 關鍵新增：註冊頂部大頭貼獨立動畫，並使其完全與主核心狀態同步
    animManager.register('topAvatar', {
      fps: 8, frameCount: 8,
      draw: (frame) => {
        const sInfo = STAGES.find(s => s.key === GameState.stage) || STAGES[1];
        drawChick(topCtx, { state: GameState.currentDominantState(), frame, stageScale: sInfo.scale, outfit: GameState.outfit, sick: GameState.health < 20, isTopAvatar: true });
      }
    });

    animManager.start(); drawBackground(GameState.background);
  },

  bindButtons(){
    document.querySelectorAll('.action-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        SoundManager.click(); const act = btn.dataset.action;
        if (act==='feed') GameState.feed(); else if (act==='water') GameState.water(); else if (act==='play') GameState.play(); else if (act==='bath') GameState.bath(); else if (act==='sleep') GameState.sleepToggle(); else if (act==='doctor') GameState.doctor(); else if (act==='clean') GameState.clean_(); else if (act==='daily') GameState.dailyReward(); else if (act==='work') GameState.work(); else if (act==='shop'){ this.openModal('shop-modal'); this.renderShop(); } else if (act==='settings') this.openModal('settings-modal');
        this.updateStats(); Save.persist();
      });
    });
    chickCanvas.addEventListener('click', () => { if (!GameState.alive) return; GameState.happy = clamp(GameState.happy + 1); this.playOneShot('happy', 200); });
  },

  bindModals(){
    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => this.closeModal(btn.dataset.close)));
    document.querySelectorAll('.tab-btn').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab-btn').forEach(t=>t.classList.remove('active')); tab.classList.add('active'); this.renderShop(tab.dataset.tab); }));
    document.getElementById('save-btn').addEventListener('click', () => { GameState.name = document.getElementById('name-input').value.trim() || 'CHICK'; GameState.settings.sfx = document.getElementById('sfx-toggle').checked; document.getElementById('chick-name').textContent = GameState.name; Save.persist(); this.toast('💾 已儲存！'); });
    document.getElementById('reset-btn').addEventListener('click', () => { if (confirm('確定要重新開始嗎？')){ Save.clear(); GameState.restart(); this.closeModal('settings-modal'); this.updateStats(); } });
    document.getElementById('restart-btn').addEventListener('click', () => { GameState.restart(); this.closeModal('death-modal'); this.updateStats(); });
  },

  bindBgSwitcher(){ document.querySelectorAll('.bg-btn').forEach(b => b.addEventListener('click', () => { GameState.background = b.dataset.bg; drawBackground(GameState.background); SoundManager.click(); Save.persist(); })); },
  openModal(id){ document.getElementById(id).classList.remove('hidden'); },
  closeModal(id){ document.getElementById(id).classList.add('hidden'); },

  renderShop(cat){
    const tab = cat || document.querySelector('.tab-btn.active')?.dataset.tab || 'food'; const list = document.getElementById('shop-list'); list.innerHTML = '';
    if (tab === 'bg'){ list.innerHTML = `<p>🎨 背景已全部開放，於畫面右上角圖示即可切換：<br>🏠 房間 / 🌱 草地 / 🚜 農場 / 🌲 森林 / ❄️ 雪地 / 🌙 夜晚</p>`; return; }
    SHOP_ITEMS[tab].forEach(item => {
      const owned = tab === 'wear' ? GameState.ownedWear[item.id] : null; const row = document.createElement('div'); row.className = 'shop-item';
      row.innerHTML = `<div class="shop-item-info"><span class="pixel-icon">${item.icon}</span><div><div>${item.name}${tab!=='wear'?` (持有 ${GameState.inventory[item.id]||0})`:''}</div><div style="font-size:7px;color:#5c3b26;">${item.desc}</div></div></div><button ${owned?'disabled':''}>${owned?'已擁有':`💰${item.price}`}</button>`;
      row.querySelector('button').addEventListener('click', () => Shop.buy(tab, item.id)); list.appendChild(row);
    });
  },

  updateStats(){
    document.getElementById('stat-level').textContent = GameState.level; document.getElementById('stat-age').textContent = Math.floor(GameState.ageDays()); document.getElementById('stat-gold').textContent = GameState.gold;
    document.getElementById('stage-label').textContent = (STAGES.find(s => s.key === GameState.stage) || STAGES[1]).label;
    const bars = { health: GameState.health, hunger: GameState.hunger, happy: GameState.happy, energy: GameState.energy, clean: GameState.clean, sleep: GameState.sleepStat };
    for (const [k, v] of Object.entries(bars)){ const el = document.getElementById('bar-' + k); if(el) { el.style.width = v + '%'; el.classList.toggle('low', v < 20); } }
  },

  showBubble(e){ const b = document.getElementById('bubble'); b.textContent = e; b.classList.remove('hidden'); },
  hideBubble(){ document.getElementById('bubble').classList.add('hidden'); },
  spawnPoop(){ const layer = document.getElementById('poop-layer'); if (layer.children.length >= 5) return; const el = document.createElement('div'); el.className = 'poop-pixel'; el.textContent = '💩'; el.style.left = randInt(10, 85) + '%'; el.style.top = randInt(60, 85) + '%'; layer.appendChild(el); },
  clearPoop(){ document.getElementById('poop-layer').innerHTML = ''; },
  toast(msg){ const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); t.classList.add('show'); clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { t.classList.add('hidden'); t.classList.remove('show'); }, 2600); },
  
  playOneShot(stateName, ms){
    const actor = animManager.get('chick'); if (!actor) return;
    const original = GameState.currentDominantState; GameState.currentDominantState = () => stateName;
    if (ms) setTimeout(() => { GameState.currentDominantState = original; }, ms);
  },

  showDeath(){
    if (this._deathShown) return; this._deathShown = true; SoundManager.death();
    document.getElementById('death-stats').textContent = `存活了 ${Math.floor(GameState.ageDays())} 天 ・ 等級 Lv.${GameState.level}`;
    this.openModal('death-modal'); let frame = 0;
    const angelAnim = setInterval(() => { if (document.getElementById('death-modal').classList.contains('hidden')){ clearInterval(angelAnim); return; } drawAngel(frame++); }, 120);
  }
};

/* ============================================================================
   12. 啟動
   ============================================================================ */
function init(){
  const hadSave = Save.load(); UI.init(); UI.updateStats(); UI.renderShop('food');
  if (!hadSave) GameState.dailyReward(); else { if (GameState.lastLoginDate !== new Date().toDateString()) setTimeout(() => UI.toast('🎁 今天還沒領每日獎勵，記得點擊「每日獎勵」按鈕！'), 1200); }
  if (GameState.alive && !mainTickInterval){ mainTickInterval = setInterval(() => { GameState.tick(); UI.updateStats(); Save.persist(); }, TICK_MS); }
  scheduleRandomEvent(); window.addEventListener('beforeunload', () => Save.persist());
}

document.addEventListener('DOMContentLoaded', init);

})();