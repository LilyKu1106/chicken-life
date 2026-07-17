/* ============================================================================
   ChickenRunGame — 從 script.js 拆分出來的獨立小遊戲模組
   依賴：window 全域共用的 PALETTE / fillPixelCircle / pxRect / px / clamp / rand /
         randInt / choice / drawChick / GameState / SoundManager / UI / STAGES 等
         （由 script.js 在載入完成後統一掛載到 window，此檔案需在 script.js 之後載入）
   ============================================================================ */

/* ============================================================================
   🏃 GAME 6：小雞賽跑《Chicken Run》
   ----------------------------------------------------------------------------
   60 秒橫向捲軸跑酷遊戲。小雞自動向右跑，玩家點擊/觸控/空白鍵控制跳躍。
   障礙物從右側持續生成並向左滾動；碰到障礙物扣血條（3 血）而非直接結束，
   讓玩家撐過 60 秒或 3 次碰撞才結算。跑越遠、碰撞越少 → 金幣越多。
   ============================================================================ */
window.ChickenRunGame = (() => {
  /* ---- 物理常數 ---- */
  // 所有物理量皆以「每秒」為單位，乘上 dt 後套用，確保不同 FPS 下行為一致。
  // GRAVITY：每秒向下加速度（相對座標/秒²）。原本是每幀 0.018，
  //   60fps 下等於每秒 1.08，下墜過快。改以合理的每秒值並乘 dt。
  const GRAVITY    = 1.6;
  const JUMP_VY    = -0.80;
  const GROUND_Y   = 0.72;
  const CHICK_R    = 0.05;    // 縮小碰撞半徑，讓判定更寬鬆
  const GAME_TIME  = 60;
  const MAX_HP     = 3;

  /* ---- 障礙物類型 ---- w 統一改為 0.05（窄身易閃避），h 保持低於跳躍高度 0.20 */
  const OBS_TYPES = [
    { w:0.05, h:0.09,  type:'stone',  label:'石頭',  color:'#9c8f7c', colorTop:'#c0b4a4', top:false },
    { w:0.05, h:0.12,  type:'cactus', label:'仙人掌', color:'#4d8a45', colorTop:'#6aaa60', top:false },
    { w:0.05, h:0.06,  type:'log',    label:'木頭',  color:'#8a5a3b', colorTop:'#b07a56', top:false },
    { w:0.05, h:0.10,  type:'fence',  label:'柵欄',  color:'#c8a060', colorTop:'#e8c880', top:false },
  ];

  /* ---- 金幣物件（可收集）---- */
  const COIN_COLOR = '#ffd23f';

  /* ---- 狀態 ---- */
  let W, H, ctx, hudEl, endCb, done, resultData;
  let chickY, chickVY, isOnGround, isJumping;
  let hp, distance, coins, timeLeft, startT, lastT;
  let obstacles = [], coinObjs = [];
  let spawnTimer = 0, coinTimer = 0;
  let scrollSpeed;          // 畫面捲動速度（相對座標/幀），隨時間加快
  let hitFlash = 0;         // 受傷閃紅幀數
  let frame = 0;
  let bgLayers = [];        // 視差背景圖層 [{x, speed, items:[]}]
  let jumpPressed = false;  // 防止長按連跳

  /* ---- Web Audio ---- */
  // 共用 SoundManager 的 AudioContext
  function _beep(f,d,t='square',v=0.07,delay=0){
    if(!GameState.settings.sfx) return;
    try{
      const ac=_ac(), t0=ac.currentTime+delay;
      const o=ac.createOscillator(), g=ac.createGain();
      o.type=t; o.frequency.setValueAtTime(f,t0);
      g.gain.setValueAtTime(v,t0); g.gain.exponentialRampToValueAtTime(0.0001,t0+d);
      o.connect(g); g.connect(ac.destination); o.start(t0); o.stop(t0+d);
    }catch(e){}
  }
  const SFX = {
    jump: ()=>{ _beep(380,0.06,'square',0.07); _beep(520,0.05,'square',0.05,0.05); },
    hit:  ()=>{ _beep(180,0.12,'sawtooth',0.1); _beep(120,0.15,'sine',0.06,0.08); },
    coin: ()=>{ _beep(880,0.04,'square',0.05); _beep(1100,0.05,'square',0.04,0.04); },
    end:  ()=>{ [523,659,784].forEach((f,i)=>_beep(f,0.1,'square',0.06,i*0.08)); },
  };

  /* ════════════════════════════════
     建立視差背景圖層
     ════════════════════════════════ */
  function _buildBg(){
    bgLayers = [
      // 遠景：山丘輪廓
      { speed:0.2, items: Array.from({length:6}, (_,i)=>({ x:i/6, h:0.06+Math.random()*0.08, w:0.12+Math.random()*0.1 })) },
      // 中景：樹木
      { speed:0.5, items: Array.from({length:8}, (_,i)=>({ x:i/8+Math.random()*0.04, h:0.1+Math.random()*0.08 })) },
      // 近景：草叢
      { speed:0.85, items: Array.from({length:12}, (_,i)=>({ x:i/12, h:0.04+Math.random()*0.03 })) },
    ];
  }

  /* ════════════════════════════════
     start()
     ════════════════════════════════ */
  function start(canvas, c, h, cb){
    W=canvas.width; H=canvas.height; ctx=c; hudEl=h; endCb=cb;
    done=false; resultData=null;
    chickY=GROUND_Y; chickVY=0; isOnGround=true; isJumping=false;
    hp=MAX_HP; distance=0; coins=0; timeLeft=GAME_TIME;
    startT=lastT=performance.now();
    obstacles=[]; coinObjs=[]; spawnTimer=0; coinTimer=0; hitFlash=0; frame=0;
    scrollSpeed=0.004;
    jumpPressed=false;
    _buildBg();

    hudEl.textContent=`⏱ ${GAME_TIME}  ❤️❤️❤️  🪙 0`;

    // 輸入：點擊 / 觸控 / 空白鍵 → 跳躍
    const onJump = (e) => {
      if(done) return;
      if(e.type==='keydown' && e.code!=='Space') return;
      if(e.type==='keydown') e.preventDefault();
      if(!jumpPressed && isOnGround){
        chickVY = JUMP_VY;
        isOnGround = false;
        isJumping = true;
        jumpPressed = true;
        SFX.jump();
      }
    };
    const onRelease = (e) => {
      if(e.type==='keyup' && e.code!=='Space') return;
      jumpPressed = false;
    };
    canvas.addEventListener('touchstart', onJump, {passive:false});
    canvas.addEventListener('click', onJump);
    document.addEventListener('keydown', onJump);
    document.addEventListener('keyup', onRelease);

    ChickenRunGame._cleanup = () => {
      canvas.removeEventListener('touchstart', onJump);
      canvas.removeEventListener('click', onJump);
      document.removeEventListener('keydown', onJump);
      document.removeEventListener('keyup', onRelease);
    };
  }

  /* ════════════════════════════════
     update()
     ════════════════════════════════ */
  function update(){
    if(done) return;
    const now = performance.now();
    const dt  = Math.min((now - lastT)/1000, 0.05); // 最大步長 50ms 防止大跳
    lastT = now;
    timeLeft = Math.max(0, GAME_TIME - (now - startT)/1000);
    frame++;

    if(timeLeft <= 0){ _endGame(); return; }

    // scrollSpeed 定義為「每秒」移動量（相對座標/秒），這樣 dt 乘上去才是正確位移。
    // 0.24/s = 原本 0.004/幀×60fps；最高加速到 0.48/s。
    scrollSpeed = 0.24 + (GAME_TIME - timeLeft) / GAME_TIME * 0.24;

    // ── 物理：小雞垂直運動（dt-scaled，與 FPS 無關）──
    chickVY += GRAVITY * dt;
    chickY  += chickVY * dt;

    // 落地判定：先修正位置再歸零速度，防止浮點誤差穿地板。
    if(chickY >= GROUND_Y){
      chickY     = GROUND_Y;
      chickVY    = 0;
      isOnGround = true;
      isJumping  = false;
      jumpPressed = false;
    }

    // ── 距離累積（每秒推進 scrollSpeed × 畫面寬度）──
    distance += scrollSpeed * W * dt;

    // ── 視差背景捲動 ──
    bgLayers.forEach(layer => {
      layer.items.forEach(item => {
        item.x -= scrollSpeed * layer.speed * dt;
        if(item.x < -0.2) item.x += 1.2;
      });
    });

    // ── 生成障礙物 ──
    spawnTimer -= dt;
    if(spawnTimer <= 0){
      const type = OBS_TYPES[Math.floor(Math.random() * OBS_TYPES.length)];
      // 防止兩個障礙物太靠近：上一個障礙物還沒離開右側 0.45 範圍就不生成
      const lastObs = obstacles[obstacles.length - 1];
      const tooClose = lastObs && lastObs.x > 0.55;
      if (!tooClose){
        obstacles.push({
          x:    1.05,
          y:    GROUND_Y - type.h,
          w:    type.w,
          h:    type.h,
          color:    type.color,
          colorTop: type.colorTop,
          type:     type.type,
          top:  false,
        });
      }
      spawnTimer = 1.8 - (GAME_TIME - timeLeft)/GAME_TIME * 0.6 + Math.random()*1.2;
    }

    // ── 生成金幣 ──
    coinTimer -= dt;
    if(coinTimer <= 0){
      coinObjs.push({ x:0.92 + Math.random()*0.1, y: GROUND_Y - 0.08 - Math.random()*0.15, r:0.018, collected:false });
      coinTimer = 1.4 + Math.random()*0.8;
    }

    // ── 移動障礙物（每秒 scrollSpeed，與小雞物理同單位）──
    obstacles = obstacles.filter(o => {
      o.x -= scrollSpeed * dt;
      return o.x > -0.15;
    });

    // ── 移動金幣 ──
    coinObjs = coinObjs.filter(co => {
      co.x -= scrollSpeed * dt;
      return co.x > -0.1;
    });

    // ── 碰撞偵測：障礙物 ──
    if(hitFlash <= 0){
      const cx = 0.2, cy = chickY;
      const chickTop = cy - CHICK_R;     // 小雞最高點
      obstacles.forEach(o => {
        const obsTop    = o.y;           // 障礙物頂端（= o.y，top-edge 座標系）
        const obsCenterX = o.x + o.w/2;
        const obsCenterY = o.y + o.h/2;
        // 若小雞完全跳過障礙物頂端（含容錯 0.015），不判定碰撞
        if (chickTop < obsTop - 0.015) return;
        // AABB：X 和 Y 都在碰撞盒範圍內才判定
        if( Math.abs(cx - obsCenterX) < (CHICK_R + o.w/2) * 0.88 &&
            Math.abs(cy - obsCenterY) < (CHICK_R + o.h/2) * 0.88 ){
          hp--;
          hitFlash = 40;
          SFX.hit();
          if(hp <= 0){ _endGame(); }
        }
      });
    } else { hitFlash--; }

    // ── 碰撞偵測：金幣 ──
    coinObjs.forEach(c => {
      if(c.collected) return;
      if( Math.abs(0.2 - c.x) < CHICK_R + c.r &&
          Math.abs(chickY - c.y) < CHICK_R + c.r ){
        c.collected = true;
        coins++;
        SFX.coin();
      }
    });
    coinObjs = coinObjs.filter(c => !c.collected);

    // ── HUD ──
    const hpStr = '❤️'.repeat(hp) + '🖤'.repeat(MAX_HP - hp);
    hudEl.textContent = `⏱ ${Math.ceil(timeLeft)}  ${hpStr}  🪙 ${coins}  📏 ${Math.floor(distance)}m`;
  }

  /* ════════════════════════════════
     render()
     ════════════════════════════════ */
  function render(c){
    // 每幀先清除，防止殘影或 canvas context 狀態污染（在某些行動裝置瀏覽器上
    // 不 clearRect 直接疊畫會讓半透明像素累積，導致整個畫面逐漸變暗）
    c.clearRect(0, 0, W, H);
    const GY = Math.round(H * GROUND_Y);

    // ── 天空 ──
    pxRect(c, 0, 0, W, GY, '#bfe9ff');

    // ── 太陽 ──
    fillPixelCircle(c, W*0.88, H*0.1, H*0.055, '#ffe87a');

    // ── 視差背景 ──
    bgLayers.forEach((layer, li) => {
      const col = li===0 ? '#c8e0b0' : li===1 ? '#7ab86a' : '#5ca04a';
      layer.items.forEach(item => {
        const ix = Math.round(item.x * W);
        if(li < 2){
          // 山丘 / 樹（三角形 + 矩形）
          const ih = Math.round((item.h||0.08) * H);
          const iw = Math.round((item.w||0.08) * W);
          pxRect(c, ix, GY - ih, iw, ih, col);
          if(li===1) pxRect(c, ix + Math.round(iw*0.35), GY - ih - Math.round(ih*0.6), Math.round(iw*0.3), Math.round(ih*0.6), '#4d8a45');
        } else {
          // 草叢
          pxRect(c, ix, GY - Math.round(item.h*H), 8, Math.round(item.h*H), col);
        }
      });
    });

    // ── 地面 ──
    pxRect(c, 0, GY, W, H - GY, '#8fcf6a');
    pxRect(c, 0, GY, W, 6, '#6fae5a');

    // 地面條紋（跑動感），用 distance 驅動確保速度一致
    const stripeOff = Math.round(distance * 0.4) % 40;
    for(let sx = -40 + stripeOff; sx < W; sx += 40){
      pxRect(c, sx, GY + 8, 20, 3, 'rgba(255,255,255,0.15)');
    }

    // ── 障礙物 ──
    obstacles.forEach(o => {
      const ox  = Math.round(o.x * W);
      const oy  = Math.round(o.y * H);           // 頂端 Y（像素）
      const ow  = Math.round(o.w * W);
      const oh  = Math.round(o.h * H);

      // 主體
      pxRect(c, ox, oy, ow, oh, o.color);

      // 頂端高光條（顯示不同障礙物質感）
      const topH = Math.max(4, Math.round(oh * 0.28));
      pxRect(c, ox, oy, ow, topH, o.colorTop || '#ffffff');

      // 障礙物類型裝飾
      if (o.type === 'cactus'){
        // 仙人掌橫枝
        const armY = Math.round(oy + oh * 0.38);
        const armW = Math.round(ow * 0.36);
        const armH = Math.max(4, Math.round(oh * 0.18));
        pxRect(c, ox - armW, armY, armW, armH, o.color);
        pxRect(c, ox + ow,   armY, armW, armH, o.color);
      } else if (o.type === 'fence'){
        // 柵欄縱板
        const slats = 3;
        const sw = Math.max(4, Math.round(ow / (slats * 2 - 1)));
        for (let i = 0; i < slats; i++){
          pxRect(c, ox + Math.round(i * ow / slats), oy, sw, oh, o.colorTop || '#f0d890');
        }
      } else if (o.type === 'log'){
        // 木紋橫線
        for (let li = 1; li <= 2; li++){
          pxRect(c, ox + 3, Math.round(oy + oh * li / 3), ow - 6, 3, 'rgba(0,0,0,0.2)');
        }
      } else if (o.type === 'stone'){
        // 石頭高光點
        fillPixelCircle(c, ox + Math.round(ow * 0.3), oy + Math.round(oh * 0.3), 3, 'rgba(255,255,255,0.4)');
      }

      // ── 紅色外框（清楚標示碰撞範圍）──
      c.strokeStyle = '#e8584a';
      c.lineWidth   = 2;
      c.strokeRect(ox, oy, ow, oh);
    });

    // ── 金幣 ──
    coinObjs.forEach(coin => {
      fillPixelCircle(c, Math.round(coin.x*W), Math.round(coin.y*H), Math.round(coin.r*W), COIN_COLOR);
      fillPixelCircle(c, Math.round(coin.x*W)-2, Math.round(coin.y*H)-2, Math.round(coin.r*W*0.4), 'rgba(255,255,255,0.6)');
    });

    // ── 小雞（用 fillPixelCircle 繪製，位置依跳躍高度浮動）──
    const chicX  = Math.round(0.2  * W);
    const chicY  = Math.round(chickY * H);
    const chicR  = Math.round(CHICK_R * W);
    const squash = isOnGround ? 1.0 : (chickVY < 0 ? 0.85 : 1.08); // 落地前稍微拉長
    const flash  = hitFlash > 0 && Math.floor(hitFlash/4)%2===0;

    c.save();
    c.translate(chicX, chicY);
    c.scale(1, squash);

    const bodyCol = flash ? '#ff4444' : (GameState.health < 20 ? PALETTE.sick : PALETTE.bodyMain);
    // 翅膀（向後飄）
    fillPixelCircle(c, -chicR*0.85, chicR*0.18, Math.round(chicR*0.4), '#e8a800');
    // 身體
    fillPixelCircle(c, 0, 0, chicR, bodyCol);
    fillPixelCircle(c, -Math.round(chicR*0.28), -Math.round(chicR*0.3), Math.round(chicR*0.42), PALETTE.bodyLight);
    // 眼睛（跑步時興奮大眼）
    const ex = Math.round(chicR*0.32);
    fillPixelCircle(c, ex, -Math.round(chicR*0.06), Math.round(chicR*0.32), PALETTE.eyeWhite);
    fillPixelCircle(c, ex+2, -Math.round(chicR*0.06), Math.round(chicR*0.18), PALETTE.eyeBlack);
    // 嘴喙（向右）
    pxRect(c, Math.round(chicR*0.55), Math.round(chicR*0.12), Math.round(chicR*0.35), Math.round(chicR*0.2), PALETTE.beak);
    // 臉紅
    fillPixelCircle(c, Math.round(chicR*0.5), Math.round(chicR*0.2), Math.round(chicR*0.16), PALETTE.blush);
    // 雞冠（成年以上）
    if(['teen','adult','old'].includes(GameState.stage)){
      fillPixelCircle(c, -Math.round(chicR*0.1), -Math.round(chicR*1.08), Math.round(chicR*0.22), PALETTE.comb);
    }
    // 腳（跑步動畫：交替抬起）
    const legPhase = Math.sin(frame * 0.4);
    pxRect(c, -Math.round(chicR*0.3), Math.round(chicR*0.82+legPhase*4), 7, 7, PALETTE.feet);
    pxRect(c, Math.round(chicR*0.1),  Math.round(chicR*0.82-legPhase*4), 7, 7, PALETTE.feet);

    c.restore();

    // 跳躍時的速度線
    if(!isOnGround && chickVY < -0.01){
      c.strokeStyle='rgba(255,255,255,0.4)'; c.lineWidth=2;
      for(let i=1;i<=3;i++){
        c.beginPath();
        c.moveTo(chicX - chicR - i*8, chicY - chicR*0.5 + i*3);
        c.lineTo(chicX - chicR - i*8 - 12, chicY - chicR*0.5 + i*3);
        c.stroke();
      }
    }

    // ── 受傷提示 ──
    if(hitFlash > 30){
      c.fillStyle='rgba(255,0,0,0.18)';
      c.fillRect(0, 0, W, H);
      c.fillStyle='#ff4444'; c.font=`bold ${Math.round(H*0.06)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      c.fillText('OUCH!', W/2, H*0.35);
    }

    // ── 操作提示（前 3 秒）──
    const elapsed = GAME_TIME - timeLeft;
    if(elapsed < 3){
      c.globalAlpha = Math.max(0, 1 - elapsed/2.5);
      c.fillStyle='#ffe9b8'; c.font=`${Math.round(H*0.04)}px monospace`;
      c.textAlign='center'; c.textBaseline='middle';
      c.fillText('點擊 / 空白鍵 跳躍！', W/2, H*0.25);
      c.globalAlpha=1;
    }
  }

  /* ════════════════════════════════
     結算
     ════════════════════════════════ */
  function _endGame(){
    if(done) return; done=true;
    SFX.end();
    const dist = Math.floor(distance);
    // 金幣：基礎距離 + 收集到的金幣 + 存活加成（每剩餘 1 血 +5）
    const goldEarned = Math.floor(dist / 15) + coins * 3 + (hp * 5);

    const summary =
      dist >= 400 ? `跑了 ${dist}m！小雞衝向終點，觀眾瘋狂歡呼！` :
      dist >= 200 ? `跑了 ${dist}m，還不錯！小雞有點喘，但很開心。` :
                    `跑了 ${dist}m，小雞下次會更努力的！`;

    resultData = {
      gameName: '小雞賽跑',
      gold:    goldEarned,
      hunger:  0,
      happy:   hp > 0 ? 10 : 0,
      happyPen: 0,
      summary,
    };
    if(endCb) endCb();
  }

  function stop(){ if(ChickenRunGame._cleanup) ChickenRunGame._cleanup(); }
  function getResult(){ return resultData; }
  return { start, update, render, stop, getResult, get done(){ return done; } };
})();

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
