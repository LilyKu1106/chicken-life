// Arcade v2-fixed — 2026-07-02
// 修復: 1)移除 window._arcLoop 2)統一清理計時器 3)避免重複loop 4)資源釋放
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const list = $('arcade-list'), modal = $('arcade-play-modal'), box = $('arcade-container'), hud = $('arcade-hud'), title = $('arcade-title'), closeBtn = $('arcade-close');

  let loopId = null;
  let activeTimers = [];
  let activeListeners = [];

  const clearAll = () => {
    if (loopId) cancelAnimationFrame(loopId);
    loopId = null;
    activeTimers.forEach(id => { try{clearInterval(id)}catch{} try{clearTimeout(id)}catch{} });
    activeTimers = [];
    activeListeners.forEach(({target,type,fn}) => target.removeEventListener(type,fn));
    activeListeners = [];
    box.innerHTML = ''; hud.innerHTML = '';
  };

  closeBtn.onclick = () => { clearAll(); modal.classList.add('hidden'); };

  const addTimer = fn => { const id = fn(); activeTimers.push(id); return id; };
  const addListener = (t,ty,f) => { t.addEventListener(ty,f); activeListeners.push({target:t,type:ty,fn:f}); };

  const reward = o => {
    if(o.gold){ GameState.gold+=o.gold; SoundManager.coin(); }
    if(o.happy) GameState.happy=Math.min(100,GameState.happy+o.happy);
    if(o.hunger) GameState.hunger=Math.min(100,GameState.hunger+o.hunger);
    if(o.mood) GameState.happy=Math.max(0,GameState.happy+o.mood);
    GameState.markDirty(); UI.updateStats();
  };
  const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;

  document.addEventListener('click',e=>{ if(e.target.closest('[data-action="arcade"]')){ SoundManager.click(); UI.openModal('arcade-modal'); }});

  const games=[
    {n:'🧠 小雞迷宮逃脫',d:'小雞迷路了！幫牠找到回家的路',p(){title.textContent='迷宮';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let px=1,py=1,ex=24,ey=18,t=30;const m=Array(20).fill().map(()=>Array(26).fill(0));for(let i=0;i<200;i++)m[rand(1,18)][rand(1,24)]=1;const draw=()=>{x.fillStyle='#ffe9b8';x.fillRect(0,0,400,300);for(let y=0;y<20;y++)for(let z=0;z<26;z++)if(m[y][z]){x.fillStyle='#5c3b26';x.fillRect(z*15,y*15,15);}x.fillStyle='#6fae5a';x.fillRect(ex*15,ey*15,15,15);x.fillStyle='#ffd23f';x.beginPath();x.arc(px*15+7,py*15+7,6,0,7);x.fill();};const k=e=>{let nx=px,ny=py;if(e.key==='ArrowUp')ny--;if(e.key==='ArrowDown')ny++;if(e.key==='ArrowLeft')nx--;if(e.key==='ArrowRight')nx++;if(nx>=0&&ny>=0&&nx<26&&ny<20&&!m[ny][nx]){px=nx;py=ny;}if(px===ex&&py===ey)end(1);};addListener(document,'keydown',k);addTimer(()=>setInterval(()=>{t--;hud.textContent='時間:'+t;if(t<=0)end(0);},1000));function loop(){draw();loopId=requestAnimationFrame(loop);}loop();function end(w){clearAll();if(w){reward({gold:40,happy:15});UI.toast('找到出口！');}else{reward({mood:-10});UI.toast('迷路了');}setTimeout(()=>closeBtn.click(),800);}}},

    {n:'🐛 抓蟲大作戰',d:'幫牠抓對食物！',p(){title.textContent='抓蟲';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let b=[],s=0,t=20;const sp=()=>b.push({x:rand(20,380),y:rand(20,280),t:Math.random()<.7?'g':'b'});const cl=e=>{const r=c.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;b=b.filter(o=>{if(Math.hypot(o.x-mx,o.y-my)<18){if(o.t==='g'){s+=10;reward({gold:2,hunger:3});}else{reward({mood:-5});}return false}return true});};addListener(c,'click',cl);addTimer(()=>setInterval(sp,600));addTimer(()=>setInterval(()=>{t--;hud.textContent='分數:'+s+' 時間:'+t;if(t<=0)end();},1000));function loop(){x.fillStyle='#fff3d6';x.fillRect(0,0,400,300);b.forEach(o=>{o.y+=1.5;x.font='20px serif';x.fillText(o.t==='g'?'🐛':'☠️',o.x,o.y);});loopId=requestAnimationFrame(loop);}loop();function end(){clearAll();setTimeout(()=>closeBtn.click(),600);}}},

    {n:'⚖ 平衡天秤',d:'讓天秤平衡',p(){title.textContent='平衡';box.innerHTML='<div id=bal style="display:flex;justify-content:space-around;padding:20px;"><div id=l style="width:45%;height:100px;background:#8a5a3b"></div><div id=r style="width:45%;height:100px;background:#8a5a3b"></div></div><div id=fb style="text-align:center"></div>';let L=0,R=0;['🌽','🍗','🥚','🍞'].forEach((e,i)=>{const b=document.createElement('button');b.textContent=e;b.style.fontSize='24px';b.onclick=()=>{const w=[3,5,2,4][i];if(L<=R){L+=w;$('l').innerHTML+=e;}else{R+=w;$('r').innerHTML+=e;}hud.textContent='L:'+L+' R:'+R;if(Math.abs(L-R)<=1&&L+R>=12){reward({gold:30,happy:10});UI.toast('成功');setTimeout(()=>closeBtn.click(),800);}};$('fb').appendChild(b);});}},

    {n:'🐔 小雞賽跑',d:'避開障礙',p(){title.textContent='賽跑';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let y=200,vy=0,obs=[],d=0,alive=1;const j=()=>{if(y>=200){vy=-10}};addListener(c,'click',j);addListener(document,'keydown',e=>{if(e.code==='Space')j()});function loop(){if(!alive)return;x.fillStyle='#b6e3a1';x.fillRect(0,0,400,300);x.fillStyle='#8a5a3b';x.fillRect(0,230,400,70);y+=vy;vy+=0.6;if(y>200){y=200;vy=0}if(Math.random()<.03)obs.push({x:400});obs.forEach(o=>{o.x-=4;x.fillStyle='#5c3b26';x.fillRect(o.x,210,20);if(o.x<60&&o.x>30&&y>180)alive=0});obs=obs.filter(o=>o.x>-20);x.font='30px serif';x.fillText('🐥',40,y+10);d++;hud.textContent='距離:'+d;if(!alive){reward({gold:Math.floor(d/10)});clearAll();setTimeout(()=>closeBtn.click(),800);return}loopId=requestAnimationFrame(loop)}loop()}},

    {n:'🍳 廚房快手',d:'完成料理',p(){title.textContent='廚房';let i=0,s=['加蛋🥚','加玉米🌽','攪拌🥄','完成🍳'];box.innerHTML='<div id=st style="color:#fff;text-align:center;padding:60px;font-size:24px"></div>';const nx=()=>{if(i>=s.length){reward({gold:50});UI.toast('成功');setTimeout(()=>closeBtn.click(),600);return}$('st').textContent=s[i];hud.textContent=(i+1)+'/4'};addListener(box,'click',()=>{i++;nx()});nx()}},

    {n:'🎈 氣球救援',d:'保持高度',p(){title.textContent='氣球';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let y=150,vy=0,h=0;const f=()=>vy-=2;addListener(c,'click',f);function loop(){vy+=.1;y+=vy;y=Math.max(20,Math.min(280,y));x.fillStyle='#6fc3df';x.fillRect(0,0,400,300);x.font='30px serif';x.fillText('🐥🎈',180,y);h=Math.max(h,300-y);hud.textContent='高度:'+Math.floor(h);if(h>250){reward({gold:35});clearAll();setTimeout(()=>closeBtn.click(),800);return}loopId=requestAnimationFrame(loop)}loop()}},

    {n:'🧪 藥水混合',d:'記住🔴🟢🔵',p(){title.textContent='藥水';box.innerHTML='<div style="color:#fff;text-align:center;padding:20px">記住: 🔴🟢🔵<div id=ps style="margin-top:20px"></div></div>';let idx=0,rec=['🔴','🟢','🔵'];['🔴','🟢','🔵','🟡'].forEach(c=>{const b=document.createElement('button');b.textContent=c;b.style.fontSize='30px';b.onclick=()=>{if(c===rec[idx]){idx++;if(idx===3){reward({gold:20});GameState.health=Math.min(100,GameState.health+30);UI.toast('成功');setTimeout(()=>closeBtn.click(),600)}}else{reward({mood:-8});idx=0}};$('ps').appendChild(b)})}},

    {n:'🎯 射擊泡泡',d:'點泡泡',p(){title.textContent='泡泡';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let b=[],s=0;addListener(c,'click',e=>{const r=c.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;b=b.filter(o=>Math.hypot(o.x-mx,o.y-my)>15||(s+=5,reward({gold:1}),0))});addTimer(()=>setInterval(()=>b.push({x:rand(20,380),y:300,c:['#ff9fb2','#6fc3df','#ffd23f'][rand(0,2)]}),500));function loop(){x.clearRect(0,0,400,300);b.forEach(o=>{o.y-=2;x.fillStyle=o.c;x.beginPath();x.arc(o.x,o.y,15,0,7);x.fill()});hud.textContent='分數:'+s;if(s>100){clearAll();setTimeout(()=>closeBtn.click(),600);return}loopId=requestAnimationFrame(loop)}loop()}},

    {n:'🧩 拼圖修復',d:'3x3拼圖',p(){title.textContent='拼圖';box.innerHTML='<div id=pz style="display:grid;grid-template-columns:repeat(3,80px);gap:4px;justify-content:center;padding:20px"></div>';let a=[1,2,3,4,5,6,7,8,0].sort(()=>Math.random()-.5),m=0;const dr=()=>{const pz=$('pz');pz.innerHTML='';a.forEach(n=>{const d=document.createElement('div');d.style.cssText='width:80px;height:80px;background:#ffe9b8;display:flex;align-items:center;justify-content:center;font-size:30px';d.textContent=n?'🐥':'';d.onclick=()=>{const i=a.indexOf(n),z=a.indexOf(0);if(Math.abs(i-z)===1||Math.abs(i-z)===3){[a[i],a[z]]=[a[z],a[i]];m++;dr();if(a.join(',')==='1,2,3,4,5,6,7,8,0'){reward({gold:40,happy:10});setTimeout(()=>closeBtn.click(),600)}}};pz.appendChild(d)});hud.textContent='步數:'+m};dr()}},

    {n:'🎲 幸運轉盤',d:'試手氣',p(){title.textContent='轉盤';box.innerHTML='<div style="text-align:center;padding:40px"><button id=sp style="font-size:24px;padding:20px">轉！</button><div id=rs style="color:#fff;margin-top:20px"></div></div>';$('sp').onclick=()=>{const p=[{t:'+30金',g:30},{t:'+飼料',f:1},{t:'-5心情',m:-5},{t:'+50金',g:50}][rand(0,3)];$('rs').textContent=p.t;if(p.g)reward({gold:p.g});if(p.f)GameState.inventory.food_basic++;if(p.m)reward({mood:p.m});setTimeout(()=>closeBtn.click(),1200)}}},

    {n:'🎮 接飼料',d:'飢餓大作戰',p(){title.textContent='接飼料';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let cx=200,fs=[],sc=0;const mv=e=>{const r=c.getBoundingClientRect();cx=e.clientX-r.left};addListener(c,'mousemove',mv);addListener(c,'touchmove',e=>mv(e.touches[0]));addTimer(()=>setInterval(()=>fs.push({x:rand(20,380),y:0,t:Math.random()<.8?'g':'b'}),700));function loop(){x.fillStyle='#b6e3a1';x.fillRect(0,0,400,300);x.font='30px serif';x.fillText('🐥',cx-15,280);fs.forEach(f=>{f.y+=3;x.fillText(f.t==='g'?'🌽':'💩',f.x,f.y);if(f.y>260&&Math.abs(f.x-cx)<30){if(f.t==='g'){sc++;reward({gold:1,hunger:2})}else{reward({mood:-3})}f.y=400}});fs=fs.filter(f=>f.y<310);hud.textContent='接到:'+sc;if(sc>=15){UI.toast('吃飽');clearAll();setTimeout(()=>closeBtn.click(),600);return}loopId=requestAnimationFrame(loop)}loop()}},

    {n:'🎵 節奏',d:'跟拍',p(){title.textContent='節奏';box.innerHTML='<canvas width=400 height=300></canvas>';const c=box.querySelector('canvas'),x=c.getContext('2d');let ns=[],sc=0,t=0;addTimer(()=>setInterval(()=>ns.push({y:0}),800));addListener(c,'click',()=>{const h=ns.find(n=>n.y>230&&n.y<270);if(h){sc+=10;reward({gold:2});ns=ns.filter(n=>n!==h)}else{reward({mood:-2})}});function loop(){t++;x.clearRect(0,0,400,300);x.fillStyle='#fff';x.fillRect(0,250,400,4);ns.forEach(n=>{n.y+=3;x.fillStyle='#ffd23f';x.fillRect(180,n.y,40,10)});hud.textContent='分數:'+sc;if(t>600){clearAll();setTimeout(()=>closeBtn.click(),600);return}loopId=requestAnimationFrame(loop)}loop()}},

    {n:'🧠 翻牌記憶',d:'配對',p(){title.textContent='記憶';box.innerHTML='<div id=mm style="display:grid;grid-template-columns:repeat(4,70px);gap:6px;justify-content:center;padding:10px"></div>';const ic=['🐥','🌽','🍗','💧','🎮','🛁','💊','📦'];const deck=[...ic,...ic].sort(()=>Math.random()-.5);let first=null,pairs=0,mv=0;deck.forEach((c,i)=>{const d=document.createElement('div');d.style.cssText='width:70px;height:70px;background:#ffe9b8;display:flex;align-items:center;justify-content:center;font-size:28px';d.dataset.c=c;d.textContent='?';d.onclick=()=>{if(d.textContent!=='?')return;d.textContent=c;if(!first){first=d}else{mv++;if(first.dataset.c===c){pairs++;if(pairs===8){reward({gold:30+Math.max(0,20-mv)});setTimeout(()=>closeBtn.click(),800)}}else{setTimeout(()=>{first.textContent='?';d.textContent='?';first=null},600)}first=null}hud.textContent='步數:'+mv};$('mm').appendChild(d)})}}
  ];

  function build(){list.innerHTML='';games.forEach(g=>{const it=document.createElement('div');it.className='shop-item';it.style.cursor='pointer';it.innerHTML=`<div class="shop-item-info"><span style="font-size:20px">${g.n.split(' ')[0]}</span><div><div style="font-size:10px">${g.n}</div><div style="font-size:8px;color:#5c3b26">${g.d}</div></div></div><button>玩</button>`;it.onclick=()=>{UI.closeModal('arcade-modal');modal.classList.remove('hidden');clearAll();g.p()};list.appendChild(it)});}
  const iv=setInterval(()=>{if(window.UI){clearInterval(iv);build()}},300);
})();