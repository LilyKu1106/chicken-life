/* ============================================================================
   WheelGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

/* ============================================================================
   🎡 GAME 4：幸運轉盤（每日一轉）
   CSS/Canvas 動畫轉盤，停下來後給予隨機獎勵或負面事件。
   ============================================================================ */
window.WheelGame = (() => {
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
    // 指針固定在畫布正上方（canvas 角度 = -π/2）。
    // 算出「指針相對於轉盤當前角度」對應的扇形索引，確保獎勵與視覺一致。
    const POINTER = -Math.PI / 2;
    const rel = ((POINTER - angle) % (Math.PI*2) + Math.PI*2) % (Math.PI*2);
    const actualSegment = Math.floor(rel / SEG) % N;
    const seg = SEGMENTS[actualSegment];
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
