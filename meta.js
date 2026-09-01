'use strict';
/* ============================================================
   ForenScope — metadata & container forensics
   EXIF/TIFF parsing, JPEG segment walk, DQT tables, PNG chunks,
   automatic findings.
   ============================================================ */

const TYPE_SIZE = {1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8};
const ORIENT  = {1:'Normal (1)',2:'Mirrored horizontal',3:'Rotated 180\u00b0',4:'Flipped vertical',5:'Transposed',6:'Rotated 90\u00b0 CW',7:'Transverse',8:'Rotated 90\u00b0 CCW'};
const EXPPROG = {0:'Unknown',1:'Manual',2:'Program AE',3:'Aperture-priority',4:'Shutter-priority',5:'Creative (bias)',6:'Action (high-shutter)',7:'Portrait',8:'Landscape'};
const METER   = {0:'Unknown',1:'Average',2:'Center-weighted avg',3:'Spot',4:'Multi-spot',5:'Pattern',6:'Partial'};
const WB      = {0:'Auto',1:'Manual'};
const PNG_CT  = {0:'Grayscale',2:'RGB',3:'Palette',4:'Grayscale+Alpha',6:'RGBA'};

const IMG_TAGS = {
  0x010E:'Image Description',0x010F:'Camera Make',0x0110:'Camera Model',0x0112:'Orientation',
  0x011A:'X Resolution',0x011B:'Y Resolution',0x0128:'Resolution Unit',0x0131:'Software',
  0x0132:'Modify Date',0x013B:'Artist',0x8298:'Copyright'
};
const EXIF_TAGS = {
  0x829A:'Exposure Time',0x829D:'F Number',0x8822:'Exposure Program',0x8827:'ISO Speed',
  0x9003:'Date Taken',0x9004:'Date Digitized',0x9010:'Offset Time',0x9101:'Components Cfg',
  0x9201:'Shutter Speed (APEX)',0x9202:'Aperture (APEX)',0x9204:'Exposure Bias',0x9205:'Max Aperture',
  0x9207:'Metering Mode',0x9208:'Light Source',0x9209:'Flash',0x920A:'Focal Length',
  0x927C:'Maker Note',0x9286:'User Comment',0xA001:'Color Space',0xA002:'Exif Width',0xA003:'Exif Height',
  0xA402:'Exposure Mode',0xA403:'White Balance',0xA405:'Focal Length (35mm)',0xA406:'Scene Capture Type',
  0xA408:'Contrast',0xA409:'Saturation',0xA40A:'Sharpness',0xA420:'Unique Image ID',
  0xA430:'Camera Owner',0xA431:'Body Serial No.',0xA432:'Lens Spec',0xA433:'Lens Make',
  0xA434:'Lens Model',0xA435:'Lens Serial No.'
};

/* ---------------- low-level readers ---------------- */
function asciiAt(dv, off, n){
  let s = '';
  for (let k = 0; k < n && off + k < dv.byteLength; k++){
    const c = dv.getUint8(off + k);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}
function latinAt(dv, off, n){
  let s = '';
  for (let k = 0; k < n && off + k < dv.byteLength; k++){
    const c = dv.getUint8(off + k);
    s += (c >= 32 || c === 10 || c === 13 || c === 9) ? String.fromCharCode(c) : ' ';
  }
  return s;
}

/* ---------------- TIFF / EXIF ---------------- */
function parseTIFF(dv, t0){
  if (t0 + 8 > dv.byteLength) throw new Error('TIFF too small');
  const le  = dv.getUint16(t0, false) === 0x4949;
  const g16 = o => dv.getUint16(o, le);
  const g32 = o => dv.getUint32(o, le);
  if (g16(t0 + 2) !== 0x002A) throw new Error('TIFF magic mismatch');
  const seen = new Set();

  function ifd(rel){
    if (!rel) return null;
    const abs = t0 + rel;
    if (abs + 2 > dv.byteLength || seen.has(abs)) return null;
    seen.add(abs);
    const n = g16(abs);
    if (n > 1024) return null;
    const ents = [];
    for (let k = 0; k < n; k++){
      const eo = abs + 2 + 12*k;
      if (eo + 12 > dv.byteLength) break;
      const tag = g16(eo), type = g16(eo + 2), count = g32(eo + 4);
      const ts = TYPE_SIZE[type] || 1, total = ts * count;
      const vo = total <= 4 ? eo + 8 : t0 + g32(eo + 8);
      ents.push({ tag, type, count, vo, total });
    }
    const next = (abs + 2 + 12*n + 4 <= dv.byteLength) ? g32(abs + 2 + 12*n) : 0;
    return { ents, next };
  }
  function rawBytes(e){
    const len = Math.max(0, Math.min(e.total, dv.byteLength - e.vo));
    return new Uint8Array(dv.buffer, dv.byteOffset + e.vo, len);
  }
  function vals(e){
    const out = [];
    const cnt = Math.min(e.count, 512);
    switch (e.type){
      case 9:
        for (let k = 0; k < cnt; k++) out.push(dv.getInt32(e.vo + 4*k, le));
        return out;
      case 10:
        for (let k = 0; k < cnt; k++) out.push([dv.getInt32(e.vo + 8*k, le), dv.getInt32(e.vo + 4 + 8*k, le)]);
        return out;
    }
    for (let k = 0; k < cnt; k++){
      switch (e.type){
        case 1: case 6: case 2: case 7: out.push(dv.getUint8(e.vo + k)); break;
        case 3: case 8:                 out.push(dv.getUint16(e.vo + 2*k, le)); break;
        case 4:                         out.push(dv.getUint32(e.vo + 4*k, le)); break;
        case 5:                         out.push([dv.getUint32(e.vo + 8*k, le), dv.getUint32(e.vo + 4 + 8*k, le)]); break;
        default: return null;
      }
    }
    return out;
  }
  return {
    le, t0, root: ifd(g32(t0 + 4)), ifd, vals, rawBytes,
    number(e){ const v = vals(e); return Array.isArray(v) ? v[0] : v; },
  };
}

function fmtEntry(T, e){
  if (e.type === 2){
    let s = '';
    for (const c of T.vals(e)){ if (!c) break; s += String.fromCharCode(c); }
    return s.trim() || '(empty)';
  }
  if (e.type === 7){
    if (e.tag === 0x9286){
      let s = new TextDecoder('utf-8', { fatal:false }).decode(T.rawBytes(e));
      if (/^ASCII/i.test(s)) s = s.slice(8);
      s = s.replace(/\u0000+/g, ' ').trim();
      return s || '(empty)';
    }
    return `(binary, ${e.count.toLocaleString()} bytes)`;
  }
  const v = T.vals(e);
  if (v == null) return `(unhandled type ${e.type})`;
  const rat = a => Array.isArray(a) ? (a[1] ? a[0]/a[1] : a[0]) : a;
  switch (e.tag){
    case 0x829A:{ const x = rat(v[0]); return x > 0 && x < 1 ? `1/${Math.round(1/x)} s` : x + ' s'; }
    case 0x829D: return '\u0192/' + rat(v[0]);
    case 0x920A: return rat(v[0]) + ' mm';
    case 0xA405: return rat(v[0]) + ' mm equivalent';
    case 0x9204:{ const x = rat(v[0]); return (x > 0 ? '+' : '') + x + ' EV'; }
    case 0x8827: return v.map(String).join('');
    case 0x0102: return v.join(', ') + ' bits';
    case 0x0112: return ORIENT[v[0]]  || v[0];
    case 0x8822: return EXPPROG[v[0]] || v[0];
    case 0x9207: return METER[v[0]]   || v[0];
    case 0xA403: return WB[v[0]]      || v[0];
    case 0x9209: return (v[0] & 1) ? 'Fired' : 'Did not fire';
    default:
      if (Array.isArray(v[0])) return v.slice(0, 8).map(p => p[0] + '/' + p[1]).join(', ');
      return v.length === 1 ? String(v[0]) : v.slice(0, 12).join(', ') + (v.length > 12 ? ' \u2026' : '');
  }
}

function exifRows(T){
  const rows = [];
  const root = T.root;
  if (!root) return rows;
  for (const e of root.ents){
    const nm = IMG_TAGS[e.tag];
    if (nm) rows.push(['Camera / IFD0', nm, fmtEntry(T, e)]);
  }
  const xp = root.ents.find(e => e.tag === 0x8769);
  if (xp){
    const sub = T.ifd(T.number(xp));
    if (sub) for (const e of sub.ents){
      const nm = EXIF_TAGS[e.tag];
      if (nm) rows.push(['EXIF', nm, fmtEntry(T, e)]);
    }
  }
  const gp = root.ents.find(e => e.tag === 0x8825);
  if (gp){
    const sub = T.ifd(T.number(gp));
    if (sub){
      const byTag = {};
      sub.ents.forEach(e => byTag[e.tag] = e);
      const rat_ = x => Array.isArray(x) ? (x[1] ? x[0]/x[1] : x[0]) : x;
      const dec = e => {
        if (!e) return null;
        const v = T.vals(e);
        if (!v) return null;
        return v.reduce((a, x, i) => a + rat_(x) * Math.pow(60, -i), 0);
      };
      const strOf = e => {
        if (e.type === 2){ let s = ''; for (const c of T.vals(e)){ if (!c) break; s += String.fromCharCode(c); } return s; }
        const v = T.vals(e);
        return v == null ? '' : String(Array.isArray(v) ? v.join(',') : v);
      };
      const lat = dec(byTag[2]), lon = dec(byTag[4]);
      const latR = byTag[1] ? strOf(byTag[1]) : '';
      const lonR = byTag[3] ? strOf(byTag[3]) : '';
      if (lat != null) rows.push(['GPS', 'Latitude',  Math.abs(lat).toFixed(6) + '\u00b0 ' + (/S/i.test(latR) ? 'S' : 'N')]);
      if (lon != null) rows.push(['GPS', 'Longitude', Math.abs(lon).toFixed(6) + '\u00b0 ' + (/W/i.test(lonR) ? 'W' : 'E')]);
      if (byTag[6]){
        const v = T.vals(byTag[6]);
        if (v) rows.push(['GPS', 'Altitude', rat_(Array.isArray(v) ? v[0] : v).toFixed(1) + ' m']);
      }
      if (byTag[12]) rows.push(['GPS', 'Map Datum', strOf(byTag[12])]);
      if (lat != null && lon != null)
        S.gpsLink = `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
    }
  }
  return rows;
}

/* ---------------- software signature scan ---------------- */
const SOFTWARE_KEYWORDS = ['photoshop','lightroom','adobe','gimp','paint.net','pixlr','snapseed',
  'canva','figma','inkscape','picsart','affinity photo','capture one','corel paint','illustrator',
  'pixelmator','photopea','polarr','vsco','midjourney','dall\u00b7e','stable diffusion'];
function findSoftwareStrings(bytes){
  try{
    const txt = new TextDecoder('latin1').decode(bytes.subarray(0, 24 * 1024 * 1024)).toLowerCase();
    const found = new Set();
    for (const kw of SOFTWARE_KEYWORDS) if (txt.includes(kw)) found.add(kw);
    return [...found];
  }catch(e){ return []; }
}

/* ---------------- dispatchers ---------------- */
function analyzeBytes(dv){
  const sig16 = dv.getUint16(0, false);
  const sig32 = dv.getUint32(0, false);
  if (sig16 === 0xFFD8)       return analyzeJPEG(dv);
  if (sig32 === 0x89504E47)   return analyzePNG(new DataView(dv.buffer, dv.byteOffset, dv.byteLength),
                                                new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  return { format:(sig32 >>> 16) === 0x4749 ? 'GIF' : (sig32 >>> 24) === 0x52 ? 'RIFF/WebP/other' : 'Unknown',
           segments:[], comments:[], dqt:[], entries:[], findings:[],
           note:'Full structural analysis supports JPEG and PNG.' };
}

/* ---------------- JPEG ---------------- */
function analyzeJPEG(dv){
  const res = { format:'JPEG', segments:[], comments:[], dqt:[], xmp:null, exifTiff:null, jfif:null,
                sof:null, findings:[], entries:[], stats:{} };
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  res._bytes = bytes;
  let i = 2, restarts = 0, dhtCount = 0;

  while (i + 4 <= dv.byteLength){
    if (dv.getUint8(i) !== 0xFF) break;
    let m = dv.getUint8(i + 1);
    while (m === 0xFF && i + 2 < dv.byteLength){ i++; m = dv.getUint8(i + 1); }

    if (m === 0xD8){ i += 2; continue; }
    if (m === 0xD9){ res.segments.push({n:'EOI', o:i, l:2}); res.stats.eoiSeen = true; break; }
    if (m === 0xDA){ res.segments.push({n:'SOS \u2014 scan data follows', o:i, l:null}); break; }

    const len = dv.getUint16(i + 2, false);
    if (len < 2 || i + 2 + len > dv.byteLength) break;
    const pay = i + 4, payLen = len - 2;

    if (m >= 0xD0 && m <= 0xD7){ restarts++; }
    else if (m === 0xE0 && payLen > 4 && asciiAt(dv, pay, 4) === 'JFIF'){
      res.jfif = { ver: dv.getUint8(pay+5) + '.' + dv.getUint8(pay+6),
                   xd: dv.getUint16(pay+8, false), yd: dv.getUint16(pay+10, false) };
      res.segments.push({n:'APP0 JFIF', o:i, l:len});
    }
    else if (m === 0xE1){
      const head = latinAt(dv, pay, Math.min(28, payLen));
      if (head.startsWith('Exif')){
        res.segments.push({n:'APP1 Exif', o:i, l:len});
        try{ res.exifTiff = parseTIFF(dv, pay + 6); }catch(e){}
      } else if (head.includes('ns.adobe.com/xap')){
        res.segments.push({n:'APP1 XMP', o:i, l:len});
        let nul = -1;
        for (let k = pay; k < Math.min(pay + 90, pay + payLen); k++) if (!dv.getUint8(k)){ nul = k; break; }
        if (nul >= 0) res.xmp = latinAt(dv, nul + 1, Math.min(payLen - (nul - pay) - 1, 20000));
      } else res.segments.push({n:'APP1', o:i, l:len});
    }
    else if (m === 0xFE){
      res.comments.push(latinAt(dv, pay, Math.min(payLen, 500)));
      res.segments.push({n:'COM comment', o:i, l:len});
    }
    else if (m === 0xDB){
      let p = pay; const end = pay + payLen;
      while (p < end){
        const pq = dv.getUint8(p) >> 4, id = dv.getUint8(p) & 15;
        p++;
        const need = pq ? 128 : 64;
        if (p + need > end) break;
        const t = [];
        for (let k = 0; k < 64; k++)
          t.push(pq ? dv.getUint16(p + 2*k, false) : dv.getUint8(p + k));
        p += need;
        res.dqt.push({ pq, id, v:t });
      }
      res.segments.push({n:'DQT quantization table' + (res.dqt.length > 1 ? 's' : ''), o:i, l:len});
    }
    else if (m === 0xC4){
      dhtCount++;
      res.segments.push({n:'DHT huffman table', o:i, l:len});
    }
    else if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC){
      const nc = dv.getUint8(pay+5);
      const comps = [];
      for (let c = 0; c < Math.min(nc,4); c++){
        const hv = dv.getUint8(pay+6+c*3);
        comps.push({ id: dv.getUint8(pay+6), h: hv>>4, v: hv&15 });
      }
      res.sof = { prec: dv.getUint8(pay), h: dv.getUint16(pay+1, false),
                  w: dv.getUint16(pay+3, false), nc, comps, prog: m === 0xC2 };
      res.segments.push({n:`SOF${m-0xC0}${m===0xC2?' progressive':''} frame`, o:i, l:len});
    }
    else if (m >= 0xE0 && m <= 0xEF) res.segments.push({n:'APP' + (m - 0xE0), o:i, l:len});
    else res.segments.push({n:'marker 0x' + m.toString(16).toUpperCase().padStart(2,'0'), o:i, l:len});

    i += 2 + len;
  }

  res.stats.restarts = restarts;
  res.stats.dhtCount = dhtCount;

  /* --- EXIF thumbnail (IFD1) extraction + dimension probe --- */
  if (res.exifTiff && res.exifTiff.root && res.exifTiff.root.next){
    const ifd1 = res.exifTiff.ifd(res.exifTiff.root.next);
    if (ifd1){
      const byTag = {};
      ifd1.ents.forEach(e => byTag[e.tag] = e);
      const offE = byTag[0x0201], cntE = byTag[0x0202];
      if (offE && cntE){
        try{
          const t0 = res.exifTiff.t0 != null ? res.exifTiff.t0 : null;
          const off = res.exifTiff.number(offE), count = res.exifTiff.number(cntE);
          const abs = (t0 ?? 0) + off;
          if (count > 0 && abs + count <= dv.byteLength){
            res.thumbBytes = new Uint8Array(dv.buffer, dv.byteOffset + abs, count);
            res.thumbDims = probeJPEGdims(res.thumbBytes);
          }
        }catch(e){}
      }
    }
  }

  buildJPEGEntries(res);
  buildFindings(res);
  return res;
}
/* quick SOF scan inside a standalone JPEG blob (thumbnail) */
function probeJPEGdims(bytes){
  try{
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 4 < bytes.length){
      if (bytes[i] !== 0xFF){ i++; continue; }
      const m = bytes[i+1];
      if (m === 0xD8){ i += 2; continue; }
      if (m === 0xDA || m === 0xD9) break;
      const len = dv.getUint16(i+2, false);
      if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
        return { h: dv.getUint16(i+5, false), w: dv.getUint16(i+7, false) };
      i += 2 + len;
    }
  }catch(e){}
  return null;
}

function buildJPEGEntries(res){
  const E = res.entries;
  if (res.sof){
    E.push(['File', 'Dimensions', `${res.sof.w}\u00d7${res.sof.h}`]);
    E.push(['File', 'Encoding', (res.sof.prog ? 'Progressive' : 'Baseline') + ` \u00b7 ${res.sof.prec}-bit \u00b7 ${res.sof.nc} component(s)`]);
  }
  if (res.jfif) E.push(['File', 'JFIF version', res.jfif.ver + ` (${res.jfif.xd}\u00d7${res.jfif.yd} density)`]);
  if (res.comments.length)
    res.comments.forEach((c, k) => E.push(['File', `Comment #${k+1}`, c]));
  if (res.xmp){
    const ct = /CreatorTool="([^"]+)"/.exec(res.xmp);
    if (ct) E.push(['XMP', 'Creator Tool', ct[1]]);
    E.push(['XMP', 'Present', humanSizeSafe(res.xmp.length) + ' \u2014 raw snippet in Structure tab']);
  }
  if (res.exifTiff && res.exifTiff.root){
    E.push(...exifRows(res.exifTiff));
    if (res.exifTiff.root.next) E.push(['EXIF', 'Thumbnail', '(embedded thumbnail IFD present)']);
  }
  if (res.thumbDims)
    E.push(['EXIF thumbnail', 'Dimensions', `${res.thumbDims.w}\u00d7${res.thumbDims.h} (${humanSizeSafe(res.thumbBytes.length)})`]);
  if (res.sof && res.sof.comps && res.sof.comps.some(c => c.h !== 1 || c.v !== 1))
    E.push(['File', 'Chroma subsampling', 'present (4:2:0 / 4:2:2 style) - normal for camera & web JPEGs']);
}
function humanSizeSafe(n){ return n < 1024 ? n + ' B' : (n/1024).toFixed(1) + ' KB'; }

/* ---------------- PNG ---------------- */
function analyzePNG(dv, bytes){
  const res = { format:'PNG', chunks:[], texts:[], entries:[], findings:[],
                ihdr:null, time:null, gama:null, srgb:null, exifTiff:null };
  res._bytes = bytes;
  let i = 8;
  while (i + 8 <= dv.byteLength){
    const len = dv.getUint32(i, false);
    let typ = '';
    for (let k = 0; k < 4; k++) typ += String.fromCharCode(dv.getUint8(i + 4 + k));
    res.chunks.push({ typ, len, o:i });
    const dp = i + 8;

    switch (typ){
      case 'IHDR':
        res.ihdr = { w: dv.getUint32(dp, false), h: dv.getUint32(dp+4, false),
                     depth: dv.getUint8(dp+8), ct: dv.getUint8(dp+9), interlace: dv.getUint8(dp+12) };
        break;
      case 'tEXt': {
        const s = new TextDecoder('latin1').decode(bytes.subarray(dp, dp + len));
        const z = s.indexOf('\u0000');
        if (z > 0) res.texts.push([s.slice(0, z), s.slice(z + 1)]);
        break;
      }
      case 'iTXt': {
        const seg = bytes.subarray(dp, dp + len);
        const dec = new TextDecoder('utf-8');
        let p = 0, kw = '';
        while (p < seg.length && seg[p] !== 0){ kw += String.fromCharCode(seg[p]); p++; }
        p++;                                  // skip NUL
        const compFlag = seg[p]; p += 2;      // compression flag + method
        let lang = '';
        while (p < seg.length && seg[p] !== 0){ lang += String.fromCharCode(seg[p]); p++; }
        p++;
        while (p < seg.length && seg[p] !== 0) p++;
        p++;
        const txt = compFlag === 1 ? '(deflate-compressed text)' :
                    dec.decode(seg.subarray(Math.min(p, seg.length))).slice(0, 2000);
        res.texts.push([kw || 'iTXt', txt]);
        break;
      }
      case 'zTXt': {
        const s = new TextDecoder('latin1').decode(bytes.subarray(dp, Math.min(dp + 80, dp + len)));
        const z = s.indexOf('\u0000');
        res.texts.push([z > 0 ? s.slice(0, z) : 'zTXt', '(compressed text)']);
        break;
      }
      case 'tIME': {
        const pad = n => String(n).padStart(2, '0');
        res.time = `${dv.getUint16(dp,false)}-${pad(dv.getUint8(dp+2))}-${pad(dv.getUint8(dp+3))} ` +
                   `${pad(dv.getUint8(dp+4))}:${pad(dv.getUint8(dp+5))}:${pad(dv.getUint8(dp+6))}`;
        break;
      }
      case 'eXIf':
        try{ res.exifTiff = parseTIFF(dv, dp); }catch(e){}
        break;
      case 'gAMA': res.gama = (dv.getUint32(dp, false) / 100000).toFixed(5); break;
      case 'sRGB': res.srgb = ['Perceptual','Relative colorimetric','Saturation','Absolute colorimetric'][dv.getUint8(dp)] || dv.getUint8(dp); break;
    }
    i += 12 + len;
    if (typ === 'IEND' || len > dv.byteLength || res.chunks.length > 800) break;
  }

  if (res.ihdr){
    E_push(res, ['File', 'Dimensions', `${res.ihdr.w}\u00d7${res.ihdr.h}`]);
    E_push(res, ['File', 'Pixel format', `${PNG_CT[res.ihdr.ct] || res.ihdr.ct} \u00b7 ${res.ihdr.depth}-bit` +
      (res.ihdr.interlace ? ' \u00b7 interlaced' : '')]);
  }
  if (res.time)     E_push(res, ['File', 'Last modified (tIME)', res.time]);
  if (res.gama)     E_push(res, ['Color', 'gAMA gamma', res.gama]);
  if (res.srgb != null) E_push(res, ['Color', 'sRGB intent', String(res.srgb)]);
  res.texts.forEach(([k, v]) => E_push(res, ['Text chunks', k, v]));
  if (res.exifTiff && res.exifTiff.root) res.entries.push(...exifRows(res.exifTiff));

  buildFindings(res);
  return res;
}
function E_push(res, row){ res.entries.push(row); }

/* ---------------- automatic findings ---------------- */
function buildFindings(res){
  const F = res.findings;
  const soft = findSoftwareStrings(res._bytes);
  if (soft.length)
    F.push(['warn', `Editing/AI-software signature string(s) found inside the file: ${soft.join(', ')}. Post-processing is confirmed; manipulation is possible but not proven.`]);

  const hasExif = !!(res.exifTiff && res.exifTiff.root && res.exifTiff.root.ents.length);
  if (!hasExif)
    F.push(['info', 'No EXIF camera metadata found \u2014 typical after messaging apps or social platforms strip it. This also weakens ELA reliability.']);

  if (hasExif && res.exifTiff.root.next)
    F.push(['ok', 'Embedded EXIF thumbnail present (kept by most in-camera workflows).']);

  /* thumbnail vs primary consistency */
  if (res.thumbDims && res.sof){
    if (res.thumbDims.w > res.sof.w || res.thumbDims.h > res.sof.h ||
        (res.sof.w > 0 && res.thumbDims.w / res.sof.w < 0.02))
      F.push(['warn', `Embedded thumbnail (${res.thumbDims.w}\u00d7${res.thumbDims.h}) is inconsistent with the main image (${res.sof.w}\u00d7${res.sof.h}) \u2014 the thumbnail may predate an edit or the file was spliced.`]);
    else
      F.push(['ok', 'Embedded thumbnail dimensions are consistent with the primary image.']);
  }

  if (res.format === 'JPEG'){
    if (res.sof && res.sof.prog)
      F.push(['info', 'Progressive JPEG encoding \u2014 common for web uploads and some editors.']);
    if (res.comments.length)
      F.push(['info', 'JPEG comment segment(s) present \u2014 review them in the Structure tab.']);
    if (res.dqt.length >= 2){
      const same = JSON.stringify(res.dqt[0].v) === JSON.stringify(res.dqt[1].v);
      F.push(['info', same
        ? 'Luma/chroma quantization tables are identical \u2014 often a sign of a re-encoded image.'
        : 'Distinct luma/chroma quantization tables \u2014 consistent with camera output.']);
    }
  }
  if (res.format === 'PNG'){
    const anc = res.chunks.filter(c => !['IHDR','IDAT','IEND','PLTE'].includes(c.typ)).map(c => c.typ);
    if (anc.includes('tIME')) F.push(['ok', 'PNG tIME chunk present \u2014 gives the file\u2019s last modification timestamp.']);
    if (anc.some(t => ['tEXt','iTXt','zTXt'].includes(t)))
      F.push(['info', 'PNG text chunk(s) present \u2014 may contain editor/software traces (see Metadata rows).']);
  }
}
