/* ============================================================================
   RPSGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

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
window.RPSGame = (() => {
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
  // 共用 SoundManager 的 AudioContext，避免建立多個實例
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
