'use strict';
/* ============================================================
   ForenScope — core: state, loading, analysis tools, zoom, magnifier
   Runs 100% locally in the browser. No uploads, no dependencies.
   ============================================================ */

/* ---------------- helpers ---------------- */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });
const decodeURL = url => new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = () => rej(new Error('image could not be decoded'));
  im.src = url;
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const humanSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(2) + ' MB';
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

let toastT;
function toast(msg){
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ---------------- state ---------------- */
const S = {
  img:null, name:'', mime:'', size:0, bytes:null,
  w:0, h:0,
  src:null, srcCtx:null, data:null,   // pristine original canvas + pixels
  view:null, viewCtx:null,            // displayed canvas
  zoom:1, fitMode:true,
  tool:'ela',
  elaQ:0.90, elaAmp:20, elaGray:false,
  gradGain:8, noiseGain:14,
  bitCh:2, bitN:0,
  cache:new Map(),
  resave:null, resaveQ:-1,
  lum:null,
  meta:null, gpsLink:null,
};

function cachePut(key, val){
  if (S.cache.size > 24) S.cache.delete(S.cache.keys().next().value);
  S.cache.set(key, val);
  return val;
}
function cacheInvalidate(prefix){
  for (const k of [...S.cache.keys()]) if (!prefix || k.startsWith(prefix)) S.cache.delete(k);
}

/* ================= image loading ================= */
async function loadFile(file){
  if (!file) return;
  if (!(file.type && file.type.startsWith('image/')) && !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || '')){
    toast('That does not look like an image file.');
    return;
  }
  try{
    const buf = await file.arrayBuffer();
    const url = URL.createObjectURL(file);
    const img = await decodeURL(url);
    URL.revokeObjectURL(url);

    S.img   = img;
    S.name  = file.name || 'clipboard.png';
    S.mime  = file.type || '';
    S.size  = file.size;
    S.bytes = buf;

    setupSource(img);
    S.cache.clear(); S.resave = null; S.resaveQ = -1; S.lum = null; S.gpsLink = null;
    S.adv = {}; S.scores = null; S.hashes = null; S.stegoCh = 2;
    if (S.thumbUrl){ URL.revokeObjectURL(S.thumbUrl); S.thumbUrl = null; }
    Object.keys(S).forEach(k => { if (k.startsWith('advScore')) delete S[k]; });

    $('#drop').classList.add('hidden');
    $$('#tools .tool, .hbtns button').forEach(b => b.disabled = false);

    try { S.meta = analyzeBytes(new DataView(buf)); }
    catch(e){ console.warn('metadata parse failed', e); S.meta = null; }
    renderMetaTab(); renderStructTab(); drawHistogram(); updateStatusHeader();

    if (S.tool === 'ela') await ensureResave();
    setZoomFit();
    renderView();
    if (window.ADV) ADV.autorun();
    toast('Loaded ' + S.w + '\u00d7' + S.h + ' \u00b7 ' + humanSize(S.size));
  }catch(err){
    console.error(err);
    toast('Could not load that image \u2014 ' + err.message);
  }
}

function setupSource(img){
  S.w = img.naturalWidth; S.h = img.naturalHeight;
  if (S.w * S.h > 30e6) toast('Very large image \u2014 analysis may be slow.');

  S.src = mkCanvas(S.w, S.h);
  S.srcCtx = ctx2d(S.src);
  S.srcCtx.fillStyle = '#fff';
  S.srcCtx.fillRect(0, 0, S.w, S.h);        // flatten transparency onto white
  S.srcCtx.drawImage(img, 0, 0);
  S.data = S.srcCtx.getImageData(0, 0, S.w, S.h);

  if (!S.view){
    S.view = document.createElement('canvas');
    S.view.className = 'viewcv';
    $('#stageInner').appendChild(S.view);
    bindViewEvents();
  }
  S.view.width = S.w; S.view.height = S.h;
  S.viewCtx = S.view.getContext('2d');
  hideMag();
}

/* ================= ELA support ================= */
async function ensureResave(){
  if (!S.src) return;
  if (S.resave && S.resaveQ === S.elaQ) return;
  const url = S.src.toDataURL('image/jpeg', S.elaQ);
  const im = await decodeURL(url);
  const c = mkCanvas(S.w, S.h);
  const cx = ctx2d(c);
  cx.drawImage(im, 0, 0);
  S.resave = cx.getImageData(0, 0, S.w, S.h);
  S.resaveQ = S.elaQ;
  cacheInvalidate('ela');
}

/* ================= tool outputs ================= */
function buildELA(){
  const out = new ImageData(S.w, S.h), o = out.data;
  const a = S.data.data, b = (S.resave ? S.resave.data : a);
  const k = S.elaAmp, gray = S.elaGray;
  for (let i = 0; i < a.length; i += 4){
    const r  = Math.abs(a[i]     - b[i])     * k;
    const g  = Math.abs(a[i + 1] - b[i + 1]) * k;
    const bl = Math.abs(a[i + 2] - b[i + 2]) * k;
    if (gray){
      const v = (r + g + bl) / 3;
      o[i] = o[i+1] = o[i+2] = v > 255 ? 255 : v;
    } else {
      o[i]   = r  > 255 ? 255 : r;
      o[i+1] = g  > 255 ? 255 : g;
      o[i+2] = bl > 255 ? 255 : bl;
    }
    o[i+3] = 255;
  }
  return out;
}

function lumArray(){
  if (S.lum) return S.lum;
  const d = S.data.data, n = S.w * S.h;
  const L = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4)
    L[p] = .299*d[i] + .587*d[i+1] + .114*d[i+2];
  return (S.lum = L);
}

function buildGradient(){
  const w = S.w, h = S.h, L = lumArray(), k = S.gradGain;
  const at = (x, y) => L[clamp(y, 0, h-1)*w + clamp(x, 0, w-1)];
  const out = new ImageData(w, h), o = out.data;
  let p = 0;
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++, p++){
      const gx = at(x+1, y) - at(x-1, y);
      const gy = at(x, y+1) - at(x, y-1);
      let v = Math.sqrt(gx*gx + gy*gy) * k;
      if (v > 255) v = 255;
      const i = p * 4;
      o[i] = o[i+1] = o[i+2] = v;
      o[i+3] = 255;
    }
  }
  return out;
}

function buildNoise(){
  const d = S.data.data, w = S.w, h = S.h, k = S.noiseGain;
  const out = new ImageData(w, h), o = out.data;
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      let rs = 0, gs = 0, bs = 0;
      for (let dy = -1; dy <= 1; dy++){
        const yy = clamp(y + dy, 0, h - 1);
        for (let dx = -1; dx <= 1; dx++){
          if (!dx && !dy) continue;
          const j = (yy*w + clamp(x + dx, 0, w - 1)) * 4;
          rs += d[j]; gs += d[j+1]; bs += d[j+2];
        }
      }
      const i = (y*w + x) * 4;
      o[i]   = clamp(128 + (d[i]   - rs/8) * k, 0, 255);
      o[i+1] = clamp(128 + (d[i+1] - gs/8) * k, 0, 255);
      o[i+2] = clamp(128 + (d[i+2] - bs/8) * k, 0, 255);
      o[i+3] = 255;
    }
  }
  return out;
}

function buildBits(){
  const d = S.data.data, n = S.w * S.h, bitN = S.bitN, ch = S.bitCh;
  const L = ch === 3 ? lumArray() : null;
  const img = new ImageData(S.w, S.h), o = img.data;
  for (let p = 0, i = 0; p < n; p++, i += 4){
    const src = ch === 3 ? L[p] : d[i + ch];
    const on = ((src >> bitN) & 1) !== 0;
    o[i] = o[i+1] = o[i+2] = on ? 255 : 0;
    o[i+3] = 255;
  }
  return img;
}

function getOutput(){
  switch (S.tool){
    case 'original':  return S.data;
    case 'ela':       return S.cache.get('ela')                       || cachePut('ela', buildELA());
    case 'gradient':  return S.cache.get('grad' + S.gradGain)         || cachePut('grad' + S.gradGain, buildGradient());
    case 'noise':     return S.cache.get('noise' + S.noiseGain)       || cachePut('noise' + S.noiseGain, buildNoise());
    case 'bits':      return S.cache.get(`bits${S.bitCh}_${S.bitN}`)  || cachePut(`bits${S.bitCh}_${S.bitN}`, buildBits());
  }
  return S.data;
}

function renderView(){
  if (!S.view) return;
  S.viewCtx.putImageData(getOutput(), 0, 0);
}

/* ================= tool switching ================= */
function selectTool(t){
  if (!S.img) return;
  S.tool = t;
  $$('#tools .tool').forEach(b => b.classList.toggle('active', b.dataset.t === t));
  $$('.params').forEach(p => p.classList.add('hidden'));
  const grp = $('#grp-' + t);
  if (grp) grp.classList.remove('hidden');
  if (window.ADV && ADV.handles(t)){ ADV.render(t); return; }
  if (t === 'ela') ensureResave().then(renderView).catch(e => toast('ELA failed: ' + e.message));
  renderView();
}

/* ================= zoom ================= */
function applyZoomCSS(z){
  S.view.style.width  = (S.w * z) + 'px';
  S.view.style.height = (S.h * z) + 'px';
}
function setZoom(z, anchor){
  if (!S.view) return;
  const st = $('#stage'), old = S.zoom;
  let ix, iy, sr;
  if (anchor){
    sr = st.getBoundingClientRect();
    ix = (anchor.cx - sr.left + st.scrollLeft) / old;
    iy = (anchor.cy - sr.top  + st.scrollTop ) / old;
  }
  S.zoom = clamp(z, .05, 32);
  S.fitMode = false;
  applyZoomCSS(S.zoom);
  if (anchor){
    st.scrollLeft = ix * S.zoom - (anchor.cx - sr.left);
    st.scrollTop  = iy * S.zoom - (anchor.cy - sr.top);
  }
  $('#zoomPct').textContent = Math.round(S.zoom * 100) + '%';
}
function setZoomFit(){
  if (!S.view) return;
  const st = $('#stage');
  const z = Math.min((st.clientWidth - 44) / S.w, (st.clientHeight - 44) / S.h, 1);
  S.zoom = z; S.fitMode = true;
  applyZoomCSS(z);
  $('#zoomPct').textContent = 'fit \u00b7 ' + Math.round(z * 100) + '%';
  st.scrollLeft = (st.scrollWidth  - st.clientWidth)  / 2;
  st.scrollTop  = (st.scrollHeight - st.clientHeight) / 2;
}

/* ================= magnifier & pixel readout ================= */
const MAG_SRC = 26; // image px sampled across the lens
function bindViewEvents(){
  S.view.addEventListener('pointermove', onPointerMove);
  S.view.addEventListener('pointerleave', hideMag);
}
function onPointerMove(e){
  if (!S.data) return;
  const r  = S.view.getBoundingClientRect();
  const ix = clamp(((e.clientX - r.left) / r.width  * S.w) | 0, 0, S.w - 1);
  const iy = clamp(((e.clientY - r.top ) / r.height * S.h) | 0, 0, S.h - 1);

  $('#stPos').textContent = `x:${ix} y:${iy}`;
  const j = (iy * S.w + ix) * 4;
  $('#stHex').textContent = '#' + [0,1,2].map(k => S.data.data[j+k].toString(16).padStart(2, '0')).join('');

  const mctx = $('#magCv').getContext('2d');
  mctx.imageSmoothingEnabled = false;
  const half = MAG_SRC / 2;
  const sx = clamp(ix + .5 - half, 0, Math.max(0, S.w - MAG_SRC));
  const sy = clamp(iy + .5 - half, 0, Math.max(0, S.h - MAG_SRC));
  mctx.clearRect(0, 0, 176, 176);
  mctx.drawImage(S.src, sx, sy, MAG_SRC, MAG_SRC, 0, 0, 176, 176); // always the ORIGINAL pixels
  mctx.strokeStyle = 'rgba(53,196,220,.9)';
  mctx.lineWidth = 1;
  mctx.beginPath();
  mctx.moveTo(88, 70); mctx.lineTo(88, 84);
  mctx.moveTo(70, 88); mctx.lineTo(84, 88);
  mctx.stroke();
  $('#mag').classList.remove('hidden');
}
function hideMag(){ $('#mag').classList.add('hidden'); }

/* ================= status bar ================= */
function updateStatusHeader(){
  $('#stName').textContent = S.name;
  $('#stDims').textContent = `${S.w}\u00d7${S.h}`;
  $('#stSize').textContent = humanSize(S.size);
  $('#stFmt').textContent  = (S.meta && S.meta.format) || S.mime.replace('image/', '').toUpperCase() || '?';
}

/* ================= histogram ================= */
function drawHistogram(){
  const cv = $('#histCv'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!S.data){
    $('#histNote').textContent = 'Load an image to see its channel distribution.';
    return;
  }
  const d = S.data.data;
  const R = new Uint32Array(256), G = new Uint32Array(256), B = new Uint32Array(256), Y = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4){
    R[d[i]]++; G[d[i+1]]++; B[d[i+2]]++;
    Y[(.299*d[i] + .587*d[i+1] + .114*d[i+2]) | 0]++;
  }
  let max = 1;
  for (let v = 1; v < 255; v++) max = Math.max(max, R[v], G[v], B[v], Y[v]);

  ctx.fillStyle = '#0b0e13'; ctx.fillRect(0, 0, 256, 150);
  ctx.strokeStyle = '#1b222c';
  ctx.beginPath();
  for (let q = 1; q < 4; q++){ ctx.moveTo(q*64 + .5, 0); ctx.lineTo(q*64 + .5, 150); }
  ctx.stroke();

  const plot = (arr, color, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let v = 0; v < 256; v++){
      const y = 148 - (arr[v] / max) * 142;
      v === 0 ? ctx.moveTo(v, y) : ctx.lineTo(v, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  plot(Y, '#dddddd', .45);
  plot(R, '#ff5f5f', .85);
  plot(G, '#69e06e', .85);
  plot(B, '#5aa9ff', .85);

  let mean = 0; const n = S.w * S.h;
  for (let p = 0; p < n; p++) mean += (.299*d[p*4] + .587*d[p*4+1] + .114*d[p*4+2]) / n;
  let gaps = 0;
  for (let v = 0; v < 256; v++) if (!R[v] && !G[v] && !B[v]) gaps++;

  $('#histNote').innerHTML =
    `Mean luma: <b>${mean.toFixed(1)}</b> \u00b7 empty RGB codes: <b>${gaps}</b><br>` +
    `Clipping or comb-like spikes can indicate contrast/brightness edits or double compression.`;
}
