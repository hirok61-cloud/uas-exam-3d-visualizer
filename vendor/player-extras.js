"use strict";
/* ============================================================
   player-extras.js — 4つのビジュアライザーページ共通のプレーヤーUI
   ・シークバー（1:1スクラブ／手順の目盛り／時刻表示）
   ・キーボード操作（Space=再生/停止, ←→=±5秒）
   ・現在の科目へのハッシュ直リンク＋リンクコピー
   ・表示中の3D画面をPNG保存
   ・全画面（Fullscreen API・非対応環境は疑似全画面）
   ・口頭指示／手順の読み上げ（Web Speech API）
   ・埋め込みモード（?embed=1）と親ページからの postMessage 制御（比較モード用）

   ページ側は <script>window.PLAYER_CFG={...}</script> で
   状態アクセサを渡すだけ。エンジンのグローバル
   （t / playing / SPEED / totalDur / samplePose / resetAnim /
     renderer / scene / camera 等）を直接読み書きする設計なので、
   エンジン読込後に配置すること。
============================================================ */
(function(){
  const CFG = window.PLAYER_CFG;
  if(!CFG) return;
  const Q=new URLSearchParams(location.search);
  const EMBED=(Q.get('embed')==='1');

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
  /* 全画面 */
  #stageBox:fullscreen, #stageBox.pe-fs{background:#0b1626;}
  #stageBox:fullscreen #stage, #stageBox.pe-fs #stage{height:100vh !important; width:100vw;}
  #stageBox.pe-fs{position:fixed; inset:0; z-index:9999; margin:0 !important; border:0 !important; border-radius:0 !important;}
  #peFsExit{display:none; position:absolute; top:12px; right:12px; z-index:5; border:0; border-radius:8px;
    background:rgba(12,22,40,.85); color:#fff; font:700 12px/1 inherit; font-family:inherit; padding:9px 13px; cursor:pointer;}
  #stageBox:fullscreen #peFsExit, #stageBox.pe-fs #peFsExit{display:block;}
  #stageBox:fullscreen #emg, #stageBox.pe-fs #emg{top:54px;}
  /* 埋め込み（比較モード等） */
  body.pe-embed header.doc, body.pe-embed nav.pagenav, body.pe-embed .wrap > :not(#stageBox){display:none !important;}
  body.pe-embed .wrap{max-width:none; padding:0;}
  body.pe-embed #stageBox{margin:0; border:0; border-radius:0;}
  body.pe-embed #stage{height:100vh;}
  body.pe-embed #hud{max-width:300px; font-size:11.5px;}
  `;
  const st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);
  if(EMBED) document.body.classList.add('pe-embed');

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
  function syncPlayBtn(){
    const b=document.getElementById('btnPlay');
    if(b) b.textContent=playing?'⏸ 一時停止':(t>=total()?'▶ もう一度':'▶ 再生');
  }
  function setPlaying(on){
    if(on){ if(t>=total()) t=0; playing=true; }
    else playing=false;
    syncPlayBtn(); poke();
  }

  /* ---------- スクラブ（pointer-downで即応・1:1追従・再生状態を保存/復元） ---------- */
  let scrubbing=false, wasPlaying=false;
  function frac(e){
    const r=trEl.getBoundingClientRect();
    if(!(r.width>0)) return null;
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

  /* ---------- 読み上げ（Web Speech API） ---------- */
  let speakMode='off';
  try{ speakMode=localStorage.getItem('peSpeak')||'off'; }catch(e){}
  if(EMBED) speakMode=Q.get('speak')||'off';   // 埋め込みは既定OFF（比較モードで二重に喋らないため）
  const canSpeak=('speechSynthesis' in window);
  let jaVoice=null;
  function pickVoice(){
    if(!canSpeak) return;
    const vs=speechSynthesis.getVoices().filter(v=>/^ja/i.test(v.lang));
    jaVoice=vs.find(v=>/Kyoko|O-ren|Google 日本語|Nanami|Ichiro|Ayumi/i.test(v.name))||vs[0]||null;
  }
  if(canSpeak){ pickVoice(); speechSynthesis.onvoiceschanged=pickVoice; }
  function ttsNormalize(s){
    return s
      .replace(/GNSS/g,'ジーエヌエスエス').replace(/OFF/g,'オフ').replace(/ON\b/g,'オン')
      .replace(/km\/h/g,'キロメートル毎時').replace(/m\/s/g,'メートル毎秒')
      .replace(/(\d)\s*m\b/g,'$1メートル').replace(/(\d)\s*°/g,'$1度').replace(/±/g,'プラスマイナス')
      .replace(/⇄/g,'から').replace(/〜/g,'から').replace(/[【】]/g,'').replace(/[…]+/g,'。');
  }
  function speechText(seg, mode){
    const label=String(seg.label||'');
    const quoted=[...label.matchAll(/「([^」]+)」/g)].map(m=>m[1]);
    if(quoted.length) return quoted.join('。');                       // 口頭指示そのもの
    if(mode==='cmd'){
      if(seg.emg && /緊急/.test(label)) return '緊急事態発生。緊急着陸';
      const cl=label.split('→').find(c=>/指示/.test(c));
      return cl? cl.replace(/【[^】]*】/g,'').replace(/（[^）]*）/g,'').trim() : null;
    }
    let s=label.split('→')[0].replace(/【[^】]*】/g,'').replace(/（[^）]*）/g,'').replace(/[!！]+$/,'').trim();
    if(s.length>70) s=s.slice(0,70);
    return s||null;
  }
  let lastSpokenSeg=null;
  function maybeSpeak(seg){
    if(!canSpeak||speakMode==='off'||!seg||seg===lastSpokenSeg) return;
    lastSpokenSeg=seg;
    const text=speechText(seg, speakMode);
    if(!text) return;
    try{
      speechSynthesis.cancel();
      const u=new SpeechSynthesisUtterance(ttsNormalize(text));
      u.lang='ja-JP'; u.rate=1.05; u.pitch=1.0; if(jaVoice) u.voice=jaVoice;
      speechSynthesis.speak(u);
    }catch(e){}
  }
  function setSpeak(m){
    speakMode=m;
    try{ localStorage.setItem('peSpeak',m); }catch(e){}
    if(canSpeak && m==='off') speechSynthesis.cancel();
    lastSpokenSeg=null;
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
    if(CFG.state && !EMBED){
      const h='#'+CFG.state();
      if(h!==lastHash){ lastHash=h; try{ history.replaceState(null,'',h); }catch(e){} }
    }
    // 読み上げ：再生中にセグメントが切り替わったとき
    if(playing && speakMode!=='off' && typeof samplePose==='function'){
      try{ maybeSpeak(samplePose(CFG.scen(), t).seg); }catch(e){}
    }else if(!playing){ lastSpokenSeg=null; }
  }
  requestAnimationFrame(ui);

  /* ---------- キーボード（Space=再生/停止, ←→=±5秒, F=全画面, Esc=疑似全画面終了） ---------- */
  window.addEventListener('keydown',e=>{
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    const tg=e.target;
    if(tg && (tg.tagName==='INPUT'||tg.tagName==='SELECT'||tg.tagName==='TEXTAREA'||tg.tagName==='BUTTON')) return;
    if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
    else if(e.key==='ArrowRight'){ e.preventDefault(); seekTo(t+5); }
    else if(e.key==='ArrowLeft'){ e.preventDefault(); seekTo(t-5); }
    else if(e.key==='f'||e.key==='F'){ toggleFS(); }
    else if(e.key==='Escape' && box.classList.contains('pe-fs')){ pseudoFS(false); }
  });

  /* ---------- 全画面 ---------- */
  const fsExit=document.createElement('button');
  fsExit.id='peFsExit'; fsExit.textContent='✕ 全画面を終了'; fsExit.onclick=()=>exitFS();
  box.appendChild(fsExit);
  let fsBtn=null;
  function isFS(){ return !!document.fullscreenElement || box.classList.contains('pe-fs'); }
  function pseudoFS(on){ box.classList.toggle('pe-fs',on); syncFsBtn(); poke(); }
  function toggleFS(){ isFS()? exitFS() : enterFS(); }
  function enterFS(){
    if(box.requestFullscreen){ box.requestFullscreen().catch(()=>pseudoFS(true)); }
    else if(box.webkitRequestFullscreen){ try{ box.webkitRequestFullscreen(); }catch(e){ pseudoFS(true); } }
    else pseudoFS(true);
  }
  function exitFS(){
    if(document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{});
    else if(document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    pseudoFS(false);
  }
  function syncFsBtn(){ if(fsBtn) fsBtn.textContent=isFS()?'✕ 全画面を終了':'⛶ 全画面'; }
  document.addEventListener('fullscreenchange',()=>{ syncFsBtn(); poke(); });
  document.addEventListener('webkitfullscreenchange',()=>{ syncFsBtn(); poke(); });

  /* ---------- プレイバー追加UI（読み上げ／全画面／リンクコピー／PNG保存） ---------- */
  const bar=document.querySelector('.playbar');
  if(bar){
    const spacer=bar.querySelector('.spacer');
    const mk=(txt,fn,title)=>{
      const b=document.createElement('button');
      b.className='pe-btn'; b.textContent=txt; b.title=title||''; b.onclick=fn;
      bar.insertBefore(b, spacer||null);
      return b;
    };
    if(canSpeak){
      const lab=document.createElement('label'); lab.className='pe-btn';
      lab.title='講師・試験員の口頭指示や手順を音声で読み上げます';
      lab.innerHTML='読み上げ <select id="peSpeakSel"><option value="off">OFF</option><option value="cmd">指示のみ</option><option value="all">手順も</option></select>';
      bar.insertBefore(lab, spacer||null);
      const sel=lab.querySelector('select'); sel.value=speakMode;
      sel.onchange=()=>setSpeak(sel.value);
    }
    fsBtn=mk('⛶ 全画面',toggleFS,'3D画面を全画面表示（F キー／Esc で戻る）');
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

  /* ---------- 親ページからの制御（比較モード等・同一オリジン想定） ---------- */
  window.addEventListener('message',e=>{
    const m=e.data; if(!m||m.type!=='pe-cmd') return;
    try{
      switch(m.cmd){
        case 'play':  setPlaying(true); break;
        case 'pause': setPlaying(false); break;
        case 'reset': if(typeof resetAnim==='function') resetAnim(); else seekTo(0); break;
        case 'seek':  seekTo(m.t); break;
        case 'speed': if(Number.isFinite(m.v)) SPEED=m.v; break;
        case 'select': if(CFG.apply) CFG.apply(String(m.h||'')); break;
        case 'speak': setSpeak(m.v||'off'); break;
      }
    }catch(err){}
    poke();
  });
  if(window.parent!==window){
    setInterval(()=>{
      try{
        parent.postMessage({type:'pe-state', id:CFG.id, t, total:total(), playing, hash:CFG.state?CFG.state():'', name:CFG.name?CFG.name():''}, '*');
      }catch(e){}
    },200);
  }

  /* ---------- ハッシュ直リンクの適用（読み込み時） ---------- */
  if(location.hash && CFG.apply){
    try{ CFG.apply(location.hash.slice(1)); }catch(e){}
  }
})();
