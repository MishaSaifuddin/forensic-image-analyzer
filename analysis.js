'use strict';
/* ============================================================
   ForenScope — advanced forensic algorithms (pure, DOM-free)
   Ported from the Veritas toolkit's Python techniques:
   FFT, MD5, perceptual hash, JPEG ghost, copy-move detection,
   PRNU consistency, frequency analysis, resampling detection,
   LSB chi-square steganalysis, IJG quantization estimation,
   deepfake heuristics, score aggregation.
   All functions accept plain {data,width,height} images so they
   are testable in Node.
   ============================================================ */

/* ---------------- basic pixel utils ---------------- */
function grayFrom(data, w, h){
  const g = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4)
    g[p] = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
  return g;
}
function resizeBilinear(src, sw, sh, tw, th, ch){   // ch channels interleaved
  const out = new Float32Array(tw * th * ch);
  for (let y = 0; y < th; y++){
    const fy = (y + .5) * sh / th - .5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < tw; x++){
      const fx = (x + .5) * sw / tw - .5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      for (let c = 0; c < ch; c++){
        const a = src[(y0 * sw + x0) * ch + c], b = src[(y0 * sw + x1) * ch + c];
        const e = src[(y1 * sw + x0) * ch + c], f = src[(y1 * sw + x1) * ch + c];
        out[(y * tw + x) * ch + c] = a * (1-wx)*(1-wy) + b * wx*(1-wy) + e * (1-wx)*wy + f * wx*wy;
      }
    }
  }
  return out;
}
function downscaleImage(img, maxDim){               // img:{data,width,height}
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (s === 1) return img;
  const tw = Math.max(1, Math.round(img.width * s));
  const th = Math.max(1, Math.round(img.height * s));
  return { width:tw, height:th, data:resizeBilinear(img.data, img.width, img.height, tw, th, 4) };
}

/* ---------------- FFT ---------------- */
function fft1d(re, im){
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++){
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j){ let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1){
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len){
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++){
        const k1 = i + j, k2 = k1 + half;
        const vr = re[k2] * cr - im[k2] * ci, vi = re[k2] * ci + im[k2] * cr;
        re[k2] = re[k1] - vr; im[k2] = im[k1] - vi;
        re[k1] += vr;         im[k1] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
function fft2d(re, im, n, m){
  const tr = new Float64Array(m), ti = new Float64Array(m);
  for (let y = 0; y < n; y++){
    const off = y * m;
    fft1d(re.subarray(off, off + m), im.subarray(off, off + m));
  }
  for (let x = 0; x < m; x++){
    for (let y = 0; y < n; y++){ tr[y] = re[y * m + x]; ti[y] = im[y * m + x]; }
    fft1d(tr, ti);
    for (let y = 0; y < n; y++){ re[y * m + x] = tr[y]; im[y * m + x] = ti[y]; }
  }
}
/* log magnitude spectrum, DC-centered */
function spectrumOfGray(g, n){
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) re[i] = g[i];
  fft2d(re, im, n, n);
  const out = new Float32Array(n * n), half = n >> 1;
  for (let y = 0; y < n; y++){
    const sy = (y + half) % n;
    for (let x = 0; x < n; x++){
      const sx = (x + half) % n;
      out[sy * n + sx] = Math.log(1 + Math.hypot(re[y * n + x], im[y * n + x]));
    }
  }
  return out;
}
function radialProfile(mag, n){
  const half = n >> 1, cnt = new Float64Array(half + 1), sum = new Float64Array(half + 1);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++){
      const r = Math.round(Math.hypot(x - half, y - half));
      if (r <= half){ sum[r] += mag[y * n + x]; cnt[r]++; }
    }
  const prof = new Float64Array(half + 1);
  for (let r = 0; r <= half; r++) prof[r] = cnt[r] ? sum[r] / cnt[r] : 0;
  return prof;
}
function fitLogLogSlope(prof, rMin = 3){
  let sx=0,sy=0,sxx=0,sxy=0,k=0;
  for (let r = rMin; r < prof.length; r++){
    if (prof[r] <= 0) continue;
    const X = Math.log(r), Y = Math.log(prof[r]);
    sx+=X; sy+=Y; sxx+=X*X; sxy+=X*Y; k++;
  }
  if (!k) return 0;
  return (k*sxy - sx*sy) / (k*sxx - sx*sx || 1);
}
function freqMetrics(g, w, h){
  const n = 256;
  const small = resizeBilinear(g, w, h, n, n, 1);
  const mag = spectrumOfGray(small, n);
  const prof = radialProfile(mag, n);
  let eLo = 0, eHi = 0;
  for (let r = 2; r < 32; r++)  eLo += prof[r];
  for (let r = 96; r < 128; r++) eHi += prof[r];
  /* periodic peaks: robust outlier detection on profile */
  const med = median(Array.from(prof.slice(4)));
  const dev = Array.from(prof.slice(4)).map(v => Math.abs(v - med));
  const mad = median(dev) * 1.4826 || 1e-9;
  const peaks = [];
  for (let r = 6; r < 126; r++)
    if ((prof[r] - med) / mad > 8 && prof[r] >= prof[r-1] && prof[r] >= prof[r+1])
      peaks.push({ r:+(r.toFixed(0)), z:+(((prof[r]-med)/mad).toFixed(1)) });
  return {
    spectrum: mag, n,
    hfRatio:+((eHi||1e-9)/(eLo||1e-9)).toExponential(2),
    slope:+fitLogLogSlope(prof).toFixed(3),
    peaks:peaks.slice(0, 8),
    anomalous: peaks.length >= 2
  };
}
function median(arr){
  if (!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}

/* ---------------- MD5 (for provenance lists) ---------------- */
function md5(bytes){
  const S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
           4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K=new Uint32Array(64);
  for(let i=0;i<64;i++) K[i]=(Math.abs(Math.sin(i+1))*4294967296)|0;
  const len=bytes.length;
  const withPad=((len+8>>6)+1)<<6;
  const msg=new Uint8Array(withPad);
  msg.set(bytes); msg[len]=0x80;
  const bitLen=len*8;
  new DataView(msg.buffer).setUint32(withPad-8, bitLen>>>0, true);
  new DataView(msg.buffer).setUint32(withPad-4, Math.floor(bitLen/4294967296), true);
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  const dv=new DataView(msg.buffer);
  for(let off=0;off<withPad;off+=64){
    const M=[]; for(let i=0;i<16;i++) M[i]=dv.getUint32(off+i*4,true);
    let A=a0,B=b0,C=c0,D=d0;
    for(let i=0;i<64;i++){
      let F,g;
      if(i<16){ F=(B&C)|(~B&D); g=i; }
      else if(i<32){ F=(D&B)|(~D&C); g=(5*i+1)&15; }
      else if(i<48){ F=B^C^D; g=(3*i+5)&15; }
      else{ F=C^(B|~D); g=(7*i)&15; }
      const tmp=D; D=C; C=B;
      const sum=((A+F+K[i]+M[g])>>>0);
      B=(B+((sum<<S[i])|(sum>>>(32-S[i]))))>>>0;
      A=tmp;
    }
    a0=(a0+A)>>>0; b0=(b0+B)>>>0; c0=(c0+C)>>>0; d0=(d0+D)>>>0;
  }
  const out=new Uint8Array(16), o=new DataView(out.buffer);
  [a0,b0,c0,d0].forEach((v,i)=>o.setUint32(i*4,v,true));
  return [...out].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* ---------------- perceptual hashes ---------------- */
function _sampleGrid(g, w, h, gw, gh){
  const out = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++){
      const x0=Math.floor(x*w/gw), x1=Math.max(x0+1,Math.floor((x+1)*w/gw));
      const y0=Math.floor(y*h/gh), y1=Math.max(y0+1,Math.floor((y+1)*h/gh));
      let s=0,c=0;
      for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++){s+=g[yy*w+xx];c++;}
      out[y*gw+x]=c?s/c:0;
    }
  return out;
}
const hex64 = bits => {
  let h='';
  for(let i=0;i<64;i+=4){ let v=0; for(let j=0;j<4;j++) v=(v<<1)|(bits[i+j]?1:0); h+=v.toString(16); }
  return h;
};
function dhash64(g,w,h){
  const px=_sampleGrid(g,w,h,9,8),bits=[];
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits.push(px[y*9+x]>px[y*9+x+1]?1:0);
  return hex64(bits);
}
function ahash64(g,w,h){
  const px=_sampleGrid(g,w,h,8,8);
  const mean=px.reduce((a,b)=>a+b,0)/64;
  const bits=[]; for(let i=0;i<64;i++)bits.push(px[i]>mean?1:0);
  return hex64(bits);
}
function hammingHex(a,b){
  let d=0;
  for(let i=0;i<a.length;i++){
    let x=parseInt(a[i],16)^parseInt(b[i],16);
    while(x){d+=x&1;x>>=1;}
  }
  return d;
}

/* ---------------- JPEG ghost (pure part) ----------------
   errMaps: array of Float32Array (per quality), qs: quality list.
   Returns per-pixel best matching quality + histogram of shares. */
function jpegGhostAnalyse(errMaps, qs, threshold){
  const n = errMaps[0].length;
  const bestQ = new Uint8Array(n);
  const minErr = new Float32Array(n);
  const share = new Float64Array(qs.length);
  for (let p = 0; p < n; p++){
    let bi = 0, bv = Infinity;
    for (let q = 0; q < errMaps.length; q++){
      const e = errMaps[q][p];
      if (e < bv){ bv = e; bi = q; }
    }
    bestQ[p] = bi; minErr[p] = bv;
    if (bv <= threshold) share[bi]++;
  }
  const total = share.reduce((a,b)=>a+b,0) || 1;
  return {
    bestQ, minErr,
    ghostedShare:+total/n,
    histPct:Array.from(share, v=>+(100*v/total).toFixed(1))
  };
}

/* ---------------- copy-move forgery detection ---------------- */
function copyMoveDetect(g, w, h, opts){
  const blk = opts.blk || 8;
  /* stride 1 => any integer clone offset is detectable; relax only for huge inputs */
  const stride = opts.stride || ((w * h > 250000) ? 2 : 1);
  const dist = opts.dist ?? 12, minVotes = opts.minVotes || 40;
  const xs=[], ys=[];
  for (let y=0; y+blk<=h; y+=stride)
    for (let x=0; x+blk<=w; x+=stride){ xs.push(x); ys.push(y); }
  const N = xs.length;
  const dim = blk*blk;
  const vecs = new Float32Array(N*dim);
  for (let b=0;b<N;b++){
    const bx=xs[b], by=ys[b];
    let mean=0;
    for(let yy=0;yy<blk;yy++)for(let xx=0;xx<blk;xx++)mean+=g[(by+yy)*w+bx+xx];
    mean/=dim;
    const off=b*dim;
    for(let yy=0;yy<blk;yy++)for(let xx=0;xx<blk;xx++)vecs[off+yy*blk+xx]=g[(by+yy)*w+bx+xx]-mean;
  }
  const idx = Array.from({length:N},(_,i)=>i);
  idx.sort((a,b)=>{
    const oa=a*dim, ob=b*dim;
    for(let k=0;k<dim;k++){ const d=vecs[oa+k]-vecs[ob+k]; if(d!==0) return d<0?-1:1; }
    return 0;
  });
  const votes=new Map(), pairs=[];
  for(let ii=0;ii<N;ii++){
    const a=idx[ii], oa=a*dim, ax=xs[a], ay=ys[a];
    for(let jj=ii+1;jj<Math.min(ii+220,N);jj++){
      const b=idx[jj], ob=b*dim;
      if(Math.abs(vecs[oa]-vecs[ob])>dist) break;          // sorted ⇒ early exit
      let s=0;
      for(let k=0;k<dim;k++){ const d=vecs[oa+k]-vecs[ob+k]; s+=d*d; }
      if(s>dist*dist) continue;
      const bx=xs[b], by=ys[b];
      const dx=bx-ax, dy=by-ay;
      if(dx*dx+dy*dy < (blk*2)*(blk*2)) continue;           // too close = texture
      pairs.push([a,b]);
      const key=(dx>>1)+','+(dy>>1);
      votes.set(key,(votes.get(key)||0)+1);
    }
  }
  /* keep consistent-offset clusters only */
  const accepted=new Set();
  const clusters=[];
  for(const [key,count] of [...votes].sort((x,y)=>y[1]-x[1])){
    if(count>=minVotes){ accepted.add(key); clusters.push({offset:key.replace(',',' , '),votes:count}); }
    if(clusters.length>=6) break;
  }
  const mask=new Uint8Array(w*h);
  let markedPairs=0;
  for(const [a,b] of pairs){
    const dx=xs[b]-xs[a], dy=ys[b]-ys[a];
    if(!accepted.has(((dx>>1))+','+((dy>>1)))) continue;
    markedPairs++;
    paint(mask,w,xs[a],ys[a],blk,1); paint(mask,w,xs[b],ys[b],blk,2);
  }
  function paint(m,W,x,y,B,v){ for(let yy=y;yy<y+B;yy++){const o=yy*W+x;m.fill(v,o,o+B);} }
  return { mask, clusters, pairCount:pairs.length, examined:N,
           flagged:markedPairs>0 };
}

/* ---------------- PRNU consistency ---------------- */
function prnuAnalyse(img){
  const {data,width:w,height:h}=downscaleImage(img,512);
  const g=grayFrom(data,w,h);
  const res=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let s=0,c=0;
    for(let dy=-1;dy<=1;dy++){const yy=y+dy;if(yy<0||yy>=h)continue;
      for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const xx=x+dx;if(xx<0||xx>=w)continue;s+=g[yy*w+xx];c++;}}
    res[y*w+x]=g[y*w+x]-s/c;
  }
  const cells=8, cw=w/cells|0, chh=h/cells|0;
  const cellVec=[];
  for(let cy=0;cy<cells;cy++)for(let cx=0;cx<cells;cx++){
    const v=new Float32Array(cw*chh);
    for(let y=0;y<chh;y++)for(let x=0;x<cw;x++)v[y*cw+x]=res[(cy*chh+y)*w+cx*cw+x];
    zeroMean(v); cellVec.push(v);
  }
  const corr=(A,B)=>{let ab=0,aa=0,bb=0;const n=A.length;for(let i=0;i<n;i++){ab+=A[i]*B[i];aa+=A[i]*A[i];bb+=B[i]*B[i];}return ab/(Math.sqrt(aa*bb)||1e-9);};
  const heat=new Float32Array(cells*cells);
  let sum=0;
  for(let cy=0;cy<cells;cy++)for(let cx=0;cx<cells;cx++){
    let c=0,n=0;
    if(cx>0){c+=corr(cellVec[cy*cells+cx-1],cellVec[cy*cells+cx]);n++;}
    if(cy>0){c+=corr(cellVec[(cy-1)*cells+cx],cellVec[cy*cells+cx]);n++;}
    heat[cy*cells+cx]=n?c/n:0; sum+=heat[cy*cells+cx];
  }
  const global=sum/(cells*cells);
  let worstI=-1,worstV=Infinity;
  for(let i=0;i<heat.length;i++)if(heat[i]<worstV){worstV=heat[i];worstI=i;}
  return { heat, cells, global:+global.toFixed(3),
           worst:{cx:worstI%cells, cy:(worstI/cells)|0, val:+worstV.toFixed(3)},
           inconsistent: global<0.25 || worstV<global-0.45 };
}
function zeroMean(v){let m=0;for(let i=0;i<v.length;i++)m+=v[i];m/=v.length;for(let i=0;i<v.length;i++)v[i]-=m;}

/* ---------------- resampling detection ---------------- */
function laplacian(g,w,h){
  const L=new Float32Array(w*h);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    L[i]=g[i-w]+g[i+w]+g[i-1]+g[i+1]-4*g[i];
  }
  return L;
}
function autocorrProminence(sig){
  let m=0;for(const v of sig)m+=v;m/=sig.length;
  const c=Array.from(sig,v=>v-m);
  const N=c.length,maxLag=Math.min(120,N>>2);
  const ac=new Float64Array(maxLag+1);
  for(let lag=1;lag<=maxLag;lag++){
    let s=0;for(let i=0;i+lag<N;i++)s+=c[i]*c[i+lag];
    ac[lag]=s/(N-lag);
  }
  let en=0;for(let lag=1;lag<=maxLag;lag++)en+=ac[lag]*ac[lag];
  const scale=Math.sqrt(en/maxLag)||1e-9;
  for(let lag=1;lag<=maxLag;lag++)ac[lag]/=scale;
  let bestLag=0,bestV=-Infinity;
  for(let lag=4;lag<=maxLag;lag++){
    if(lag>=7&&lag<=9)continue;                 // skip JPEG 8-block grid
    if(ac[lag]>bestV){bestV=ac[lag];bestLag=lag;}
  }
  const rest=[];for(let lag=4;lag<=maxLag;lag++){if(lag>=7&&lag<=9)continue;rest.push(ac[lag]);}
  const med=median(rest);
  const mad=median(rest.map(v=>Math.abs(v-med)))*1.4826||1e-9;
  const prominence=(bestV-med)/mad;
  return {ac:Array.from(ac),lag:bestLag,prominence:+prominence.toFixed(1)};
}
function resamplingDetect(img){
  const {data,width:w,height:h}=downscaleImage(img,600);
  const g=grayFrom(data,w,h);
  const L=laplacian(g,w,h);
  const rowSig=new Float64Array(w),colSig=new Float64Array(h);
  for(let x=0;x<w;x++){let s=0;for(let y=0;y<h;y++)s+=Math.abs(L[y*w+x]);rowSig[x]=s/h;}
  for(let y=0;y<h;y++){let s=0;for(let x=0;x<w;x++)s+=Math.abs(L[y*w+x]);colSig[y]=s/w;}
  const H=autocorrProminence(rowSig), V=autocorrProminence(colSig);
  return { H,V,laps:L,w,h,
           periodic: H.prominence>8 || V.prominence>8 };
}

/* ---------------- LSB chi-square steganalysis ---------------- */
function erfc(x){
  const z=Math.abs(x),t=1/(1+z/2);
  const r=t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(0.37409196+t*(0.09678418+
        t*(-0.18628806+t*(0.27886807+t*(-1.13520398+t*(1.48851587+t*(-0.82215223+
        t*0.17087277)))))))));
  return x>=0?r:2-r;
}
function chiSqP(x2,df){
  const z=(Math.cbrt(x2/df)-(1-2/(9*df)))/Math.sqrt(2/(9*df));
  return clamp01(0.5*erfc(z/Math.SQRT2));
}
const clamp01=v=>v<0?0:v>1?1:v;
function stegoChi(img, channel){
  const {data,width:w,height:h}=img;
  const chunks=64,total=w*h,per=total/chunks|0;
  const ps=[];
  for(let c=0;c<chunks;c++){
    const hist=new Uint32Array(256);
    for(let i=c*per;i<(c+1)*per;i++)hist[data[i*4+channel]]++;
    let x2=0;
    for(let v=0;v<256;v+=2){
      const o=hist[v],e=hist[v+1],s=o+e;
      if(s===0)continue;
      x2+=(o-e)*(o-e)/s;
    }
    ps.push(+chiSqP(x2,127).toFixed(3));
  }
  const suspectChunks=ps.filter(p=>p>0.5).length;
  return {ps,suspectFrac:+(suspectChunks/chunks).toFixed(2),
          verdict:suspectChunks>=chunks*0.6?'likely embedded':suspectChunks>=chunks*0.35?'possible':'none detected'};
}

/* ---------------- IJG quantization estimation ---------------- */
const IJG_LUMA=[
  16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55,
  14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92,
  49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99];
const IJG_CHROMA=[
  17,18,24,47,99,99,99,99, 18,21,26,66,99,99,99,99,
  24,26,56,99,99,99,99,99, 47,66,99,99,99,99,99,99,
  99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99,
  99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99];
function scaledTable(base,q){
  const S=q<50?5000/q:200-2*q;
  return base.map(v=>Math.max(1,Math.min(255,Math.floor((v*S+50)/100))));
}
function estimateQuality(tab,base){
  let bestQ=50,bestD=Infinity;
  for(let q=1;q<=100;q++){
    const t=scaledTable(base,q);
    let d=0;for(let i=0;i<64;i++)d+=Math.abs(t[i]-tab[i]);
    if(d<bestD){bestD=d;bestQ=q;}
  }
  return {q:bestQ,delta:bestD};
}
function quantAnalyse(dqt){
  if(!dqt.length)return null;
  const luma=dqt[0].v.slice(0,64);
  const chroma=dqt.length>1?dqt[1].v.slice(0,64):null;
  const el=estimateQuality(luma,IJG_LUMA);
  const ec=chroma?estimateQuality(chroma,IJG_CHROMA):null;
  const stdMatch=el.delta===0;
  const doubleHint=!stdMatch && ec && Math.abs(el.q-ec.q)>=12;
  return { lumaQ:el.q, chromaQ:ec?ec.q:null, stdMatch,
           doubleHint, tables:dqt.length };
}

/* ---------------- deepfake / AI-artifact heuristics ---------------- */
function deepfakeHeuristics(img){
  const {data,width:w,height:h}=img;
  /* center crop */
  const cw=Math.min(w,Math.round(Math.min(w,h)*0.55)), chh=Math.min(h,Math.round(Math.min(w,h)*0.55));
  const cx0=(w-cw)>>1, cy0=(h-chh)>>1;
  const crop=new Float32Array(cw*chh);
  for(let y=0;y<chh;y++)for(let x=0;x<cw;x++){
    const i=((cy0+y)*w+cx0+x)*4;
    crop[y*cw+x]=.299*data[i]+.587*data[i+1]+.114*data[i+2];
  }
  const n=256;
  const small=resizeBilinear(crop,cw,chh,n,n,1);
  const mag=spectrumOfGray(small,n);
  const prof=radialProfile(mag,n);
  const slope=fitLogLogSlope(prof);
  /* angular anisotropy (GAN upsampling often directional) */
  const half=n>>1, sector=new Float64Array(16);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const dx=x-half,dy=y-half,r=Math.hypot(dx,dy);
    if(r<24||r>half-2)continue;
    let ang=Math.atan2(dy,dx)+Math.PI;             // 0..2pi
    sector[Math.min(15,(ang/(2*Math.PI)*16)|0)]+=mag[y*n+x];
  }
  const secMean=sector.reduce((a,b)=>a+b,0)/16;
  const aniso=Math.sqrt(sector.reduce((a,b)=>a+(b-secMean)**2,0)/16)/(secMean||1e-9);
  /* chroma high-frequency vs luma */
  let ly=0,cb=0,cr=0,lyN=0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=(y*w+x)*4;
    const Y=.299*data[i]+.587*data[i+1]+.114*data[i+2];
    const Cb=data[i+2]-Y, Cr=data[i]-Y;
    const lapY=Y*4-(data[i-4]+data[i+4]+data[i-w*4]+data[i+w*4]);
    ly+=Math.abs(lapY);lyN++;
    cb+=Math.abs(Cb-(data[i+2-w*4]-(.299*data[i-w*4]+.587*data[i-w*4+1]+.114*data[i-w*4+2])));
    cr+=Math.abs(Cr-(data[i-w*4]-(.299*data[i-w*4]+.587*data[i-w*4+1]+.114*data[i-w*4+2])));
  }
  const chromaRatio=((cb+cr)/2)/(ly||1e-9);
  /* micro-texture entropy proxy: local std in center vs border */
  const blockStd=(bx,by,bw,bh)=>{
    let s=0,s2=0,c=0;
    for(let y=by;y<by+bh;y+=2)for(let x=bx;x<bx+bw;x+=2){const v=crop[y*cw+x];s+=v;s2+=v*v;c++;}
    const m=s/c;return Math.sqrt(Math.max(0,s2/c-m*m));
  };
  const centerStd=blockStd(cw*0.3|0,chh*0.3|0,cw*0.4|0,chh*0.4|0);
  const borderStd=(blockStd(0,0,cw,20)+blockStd(0,chh-20,cw,20)+
                   blockStd(0,0,20,chh)+blockStd(cw-20,0,20,chh))/4;
  /* heuristic blend (NOT machine learning - screening only) */
  let aiScore=50;
  aiScore+=Math.max(-20,Math.min(25,(1.05-slope)*38));            // flat spectra → GAN-ish
  aiScore+=Math.max(-10,Math.min(20,(aniso-0.18)*90));            // directional energy
  aiScore+=Math.max(-12,Math.min(18,(0.30-chromaRatio)*70));      // over-smooth chroma
  aiScore+=Math.max(-10,Math.min(15,(centerStd-borderStd)*-0.9)); // center smoother than border
  aiScore=Math.max(0,Math.min(100,Math.round(aiScore)));
  return {aiScore, slope:+slope.toFixed(3), aniso:+aniso.toFixed(3),
          chromaRatio:+chromaRatio.toFixed(3),
          cropRect:{x:cx0,y:cy0,w:cw,h:chh}, spectrum:mag, n};
}

/* ---------------- overall authenticity scoring ---------------- */
function aggregateScore(components){
  /* components: [{name, risk(0..1), note}] - risk is how suspicious each check is */
  let score=100;
  const WEIGHTS={
    'Metadata integrity':14,'JPEG ghost clusters':16,'Copy-move regions':18,
    'PRNU consistency':10,'Frequency anomalies':8,'AI-artifact heuristics':6,
    'Resampling traces':10,'LSB steganalysis':6,'Quantization anomalies':4,
    'ELA response variance':8,'Tamper detection':20
  };
  const rows=[];
  for(const c of components){
    const w=WEIGHTS[c.name]||8;
    const penalty=(c.risk||0)*w;
    score-=penalty;
    rows.push({name:c.name,risk:c.risk||0,note:c.note||''});
  }
  score=Math.max(3,Math.min(98,Math.round(score)));
  const risk=score>=80?'low':score>=60?'medium':score>=40?'elevated':'high';
  return {score,risk,rows};
}

/* ---------------- tamper detection (composite heatmap) ---------------- */
function tamperDetect(img, opts){
  const {data, width:w, height:h} = img;
  const blk = opts.blk || 16;
  const sensitivity = opts.sensitivity || 'med';

  const g = grayFrom(data, w, h);

  /* --- 1. ELA inconsistency map --- */
  const elaMap = new Float32Array(w * h);
  if (typeof S !== 'undefined' && S.resave){
    const a = S.data.data, b = S.resave.data;
    const k = S.elaAmp || 20;
    for (let p = 0, i = 0; p < w * h; p++, i += 4){
      const d = (Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2])) / 3 * k;
      elaMap[p] = Math.min(1, d / 255);
    }
  }

  /* --- 2. Noise inconsistency map --- */
  const noiseMap = new Float32Array(w * h);
  {
    const noise = new Float32Array(w * h);
    for (let y = 0; y < h; y++){
      for (let x = 0; x < w; x++){
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++){
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++){
            if (!dx && !dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            sum += g[yy * w + xx]; cnt++;
          }
        }
        noise[y * w + x] = Math.abs(g[y * w + x] - sum / cnt);
      }
    }
    const bw = Math.ceil(w / blk), bh = Math.ceil(h / blk);
    const blockNoise = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++){
      for (let bx = 0; bx < bw; bx++){
        let s = 0, c = 0;
        const y0 = by * blk, y1 = Math.min(y0 + blk, h);
        const x0 = bx * blk, x1 = Math.min(x0 + blk, w);
        for (let y = y0; y < y1; y += 2){
          for (let x = x0; x < x1; x += 2){
            s += noise[y * w + x]; c++;
          }
        }
        blockNoise[by * bw + bx] = c ? s / c : 0;
      }
    }
    let globalMean = 0, gCnt = 0;
    for (let i = 0; i < blockNoise.length; i++){ globalMean += blockNoise[i]; gCnt++; }
    globalMean /= gCnt || 1;
    for (let by = 0; by < bh; by++){
      for (let bx = 0; bx < bw; bx++){
        const dev = Math.abs(blockNoise[by * bw + bx] - globalMean) / (globalMean || 1);
        const v = Math.min(1, dev * 2);
        const y0 = by * blk, y1 = Math.min(y0 + blk, h);
        const x0 = bx * blk, x1 = Math.min(x0 + blk, w);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++)
            noiseMap[y * w + x] = v;
      }
    }
  }

  /* --- 3. Edge discontinuity map --- */
  const edgeMap = new Float32Array(w * h);
  {
    const sobel = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++){
      for (let x = 1; x < w - 1; x++){
        const i00 = g[(y-1)*w+(x-1)], i01 = g[(y-1)*w+x], i02 = g[(y-1)*w+(x+1)];
        const i20 = g[(y+1)*w+(x-1)], i21 = g[(y+1)*w+x], i22 = g[(y+1)*w+(x+1)];
        const gx = -i00 - 2*i01 - i02 + i20 + 2*i21 + i22;
        const gy = -i00 - 2*i20 - i22 + i01 + 2*i01 + i02;
        sobel[y*w+x] = Math.sqrt(gx*gx + gy*gy);
      }
    }
    const bw = Math.ceil(w / blk), bh = Math.ceil(h / blk);
    const blockEdge = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++){
      for (let bx = 0; bx < bw; bx++){
        let s = 0, c = 0;
        const y0 = by * blk, y1 = Math.min(y0 + blk, h);
        const x0 = bx * blk, x1 = Math.min(x0 + blk, w);
        for (let y = y0; y < y1; y += 2){
          for (let x = x0; x < x1; x += 2){
            s += sobel[y * w + x]; c++;
          }
        }
        blockEdge[by * bw + bx] = c ? s / c : 0;
      }
    }
    for (let by = 0; by < bh; by++){
      for (let bx = 0; bx < bw; bx++){
        let neighborSum = 0, neighborCnt = 0;
        for (let dy = -1; dy <= 1; dy++){
          for (let dx = -1; dx <= 1; dx++){
            if (!dx && !dy) continue;
            const ny = by + dy, nx = bx + dx;
            if (ny >= 0 && ny < bh && nx >= 0 && nx < bw){
              neighborSum += blockEdge[ny * bw + nx]; neighborCnt++;
            }
          }
        }
        const neighborMean = neighborCnt ? neighborSum / neighborCnt : 0;
        const dev = neighborMean > 0 ? Math.abs(blockEdge[by*bw+bx] - neighborMean) / neighborMean : 0;
        const v = Math.min(1, dev * 1.5);
        const y0 = by * blk, y1 = Math.min(y0 + blk, h);
        const x0 = bx * blk, x1 = Math.min(x0 + blk, w);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++)
            edgeMap[y * w + x] = v;
      }
    }
  }

  /* --- 4. Block color statistics anomaly --- */
  const statMap = new Float32Array(w * h);
  {
    const bw = Math.ceil(w / blk), bh = Math.ceil(h / blk);
    const blockMeans = [];
    for (let by = 0; by < bh; by++){
      for (let bx = 0; bx < bw; bx++){
        let rS=0, gS=0, bS=0, c=0;
        const y0=by*blk, y1=Math.min(y0+blk,h), x0=bx*blk, x1=Math.min(x0+blk,w);
        for (let y=y0;y<y1;y+=2) for (let x=x0;x<x1;x+=2){
          const i=(y*w+x)*4;
          rS+=data[i]; gS+=data[i+1]; bS+=data[i+2]; c++;
        }
        blockMeans.push(c?[rS/c,gS/c,bS/c]:[128,128,128]);
      }
    }
    const globalR=blockMeans.reduce((a,b)=>a+b[0],0)/blockMeans.length;
    const globalG=blockMeans.reduce((a,b)=>a+b[1],0)/blockMeans.length;
    const globalB=blockMeans.reduce((a,b)=>a+b[2],0)/blockMeans.length;
    for (let by=0;by<bh;by++){
      for (let bx=0;bx<bw;bx++){
        const m=blockMeans[by*bw+bx];
        const dr=Math.abs(m[0]-globalR)/255, dg=Math.abs(m[1]-globalG)/255, db=Math.abs(m[2]-globalB)/255;
        const v=Math.min(1, (dr+dg+db)*3);
        const y0=by*blk,y1=Math.min(y0+blk,h),x0=bx*blk,x1=Math.min(x0+blk,w);
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)statMap[y*w+x]=v;
      }
    }
  }

  /* --- combine signals --- */
  const n = w * h;
  const heatmap = new Float32Array(n);
  const weights = { ela: 0.30, noise: 0.30, edge: 0.25, stat: 0.15 };

  for (let p = 0; p < n; p++){
    heatmap[p] = elaMap[p]*weights.ela + noiseMap[p]*weights.noise
               + edgeMap[p]*weights.edge + statMap[p]*weights.stat;
  }

  /* sensitivity thresholding */
  const threshMap = { low: 0.18, med: 0.12, high: 0.07 };
  const threshold = threshMap[sensitivity] || 0.12;

  /* contour detection: find connected high-confidence regions */
  const contourMask = new Uint8Array(n);
  let flaggedCount = 0;
  for (let p = 0; p < n; p++){
    if (heatmap[p] >= threshold){
      contourMask[p] = 1;
      flaggedCount++;
    }
  }

  /* simple blob detection via flood fill */
  const visited = new Uint8Array(n);
  const regions = [];
  for (let p = 0; p < n; p++){
    if (!contourMask[p] || visited[p]) continue;
    let minX=w, minY=h, maxX=0, maxY=0, area=0, sumConf=0;
    const queue = [p];
    visited[p] = 1;
    while (queue.length){
      const cur = queue.shift();
      const cx = cur % w, cy = (cur / w) | 0;
      minX = Math.min(minX, cx); minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
      area++; sumConf += heatmap[cur];
      for (const [ddx,ddy] of [[-1,0],[1,0],[0,-1],[0,1]]){
        const nx=cx+ddx, ny=cy+ddy;
        if (nx<0||nx>=w||ny<0||ny>=h) continue;
        const ni=ny*w+nx;
        if (contourMask[ni] && !visited[ni]){ visited[ni]=1; queue.push(ni); }
      }
    }
    if (area >= blk * blk / 4){
      regions.push({
        x:minX, y:minY, w:maxX-minX+1, h:maxY-minY+1,
        area, avgConf:+(sumConf/area).toFixed(3)
      });
    }
  }
  regions.sort((a,b)=>b.area-a.area);

  const flaggedPct = +(flaggedCount/n*100).toFixed(1);
  return { heatmap, contourMask, regions, flaggedPct,
           flagged: flaggedPct > 3 };
}
