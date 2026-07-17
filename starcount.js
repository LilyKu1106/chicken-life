/* ============================================================================
   StarCountGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

let randomEventTimerId = null;
let weatherTimerId     = null;

/* ============================================================================
   🌙 StarCountGame — 深夜數星星
   ----------------------------------------------------------------------------
   夜空短暫閃現一群星星，玩家在星星消失後從 3 個選項中選出正確數量。
   共 10 題，連對有獎勵加成，小雞會依答題結果做出不同表情動作。

   流程：開場動畫 → 顯示星星(0.8s) → 遮蓋 → 3 個選項(3s 倒數) → 結果 → 下一題
   ============================================================================ */
window.StarCountGame = (() => {
  /* ── 常數 ── */
  const TOTAL_Q      = 10;   // 總題數
  const SHOW_MS      = 1800;  // 星星顯示時長（原 850ms → 1800ms）
  const ANSWER_MS    = 6000;  // 作答時限（原 3000ms → 6000ms）
  const RESULT_MS    = 1500;  // 顯示結果時長（原 1100ms → 1500ms）
  const MIN_STARS    = 3;
  const MAX_STARS    = 15;
  const STAR_SHAPES  = ['★','✦','✧','✶','✸'];

  /* ── 狀態 ── */
  let W, H, ctx, hudEl, endCb, done, resultData;
  let phase;  // 'intro'|'show'|'hide'|'answer'|'result'|'finish'
  let question, correct, options, playerAnswer;
  let stars;              // [{x,y,size,shape,twinkle}]
  let phaseStart;         // 目前 phase 開始的時間戳（ms）
  let score, streak, totalCoins;
  let chickMood;          // 'idle'|'think'|'happy'|'sad'|'cheer'
  let chickFrame = 0;
  let introAlpha = 0;
  let resultMsg  = '';

  /* ── 音效（共用 SoundManager AudioContext）── */
  function _beep(freq, dur, type = 'square', vol = 0.06){
    if (!GameState.settings.sfx) return;
    try {
      const ac = SoundManager.getCtx(), t = ac.currentTime;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + dur);
    } catch(e){}
  }
  const SFX = {
    show:    () => _beep(660, 0.06, 'sine', 0.05),
    correct: () => { [523,659,784].forEach((f,i) => _beep(f,0.10,'square',0.06, i*0.07)); },
    wrong:   () => { _beep(220, 0.18, 'sawtooth', 0.09); },
    tick:    () => _beep(440, 0.04, 'square', 0.03),
    finish:  () => { [523,659,784,1046].forEach((f,i) => _beep(f,0.12,'square',0.07,i*0.09)); },
  };

  /* ── 題目生成 ──
     答案在 MIN_STARS~MAX_STARS 範圍內，
     選項設計讓差距「夠相近但不太容易矇對」。 */
  function _makeQuestion(qNum){
    // 難度隨題號遞增：前 3 題較少星星，後幾題數量多且顯示時間同樣短
    const minN = Math.min(MIN_STARS + qNum, 8);
    const maxN = Math.min(MAX_STARS, 6 + qNum * 1.2);
    correct = Math.floor(Math.random() * (maxN - minN + 1)) + minN;

    // 生成 3 個選項（含正確答案），相差 1~3，不重複，不超出範圍
    const opts = new Set([correct]);
    while (opts.size < 3){
      const delta = randInt(1, 3) * (Math.random() < 0.5 ? 1 : -1);
      const v = correct + delta;
      if (v >= 1 && v <= MAX_STARS + 2) opts.add(v);
    }
    options = [...opts].sort((a,b) => a - b);

    // 生成星星座標（均勻散布，避免太靠近邊緣和彼此）
    stars = _placeStars(correct, W, H);
  }

  function _placeStars(n, w, h){
    const margin  = w * 0.12;
    const skyH    = h * 0.62;  // 星星只出現在夜空上半部
    const result  = [];
    const minDist = w * 0.09;
    let attempts  = 0;

    while (result.length < n && attempts < n * 40){
      attempts++;
      const x = margin + Math.random() * (w - margin * 2);
      const y = margin + Math.random() * (skyH - margin * 1.5);
      // 避免星星太密集
      const tooClose = result.some(s => Math.hypot(s.x - x, s.y - y) < minDist);
      if (!tooClose){
        result.push({
          x, y,
          size:    w * (0.016 + Math.random() * 0.018),
          shape:   STAR_SHAPES[Math.floor(Math.random() * STAR_SHAPES.length)],
          twinkle: Math.random() * Math.PI * 2,  // 閃爍相位偏移
        });
      }
    }
    return result;
  }

  /* ── start() ── */
  function start(canvas, c, h, cb){
    W = canvas.width; H = canvas.height;
    ctx = c; hudEl = h; endCb = cb;
    done = false; resultData = null;
    score = 0; streak = 0; totalCoins = 0;
    question = 0; playerAnswer = null;
    chickMood = 'idle'; chickFrame = 0; introAlpha = 0;
    phase = 'intro'; phaseStart = performance.now();

    hudEl.textContent = `🌙 深夜數星星  題目 0/${TOTAL_Q}  🪙 0`;

    // 選項按鈕點擊
    const onClick = (e) => {
      if (phase !== 'answer') return;
      const rect = canvas.getBoundingClientRect();
      const src  = e.touches?.[0] ?? e;
      const mx   = (src.clientX - rect.left)  * (W / rect.width);
      const my   = (src.clientY - rect.top)   * (H / rect.height);
      options.forEach((opt, i) => {
        const b = _optionBtn(i);
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h){
          _submitAnswer(opt);
        }
      });
    };
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('touchstart', onClick, { passive: true });
    StarCountGame._cleanup = () => {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('touchstart', onClick);
    };
  }

  /* ── 選項按鈕座標（依索引計算，畫面與碰撞共用同一份）── */
  function _optionBtn(i){
    const bw = Math.round(W * 0.26), bh = Math.round(H * 0.10);
    const gap = Math.round((W - bw * 3) / 4);
    return { x: gap + i * (bw + gap), y: Math.round(H * 0.74), w: bw, h: bh };
  }

  /* ── 玩家作答 ── */
  function _submitAnswer(chosen){
    if (phase !== 'answer') return;
    playerAnswer = chosen;
    const isCorrect = chosen === correct;
    if (isCorrect){
      streak++;
      const mult = streak >= 5 ? 3 : streak >= 3 ? 2 : 1;
      const earned = 10 * mult;
      score += earned;
      totalCoins += earned;
      resultMsg  = streak >= 3
        ? `🔥 連對 ${streak}！+${earned} 💰（x${mult}倍！）`
        : `✅ 正確！+${earned} 💰`;
      chickMood  = streak >= 3 ? 'cheer' : 'happy';
      SFX.correct();
    } else {
      streak = 0;
      resultMsg = `❌ 答錯了！正確答案是 ${correct} 顆`;
      chickMood = 'sad';
      SFX.wrong();
    }
    phase = 'result';
    phaseStart = performance.now();
  }

  /* ── update() ── */
  function update(){
    if (done) return;
    const now = performance.now();
    const elapsed = now - phaseStart;
    chickFrame++;

    if (phase === 'intro'){
      introAlpha = Math.min(1, elapsed / 800);
      if (elapsed > 1400){
        question = 0;
        _nextQuestion(now);
      }
      return;
    }

    if (phase === 'show'){
      if (elapsed >= SHOW_MS){
        phase = 'hide';
        phaseStart = now;
        chickMood = 'think';
      }
      return;
    }

    if (phase === 'hide'){
      if (elapsed >= 180){
        phase = 'answer';
        phaseStart = now;
        SFX.show();
      }
      return;
    }

    if (phase === 'answer'){
      // 倒數提示音（最後 1 秒）
      if (elapsed > ANSWER_MS - 2000 && elapsed < ANSWER_MS && Math.floor(elapsed / 333) > Math.floor((elapsed - 16) / 333)){
        SFX.tick();
      }
      // 時間到視為答錯
      if (elapsed >= ANSWER_MS){
        playerAnswer = -1;
        streak = 0;
        resultMsg = `⏰ 時間到！正確答案是 ${correct} 顆`;
        chickMood = 'sad';
        SFX.wrong();
        phase = 'result';
        phaseStart = now;
      }
      return;
    }

    if (phase === 'result'){
      if (elapsed >= RESULT_MS){
        question++;
        if (question >= TOTAL_Q){
          _endGame();
        } else {
          _nextQuestion(now);
        }
      }
      return;
    }
  }

  function _nextQuestion(now){
    _makeQuestion(question);
    playerAnswer = null;
    resultMsg = '';
    chickMood = 'idle';
    phase = 'show';
    phaseStart = now;
    SFX.show();
    hudEl.textContent = `🌙 題目 ${question + 1}/${TOTAL_Q}  🔥 連對 ${streak}  🪙 ${totalCoins}`;
  }

  function _endGame(){
    if (done) return;
    done = true;
    SFX.finish();
    const goldEarned = Math.round(totalCoins / 5);
    const pct = Math.round(score / (TOTAL_Q * 10) * 100);
    const summary =
      pct >= 90 ? `滿分達人！小雞驚訝地發現你比牠還會數星星！（得分 ${score}）` :
      pct >= 60 ? `不錯喔！小雞開始記得一些東西了。（得分 ${score}）` :
                  `小雞忘光光了……但牠還是很努力！（得分 ${score}）`;
    resultData = {
      gameName: '深夜數星星',
      gold: goldEarned, hunger: 0,
      happy: pct >= 60 ? 12 : 0, happyPen: pct < 40 ? -5 : 0,
      summary,
    };
    if (endCb) endCb();
  }

  /* ── render() ── */
  function render(c){
    c.clearRect(0, 0, W, H);

    // 夜空背景
    pxRect(c, 0, 0, W, Math.round(H * 0.68), '#0e1a36');
    // 地面
    pxRect(c, 0, Math.round(H * 0.68), W, Math.round(H * 0.32), '#1a2010');
    pxRect(c, 0, Math.round(H * 0.68), W, 5, '#2a3a18');
    // 月亮
    fillPixelCircle(c, Math.round(W * 0.82), Math.round(H * 0.12), Math.round(W * 0.07), '#fff8c0');
    fillPixelCircle(c, Math.round(W * 0.86), Math.round(H * 0.10), Math.round(W * 0.055), '#0e1a36');

    // ── Intro ──
    if (phase === 'intro'){
      c.globalAlpha = introAlpha;
      c.fillStyle = '#ffe9b8'; c.font = `bold ${Math.round(H * 0.065)}px monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('🌙 深夜數星星', W / 2, H * 0.28);
      c.font = `${Math.round(H * 0.038)}px monospace`;
      c.fillStyle = '#b6e3a1';
      c.fillText('星星閃現後馬上消失', W / 2, H * 0.40);
      c.fillText('從選項選出正確數量！', W / 2, H * 0.48);
      c.globalAlpha = 1;
      _drawChick(c, W * 0.5, H * 0.88, 'idle');
      return;
    }

    // ── 星星層（show 時顯示，hide/answer/result 時隱藏）──
    if (phase === 'show'){
      const t = performance.now();
      stars.forEach(s => {
        const twinkle = 0.7 + 0.3 * Math.sin(t / 180 + s.twinkle);
        c.globalAlpha = twinkle;
        c.fillStyle = '#ffe9b8';
        c.font = `${Math.round(s.size * 3.2)}px serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(s.shape, Math.round(s.x), Math.round(s.y));
      });
      c.globalAlpha = 1;
      // 提示文字
      c.fillStyle = 'rgba(255,233,184,0.7)'; c.font = `${Math.round(H * 0.035)}px monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('星星有幾顆？', W / 2, H * 0.72);
    }

    // ── 問題標題（hide / answer / result 都顯示）──
    if (phase === 'hide' || phase === 'answer' || phase === 'result'){
      c.fillStyle = '#ffe9b8'; c.font = `bold ${Math.round(H * 0.048)}px monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('星星有幾顆？', W / 2, H * 0.22);

      // 遮蓋提示（hide 短暫過渡）
      if (phase === 'hide'){
        c.fillStyle = 'rgba(14,26,54,0.92)';
        c.fillRect(0, 0, W, Math.round(H * 0.66));
        c.fillStyle = '#6fc3df'; c.font = `${Math.round(H * 0.042)}px monospace`;
        c.fillText('好好想想…', W / 2, H * 0.34);
      }

      // ── 選項按鈕 ──
      if (phase === 'answer' || phase === 'result'){
        options.forEach((opt, i) => {
          const b = _optionBtn(i);
          let bg = '#2a3a5a', fg = '#ffe9b8', border = '#4a6a9a';
          if (phase === 'result'){
            if (opt === correct)       { bg = '#1a4a2a'; border = '#4aaa6a'; }
            else if (opt === playerAnswer){ bg = '#4a1a1a'; border = '#aa4a4a'; }
          }
          pxRect(c, b.x, b.y, b.w, b.h, bg);
          c.strokeStyle = border; c.lineWidth = 3;
          c.strokeRect(b.x, b.y, b.w, b.h);
          c.fillStyle = fg; c.font = `bold ${Math.round(b.h * 0.48)}px monospace`;
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(String(opt), b.x + b.w / 2, b.y + b.h / 2);
        });

        // 倒數條
        if (phase === 'answer'){
          const elapsed = performance.now() - phaseStart;
          const ratio   = Math.max(0, 1 - elapsed / ANSWER_MS);
          const barW    = Math.round(W * 0.7);
          const barX    = Math.round((W - barW) / 2);
          const barY    = Math.round(H * 0.70);
          pxRect(c, barX, barY, barW, 8, '#2a3a5a');
          const col = ratio > 0.4 ? '#6fc3df' : ratio > 0.2 ? '#ffd23f' : '#e8584a';
          pxRect(c, barX, barY, Math.round(barW * ratio), 8, col);
        }

        // 結果提示
        if (phase === 'result'){
          c.fillStyle = playerAnswer === correct ? '#b6e3a1' : '#e8584a';
          c.font = `${Math.round(H * 0.042)}px monospace`;
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(resultMsg, W / 2, H * 0.66);
        }
      }
    }

    // ── 小雞 ── 畫在選項按鈕下方，避免遮擋
    _drawChick(c, W * 0.5, H * 0.91, chickMood);

    // ── 題號 / 分數條 ──
    if (phase !== 'intro'){
      c.fillStyle = 'rgba(255,233,184,0.6)';
      c.font = `${Math.round(H * 0.032)}px monospace`;
      c.textAlign = 'left'; c.textBaseline = 'top';
      c.fillText(`Q${question + 1}/${TOTAL_Q}`, Math.round(W * 0.04), Math.round(H * 0.03));
      c.textAlign = 'right';
      c.fillText(`🔥${streak}  🪙${totalCoins}`, W - Math.round(W * 0.04), Math.round(H * 0.03));
    }
  }

  /* ── 小雞繪製（依 mood 顯示不同表情）── */
  function _drawChick(c, cx, cy, mood){
    const r = Math.round(W * 0.072);
    const bob = Math.sin(chickFrame * 0.12) * 3;
    const finalCy = cy + bob;

    // 身體
    fillPixelCircle(c, Math.round(cx), Math.round(finalCy), r, PALETTE.bodyMain);
    fillPixelCircle(c, Math.round(cx - r * 0.28), Math.round(finalCy - r * 0.3), Math.round(r * 0.4), PALETTE.bodyLight);

    // 臉紅
    fillPixelCircle(c, Math.round(cx - r * 0.5), Math.round(finalCy + r * 0.1), Math.round(r * 0.16), PALETTE.blush);
    fillPixelCircle(c, Math.round(cx + r * 0.5), Math.round(finalCy + r * 0.1), Math.round(r * 0.16), PALETTE.blush);

    // 眼睛
    const ex = Math.round(r * 0.33), ey = Math.round(finalCy - r * 0.05);
    if (mood === 'happy' || mood === 'cheer'){
      // 瞇眼笑
      pxRect(c, Math.round(cx)-ex-6, ey, 12, 3, PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)-ex-6, ey-3, 2, 3, PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)-ex+4, ey-3, 2, 3, PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)+ex-6, ey, 12, 3, PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)+ex-6, ey-3, 2, 3, PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)+ex+4, ey-3, 2, 3, PALETTE.eyeBlack);
    } else if (mood === 'sad'){
      fillPixelCircle(c, Math.round(cx) - ex, ey + 2, Math.round(r * 0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, Math.round(cx) + ex, ey + 2, Math.round(r * 0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, Math.round(cx) - ex, ey + 4, Math.round(r * 0.15), PALETTE.eyeBlack);
      fillPixelCircle(c, Math.round(cx) + ex, ey + 4, Math.round(r * 0.15), PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)-ex-7, ey-8, 12, 3, PALETTE.eyeBlack);
      pxRect(c, Math.round(cx)+ex-5, ey-8, 12, 3, PALETTE.eyeBlack);
    } else if (mood === 'think'){
      // 斜眼思考
      fillPixelCircle(c, Math.round(cx) - ex, ey, Math.round(r * 0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, Math.round(cx) + ex, ey, Math.round(r * 0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, Math.round(cx) - ex + 2, ey + 3, Math.round(r * 0.14), PALETTE.eyeBlack);
      fillPixelCircle(c, Math.round(cx) + ex + 2, ey + 3, Math.round(r * 0.14), PALETTE.eyeBlack);
      // 思考泡泡
      fillPixelCircle(c, Math.round(cx + r * 0.75), Math.round(finalCy - r * 0.95), 5, '#ffffff');
      fillPixelCircle(c, Math.round(cx + r * 0.95), Math.round(finalCy - r * 1.2), 8, '#ffffff');
      fillPixelCircle(c, Math.round(cx + r * 1.1), Math.round(finalCy - r * 1.45), 11, '#ffffff');
      pxRect(c, Math.round(cx + r * 1.0), Math.round(finalCy - r * 1.55), 18, 12, '#ffffff');
      pxRect(c, Math.round(cx + r * 1.02), Math.round(finalCy - r * 1.52), 4, 4, '#888');
      pxRect(c, Math.round(cx + r * 1.09), Math.round(finalCy - r * 1.52), 4, 4, '#888');
      pxRect(c, Math.round(cx + r * 1.16), Math.round(finalCy - r * 1.52), 4, 4, '#888');
    } else {
      // idle: 普通眼睛
      fillPixelCircle(c, Math.round(cx) - ex, ey, Math.round(r * 0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, Math.round(cx) + ex, ey, Math.round(r * 0.28), PALETTE.eyeWhite);
      fillPixelCircle(c, Math.round(cx) - ex, ey, Math.round(r * 0.14), PALETTE.eyeBlack);
      fillPixelCircle(c, Math.round(cx) + ex, ey, Math.round(r * 0.14), PALETTE.eyeBlack);
    }

    // 嘴
    pxRect(c, Math.round(cx) - 5, Math.round(finalCy + r * 0.24), 10, 6, PALETTE.beak);
    if (mood === 'cheer'){
      pxRect(c, Math.round(cx) - 4, Math.round(finalCy + r * 0.25), 8, 4, PALETTE.beakDark);
    }

    // 翅膀（cheer 時舉起）
    if (mood === 'cheer'){
      fillPixelCircle(c, Math.round(cx - r * 0.95), Math.round(finalCy - r * 0.2), Math.round(r * 0.38), '#e8a800');
      fillPixelCircle(c, Math.round(cx + r * 0.95), Math.round(finalCy - r * 0.2), Math.round(r * 0.38), '#e8a800');
    } else {
      fillPixelCircle(c, Math.round(cx - r * 0.88), Math.round(finalCy + r * 0.2), Math.round(r * 0.35), '#e8a800');
      fillPixelCircle(c, Math.round(cx + r * 0.88), Math.round(finalCy + r * 0.2), Math.round(r * 0.35), '#e8a800');
    }

    // 連對星星特效
    if (mood === 'cheer'){
      for (let i = 0; i < 5; i++){
        const a = chickFrame * 0.08 + i * (Math.PI * 2 / 5);
        const sx = cx + Math.cos(a) * r * 1.5;
        const sy = finalCy + Math.sin(a) * r * 1.5;
        c.fillStyle = '#ffd23f';
        c.font = `${Math.round(r * 0.4)}px serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('★', Math.round(sx), Math.round(sy));
      }
    }
  }

  function stop(){ if (StarCountGame._cleanup) StarCountGame._cleanup(); }
  function getResult(){ return resultData; }

  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

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
