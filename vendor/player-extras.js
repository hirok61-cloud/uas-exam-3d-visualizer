"use strict";
/* ============================================================
   player-extras.js — 4つのビジュアライザーページ共通のプレーヤーUI
   ・シークバー（1:1スクラブ／手順の目盛り／時刻表示）
   ・キーボード操作（Space=再生/停止, ←→=±5秒）
   ・現在の科目へのハッシュ直リンク＋リンクコピー
   ・表示中の3D画面をPNG保存

   ページ側は <script>window.PLAYER_CFG={...}</script> で
   状態アクセサを渡すだけ。エンジンのグローバル
   （t / playing / totalDur / renderer / scene / camera 等）を
   直接読み書きする設計なので、エンジン読込後に配置すること。
============================================================ */
(function(){
  const CFG = window.PLAYER_CFG;
  if(!CFG) return;

  /* ---------- CSS 注入 ---------- */
  const css = `
  #stageBox{--seek-h:34px;}
  #legend{bottom:calc(var(--seek-h) + 8px) !important;}
  #peSeek{position:absolute; left:0; right:0; bottom:0; height:var(--seek-h);
    cursor:pointer; touch-action:none; user-select:none;
    background:linear-gradient(to top, rgba(12,22,40,.60), rgba(12,22,40,0));}
  #peSeek .tr{position:absolute; left:14px; right:86px; bottom:14px; height:4px;
    border-radius:2px; background:rgba(255,255,255,.26);}
  #peSeek .tk{position:absolute; top:-2px; width:2px; height:8px; border-radius:1px;
    background:rgba(255,255,255,.55); transform:translateX(-50%);}
  #peSeek .fi{position:absolute; left:0; top:0; bottom:0; width:0;
    border-radius:2px; background:#4fa3ff;}
  #peSeek .kn{position:absolute; top:50%; left:0; width:13px; height:13px; border-radius:50%;
    background:#fff; transform:translate(-50%,-50%); box-shadow:0 1px 4px rgba(0,0,0,.45);
    transition:transform .12s ease-out;}
  #peSeek:hover .kn, #peSeek.drag .kn{transform:translate(-50%,-50%) scale(1.3);}
  #peSeek .tm{position:absolute; right:14px; bottom:8px; font-size:11px; color:#fff;
    text-shadow:0 1px 2px rgba(0,0,0,.6); font-variant-numeric:tabular-nums; letter-spacing:.02em;}
  @media (prefers-reduced-motion: reduce){ #peSeek .kn{transition:none;} }
  .pe-btn{white-space:nowrap;}
  @media (max-width:760px){ #peSeek .tr{right:78px;} }
  `;
  const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);

  /* ---------- シークバー DOM ---------- */
  const box=document.getElementById('stageBox');
  const seek=document.createElement('div');
  seek.id='peSeek';
  seek.setAttribute('role','slider');
  seek.setAttribute('aria-label','再生位置');
  seek.innerHTML='<div class="tr"><div class="ticks"></div><div class="fi"></div><div class="kn"></div></div><div class="tm">0:00 / 0:00</div>';
  box.appendChild(seek);
  const trEl=seek.querySelector('.tr'), fiEl=seek.querySelector('.fi'),
        knEl=seek.querySelector('.kn'), tmEl=seek.querySelector('.tm'),
        tkBox=seek.querySelector('.ticks');

  function fmt(s){ s=Math.max(0,Math.floor(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
  function total(){ try{ return totalDur(CFG.scen()); }catch(e){ return 0; } }

  /* トレイルはシーク位置と矛盾するため、シーク時はリセットする */
  function resetTrail(){
    try{
      if(typeof clearTrail==='function'){ clearTrail(); }
      else if(typeof trailPts!=='undefined'){
        trailPts.length=0;
        if(typeof trailLine!=='undefined' && trailLine){ trailGroup.remove(trailLine); trailLine=null; }
      }
      if(typeof lastTrailT!=='undefined') lastTrailT=t;
    }catch(e){}
  }
  function poke(){ try{ if(typeof forceRender!=='undefined') forceRender=true; }catch(e){} }
  function seekTo(sec){
    const tt=total();
    if(!Number.isFinite(sec)||!(tt>0)) return;
    t=Math.min(tt,Math.max(0,sec));
    resetTrail(); poke();
  }

  /* ---------- スクラブ（pointer-downで即応・1:1追従・再生状態を保存/復元） ---------- */
  let scrubbing=false, wasPlaying=false;
  function frac(e){
    const r=trEl.getBoundingClientRect();
    if(!(r.width>0)) return null;   // 非表示中など幅0のときはシークしない
    return Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
  }
  seek.addEventListener('pointerdown',e=>{
    try{ seek.setPointerCapture(e.pointerId); }catch(err){}
    scrubbing=true; seek.classList.add('drag');
    wasPlaying=playing; playing=false;
    const f=frac(e); if(f!==null) seekTo(f*total());
    e.preventDefault();
  });
  seek.addEventListener('pointermove',e=>{ if(!scrubbing) return; const f=frac(e); if(f!==null) seekTo(f*total()); });
  function endScrub(){
    if(!scrubbing) return;
    scrubbing=false; seek.classList.remove('drag');
    if(wasPlaying && t<total()){ playing=true; syncPlayBtn(); }
    poke();
  }
  seek.addEventListener('pointerup',endScrub);
  seek.addEventListener('pointercancel',endScrub);
  function syncPlayBtn(){
    const b=document.getElementById('btnPlay');
    if(b) b.textContent=playing?'⏸ 一時停止':(t>=total()?'▶ もう一度':'▶ 再生');
  }

  /* ---------- 手順の目盛り（シナリオ切替時に再構築） ---------- */
  let tickKey=null;
  function rebuildTicks(){
    const key=(CFG.state?CFG.state():'')+'|'+total().toFixed(1);
    if(key===tickKey) return;
    tickKey=key;
    tkBox.innerHTML='';
    const fr=(CFG.ticks?CFG.ticks():[])||[];
    fr.forEach(f=>{
      if(!(f>0 && f<1)) return;
      const s=document.createElement('span'); s.className='tk'; s.style.left=(f*100)+'%';
      tkBox.appendChild(s);
    });
  }

  /* ---------- 表示更新（独立rAF・値が変わったときだけDOMを書く） ---------- */
  let lastFill=-1, lastTm='', lastHash='';
  function ui(){
    requestAnimationFrame(ui);
    const tt=total(); if(!(tt>0)) return;
    rebuildTicks();
    const fr=Math.min(1,t/tt);
    const pct=Math.round(fr*1000)/10;
    if(pct!==lastFill){
      lastFill=pct;
      fiEl.style.width=pct+'%';
      knEl.style.left=pct+'%';
      seek.setAttribute('aria-valuenow', String(Math.round(fr*100)));
    }
    const s=fmt(t)+' / '+fmt(tt);
    if(s!==lastTm){ lastTm=s; tmEl.textContent=s; }
    // ハッシュ直リンク（選択が変わったら書き換え）
    if(CFG.state){
      const h='#'+CFG.state();
      if(h!==lastHash){ lastHash=h; try{ history.replaceState(null,'',h); }catch(e){} }
    }
  }
  requestAnimationFrame(ui);

  /* ---------- キーボード（Space=再生/停止, ←→=±5秒） ---------- */
  window.addEventListener('keydown',e=>{
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    const tg=e.target;
    if(tg && (tg.tagName==='INPUT'||tg.tagName==='SELECT'||tg.tagName==='TEXTAREA'||tg.tagName==='BUTTON')) return;
    if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
    else if(e.key==='ArrowRight'){ e.preventDefault(); seekTo(t+5); }
    else if(e.key==='ArrowLeft'){ e.preventDefault(); seekTo(t-5); }
  });

  /* ---------- プレイバー追加ボタン（リンクコピー／PNG保存） ---------- */
  const bar=document.querySelector('.playbar');
  if(bar){
    const spacer=bar.querySelector('.spacer');
    const mk=(txt,fn,title)=>{
      const b=document.createElement('button');
      b.className='pe-btn'; b.textContent=txt; b.title=title||''; b.onclick=fn;
      bar.insertBefore(b, spacer||null);
      return b;
    };
    const linkBtn=mk('🔗 リンク',()=>{
      navigator.clipboard.writeText(location.href).then(()=>{
        linkBtn.textContent='✓ コピーしました';
        setTimeout(()=>{ linkBtn.textContent='🔗 リンク'; },1400);
      }).catch(()=>{ prompt('このURLをコピーしてください', location.href); });
    },'表示中の科目へのリンクをコピー');
    mk('📷 保存',()=>{
      try{
        if(renderer.setScissorTest) renderer.setScissorTest(false);
        const cv=document.getElementById('stage');
        renderer.setViewport(0,0,cv.clientWidth,cv.clientHeight);
        renderer.render(scene,camera);
        const name=(CFG.id||'course')+'_'+((CFG.name?CFG.name():'')||'').replace(/[\s／/:：（）()]+/g,'_');
        const a=document.createElement('a');
        a.href=cv.toDataURL('image/png');
        a.download=name+'.png'; a.click();
        poke();
      }catch(err){ alert('画像の保存に失敗しました: '+err.message); }
    },'現在の3D画面をPNG画像として保存');
  }

  /* ---------- ハッシュ直リンクの適用（読み込み時） ---------- */
  if(location.hash && CFG.apply){
    try{ CFG.apply(location.hash.slice(1)); }catch(e){}
  }
})();
