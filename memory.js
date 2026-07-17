/* ============================================================================
   MemoryGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

/* ============================================================================
   🃏 GAME 3：翻牌記憶《小雞記憶挑戰》
   4×4 DOM 翻牌，找出 8 對相同圖案，步數越少分越高。
   ============================================================================ */
window.MemoryGame = (() => {
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
