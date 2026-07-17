/* ============================================================================
   BugHuntGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

/* ============================================================================
   🐛 GAME 2：抓蟲大作戰
   點擊畫面上的蟲子，好蟲加分、毒蟲扣心情，30秒結算。
   ============================================================================ */
window.BugHuntGame = (() => {
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
