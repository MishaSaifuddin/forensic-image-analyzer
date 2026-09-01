'use strict';
/* ============================================================
   ForenScope — PDF report generator
   A minimal, dependency-free PDF 1.4 writer (text + vector +
   embedded JPEG images) plus report assembly from the live
   analysis state. Everything stays on the local machine.
   ============================================================ */

/* ---------------- text / encoding helpers ---------------- */
const LATIN_MAP = {
  '\u00b0':' deg','\u00d7':'x','\u00f7':'/','\u2014':'-','\u2013':'-','\u2018':"'",'\u2019':"'",
  '\u201c':'"','\u201d':'"','\u2026':'...','\u2192':'->','\u2713':'[OK]','\u26a0':'[!]',
  '\u2716':'[X]','\u2139':'[i]','\u0192':'f','\u2264':'<=','\u2265':'>=','\u00b7':'-','\u00a0':' '
};
function latinize(s){
  return String(s ?? '').replace(/[\u0080-\uFFFF]/g,
    ch => LATIN_MAP[ch] !== undefined ? LATIN_MAP[ch] : (ch.charCodeAt(0) <= 0xFF ? ch : '?'));
}
function bstr(s){                       // latin-1 string -> bytes
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}
const pdfEsc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/* ---------------- tiny PDF writer ---------------- */
const REP_W = 595, REP_H = 842, MARGIN = 46;
const CONTENT_BOTTOM = 56;              // footer keep-out zone

class MiniPDF{
  constructor(){
    this.bodies = [];                   // string | {head, data:Uint8Array}
    this.pages  = [];
    /* obj 1..3 = fonts, obj 4 reserved for /Pages */
    this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    this.add(null);
    this._catalog = 0; this._info = 0;
  }
  add(body){ this.bodies.push(body); return this.bodies.length; }

  addPage(){
    const p = { ops:[], imgs:Object.create(null), imgN:0, num:0, _closed:false };
    this.pages.push(p);
    return p;
  }
  addImage(p, canvas, jpegQuality){
    const url  = canvas.toDataURL('image/jpeg', jpegQuality || 0.88);
    const b64  = url.slice(url.indexOf(',') + 1);
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const num  = this.add({
      head:`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
           `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`,
      data
    });
    const name = 'Im' + (++p.imgN);
    p.imgs[name] = num;
    return name;
  }
  endPage(p, pageNo){
    if (p._closed) return;
    p._closed = true;
    const gray = '0.45 0.49 0.55';
    p.ops.push(`${gray} rg BT /F1 7.5 Tf 1 0 0 1 ${MARGIN} ${REP_H - 30} Tm (${pdfEsc(latinize('ForenScope forensic image analysis - results are indicators, not proof of manipulation.'))}) Tj ET`);
    const right = `Page ${pageNo}`;
    const rx = (REP_W - MARGIN - right.length * 7.5 * 0.50).toFixed(1);
    p.ops.push(`${gray} rg BT /F1 7.5 Tf 1 0 0 1 ${rx} ${REP_H - 30} Tm (${pdfEsc(right)}) Tj ET`);

    const content = p.ops.join('\n');
    const cObj = this.add({ head:`<< /Length ${content.length} >>\nstream\n`, data:bstr(content) });
    const xo = Object.keys(p.imgs).length
      ? ' /XObject << ' + Object.entries(p.imgs).map(([n, o]) => `/${n} ${o} 0 R`).join(' ') + ' >>'
      : '';
    p.num = this.add(
      `<< /Type /Page /Parent 4 0 R /MediaBox [0 0 ${REP_W} ${REP_H}] ` +
      `/Resources << /Font << /F1 1 0 R /F2 2 0 R /F3 3 0 R >>${xo} >> /Contents ${cObj} 0 R >>`
    );
  }
  finish(title){
    const kids = this.pages.map(p => `${p.num} 0 R`).join(' ');
    this.bodies[3] = `<< /Type /Pages /Kids [ ${kids} ] /Count ${this.pages.length} >>`;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const d = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}` +
              `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    this._info    = this.add(`<< /Title (${pdfEsc(latinize(title))}) /Producer (ForenScope) /Creator (ForenScope web) /CreationDate (D:${d}) >>`);
    this._catalog = this.add('<< /Type /Catalog /Pages 4 0 R >>');

    const head = bstr('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
    let len = head.length;
    const parts = [head], offs = [];
    this.bodies.forEach((b, i) => {
      offs[i] = len;
      const n1 = bstr(`${i + 1} 0 obj\n`);  parts.push(n1); len += n1.length;
      if (typeof b === 'string'){
        const s = bstr(b + '\n');           parts.push(s);  len += s.length;
      } else {
        const h = bstr(b.head);             parts.push(h);  len += h.length;
        parts.push(b.data);                 len += b.data.length;
        const e = bstr('\nendstream\n');    parts.push(e);  len += e.length;
      }
      const e2 = bstr('endobj\n');          parts.push(e2); len += e2.length;
    });
    const xrefOff = len;
    let xr = `xref\n0 ${this.bodies.length + 1}\n0000000000 65535 f \n`;
    offs.forEach(o => xr += String(o).padStart(10, '0') + ' 00000 n \n');
    xr += `trailer\n<< /Size ${this.bodies.length + 1} /Root ${this._catalog} 0 R /Info ${this._info} 0 R >>\n` +
          `startxref\n${xrefOff}\n%%EOF\n`;
    parts.push(bstr(xr));
    return new Blob(parts, { type:'application/pdf' });
  }
}

/* ---------------- drawing helpers (y measured from top) ---------------- */
const WIDTH_K = { F1:.500, F2:.535, F3:.600 };
const estW = (s, f, sz) => String(s).length * WIDTH_K[f] * sz;

function txt(p, x, yTop, s, { f='F1', sz=10, c='0.13 0.15 0.18' } = {}){
  p.ops.push(`${c} rg BT /${f} ${sz} Tf 1 0 0 1 ${Number(x).toFixed(1)} ${(REP_H - yTop).toFixed(1)} Tm (${pdfEsc(latinize(s))}) Tj ET`);
}
function fillRect(p, x, yTop, w, h, c){
  p.ops.push(`${c} rg ${x.toFixed(1)} ${(REP_H - yTop - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
}
function hline(p, x, yTop, w, c, lw){
  p.ops.push(`${c} RG ${(lw || .7)} w ${x.toFixed(1)} ${(REP_H - yTop).toFixed(1)} m ${(x + w).toFixed(1)} ${(REP_H - yTop).toFixed(1)} l S`);
}
function drawImage(p, x, yTop, w, h, holder){
  const name = holder.addImage(p, holder.canvas);
  p.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(REP_H - yTop - h).toFixed(2)} cm /${name} Do Q`);
}

function wrapText(text, maxW, f='F1', sz=10){
  const out = [];
  for (const raw of String(text ?? '').split('\n')){
    if (raw === ''){ out.push(''); continue; }
    let line = '';
    for (const tok of raw.split(/\s+/)){
      if (!tok) continue;
      let word = tok;
      if (estW(line ? line + ' ' + word : word, f, sz) <= maxW){
        line = line ? line + ' ' + word : word;
        continue;
      }
      if (line){ out.push(line); line = ''; }
      const cutLen = Math.max(1, Math.floor(maxW / (WIDTH_K[f] * sz)));
      while (estW(word, f, sz) > maxW){          // hard-split oversized tokens (hashes, URLs)
        out.push(word.slice(0, cutLen));
        word  = word.slice(cutLen);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}

/* ---------------- page chrome ---------------- */
function pageHeader(p, fileName){
  fillRect(p, 0, 0, REP_W, 4, '0.208 0.769 0.863');
  txt(p, MARGIN, 22, 'ForenScope - forensic image analysis report', { sz:8, c:'0.45 0.49 0.55' });
  const fn = String(fileName || '');
  const short = fn.length > 58 ? fn.slice(0, 55) + '...' : fn;
  txt(p, REP_W - MARGIN - estW(short, 'F1', 8), 22, short, { sz:8, c:'0.45 0.49 0.55' });
  hline(p, MARGIN, 32, REP_W - 2 * MARGIN, '0.85 0.88 0.91', .7);
}
function sectionTitle(p, t){
  txt(p, MARGIN, p.y + 14, t, { f:'F2', sz:13, c:'0.10 0.12 0.15' });
  hline(p, MARGIN, p.y + 21, REP_W - 2 * MARGIN, '0.208 0.769 0.863', 1.1);
  p.y += 34;
}
/* flows across pages when `flip` is provided; returns the (possibly new) page */
function para(p, text, { w, f='F1', sz=9.5, c='0.25 0.28 0.33', lh } = {}, flip){
  const width = w || REP_W - 2 * MARGIN;
  const dy = lh || sz * 1.38;
  for (const ln of wrapText(text, width, f, sz)){
    if (p.y + dy > REP_H - CONTENT_BOTTOM){
      if (!flip) return p;
      p = flip();
    }
    txt(p, MARGIN, p.y, ln, { f, sz, c });
    p.y += dy;
  }
  return p;
}
/* key-value row with wrapping value column; false => caller must flip */
function kvRow(p, k, v, { keyW=150, sz=9 } = {}){
  const lines = wrapText(String(v ?? ''), REP_W - 2 * MARGIN - keyW - 8, 'F1', sz);
  const dy = sz * 1.38;
  if (p.y + lines.length * dy > REP_H - CONTENT_BOTTOM) return false;
  txt(p, MARGIN + keyW - estW(k, 'F1', sz) - 6, p.y, k, { sz, c:'0.45 0.49 0.55' });
  lines.forEach((ln, i) => txt(p, MARGIN + keyW, p.y + i * dy, ln, { sz }));
  p.y += lines.length * dy + 2;
  return true;
}

/* ================= data prep ================= */
async function shaHex(buf, alg){
  try{
    const d = await crypto.subtle.digest(alg, buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }catch(e){ return '(unavailable in this context)'; }
}
function toReportCanvas(src, maxDim){
  if (Math.max(src.width, src.height) <= maxDim) return src;
  const s = maxDim / Math.max(src.width, src.height);
  const c = mkCanvas(Math.round(src.width * s), Math.round(src.height * s));
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function imageDataToCanvas(imgData){
  const c = mkCanvas(imgData.width, imgData.height);
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}
async function buildViewList(){
  const views = [];
  views.push(['Original (flattened to RGB)', S.src,
    'The source image as decoded by the browser; transparency flattened onto white.']);

  await ensureResave();
  views.push([`Error Level Analysis - quality ${Math.round(S.elaQ * 100)}%, amplification x${S.elaAmp}${S.elaGray ? ', grayscale' : ''}`,
    imageDataToCanvas(buildELA()),
    'Each pixel shows the difference between the original and a fresh JPEG re-save at the chosen quality. Uniformly dark areas share the same compression history; brighter patches were compressed differently and deserve closer inspection.']);

  views.push([`Luminance Gradient - gain x${S.gradGain}`,
    imageDataToCanvas(buildGradient()),
    'Horizontal and vertical luminance gradients. Spliced-in regions often show discontinuous edge energy or lighting direction that conflicts with the rest of the scene.']);

  views.push([`Noise / High-Pass Residual - gain x${S.noiseGain}`,
    imageDataToCanvas(buildNoise()),
    'Pixel values minus their local mean. Consistent fine texture is expected from one sensor; smooth patches or mismatched noise structure can indicate retouching, inpainting or paste-overs.']);

  const chName = ['Red', 'Green', 'Blue', 'Luma'][S.bitCh];
  views.push([`Bit Plane - ${chName} channel, bit ${S.bitN}`,
    imageDataToCanvas(buildBits()),
    'A single bit of the selected channel across the whole image. Structured shapes in low bits (especially bit 0) can reveal pasted content, watermarks or steganographic remnants.']);

  return views.map(([t, cv, note]) => [t, toReportCanvas(cv, 1400), note]);
}

/* ================= report assembly ================= */
async function generateReport(caseMeta){
  if (!S.img) throw new Error('no image loaded');
  const doc = new MiniPDF();

  const newPage = () => {
    const p = doc.addPage();
    pageHeader(p, S.name);
    p.y = 52;
    return p;
  };
  const ensure = (p, neededH) => {
    if (p.y + neededH <= REP_H - CONTENT_BOTTOM) return p;
    doc.endPage(p, doc.pages.length);
    return newPage();
  };

  /* ---------- page 1: title & case ---------- */
  let p = newPage();
  p.y = 96;
  txt(p, MARGIN, p.y, 'FORENSIC IMAGE ANALYSIS REPORT', { f:'F2', sz:21, c:'0.08 0.10 0.13' }); p.y += 17;
  txt(p, MARGIN, p.y, 'generated locally with ForenScope - no data left this workstation', { sz:9, c:'0.45 0.49 0.55' }); p.y += 15;
  hline(p, MARGIN, p.y, REP_W - 2 * MARGIN, '0.208 0.769 0.863', 1.4); p.y += 18;

  const now = new Date();
  sectionTitle(p, 'Case information');
  const caseRows = [
    ['Case / exhibit ID', caseMeta.caseId || '(not provided)'],
    ['Analyst',           caseMeta.analyst || '(not provided)'],
    ['Notes',             caseMeta.notes || '-'],
    ['Report generated',  now.toString()],
    ['Tool',              'ForenScope web edition (client-side analysis)'],
  ];
  for (const [k, v] of caseRows){
    if (!kvRow(p, k, v)){ doc.endPage(p, doc.pages.length); p = newPage(); kvRow(p, k, v); }
  }

  /* ---------- file identification ---------- */
  p = ensure(p, 170);
  sectionTitle(p, 'File identification');
  const fileRows = [
    ['File name', S.name],
    ['Detected format', (S.meta && S.meta.format) || S.mime || '?'],
    ['Dimensions', `${S.w} x ${S.h} px`],
    ['File size', `${humanSize(S.size)} (${S.size.toLocaleString()} bytes)`],
    ['MIME type (browser)', S.mime || '(unknown)'],
    ['SHA-256', await shaHex(S.bytes, 'SHA-256')],
    ['SHA-1',   await shaHex(S.bytes, 'SHA-1')],
  ];
  for (const [k, v] of fileRows){
    if (!kvRow(p, k, v)){ doc.endPage(p, doc.pages.length); p = newPage(); kvRow(p, k, v); }
  }

  /* ---------- findings ---------- */
  p = ensure(p, 90);
  sectionTitle(p, 'Automatic findings');
  const findings = (S.meta && S.meta.findings && S.meta.findings.length)
    ? S.meta.findings : [['ok', 'No structural red flags found in metadata or container layout.']];
  for (const [cls, msg] of findings){
    const tag   = cls === 'warn' ? '[!] ' : cls === 'bad' ? '[X] ' : cls === 'ok' ? '[OK] ' : '[i] ';
    const color = cls === 'warn' ? '0.75 0.42 0.02' : cls === 'bad' ? '0.78 0.13 0.13'
                : cls === 'ok' ? '0.13 0.55 0.13' : '0.11 0.47 0.62';
    const lines = wrapText(tag + msg, REP_W - 2 * MARGIN - 14, 'F1', 9);
    if (p.y + lines.length * 12.4 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
    for (const ln of lines){ txt(p, MARGIN + 14, p.y, ln, { sz:9, c:color }); p.y += 12.4; }
    p.y += 3;
  }

  /* ---------- metadata ---------- */
  p = ensure(p, 120);
  sectionTitle(p, 'Extracted metadata');
  const entries = (S.meta && S.meta.entries) || [];
  if (entries.length){
    const groups = {};
    for (const [g, k, v] of entries) (groups[g] = groups[g] || []).push([k, v]);
    for (const g of Object.keys(groups)){
      p = ensure(p, 44);
      txt(p, MARGIN, p.y, g.toUpperCase(), { f:'F2', sz:9, c:'0.35 0.40 0.47' }); p.y += 13;
      for (const [k, v] of groups[g]){
        if (!kvRow(p, k, v)){
          doc.endPage(p, doc.pages.length); p = newPage();
          txt(p, MARGIN, p.y, g.toUpperCase() + ' (continued)', { f:'F2', sz:9, c:'0.35 0.40 0.47' }); p.y += 13;
          kvRow(p, k, v);
        }
      }
      p.y += 6;
    }
    if (S.gpsLink) p = para(p, `GPS coordinates available - opens at: ${S.gpsLink}`, { sz:8.5, c:'0.11 0.47 0.62' }, () => newPage());
  } else {
    para(p, 'No EXIF/PNG metadata entries were found. Metadata stripping is typical when files pass through messaging apps or social platforms.', { c:'0.45 0.49 0.55' });
    p.y += 6;
  }

  /* ---------- histogram ---------- */
  p = ensure(p, 280);
  sectionTitle(p, 'Colour histogram');
  {
    const histCv = $('#histCv');
    if (histCv){
      const dispW = 320, dispH = dispW * histCv.height / histCv.width;
      if (p.y + dispH + 46 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
      drawImage(p, MARGIN, p.y, dispW, dispH, { canvas:histCv, addImage:(pp, cv) => doc.addImage(pp, cv) });
      p.y += dispH + 10;
      p = para(p, 'Clipped peaks at 0/255 suggest exposure or contrast edits; comb-like gaps indicate re-quantization from double compression.',
        { sz:8.5, c:'0.45 0.49 0.55' }, () => newPage());
      p.y += 6;
    }
  }

  /* ---------- structure ---------- */
  if (S.meta && S.meta.format === 'JPEG'){
    p = ensure(p, 150);
    sectionTitle(p, 'JPEG segment layout');
    const segs = S.meta.segments.slice(0, 80);
    const colN = MARGIN, colO = MARGIN + 250, colL = MARGIN + 350;
    txt(p, colN, p.y, 'SEGMENT', { f:'F2', sz:8, c:'0.55 0.60 0.66' });
    txt(p, colO, p.y, 'OFFSET',  { f:'F2', sz:8, c:'0.55 0.60 0.66' });
    txt(p, colL, p.y, 'LENGTH',  { f:'F2', sz:8, c:'0.55 0.60 0.66' });
    p.y += 11;
    for (const s of segs){
      if (p.y + 11 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
      txt(p, colN, p.y, s.n, { f:'F3', sz:8 });
      txt(p, colO, p.y, s.o.toLocaleString(), { f:'F3', sz:8 });
      txt(p, colL, p.y, s.l == null ? '-' : s.l.toLocaleString(), { f:'F3', sz:8 });
      p.y += 10.5;
    }
    if (S.meta.segments.length > segs.length){
      p = para(p, `(+${S.meta.segments.length - segs.length} more segments omitted)`, { sz:8, c:'0.55 0.60 0.66' }, () => newPage());
    }
    p.y += 6;

    if ((S.meta.dqt || []).length){
      p = ensure(p, 130);
      sectionTitle(p, 'JPEG quantization tables');
      S.meta.dqt.forEach((t, ti) => {
        p = ensure(p, 110);
        txt(p, MARGIN, p.y, `Table #${ti} - id ${t.id}, ${t.pq ? '16-bit' : '8-bit'} precision`, { f:'F2', sz:9, c:'0.25 0.28 0.33' });
        p.y += 13;
        for (let r = 0; r < 8; r++){
          if (p.y + 11 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
          const row = [];
          for (let q = 0; q < 8; q++) row.push(String(t.v[r * 8 + q]).padStart(5, ' '));
          txt(p, MARGIN + 8, p.y, row.join(' '), { f:'F3', sz:8.5, c:'0.20 0.24 0.30' });
          p.y += 10.5;
        }
        p.y += 8;
      });
    }
    if ((S.meta.comments || []).length){
      p = ensure(p, 70);
      sectionTitle(p, 'JPEG comments');
      for (const c of S.meta.comments) p = para(p, `"${c}"`, { sz:8.5, c:'0.35 0.40 0.47', f:'F3' }, () => newPage());
    }
    if (S.meta.xmp){
      p = ensure(p, 80);
      sectionTitle(p, 'XMP packet (excerpt)');
      p = para(p, S.meta.xmp.replace(/\s+/g, ' ').slice(0, 1400), { f:'F3', sz:7.5, c:'0.35 0.40 0.47' }, () => newPage());
    }
  }
  else if (S.meta && S.meta.format === 'PNG'){
    p = ensure(p, 160);
    sectionTitle(p, 'PNG chunk summary');
    const counts = {};
    (S.meta.chunks || []).forEach(c => counts[c.typ] = (counts[c.typ] || 0) + 1);
    const colT = MARGIN, colC = MARGIN + 160, colB = MARGIN + 240;
    txt(p, colT, p.y, 'CHUNK', { f:'F2', sz:8, c:'0.55 0.60 0.66' });
    txt(p, colC, p.y, 'COUNT', { f:'F2', sz:8, c:'0.55 0.60 0.66' });
    txt(p, colB, p.y, 'BYTES', { f:'F2', sz:8, c:'0.55 0.60 0.66' });
    p.y += 11;
    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(t => {
      if (p.y + 11 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
      const bytes = S.meta.chunks.filter(c => c.typ === t).reduce((a, c) => a + c.len, 0);
      txt(p, colT, p.y, t, { f:'F3', sz:8 });
      txt(p, colC, p.y, String(counts[t]), { f:'F3', sz:8 });
      txt(p, colB, p.y, humanSizeSafe(bytes), { f:'F3', sz:8 });
      p.y += 10.5;
    });
    if ((S.meta.texts || []).length){
      p = ensure(p, 70);
      sectionTitle(p, 'PNG text chunks');
      for (const [k, v] of S.meta.texts){
        if (!kvRow(p, k, v)){ doc.endPage(p, doc.pages.length); p = newPage(); kvRow(p, k, v); }
      }
    }
  }

  /* ---------- visual analyses ---------- */
  const views = await buildViewList();
  const availW = REP_W - 2 * MARGIN;
  for (const [title, cv, note] of views){
    let w = availW, h = w * cv.height / cv.width;
    if (h > 470){ h = 470; w = h * cv.width / cv.height; }
    const noteLines = note ? wrapText(note, availW, 'F1', 8.5).length : 0;
    p = ensure(p, h + 40 + noteLines * 11.8 + 18);
    sectionTitle(p, title);
    if (note){
      p = para(p, note, { sz:8.5, c:'0.45 0.49 0.55' });
      p.y += 4;
    }
    drawImage(p, MARGIN + (availW - w) / 2, p.y, w, h, { canvas:cv, addImage:(pp, c2) => doc.addImage(pp, c2) });
    p.y += h + 16;
  }

  /* ---------- overall authenticity assessment ---------- */
  {
    if (!S.scores && typeof computeScores === 'function') computeScores();
    const sc = S.scores;
    if (sc){
      p = ensure(p, 240);
      sectionTitle(p, 'Overall authenticity assessment');
      const gaugeCv = document.getElementById('gaugeCv');
      if (gaugeCv){
        drawImage(p, MARGIN, p.y, 190, 110, { canvas:gaugeCv, addImage:(pp, c2) => doc.addImage(pp, c2) });
      }
      txt(p, MARGIN + 205, p.y + 10, `${sc.score} / 100`, { f:'F2', sz:15 });
      txt(p, MARGIN + 205, p.y + 28,
          sc.risk === 'low' ? 'No significant indicators'
        : sc.risk === 'medium' ? 'Some indicators present - review views'
        : sc.risk === 'elevated' ? 'Multiple indicators - treat with caution'
        : 'Strong indicators of manipulation',
          { sz:9, c:'0.45 0.49 0.55' });
      txt(p, MARGIN + 205, p.y + 44, 'composite heuristic score - NOT proof', { sz:7.5, c:'0.62 0.30 0.03' });
      p.y += 118;

      for (const r of (sc.rows || [])){
        if (p.y + 12 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
        const col = (r.risk || 0) >= .55 ? '0.78 0.13 0.13'
                  : (r.risk || 0) >= .25 ? '0.75 0.42 0.02' : '0.13 0.55 0.13';
        txt(p, MARGIN,      p.y, r.name, { f:'F2', sz:9 });
        txt(p, MARGIN + 170, p.y, r.note || '', { f:'F3', sz:7.5, c:'0.45 0.49 0.55' });
        txt(p, REP_W - MARGIN - 44, p.y, Math.round((r.risk || 0) * 100) + '%', { f:'F2', sz:9, c:col });
        p.y += 12.5;
      }
      p.y += 6;

      try{
        const h = await ensureHashes();
        p = ensure(p, 90);
        txt(p, MARGIN, p.y, 'FILE HASHES / PERCEPTUAL FINGERPRINTS', { f:'F2', sz:9, c:'0.35 0.40 0.47' }); p.y += 13;
        for (const [k, v] of [['MD5', h.md5], ['SHA-256', h.sha256], ['aHash', h.ahash], ['dHash', h.dhash]]){
          if (!v) continue;
          for (const ln of wrapText(`${k}:  ${v}`, REP_W - 2 * MARGIN, 'F3', 8)){
            if (p.y + 11 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
            txt(p, MARGIN, p.y, ln, { f:'F3', sz:8 }); p.y += 10.6;
          }
          p.y += 1;
        }
      }catch(e){}
      p.y += 4;
      p = para(p,
        'The authenticity score aggregates independent screening techniques (metadata warnings, ELA variance, JPEG ghost clusters, copy-move detection, PRNU consistency, spectral anomalies, resampling traces, LSB steganalysis). Each component is probabilistic; the composite must be treated as a triage aid that directs manual review, never as a verdict.',
        { sz:8.5, c:'0.45 0.49 0.55' }, () => newPage());
      p.y += 8;
    }
  }

  /* ---------- advanced analyses ---------- */
  {
    const advEntries = Object.entries(S.adv || {});
    if (advEntries.length){
      p = ensure(p, 140);
      sectionTitle(p, 'Advanced analyses');
      const availW = REP_W - 2 * MARGIN;
      for (const [, res] of advEntries){
        let w = availW, h = w * res.canvas.height / res.canvas.width;
        if (h > 430){ h = 430; w = h * res.canvas.width / res.canvas.height; }
        const lineH = res.lines.reduce((a, l) => a + wrapText(l, availW - 10, 'F1', 8.5).length * 11.6 + 3, 0);
        p = ensure(p, h + lineH + 52);
        txt(p, MARGIN, p.y, res.title.toUpperCase(), { f:'F2', sz:9.5, c:'0.35 0.40 0.47' }); p.y += 13;
        for (const ln of res.lines){
          for (const wl of wrapText('\u2022 ' + ln, availW - 10, 'F1', 8.5)){
            if (p.y + 12 > REP_H - CONTENT_BOTTOM){ doc.endPage(p, doc.pages.length); p = newPage(); }
            txt(p, MARGIN, p.y, wl, { sz:8.5, c:'0.20 0.24 0.30' }); p.y += 11.6;
          }
          p.y += 3;
        }
        p.y += 4;
        drawImage(p, MARGIN + (availW - w) / 2, p.y, w, h, { canvas:res.canvas, addImage:(pp, c2) => doc.addImage(pp, c2) });
        p.y += h + 16;
      }
    }
  }

  /* ---------- interpretation & limitations ---------- */
  p = ensure(p, 230);
  sectionTitle(p, 'How to read these results');
  p = para(p,
    'Error Level Analysis works because every JPEG save leaves quantization fingerprints. Regions edited after the last save respond differently to re-compression than untouched regions. However, uniform processing (filters, re-shares, platform re-encodes) flattens ELA response, and naturally textured areas can look bright without any tampering.',
    {}, () => newPage());
  p.y += 4;
  p = para(p,
    'Noise and gradient views support ELA: consistent sensor noise and coherent light direction across the frame are expected in camera originals. Bit-plane views expose low-bit structures invisible at normal viewing.',
    {}, () => newPage());
  p.y += 4;
  p = para(p,
    'Metadata provides provenance clues - camera model, timestamps, editing software traces - but absence of metadata is normal for re-shared media, and editor strings alone do not prove malicious manipulation.',
    {}, () => newPage());
  p.y += 6;
  p = para(p,
    'LIMITATIONS: These techniques are screening indicators, not proof. Conclude only after corroborating with original files, hash comparison against trusted sources, reverse-image searches and, where warranted, expert examination.',
    { c:'0.62 0.30 0.03' }, () => newPage());

  /* ---------- finalize ---------- */
  for (let i = 0; i < doc.pages.length; i++) doc.endPage(doc.pages[i], i + 1);

  const blob  = doc.finish('ForenScope report - ' + S.name);
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '').replace('-', '');
  const cs    = (caseMeta.caseId || 'case').replace(/[^\w.-]+/g, '_') || 'case';
  const fname = `forenscope_report_${cs}_${stamp}.pdf`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  return fname;
}
