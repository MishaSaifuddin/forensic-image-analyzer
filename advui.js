'use strict';
/* ============================================================
   ForenScope — advanced-tool UI glue, scores dashboard,
   sample image generator. Bridges analysis.js to the stage.
   ============================================================ */

S.adv = {};            // tool results: {title, lines[], canvas}
S.hashes = null;
S.scores = null;
let ADV_BUSY = false;

const ADV = {
  handles(t){ return !!ADV_RENDER[t]; },
  async render(t){
    if (!S.img || ADV_BUSY) return;
    if (t === 'quant' && !(S.meta && S.meta.dqt && S.meta.dqt.length)){ toast('Quantization tables need a JPEG.'); return; }
    ADV_BUSY = true;
    $('#stage').style.cursor = 'progress';
    try{ await ADV_RENDER[t](); computeScores(); }
    catch(e){ console.error(e); toast(t + ' failed: ' + e.message); }
    finally{ ADV_BUSY = false; $('#stage').style.cursor = ''; }
  },
  async autorun(){
    if (!S.img) return;
    for (const t of ['stego', 'resamp', 'freq', 'deepfake', 'prnu']){
      try{ await ADV.render(t); }catch(e){}
    }
  }
};

/* ---------------- small helpers ---------------- */
function prepImg(maxDim){ return downscaleImage({ data:S.data.data, width:S.w, height:S.h }, maxDim); }
function blitView(cv){
  const c = S.viewCtx;
  c.imageSmoothingEnabled = true;
  c.drawImage(cv, 0, 0, S.w, S.h);
  c.imageSmoothingEnabled = false;
}
function finish(tool, title, canvas, lines){
  S.adv[tool] = { title, lines, canvas };
  blitView(canvas);
  updateStatusHeader();
}
function grayToCanvas(g, w, h, gain = 1){
  const cv = mkCanvas(w, h), cx = ctx2d(cv);
  const id = cx.createImageData(w, h), o = id.data;
  for (let p = 0, i = 0; p < g.length; p++, i += 4){
    let v = Math.abs(g[p]) * gain;
    o[i] = o[i+1] = o[i+2] = v > 255 ? 255 : v;
    o[i+3] = 255;
  }
  cx.putImageData(id, 0, 0);
  return cv;
}
function heatRGB(v){ // 0..1 blue→cyan→green→yellow→red
  v = clamp01(v);
  const stops = [[0,[30,60,190]],[.25,[40,180,220]],[.5,[60,200,90]],[.75,[250,200,40]],[1,[230,45,35]]];
  for (let k = 1; k < stops.length; k++){
    if (v <= stops[k][0]){
      const [p0,c0]=stops[k-1],[p1,c1]=stops[k], t=(v-p0)/(p1-p0);
      return c0.map((a,i)=>Math.round(a+(c1[i]-a)*t));
    }
  }
  return [230,45,35];
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/* ================= JPEG GHOST ================= */
const ADV_RENDER = {};
ADV_RENDER.ghost = async function(){
  toast('JPEG Ghost \u2014 re-encoding at 12 quality levels\u2026');
  const ds = prepImg(900);
  const srcCv = mkCanvas(ds.width, ds.height);
  ctx2d(srcCv).putImageData(new ImageData(new Uint8ClampedArray(ds.data), ds.width, ds.height), 0, 0);
  const base = ds.data;
  const qs = [40,45,50,55,60,65,70,75,80,85,90,95];
  const errMaps = [];
  for (const q of qs){
    const im = await decodeURL(srcCv.toDataURL('image/jpeg', q/100));
    const rc = mkCanvas(ds.width, ds.height);
    const rx = ctx2d(rc);
    rx.drawImage(im, 0, 0);
    const rd = rx.getImageData(0, 0, ds.width, ds.height).data;
    const e = new Float32Array(ds.width * ds.height);
    for (let p = 0, i = 0; p < e.length; p++, i += 4)
      e[p] = (Math.abs(base[i]-rd[i]) + Math.abs(base[i+1]-rd[i+1]) + Math.abs(base[i+2]-rd[i+2])) / 3;
    errMaps.push(e);
  }
  const res = jpegGhostAnalyse(errMaps, qs, 10);

  /* visualisation: map + legend */
  const W = 720, H = 470, mapW = 620;
  const cv = mkCanvas(W, H), cx = ctx2d(cv);
  const id = cx.createImageData(mapW, H), o = id.data;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < mapW; x++){
      const sx = (x / mapW * ds.width)|0, sy = (y / H * ds.height)|0;
      const p = sy * ds.width + sx, i = (y * mapW + x) * 4;
      if (res.minErr[p] <= 10){
        const rgb = heatRGB(1 - res.bestQ[p] / (qs.length - 1));
        o[i]=rgb[0]; o[i+1]=rgb[1]; o[i+2]=rgb[2];
      } else { o[i]=o[i+1]=o[i+2]=16; }
      o[i+3]=255;
    }
  cx.putImageData(id, 0, 0);
  /* legend */
  cx.fillStyle = '#10141a'; cx.fillRect(mapW, 0, W-mapW, H);
  for (let y = 0; y < 300; y++){
    const q = 1 - y/300;
    const rgb = heatRGB(q);
    cx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    cx.fillRect(mapW+24, 60+y, 22, 1);
  }
  cx.fillStyle = '#8a94a3'; cx.font = '11px monospace';
  cx.fillText('q95', mapW+52, 68); cx.fillText('q40', mapW+52, 366);
  const maxShare = Math.max(...res.histPct, 1);
  res.histPct.forEach((pc, i) => {
    const bh = pc / maxShare * 80;
    cx.fillStyle = '#35c4dc';
    cx.fillRect(mapW+18+i*8, 430-bh, 6, bh);
  });
  cx.fillText('share % per q', mapW+14, 446);

  const ranked = qs.map((q,i)=>({q,p:res.histPct[i]})).sort((a,b)=>b.p-a.p);
  const second = ranked[1];
  const lines = [
    `Ghosted pixels (err \u2264 10): ${(res.ghostedShare*100).toFixed(1)}% of image`,
    `Best-match shares: q${ranked[0].q} ${ranked[0].p}% \u00b7 q${second.q} ${second.p}% \u00b7 q${ranked[2].q} ${ranked[2].p}%`,
    second.p >= 12
      ? `\u26a0 Secondary cluster at quality ~${second.q} suggests regions saved in an earlier editing cycle.`
      : '\u2713 Single dominant quality \u2014 no obvious multi-cycle compression history.'
  ];
  S.advScoreGhost = second.p >= 12 ? Math.min(1, second.p/40) : 0;
  finish('ghost', 'JPEG Ghost map', cv, lines);
};

/* ================= COPY-MOVE ================= */
ADV_RENDER.cmfd = function(){
  const img = prepImg(400);
  const g = grayFrom(img.data, img.width, img.height);
  const dist = +($('#cmfdSim')?.value || 12);
  const minVotes = +($('#cmfdMin')?.value || 60);
  toast('Copy-Move scan running\u2026');
  const r = copyMoveDetect(g, img.width, img.height, { dist, minVotes });

  const cv = mkCanvas(img.width, img.height), cx = ctx2d(cv);
  const id = cx.createImageData(img.width, img.height), o = id.data;
  const dim = 0.35;
  for (let p = 0, i = 0; p < g.length; p++, i += 4){
    const v = g[p]*dim+20;
    o[i]=o[i+1]=o[i+2]=v; o[i+3]=255;
  }
  /* paint mask clusters */
  const colors=[[255,72,72],[64,156,255],[255,170,40]];
  r.clusters.forEach((c,k)=>{
    const col=colors[k%colors.length];
    for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){
      if(!r.mask[y*img.width+x])continue;
      const i=(y*img.width+x)*4;
      o[i]=col[0];o[i+1]=col[1];o[i+2]=col[2];
    }
  });
  cx.putImageData(id,0,0);

  const lines=[
    `Blocks examined: ${r.examined.toLocaleString()} \u00b7 candidate pairs: ${r.pairCount.toLocaleString()}`,
    r.flagged
      ? `\u26a0 ${r.clusters.length} consistent-offset cluster(s): ` +
        r.clusters.map(c=>`(${c.offset}) px\u00d7${c.votes}`).join('  ')
      : '\u2713 No offset-consistent duplicated regions above threshold.'
  ];
  S.advScoreCmfd=r.flagged?Math.min(1,r.clusters.length/3):0;
  finish('cmfd','Copy-Move forgery map',cv,lines);
};

/* ================= PRNU ================= */
ADV_RENDER.prnu = function(){
  const img={data:S.data.data,width:S.w,height:S.h};
  const r=prnuAnalyse(img);
  const C=r.cells;
  const cv=mkCanvas(C*56,C*56),cx=ctx2d(cv);
  for(let cy=0;cy<C;cy++)for(let cx2=0;cx2<C;cx2++){
    const v=(r.heat[cy*C+cx2]+1)/2;
    const rgb=heatRGB(v);
    cx.fillStyle=`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    cx.fillRect(cx2*56,cy*56,54,54);
    if(r.heat[cy*C+cx2]<r.global-0.45){
      cx.strokeStyle='#ff5555';cx.lineWidth=3;cx.strokeRect(cx2*56+1,cy*56+1,52,52);
    }
  }
  const lines=[
    `Global neighbour-cell residual correlation: ${r.global}`,
    `Weakest cell (${r.worst.cx},${r.worst.cy}): ${r.worst.val} ${r.worst.val<r.global-0.45?'\u26a0 outlier':'\u2713 within range'}`,
    r.inconsistent?'\u26a0 Inconsistent sensor-noise pattern \u2014 possible splice region or mixed sources.'
                  :'\u2713 Sensor noise pattern reasonably uniform.',
    '(Reliable mainly on lightly-compressed originals.)'
  ];
  S.advScorePrnu=r.inconsistent?0.8:(Math.max(0,(0.25-r.global))*2);
  finish('prnu','PRNU consistency heatmap',cv,lines);
};

/* ================= FREQUENCY ================= */
ADV_RENDER.freq = function(){
  const img=prepImg(600);
  const g=grayFrom(img.data,img.width,img.height);
  const m=freqMetrics(g,img.width,img.height);
  const cv=mkCanvas(544,280),cx=ctx2d(cv);
  cx.fillStyle='#000';cx.fillRect(0,0,256,256);
  let mx=0;for(let i=0;i<m.spectrum.length;i++)mx=Math.max(mx,m.spectrum[i]);
  const id=cx.createImageData(256,256),o=id.data;
  for(let i=0,p=0;i<m.spectrum.length;i++,p+=4){
    const v=Math.min(255,m.spectrum[i]/mx*300);
    o[p]=o[p+1]=o[p+2]=v;o[p+3]=255;
  }
  cx.putImageData(id,0,0);
  /* radial profile plot */
  const prof=radialProfile(m.spectrum,m.n);
  cx.fillStyle='#10141a';cx.fillRect(270,0,274,256);
  cx.strokeStyle='#35c4dc';cx.beginPath();
  const pMax=Math.max(...prof.slice(2));
  for(let r=2;r<128;r++){
    const X=270+(r-2)/126*264,Y=250-prof[r]/pMax*235;
    r===2?cx.moveTo(X,Y):cx.lineTo(X,Y);
  }
  cx.stroke();
  m.peaks.forEach(pk=>{
    const X=270+(pk.r-2)/126*264,Y=250-prof[pk.r]/pMax*235;
    cx.fillStyle='#ff6b6b';cx.beginPath();cx.arc(X,Y,3,0,7);cx.fill();
  });
  cx.fillStyle='#8a94a3';cx.font='10px monospace';cx.fillText('radial energy profile',276,12);

  const lines=[
    `Power-law slope: ${m.slope} (natural photos \u2248 -1.6 \u2026 -2.2)`,
    `High-freq / low-freq ratio: ${m.hfRatio}`,
    m.peaks.length?`Periodic peaks at radii: ${m.peaks.map(p=>'r'+p.r+' (\u03c3'+p.z+')').join(', ')}`:'No significant periodic spectral peaks',
    m.anomalous?'\u26a0 Anomalous spectral structure \u2014 check for synthetic patterns/upsampling.':'\u2713 Spectrum consistent with natural imagery.'
  ];
  S.advScoreFreq=m.anomalous?0.5:(m.peaks.length?0.25:0);
  finish('freq','FFT spectrum & radial profile',cv,lines);
};

/* ================= DEEPFAKE HEURISTICS ================= */
ADV_RENDER.deepfake = function(){
  const r=deepfakeHeuristics({data:S.data.data,width:S.w,height:S.h});
  /* compose overview with crop rect + crop spectrum */
  const ov=toReportCanvas(S.src,420);
  const spec=256;
  const cv=mkCanvas(ov.width+spec+16,Math.max(ov.height,spec)),cx=ctx2d(cv);
  cx.drawImage(ov,0,0);
  cx.strokeStyle='#ffb454';cx.lineWidth=2;
  const sx=ov.width/S.w,sy=ov.height/S.h;
  cx.strokeRect(r.cropRect.x*sx,r.cropRect.y*sy,r.cropRect.w*sx,r.cropRect.h*sy);
  let mx=0;for(let i=0;i<r.spectrum.length;i++)mx=Math.max(mx,r.spectrum[i]);
  const ox=ov.width+16,id=cx.createImageData(spec,spec),o=id.data;
  for(let i=0,p=0;i<r.spectrum.length;i++,p+=4){
    const v=Math.min(255,r.spectrum[i]/mx*300);
    o[p]=v*0.55;o[p+1]=v*0.85;o[p+2]=v;o[p+3]=255;
  }
  cx.fillStyle='#000';cx.fillRect(ox,0,spec,spec);
  cx.putImageData(id,ox,0);
  cx.fillStyle='#8a94a3';cx.font='10px monospace';cx.fillText('center-crop spectrum',ox+4,12);

  const band=r.aiScore>=65?'HIGH AI-likeness':r.aiScore>=50?'borderline':r.aiScore>=35?'likely natural':'natural-looking';
  const lines=[
    `AI-artifact heuristic score: ${r.aiScore}/100 (${band})`,
    `Spectral slope ${r.slope} \u00b7 angular anisotropy ${r.aniso} \u00b7 chroma/luma HF ratio ${r.chromaRatio}`,
    '\u26a0 Heuristic screening only \u2014 not a neural detector. High scores warrant closer review, not conclusions.'
  ];
  S.advScoreAi=Math.max(0,(r.aiScore-50))/50;
  finish('deepfake','Deepfake / AI-artifact heuristics',cv,lines);
};

/* ================= RESAMPLING ================= */
ADV_RENDER.resamp = function(){
  const img=prepImg(600);
  const r=resamplingDetect(img);
  const lapVis=grayToCanvas(r.laps,r.w,r.h,9);
  /* AC curves panel */
  const cv=mkCanvas(Math.max(lapVis.width,560),lapVis.height+120),cx=ctx2d(cv);
  cx.drawImage(lapVis,0,0);
  const py=lapVis.height+8;
  cx.fillStyle='#10141a';cx.fillRect(0,py,cv.width,112);
  [['H','#35c4dc',r.H],['V','#ffb454',r.V]].forEach(([lbl,col,A],k)=>{
    cx.strokeStyle=col;cx.beginPath();
    const maxX=Math.min(A.ac.length,121);
    for(let lag=1;lag<maxX;lag++){
      const X=10+(lag-1)/(maxX-2)*(cv.width/2-30)+(k*(cv.width/2));
      const Y=py+96-Math.max(-3,Math.min(6,A.ac[lag]))/9*88;
      lag===1?cx.moveTo(X,Y):cx.lineTo(X,Y);
    }
    cx.stroke();
    cx.fillStyle='#8a94a3';cx.font='10px monospace';
    cx.fillText(`rows ${lbl==='H'?'(horizontal)':'(vertical)'}: peak lag ${A.lag}, prominence \u03c3=${A.prominence}`,10+k*(cv.width/2),py+108);
  });

  const lines=[
    `Horizontal: lag ${r.H.lag}, prominence \u03c3=${r.H.prominence} \u00b7 Vertical: lag ${r.V.lag}, prominence \u03c3=${r.V.prominence}`,
    r.periodic?'\u26a0 Periodic interpolation signature detected \u2014 image was likely resized/resampled.'
              :'\u2713 No periodic resampling signature above threshold.',
    '(Lags 7-9 excluded to avoid confusing the JPEG 8px grid with resizing.)'
  ];
  S.advScoreResamp=r.periodic?0.8:0;
  finish('resamp','Resampling detection (|Laplacian|)',cv,lines);
};

/* ================= STEGO CHI-SQUARE ================= */
ADV_RENDER.stego = function(){
  const ch=S.stegoCh??2;
  const r=stegoChi({data:S.data.data,width:S.w,height:S.h},ch);
  const chName=['R','G','B'][ch]||'B';
  /* LSB plane with suspicious-block tint */
  const small=prepImg(700);
  const d=small.data,w2=small.width,h2=small.height;
  const blocks=16,bw=Math.ceil(w2/blocks),bh=Math.ceil(h2/blocks);
  const cv=mkCanvas(w2,h2),cx=ctx2d(cv);
  const id=cx.createImageData(w2,h2),o=id.data;
  for(let p=0,i=0;p<w2*h2;p++,i+=4){
    const on=(d[i*4+ch]>>0)&1;
    o[i]=o[i+1]=o[i+2]=on?230:10;o[i+3]=255;
  }
  cx.putImageData(id,0,0);
  for(let by=0;by<blocks;by++)for(let bx=0;bx<blocks;bx++){
    /* per-block chi p */
    const hist=new Uint32Array(256);
    for(let y=by*bh;y<Math.min((by+1)*bh,h2);y++)
      for(let x=bx*bw;x<Math.min((bx+1)*bw,w2);x++)
        hist[d[(y*w2+x)*4+ch]]++;
    let x2=0;
    for(let v=0;v<256;v+=2){const s=hist[v]+hist[v+1];if(s)x2+=(hist[v]-hist[v+1])**2/s;}
    const p=chiSqP(x2,127);
    if(p>0.5){cx.fillStyle=`rgba(255,60,60,${Math.min(.85,(p-.5)*1.6)})`;cx.fillRect(bx*bw,by*bh,bw,bh);}
  }
  const lines=[
    `Channel ${chName}: sequential chi-square p-values across ${r.ps.length} chunks`,
    `Suspect chunks (p>0.5): ${Math.round(r.suspectFrac*100)}% \u2014 verdict: ${r.verdict}`,
    r.suspectFrac>=0.6?'\u26a0 Pattern consistent with LSB embedding (hidden data possible).'
                      :'\u2713 LSB distribution looks natural.',
    'Red tint on the stage marks locally suspect 16th-blocks over the LSB plane.'
  ];
  S.advScoreStego=r.suspectFrac>=0.6?0.85:r.suspectFrac>=0.35?0.4:0;
  S.stegoResult=r;
  finish('stego','LSB steganalysis (chi-square)',cv,lines);
};

/* ================= QUANTIZATION ANALYSIS ================= */
ADV_RENDER.quant = function(){
  const a=quantAnalyse(S.meta.dqt);
  if(!a)return;
  const cell=13,gw=cell*8,pad=86;
  const cv=mkCanvas(pad*3+gw*3,210),cx=ctx2d(cv);
  const drawGrid=(x0,label,tab,ref)=>{
    cx.fillStyle='#d7dde6';cx.font='11px monospace';
    cx.fillText(label,x0,14);
    for(let i=0;i<64;i++){
      const gx=x0+(i%8)*cell,gy=22+(i>>3)*cell;
      const v=clamp01(tab[i]/128);
      const rgb=heatRGB(v);
      cx.fillStyle=`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      cx.fillRect(gx,gy,cell-1,cell-1);
      if(ref&&tab[i]!==ref[i]){cx.strokeStyle='#fff';cx.lineWidth=.5;cx.strokeRect(gx+.5,gy+.5,cell-2,cell-2);}
    }
  };
  const actual=S.meta.dqt[0].v.slice(0,64);
  const ref=scaledTable(IJG_LUMA,a.lumaQ);
  const chroma=S.meta.dqt.length>1?S.meta.dqt[1].v.slice(0,64):null;
  drawGrid(pad,'luma (file)',actual,null);
  drawGrid(pad+gw+pad/2,`IJG std @ est.q${a.lumaQ}`,ref,null);
  if(chroma)drawGrid(pad+(gw+pad/2)*2,'chroma (file)',chroma,null);

  const subs=(S.meta.sof&&S.meta.sof.comps&&S.meta.sof.comps.some(c=>c.h!==1||c.v!==1))?'4:2:0/4:2:2 detected':'4:4:4 (none)';
  const lines=[
    `Estimated encoder quality: luma \u2248 ${a.lumaQ}${a.chromaQ!=null?` \u00b7 chroma \u2248 ${a.chromaQ}`:''}`,
    a.stdMatch?'\u2713 Tables match the standard IJG curve exactly \u2014 typical single save.'
              :`\u2139 Tables deviate from IJG standard (custom editor or re-encode).`,
    a.doubleHint?'\u26a0 Luma/chroma quality estimates diverge strongly \u2014 possible double compression.':"",
    `Chroma subsampling: ${subs}`
  ].filter(Boolean);
  S.advScoreQuant=a.doubleHint?0.35:0;
  finish('quant','Quantization table analysis',cv,lines);
};

/* ================= TAMPER DETECTION ================= */
ADV_RENDER.tamper = async function(){
  toast('Running tamper detection scan\u2026');
  const ds = prepImg(800);
  const blk = +($('#tamperBlk')?.value || 16);
  const sensBtn = $('#tamperSensSel button.on');
  const sens = sensBtn ? sensBtn.dataset.s : 'med';
  const opacity = (+($('#tamperOp')?.value || 75)) / 100;
  const showContours = $('#tamperContours')?.checked !== false;

  const r = tamperDetect({data:ds.data, width:ds.width, height:ds.height}, {blk, sensitivity:sens});

  const W = ds.width, H = ds.height;
  const cv = mkCanvas(W, H), cx = ctx2d(cv);

  /* draw dimmed original */
  const tmpCv = mkCanvas(W, H);
  const tmpCx = ctx2d(tmpCv);
  tmpCx.putImageData(new ImageData(new Uint8ClampedArray(ds.data), W, H), 0, 0);
  cx.globalAlpha = 0.45;
  cx.drawImage(tmpCv, 0, 0);
  cx.globalAlpha = 1;

  /* draw heatmap */
  const id = cx.createImageData(W, H), o = id.data;
  for (let p = 0, i = 0; p < W*H; p++, i += 4){
    const v = clamp01(r.heatmap[p]);
    const rgb = heatRGB(v);
    o[i] = rgb[0]; o[i+1] = rgb[1]; o[i+2] = rgb[2];
    o[i+3] = v > 0.01 ? Math.round(opacity * 255) : 0;
  }
  cx.putImageData(id, 0, 0);

  /* contour outlines */
  if (showContours){
    cx.strokeStyle = 'rgba(255,80,80,0.8)';
    cx.lineWidth = 1.5;
    r.regions.slice(0, 20).forEach((reg, idx) => {
      cx.strokeRect(reg.x, reg.y, reg.w, reg.h);
      cx.fillStyle = 'rgba(255,80,80,0.9)';
      cx.font = 'bold 10px monospace';
      const lbl = `#${idx+1}`;
      cx.fillText(lbl, reg.x + 2, reg.y - 3 > 10 ? reg.y - 3 : reg.y + 12);
    });
  }

  /* legend */
  const legW = 180, legH = 220;
  const legCv = mkCanvas(legW, legH), legCx = ctx2d(legCv);
  legCx.fillStyle = 'rgba(15,19,26,0.92)';
  legCx.fillRect(0, 0, legW, legH);
  legCx.fillStyle = '#d7dde6';
  legCx.font = 'bold 10px monospace';
  legCx.fillText('TAMPER HEATMAP', 8, 16);

  for (let y = 0; y < 140; y++){
    const v = 1 - y / 140;
    const rgb = heatRGB(v);
    legCx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    legCx.fillRect(12, 26 + y, 16, 1);
  }
  legCx.fillStyle = '#8a94a3';
  legCx.font = '9px monospace';
  legCx.fillText('high', 34, 34);
  legCx.fillText('low', 34, 162);
  legCx.fillText('safe', 34, 174);

  legCx.fillStyle = '#d7dde6';
  legCx.font = '10px monospace';
  legCx.fillText(`Flagged: ${r.flaggedPct}%`, 12, 194);
  legCx.fillText(`Regions: ${r.regions.length}`, 12, 208);

  const fullCv = mkCanvas(W + legW + 8, Math.max(H, legH));
  const fullCx = ctx2d(fullCv);
  fullCx.drawImage(cv, 0, 0);
  fullCx.drawImage(legCv, W + 8, 0);

  const lines = [
    `Block size: ${blk}px \u00b7 Sensitivity: ${sens}`,
    `Flagged area: ${r.flaggedPct}% of image \u00b7 Suspicious regions: ${r.regions.length}`,
  ];
  if (r.regions.length > 0){
    const top3 = r.regions.slice(0, 3).map((reg, i) =>
      `  Region #${i+1}: ${reg.w}\u00d7${reg.h}px at (${reg.x},${reg.y}), avg confidence ${reg.avgConf}`
    );
    lines.push('Top suspicious regions:');
    lines.push(...top3);
  }
  lines.push(
    r.flagged
      ? '\u26a0 Multiple anomalous regions detected \u2014 strong tamper indicators. Inspect with ELA and Noise tools.'
      : '\u2713 No significant tamper indicators above threshold.'
  );

  S.advScoreTamper = r.flaggedPct > 20 ? 0.85 : r.flaggedPct > 10 ? 0.5 : r.flaggedPct > 3 ? 0.25 : 0;
  finish('tamper', 'Tamper Detection (composite heatmap)', fullCv, lines);
};

/* ================= SCORES DASHBOARD ================= */
function computeScores(){
  if (!S.img) return;
  const comps = [];
  const add = (name, v, note) => comps.push({ name, risk: v, note: note || '' });

  const meta = S.meta || {};
  const findings = meta.findings || [];
  const warnCount = findings.filter(f => f[0] === 'warn').length;

  add('Metadata integrity',
      warnCount >= 2 ? .7 : warnCount === 1 ? .4 : 0,
      warnCount ? `${warnCount} metadata warning(s)` : 'no warnings');

  if (S.advScoreGhost != null) add('JPEG ghost clusters', S.advScoreGhost, 'multi-quality history');
  if (S.advScoreCmfd   != null) add('Copy-move regions', S.advScoreCmfd, 'duplicated patches');
  if (S.advScorePrnu   != null) add('PRNU consistency',  S.advScorePrnu, 'sensor-noise uniformity');
  if (S.advScoreFreq   != null) add('Frequency anomalies', S.advScoreFreq, 'FFT structure');
  if (S.advScoreAi     != null) add('AI-artifact heuristics', S.advScoreAi, 'screening only');
  if (S.advScoreResamp != null) add('Resampling traces', S.advScoreResamp, 'interpolation signature');
  if (S.advScoreStego  != null) add('LSB steganalysis', S.advScoreStego, 'chi-square');
  if (S.advScoreQuant  != null) add('Quantization anomalies', S.advScoreQuant, 'DQT vs IJG');
  if (S.advScoreTamper != null) add('Tamper detection', S.advScoreTamper, 'composite heatmap');

  /* ELA surface-brightness spread as a weak component */
  if (S.resave){
    try{
      const a = S.data.data, b = ctx2d(S.resave).getImageData(0,0,S.w,S.h).data;
      let sum = 0, sum2 = 0, n = 0, step = Math.max(4, ((a.length/4/60000)|0)*4);
      for (let i = 0; i < a.length; i += step*4){
        const d = (Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2])) / 3 * S.elaAmp;
        sum += d; sum2 += d*d; n++;
      }
      const mean = sum/n, sd = Math.sqrt(Math.max(0, sum2/n - mean*mean));
      const cvv = mean > 1 ? sd/mean : 0;
      add('ELA response variance', clamp01((cvv-0.6)/2.2), `CV=${cvv.toFixed(2)}`);
    }catch(e){}
  }

  S.scores = aggregateScore(comps);
  updateScoreTab();
}

async function ensureHashes(){
  if (S.hashes) return S.hashes;
  const bytes = new Uint8Array(S.bytes);
  const small = prepImg(64);
  const sg = grayFrom(small.data, small.width, small.height);
  const h = {
    md5: md5(bytes),
    ahash: hex64(ahash64(sg, small.width, small.height)),
    dhash: hex64(dhash64(sg, small.width, small.height))
  };
  try{
    const [s256, s1] = await Promise.all([
      crypto.subtle.digest('SHA-256', bytes),
      crypto.subtle.digest('SHA-1', bytes)
    ]);
    const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
    h.sha256 = toHex(s256); h.sha1 = toHex(s1);
  }catch(e){}
  S.hashes = h;
  return h;
}

function updateScoreTab(){
  const list = $('#scoreList');
  if (!list) return;
  if (!S.img){ list.innerHTML = '<p class="hint">Load an image \u2014 light analyses run automatically.</p>'; return; }
  const sc = S.scores || aggregateScore([]);
  drawGauge($('#gaugeCv'), sc.score);
  $('#scoreVerdict').textContent = `${sc.score}/100 \u00b7 ${sc.risk}`;

  const rows = (sc.rows || []).map(r =>
    `<div class="scorerow"><span class="dot ${riskClass(r.risk)}"></span>` +
    `<span class="sc-name">${esc(r.name)}</span>` +
    `<span class="sc-note">${esc(r.note||'')}</span></div>`);
  list.innerHTML = rows.join('') ||
    '<p class="hint">Advanced analyses still running\u2026</p>';

  ensureHashes().then(h => {
    const el = $('#hashList');
    if (!el) return;
    el.innerHTML =
      hashRow('MD5', h.md5) + hashRow('SHA-256', h.sha256) + hashRow('SHA-1', h.sha1) +
      hashRow('aHash', h.ahash) + hashRow('dHash', h.dhash);
  }).catch(()=>{});
}
const riskClass = r => r >= .55 ? 'red' : r >= .25 ? 'amber' : 'green';
const hashRow = (k, v) => v
  ? `<div class="hashrow"><span>${k}</span><code title="${esc(v)}">${esc(v.slice(0,32))}${v.length>32?'\u2026':''}</code><button class="copybtn" data-copy="${esc(v)}">copy</button></div>`
  : '';
function drawGauge(cv, score){
  if (!cv) return;
  cv.width = 260; cv.height = 150;
  const c = cv.getContext('2d');
  const cx = 130, cy = 128, R = 100;
  const zones = [[0,.45,'#57c26a'],[.45,.65,'#e8c34a'],[.65,.82,'#ef9440'],[.82,1,'#e0483c']];
  zones.forEach(([a,b,col])=>{
    c.beginPath();
    c.strokeStyle = col; c.lineWidth = 16; c.lineCap='butt';
    c.arc(cx, cy, R, Math.PI + a*Math.PI, Math.PI + b*Math.PI);
    c.stroke();
  });
  const ang = Math.PI + clamp01(score/100)*Math.PI;
  c.beginPath();
  c.strokeStyle = '#f2f5fa'; c.lineWidth = 3; c.lineCap='round';
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(ang)*(R-22), cy + Math.sin(ang)*(R-22));
  c.stroke();
  c.beginPath(); c.fillStyle='#f2f5fa'; c.arc(cx, cy, 5, 0, 7); c.fill();
  c.fillStyle = '#f2f5fa'; c.font = 'bold 30px monospace'; c.textAlign = 'center';
  c.fillText(String(score|0), cx, cy - 18);
}

/* ================= SAMPLE IMAGE GENERATOR ================= */
async function loadSampleImage(){
  const W = 1080, H = 720;
  const c = mkCanvas(W, H), x = ctx2d(c);
  const sky = x.createLinearGradient(0,0,0,H*0.62);
  sky.addColorStop(0,'#274a73'); sky.addColorStop(1,'#a8c4dd');
  x.fillStyle = sky; x.fillRect(0,0,W,H*.62);
  x.fillStyle = '#f4e9c8'; x.beginPath(); x.arc(W*.78,H*.2,46,0,7); x.fill();
  x.fillStyle = '#3d5875';
  x.beginPath(); x.moveTo(0,H*.62); x.lineTo(W*.24,H*.28); x.lineTo(W*.46,H*.62); x.closePath(); x.fill();
  x.fillStyle = '#2e4661';
  x.beginPath(); x.moveTo(W*.34,H*.62); x.lineTo(W*.60,H*.36); x.lineTo(W*.86,H*.62); x.closePath(); x.fill();
  const gr = x.createLinearGradient(0,H*.6,0,H);
  gr.addColorStop(0,'#4d6b3a'); gr.addColorStop(1,'#2f4723');
  x.fillStyle = gr; x.fillRect(0,H*.61,W,H*.39);
  /* house */
  x.fillStyle = '#8a6f52'; x.fillRect(W*.12,H*.68,150,120);
  x.fillStyle = '#5d3f2e';
  x.beginPath(); x.moveTo(W*.12-14,H*.68); x.lineTo(W*.12+75,H*.60); x.lineTo(W*.12+164,H*.68); x.closePath(); x.fill();
  x.fillStyle = '#3a2c1e'; x.fillRect(W*.12+60,H*.72,34,116);
  /* trees */
  const tree = (tx,ty,s)=>{
    x.fillStyle = '#5b4028'; x.fillRect(tx-6*s,ty,12*s,34*s);
    x.fillStyle = '#38602f';
    x.beginPath(); x.arc(tx,ty-14*s,30*s,0,7); x.fill();
    x.beginPath(); x.arc(tx-20*s,ty+6*s,22*s,0,7); x.fill();
    x.beginPath(); x.arc(tx+20*s,ty+6*s,22*s,0,7); x.fill();
  };
  tree(W*.55,H*.80,1.15); tree(W*.70,H*.84,0.85); tree(W*.90,H*.78,1.3);
  /* copy-move patch: clone part of the left bush onto the lawn */
  x.drawImage(c, 700, 520, 190, 95, 380, 596, 190, 95);
  /* subtle brightness-lifted rectangle (ELA-visible spliced region) */
  x.fillStyle = 'rgba(255,255,214,0.07)';
  x.fillRect(700,110,250,170);

  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  loadFile(new File([blob], 'sample_scene.jpg', { type:'image/jpeg' }));
}
