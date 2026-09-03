"use strict";
/* ============================================================
   fx.js — 4ページ共通の見た目の演出
   ・空のグラデーションドーム（夜間シナリオでは自動で非表示）
   ・吹き流し（風向を示し、風でゆらぐ）
   ・離着陸・滑走時の砂煙

   ページ側は window.FX_CFG={
     pos:()=>Vector3,           // 機体位置
     seg:()=>segment|null,      // 現在のセグメント（t: takeoff/land/roll 等）
     scale:()=>number,          // 世界の縮尺（マルチ=1, ヘリ=1.6〜2.5, 飛行機=7）
     wind:()=>[x,z,scale,dirRad]|null,  // 吹き流しの位置と向き（風下方向）
     skyR:number                // 空ドーム半径（カメラfar未満）
   } を用意する。エンジン読込後に配置すること（scene/playing/THREE を参照）。
============================================================ */
(function(){
  const CFG=window.FX_CFG; if(!CFG||typeof THREE==='undefined'||typeof scene==='undefined') return;

  /* ---------- 空ドーム ---------- */
  const sky=(function(){
    const geo=new THREE.SphereGeometry(CFG.skyR||350, 32, 16);
    const mat=new THREE.ShaderMaterial({
      side:THREE.BackSide, depthWrite:false, fog:false,
      uniforms:{ top:{value:new THREE.Color(0x5c8fd6)}, mid:{value:new THREE.Color(0xa9cbee)}, bot:{value:new THREE.Color(0xe3eef8)} },
      vertexShader:'varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader:'uniform vec3 top,mid,bot; varying vec3 vP; void main(){ float h=clamp(vP.y,0.0,1.0); vec3 c=h<0.18? mix(bot,mid,h/0.18) : mix(mid,top,(h-0.18)/0.82); gl_FragColor=vec4(c,1.0); }'
    });
    const m=new THREE.Mesh(geo,mat); m.renderOrder=-10; m.frustumCulled=false;
    scene.add(m); return m;
  })();
  // 夜間シナリオ（背景が暗い）ではドームを消して既存の夜空を見せる
  function syncSky(){
    const bg=scene.background;
    const dark=bg&&bg.isColor&&(bg.r+bg.g+bg.b)<0.6;
    sky.visible=!dark;
    // ドーム内側にカメラを置くため、カメラ位置に追従させる
    if(typeof camera!=='undefined') sky.position.copy(camera.position);
  }

  /* ---------- 吹き流し ---------- */
  const sock=new THREE.Group();
  (function build(){
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,2.6,8), new THREE.MeshLambertMaterial({color:0xd9dde3}));
    pole.position.y=1.3; sock.add(pole);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(0.16,0.02,6,16), new THREE.MeshLambertMaterial({color:0x444a55}));
    ring.position.y=2.6; ring.rotation.y=Math.PI/2; sock.add(ring);
    // 円錐（オレンジ／白の縞を2段で表現）・先端が風下（+x）を向く
    const cone=new THREE.Group(); cone.position.y=2.6;
    const seg1=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.12,0.45,10,1,true), new THREE.MeshLambertMaterial({color:0xff7a1a,side:THREE.DoubleSide}));
    const seg2=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.085,0.45,10,1,true), new THREE.MeshLambertMaterial({color:0xf4f4f4,side:THREE.DoubleSide}));
    const seg3=new THREE.Mesh(new THREE.CylinderGeometry(0.085,0.05,0.4,10,1,true), new THREE.MeshLambertMaterial({color:0xff7a1a,side:THREE.DoubleSide}));
    [seg1,seg2,seg3].forEach((s,i)=>{ s.rotation.z=-Math.PI/2; s.position.x=0.225+i*0.44; cone.add(s); });
    sock.add(cone); sock.userData.cone=cone;
    const lab=(function(){ // ラベル（キャンバス）
      const c=document.createElement('canvas'); c.width=256; c.height=64; const g=c.getContext('2d');
      g.fillStyle='rgba(255,255,255,.85)'; g.fillRect(0,8,256,48);
      g.fillStyle='#2b5d8a'; g.font='bold 30px Meiryo,sans-serif'; g.textAlign='center'; g.textBaseline='middle';
      g.fillText('風向（吹き流し）',128,32);
      const tex=new THREE.CanvasTexture(c); tex.minFilter=THREE.LinearFilter;
      const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true}));
      sp.scale.set(3.2,0.8,1); sp.position.y=3.5; return sp;
    })();
    sock.add(lab);
    sock.visible=false; scene.add(sock);
  })();
  let sockKey=null, sockDir=0;
  function syncSock(now){
    const w=CFG.wind?CFG.wind():null;
    const key=w?w.join(','):'none';
    if(key!==sockKey){
      sockKey=key;
      if(!w){ sock.visible=false; return; }
      sock.visible=true; sock.position.set(w[0],0,w[1]); sock.scale.setScalar(w[2]||1); sockDir=w[3]||0;
    }
    if(!sock.visible) return;
    const s=now/1000;
    sock.rotation.y=sockDir+Math.sin(s*1.3)*0.10+Math.sin(s*3.1)*0.04;   // 風向のゆらぎ
    const cone=sock.userData.cone;
    cone.rotation.z=-0.28+Math.sin(s*2.2)*0.07;                          // 2〜3m/sなら軽く垂れる
  }

  /* ---------- 砂煙 ---------- */
  const DUST_N=28;
  const dustTex=(function(){
    const c=document.createElement('canvas'); c.width=c.height=64; const g=c.getContext('2d');
    const gr=g.createRadialGradient(32,32,2,32,32,30);
    gr.addColorStop(0,'rgba(196,178,140,0.55)'); gr.addColorStop(0.6,'rgba(196,178,140,0.22)'); gr.addColorStop(1,'rgba(196,178,140,0)');
    g.fillStyle=gr; g.fillRect(0,0,64,64);
    const t=new THREE.CanvasTexture(c); t.minFilter=THREE.LinearFilter; return t;
  })();
  const dust=[];
  for(let i=0;i<DUST_N;i++){
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:dustTex,transparent:true,opacity:0,depthWrite:false}));
    sp.visible=false; scene.add(sp); dust.push({sp,age:0,life:1,s0:1,vx:0,vz:0});
  }
  let nextDust=0, lastSpawn=0;
  function spawn(px,pz,sc,spread,drift){
    const d=dust[nextDust]; nextDust=(nextDust+1)%DUST_N;
    d.age=0; d.life=0.7+Math.random()*0.5; d.s0=sc*(0.25+Math.random()*0.2);
    d.vx=(Math.random()-0.5)*spread+drift[0]; d.vz=(Math.random()-0.5)*spread+drift[1];
    d.sp.position.set(px+(Math.random()-0.5)*sc*0.4, 0.05*sc, pz+(Math.random()-0.5)*sc*0.4);
    d.sp.visible=true;
  }
  function syncDust(dt,now){
    const seg=CFG.seg?CFG.seg():null;
    const p=CFG.pos?CFG.pos():null;
    const sc=CFG.scale?CFG.scale():1;
    if(seg&&p&&typeof playing!=='undefined'&&playing){
      const near=p.y<1.1*sc;
      let emit=false, spread=0.6*sc, drift=[0,0];
      if((seg.t==='takeoff'||seg.t==='land')&&near) emit=true;
      if(seg.t==='roll'){ emit=true; spread=0.35*sc; drift=[-(0.9*sc),0]; }   // 滑走：後方へ流す
      if(emit && now-lastSpawn>45){ lastSpawn=now; spawn(p.x,p.z,sc,spread,drift); if(seg.t!=='roll') spawn(p.x,p.z,sc,spread,drift); }
    }
    for(const d of dust){
      if(!d.sp.visible) continue;
      d.age+=dt; const u=d.age/d.life;
      if(u>=1){ d.sp.visible=false; continue; }
      const s=d.s0*(1+u*2.2);
      d.sp.scale.set(s,s*0.7,1);
      d.sp.position.x+=d.vx*dt; d.sp.position.z+=d.vz*dt; d.sp.position.y+=0.25*sc*dt;
      d.sp.material.opacity=0.55*(1-u)*(1-u);
    }
  }

  /* ---------- ループ ---------- */
  let prev=performance.now();
  (function fx(now){
    requestAnimationFrame(fx);
    const dt=Math.min(0.05,(now-prev)/1000); prev=now;
    syncSky(); syncSock(now); syncDust(dt,now);
  })(performance.now());
})();
