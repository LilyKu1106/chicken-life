/* ============================================================================
   LaneRunGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

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
window.LaneRunGame = (() => {
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
      // 間隔隨速度縮短，最短 0.9s（確保小學生有足夠反應時間）
      this.spawnTimer = Math.max(0.9, 1.8 - (speed - BASE_SPEED) / BASE_SPEED * 0.5);
    },

    _spawn(speed){
      // Prototype 難度：一次只出現一個障礙物，確保玩家有充裕時間反應
      const lane   = Math.floor(Math.random() * LANES);
      const spawnY = -0.12;

      // 同跑道最短間距保護
      const tooClose = this.items.some(o =>
        o.lane === lane && Math.abs(o.yR - spawnY) < 0.30
      );
      if (tooClose) return;

      const def = OBS_DEFS[Math.floor(Math.random() * OBS_DEFS.length)];
      this.items.push({
        lane,
        xR: LANE_XR[lane],
        yR: spawnY, prevYR: spawnY - 0.01,
        hw: def.w / 2, hh: def.h / 2,
        def,
      });
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

  // 音效：共用 SoundManager 的 AudioContext（不再自行建立實例）
  function _sfx(type){
    if (!GameState.settings.sfx) return;
    try {
      const ac = SoundManager.getCtx(), t0 = ac.currentTime;
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

let randomEventTimerId = null;
let weatherTimerId     = null;

/* ============================================================================
   🌙 StarCountGame — 深夜數星星
   ----------------------------------------------------------------------------
   夜空短暫閃現一群星星，玩家在星星消失後從 3 個選項中選出正確數量。
   共 10 題，連對有獎勵加成，小雞會依答題結果做出不同表情動作。

   流程：開場動畫 → 顯示星星(0.8s) → 遮蓋 → 3 個選項(3s 倒數) → 結果 → 下一題
   ============================================================================ */
