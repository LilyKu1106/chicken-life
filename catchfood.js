/* ============================================================================
   CatchFoodGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

/* ============================================================================
   🍗 GAME 1：接飼料《飢餓大作戰》
   小雞左右移動，接住從天而降的食物，避開腐壞食物。
   操作：觸控左/右半邊點擊 或 鍵盤 ←→
   ============================================================================ */
window.CatchFoodGame = (() => {
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
