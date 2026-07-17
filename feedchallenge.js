/* ============================================================================
   FeedChallengeGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

/* ============================================================================
   🍗 FeedChallengeGame — 餵食大挑戰
   ----------------------------------------------------------------------------
   小雞站在畫面左側，右側有一個左右移動的碗。
   玩家按住蓄力（進度條增長），放開時飼料按拋物線飛出，
   落點依碗的位置判定 Perfect / Good / Miss。
   共 10 顆飼料，結算飽食度與金幣獎勵。

   物理：
     飼料初速 Vx = power * MAX_VX（水平）
     初速 Vy = -power * MAX_VY（向上）
     每幀：Vx 不變, Vy += GRAVITY * dt
     落地（y >= BOWL_Y）→ 判定
   ============================================================================ */
window.FeedChallengeGame = (() => {
  /* ── 常數 ── */
  const TOTAL_BALLS  = 10;
  const GRAVITY      = 1.4;          // 相對座標/秒²
  const MAX_VX       = 1.6;          // 最大水平速度（相對/秒）
  const MAX_VY       = 2.2;          // 最大向上初速（相對/秒）
  const CHICK_XR     = 0.16;         // 小雞 X（相對）
  const CHICK_YR     = 0.68;         // 小雞站立 Y（相對）
  const BOWL_YR      = 0.75;         // 碗的 Y（相對，地面略上方）
  const BOWL_W       = 0.13;         // 碗寬（相對）
  const PERFECT_R    = BOWL_W * 0.28; // Perfect 判定半徑（相對）
  const GOOD_R       = BOWL_W * 0.55; // Good 判定半徑（相對）
  const CHARGE_TIME  = 1.6;           // 最大蓄力時長（秒）

  /* ── 碗的移動模式（分 3 個難度段）── */
  // 前 3 球慢，4-7 球中，8-10 球快且方向不規律
  function _bowlSpeed(ballIdx){
    if (ballIdx < 3)  return 0.28;
    if (ballIdx < 7)  return 0.46;
    return 0.62;
  }

  /* ── 狀態 ── */
  let W, H, ctx, hudEl, endCb, done, resultData;
  let phase;  // 'intro'|'charge'|'flying'|'result'|'finish'
  let ballIdx, score, totalCoins, hungerBonus;
  let charging, chargeT, power;      // 蓄力
  let phaseStart;                    // 目前 phase 的開始時間戳（ms）
  let projX, projY, projVX, projVY;  // 飛行中的飼料
  let bowlX, bowlDir;                // 碗的位置與方向
  let resultLabel, resultColor;      // 本球結果
  let resultTimer;
  let chickMood, chickFrame;
  let trailPoints;                   // 飼料軌跡
  let lastT;
  let introAlpha;

  /* ── 音效 ── */
  function _beep(f, d, t = 'square', v = 0.06, delay = 0){
    if (!GameState.settings.sfx) return;
    try {
      const ac = SoundManager.getCtx(), t0 = ac.currentTime + delay;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = t; o.frequency.setValueAtTime(f, t0);
      g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g); g.connect(ac.destination); o.start(t0); o.stop(t0 + d);
    } catch(e) {}
  }
  const SFX = {
    charge:  () => _beep(300 + power * 400, 0.04, 'sine', 0.04),
    throw:   () => { _beep(520, 0.06); _beep(680, 0.05, 'square', 0.04, 0.05); },
    perfect: () => { [880, 1100, 1320].forEach((f,i) => _beep(f, 0.10, 'square', 0.07, i*0.07)); },
    good:    () => { _beep(660, 0.08); _beep(880, 0.06, 'square', 0.05, 0.08); },
    miss:    () => _beep(180, 0.18, 'sawtooth', 0.08),
    finish:  () => { [523,659,784,1046].forEach((f,i) => _beep(f,0.12,'square',0.07,i*0.09)); },
  };

  /* ── start() ── */
  function start(canvas, c, h, cb){
    W = canvas.width; H = canvas.height;
    ctx = c; hudEl = h; endCb = cb;
    done = false; resultData = null;
    ballIdx = 0; score = 0; totalCoins = 0; hungerBonus = 0;
    charging = false; chargeT = 0; power = 0;
    projX = projY = -1;
    bowlX = 0.5; bowlDir = 1;
    resultLabel = ''; resultColor = '#ffe9b8'; resultTimer = 0;
    chickMood = 'idle'; chickFrame = 0;
    trailPoints = [];
    phase = 'intro'; lastT = phaseStart = performance.now(); introAlpha = 0;

    hudEl.textContent = `🍗 餵食大挑戰  第 1/${TOTAL_BALLS} 顆`;

    /* 輸入：按下蓄力，放開投擲 */
    const onDown = (e) => {
      if (phase !== 'charge') return;
      e.preventDefault();
      charging = true; chargeT = 0;
    };
    const onUp = (e) => {
      if (phase !== 'charge' || !charging) return;
      e.preventDefault();
      _throw();
    };
    canvas.addEventListener('mousedown',  onDown);
    canvas.addEventListener('mouseup',    onUp);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchend',   onUp,   { passive: false });
    FeedChallengeGame._cleanup = () => {
      canvas.removeEventListener('mousedown',  onDown);
      canvas.removeEventListener('mouseup',    onUp);
      canvas.removeEventListener('touchstart', onDown);
      canvas.removeEventListener('touchend',   onUp);
    };
  }

  /* ── 投出飼料 ── */
  function _throw(){
    charging = false;
    // 蓄力未滿也可投出，power 決定速度
    power = Math.min(1, chargeT / CHARGE_TIME);
    if (power < 0.08) { power = 0.08; } // 最低速確保飛得到

    projX  = CHICK_XR + 0.06;
    projY  = CHICK_YR - 0.08;
    projVX = power * MAX_VX;
    projVY = -(power * MAX_VY);
    trailPoints = [];
    phase = 'flying';
    chickMood = 'throw';
    SFX.throw();
  }

  /* ── 判定落點 ── */
  function _judge(){
    const dx = Math.abs(projX - bowlX);
    if (dx < PERFECT_R){
      resultLabel = 'PERFECT！'; resultColor = '#ffd23f';
      score += 30; totalCoins += 30; hungerBonus += 8;
      chickMood = 'happy'; SFX.perfect();
    } else if (dx < GOOD_R){
      resultLabel = 'GOOD!'; resultColor = '#b6e3a1';
      score += 10; totalCoins += 10; hungerBonus += 3;
      chickMood = 'happy'; SFX.good();
    } else {
      resultLabel = 'MISS...'; resultColor = '#e8584a';
      chickMood = 'sad'; SFX.miss();
    }
    resultTimer = 0;
    phase = 'result';
  }

  /* ── update() ── */
  function update(){
    if (done) return;
    const now = performance.now();
    const dt  = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    chickFrame++;

    if (phase === 'intro'){
      introAlpha = Math.min(1, (now - phaseStart) / 900);
      if (introAlpha >= 1) phase = 'charge';
      return;
    }

    // 碗左右移動
    if (phase === 'charge' || phase === 'flying'){
      bowlX += bowlDir * _bowlSpeed(ballIdx) * dt;
      const margin = BOWL_W / 2 + 0.04;
      if (bowlX > 1 - margin){ bowlX = 1 - margin; bowlDir = -1; }
      if (bowlX < margin)     { bowlX = margin;     bowlDir =  1; }
    }

    // 蓄力計時
    if (phase === 'charge' && charging){
      chargeT = Math.min(chargeT + dt, CHARGE_TIME);
      power = chargeT / CHARGE_TIME;
      if (chargeT >= CHARGE_TIME) _throw(); // 蓄滿自動投出
      if (chickFrame % 6 === 0) SFX.charge();
    }

    // 拋物線飛行
    if (phase === 'flying'){
      trailPoints.push({ x: projX, y: projY });
      if (trailPoints.length > 18) trailPoints.shift();

      projVY += GRAVITY * dt;
      projX  += projVX * dt;
      projY  += projVY * dt;

      // 落地（碗的 Y 位置）
      if (projY >= BOWL_YR){
        projY = BOWL_YR;
        _judge();
      }
      // 飛出畫面右側（沒打到碗）
      if (projX > 1.05){
        projY = BOWL_YR;
        resultLabel = 'MISS...'; resultColor = '#e8584a';
        chickMood = 'sad'; SFX.miss();
        resultTimer = 0; phase = 'result';
      }
    }

    // 結果展示
    if (phase === 'result'){
      resultTimer += dt;
      if (resultTimer >= 1.2){
        ballIdx++;
        if (ballIdx >= TOTAL_BALLS){
          _endGame();
        } else {
          charging = false; chargeT = 0; power = 0;
          projX = projY = -1; trailPoints = [];
          resultLabel = ''; chickMood = 'idle';
          phase = 'charge';
          hudEl.textContent = `🍗 第 ${ballIdx + 1}/${TOTAL_BALLS} 顆  🪙 ${totalCoins}`;
        }
      }
    }
  }

  /* ── render() ── */
  function render(c){
    c.clearRect(0, 0, W, H);

    /* 背景：廚房場景 */
    pxRect(c, 0, 0, W, Math.round(H * 0.78), '#f7e7c4');
    pxRect(c, 0, Math.round(H * 0.78), W, Math.round(H * 0.22), '#c89a63');
    // 桌面線
    pxRect(c, 0, Math.round(H * 0.78), W, 5, '#a87b46');
    // 牆上窗戶裝飾
    pxRect(c, Math.round(W * 0.62), Math.round(H * 0.08), Math.round(W * 0.28), Math.round(H * 0.22), '#9fd6ef');
    pxRect(c, Math.round(W * 0.62), Math.round(H * 0.08), Math.round(W * 0.28), Math.round(H * 0.22), 'rgba(255,255,255,0.3)');
    pxRect(c, Math.round(W * 0.62), Math.round(H * 0.08), 3, Math.round(H * 0.22), '#8a5a3b');
    pxRect(c, Math.round(W * 0.76 - 1), Math.round(H * 0.08), 3, Math.round(H * 0.22), '#8a5a3b');
    pxRect(c, Math.round(W * 0.62), Math.round(H * 0.19), Math.round(W * 0.28), 3, '#8a5a3b');

    /* 碗 */
    const bx = Math.round(bowlX * W);
    const by = Math.round(BOWL_YR * H);
    const bw = Math.round(BOWL_W * W);
    const bh = Math.round(bw * 0.45);
    // 碗身（梯形用兩個 pxRect 近似）
    pxRect(c, bx - bw/2,      by - bh,     bw,          bh,      '#e8d8b0');
    pxRect(c, bx - bw*0.42,   by - bh*0.4, bw * 0.84,   bh*0.4, '#d4c090');
    pxRect(c, bx - bw/2,      by - bh,     bw,          6,       '#c8b070');
    // 碗裡的飼料粒（裝飾）
    for (let i = 0; i < 4; i++){
      fillPixelCircle(c, bx - bw*0.25 + i * bw*0.16, by - bh*0.55, Math.round(bw*0.07), '#e8a800');
    }
    // Perfect / Good 判定圈（半透明提示）
    c.strokeStyle = 'rgba(255,210,63,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.arc(bx, by - bh * 0.5, Math.round(PERFECT_R * W), 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(180,220,150,0.35)'; c.lineWidth = 2;
    c.beginPath(); c.arc(bx, by - bh * 0.5, Math.round(GOOD_R * W), 0, Math.PI * 2); c.stroke();

    /* 飼料軌跡 */
    trailPoints.forEach((p, i) => {
      const alpha = (i / trailPoints.length) * 0.5;
      const r_    = Math.max(2, Math.round(W * 0.012 * (i / trailPoints.length)));
      c.globalAlpha = alpha;
      fillPixelCircle(c, Math.round(p.x * W), Math.round(p.y * H), r_, '#ffd23f');
    });
    c.globalAlpha = 1;

    /* 飛行中的飼料球 */
    if (projX >= 0 && phase === 'flying'){
      fillPixelCircle(c, Math.round(projX * W), Math.round(projY * H), Math.round(W * 0.022), '#ffd23f');
      fillPixelCircle(c, Math.round(projX * W) - 3, Math.round(projY * H) - 3, Math.round(W * 0.01), '#fff3a0');
    }

    /* 蓄力條 */
    if (phase === 'charge'){
      const barW = Math.round(W * 0.55);
      const barX = Math.round((W - barW) / 2);
      const barY = Math.round(H * 0.88);
      pxRect(c, barX, barY, barW, 14, '#2b2017');
      const col = power < 0.5 ? '#6fc3df' : power < 0.85 ? '#ffd23f' : '#e8584a';
      pxRect(c, barX, barY, Math.round(barW * power), 14, col);
      c.strokeStyle = '#ffe9b8'; c.lineWidth = 2;
      c.strokeRect(barX, barY, barW, 14);
      c.fillStyle = '#ffe9b8'; c.font = `${Math.round(H * 0.032)}px monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(charging ? '放開！' : '按住蓄力', W / 2, barY + 30);
    }

    /* 結果文字 */
    if ((phase === 'result' || phase === 'flying') && resultLabel){
      const alpha = phase === 'result'
        ? Math.min(1, 1 - (resultTimer - 0.8) / 0.4)
        : 1;
      c.globalAlpha = Math.max(0, alpha);
      c.fillStyle = resultColor;
      c.font = `bold ${Math.round(H * 0.072)}px monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      // 文字輕微彈跳
      const bounce = phase === 'result' ? -Math.sin(resultTimer * 8) * 8 : 0;
      c.fillText(resultLabel, W / 2, H * 0.42 + bounce);
      c.globalAlpha = 1;
    }

    /* 小雞 */
    _drawChick(c, CHICK_XR * W, CHICK_YR * H, chickMood);

    /* Intro 遮罩 */
    if (phase === 'intro'){
      c.globalAlpha = Math.max(0, 1 - introAlpha);
      pxRect(c, 0, 0, W, H, '#0e1a36');
      c.globalAlpha = Math.min(1, introAlpha * 2);
      c.fillStyle = '#ffe9b8'; c.font = `bold ${Math.round(H * 0.065)}px monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('🍗 餵食大挑戰', W / 2, H * 0.3);
      c.font = `${Math.round(H * 0.036)}px monospace`;
      c.fillStyle = '#b6e3a1';
      c.fillText('按住蓄力，放開投出！', W / 2, H * 0.44);
      c.fillText('瞄準碗的中心拿 PERFECT！', W / 2, H * 0.52);
      c.globalAlpha = 1;
    }

    /* 分數顯示（左上）*/
    if (phase !== 'intro'){
      c.fillStyle = 'rgba(43,32,23,0.7)'; c.font = `${Math.round(H * 0.032)}px monospace`;
      c.textAlign = 'left'; c.textBaseline = 'top';
      c.fillText(`球 ${ballIdx + 1}/${TOTAL_BALLS}`, Math.round(W * 0.04), Math.round(H * 0.03));
      c.textAlign = 'right';
      c.fillText(`🪙 ${totalCoins}`, W - Math.round(W * 0.04), Math.round(H * 0.03));
    }
  }

  /* ── 小雞繪製 ── */
  function _drawChick(c, cx, cy, mood){
    const r   = Math.round(W * 0.078);
    const bob = Math.sin(chickFrame * 0.1) * 3;
    const tilt = mood === 'throw' ? -18 : 0;
    const fcx = Math.round(cx), fcy = Math.round(cy + bob);

    c.save();
    c.translate(fcx, fcy);
    c.rotate(tilt * Math.PI / 180);
    c.translate(-fcx, -fcy);

    fillPixelCircle(c, fcx - Math.round(r*0.85), fcy + Math.round(r*0.15), Math.round(r*0.38),
      mood === 'throw' ? '#ffe87a' : '#e8a800');
    fillPixelCircle(c, fcx + Math.round(r*0.85), fcy + Math.round(r*0.15), Math.round(r*0.38),
      mood === 'throw' ? '#ffe87a' : '#e8a800');
    fillPixelCircle(c, fcx, fcy, r, PALETTE.bodyMain);
    fillPixelCircle(c, fcx - Math.round(r*0.28), fcy - Math.round(r*0.3), Math.round(r*0.42), PALETTE.bodyLight);
    fillPixelCircle(c, fcx - Math.round(r*0.5), fcy + Math.round(r*0.1), Math.round(r*0.16), PALETTE.blush);
    fillPixelCircle(c, fcx + Math.round(r*0.5), fcy + Math.round(r*0.1), Math.round(r*0.16), PALETTE.blush);

    const ex = Math.round(r*0.33), ey = fcy - Math.round(r*0.05);
    if (mood === 'happy'){
      pxRect(c, fcx-ex-6, ey, 12, 3, PALETTE.eyeBlack);
      pxRect(c, fcx-ex-6, ey-3, 2, 3, PALETTE.eyeBlack);
      pxRect(c, fcx-ex+4, ey-3, 2, 3, PALETTE.eyeBlack);
      pxRect(c, fcx+ex-6, ey, 12, 3, PALETTE.eyeBlack);
      pxRect(c, fcx+ex-6, ey-3, 2, 3, PALETTE.eyeBlack);
      pxRect(c, fcx+ex+4, ey-3, 2, 3, PALETTE.eyeBlack);
    } else if (mood === 'sad'){
      fillPixelCircle(c, fcx-ex, ey+2, Math.round(r*0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, fcx+ex, ey+2, Math.round(r*0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, fcx-ex, ey+4, Math.round(r*0.14), PALETTE.eyeBlack);
      fillPixelCircle(c, fcx+ex, ey+4, Math.round(r*0.14), PALETTE.eyeBlack);
      pxRect(c, fcx-ex-7, ey-8, 12, 3, PALETTE.eyeBlack);
      pxRect(c, fcx+ex-5, ey-8, 12, 3, PALETTE.eyeBlack);
    } else if (mood === 'throw'){
      fillPixelCircle(c, fcx-ex, ey-2, Math.round(r*0.3), PALETTE.eyeWhite);
      fillPixelCircle(c, fcx+ex, ey-2, Math.round(r*0.3), PALETTE.eyeWhite);
      fillPixelCircle(c, fcx-ex+3, ey, Math.round(r*0.16), PALETTE.eyeBlack);
      fillPixelCircle(c, fcx+ex+3, ey, Math.round(r*0.16), PALETTE.eyeBlack);
    } else {
      fillPixelCircle(c, fcx-ex, ey, Math.round(r*0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, fcx+ex, ey, Math.round(r*0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, fcx-ex, ey, Math.round(r*0.14), PALETTE.eyeBlack);
      fillPixelCircle(c, fcx+ex, ey, Math.round(r*0.14), PALETTE.eyeBlack);
    }
    pxRect(c, fcx - 5, fcy + Math.round(r*0.24), 10, 6, PALETTE.beak);

    c.restore();
  }

  function _endGame(){
    if (done) return;
    done = true;
    SFX.finish();
    const goldEarned = Math.round(totalCoins / 8);
    const hungerGain = Math.min(30, hungerBonus);
    const pct = Math.round(score / (TOTAL_BALLS * 30) * 100);
    const summary =
      pct >= 80 ? `投餵高手！小雞吃得圓滾滾，幸福感爆表！（得分 ${score}）` :
      pct >= 40 ? `還不錯，小雞勉強填飽肚子，繼續練習！（得分 ${score}）` :
                  `小雞還是餓著……這飼料飛去哪了？（得分 ${score}）`;
    resultData = {
      gameName: '餵食大挑戰',
      gold:    goldEarned,
      hunger:  hungerGain,
      happy:   pct >= 60 ? 10 : 0,
      happyPen: 0,
      summary,
    };
    if (endCb) endCb();
  }

  function stop(){ if (FeedChallengeGame._cleanup) FeedChallengeGame._cleanup(); }
  function getResult(){ return resultData; }

  return { start, update, render, stop, getResult, get done(){ return done; } };
})();
