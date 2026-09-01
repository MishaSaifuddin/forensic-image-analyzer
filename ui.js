'use strict';
/* ============================================================
   ForenScope — UI rendering + event wiring
   ============================================================ */

/* ================= metadata tab ================= */
function renderMetaTab(){
  const el = $('#tab-meta');
  if (!S.meta){
    el.innerHTML = '<p class="placeholder">Load an image to inspect its EXIF / PNG metadata and automatic findings.</p>';
    return;
  }
  const m = S.meta;
  const parts = [];

  parts.push('<h3>Automatic findings</h3>');
  const f = (m.findings && m.findings.length)
    ? m.findings.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join('')
    : '<li class="ok">No structural red flags found. Manual review of the analysis views is still recommended.</li>';
  parts.push(`<ul class="findings">${f}</ul>`);

  parts.push('<h3>File</h3><div class="kv">');
  parts.push(kv('Name', S.name));
  parts.push(kv('Format', m.format || '?'));
  parts.push(kv('Size', humanSize(S.size) + ` (${S.size.toLocaleString()} bytes)`));
  if (m.note) parts.push(kv('Note', m.note));
  for (const [g, k, v] of (m.entries || [])){
    if (g === 'File') parts.push(kv(k, v));
  }
  parts.push('</div>');

  const groups = {};
  for (const [g, k, v] of (m.entries || [])){
    if (g === 'File') continue;
    (groups[g] = groups[g] || []).push([k, v]);
  }
  for (const g of Object.keys(groups)){
    parts.push(`<h3>${esc(g)}</h3><div class="kv">`);
    for (const [k, v] of groups[g]) parts.push(kv(k, v));
    parts.push('</div>');
  }

  /* embedded EXIF thumbnail */
  if (m.thumbBytes){
    try{
      if (S.thumbUrl) URL.revokeObjectURL(S.thumbUrl);
      S.thumbUrl = URL.createObjectURL(new Blob([m.thumbBytes], { type: 'image/jpeg' }));
      parts.push(`<h3>Embedded EXIF thumbnail</h3><img class="thumbPrev" alt="embedded thumbnail" src="${S.thumbUrl}">`);
      if (m.thumbDims)
        parts.push(`<p class="hint" style="margin-top:2px">Thumbnail is ${m.thumbDims.w}\u00d7${m.thumbDims.h} \u2014 compare with the main image (${S.w}\u00d7${S.h}).</p>`);
    }catch(e){}
  }

  if (S.gpsLink)
    parts.push(`<p style="margin-top:10px"><a href="${esc(S.gpsLink)}" target="_blank" rel="noopener">Open GPS coordinates in maps \u2197</a></p>`);

  el.innerHTML = parts.join('');

  function kv(k, v){ return `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`; }
}

/* ================= structure tab ================= */
function renderStructTab(){
  const el = $('#tab-struct');
  if (!S.meta){
    el.innerHTML = '<p class="placeholder">Load an image to see its JPEG segments / quantization tables / PNG chunks.</p>';
    return;
  }
  const m = S.meta;
  const parts = [];

  if (m.format === 'JPEG'){
    parts.push('<h3>Segment layout</h3><table class="struct"><tr><th>segment</th><th>offset</th><th>length</th></tr>');
    for (const s of m.segments.slice(0, 120))
      parts.push(`<tr><td>${esc(s.n)}</td><td>${s.o.toLocaleString()}</td><td>${s.l == null ? '\u2014' : s.l.toLocaleString()}</td></tr>`);
    parts.push('</table>');

    const st = m.stats || {};
    parts.push(`<h3>Scan statistics</h3><div class="kv">
      ${kv('Restart markers', st.restarts ?? 0)}
      ${kv('Huffman segments', st.dhtCount ?? 0)}
      ${kv('EOI present', st.eoiSeen ? 'yes' : 'no / trailing data')}
      ${kv('Trailing bytes after EOI', (st.eoiSeen && S.size > 0) ? '?' : '?')}
    </div>`);

    if ((st.dhtCount || 0) === 0)
      parts.push('<ul class="findings"><li class="info">No DHT before SOS \u2014 likely a shortened/optimized stream or parse stopped early.</li></ul>');

    if (m.dqt.length){
      parts.push('<h3>Quantization table(s)</h3>');
      m.dqt.forEach((t, ti) => {
        parts.push(`<div style="margin:8px 0 2px;color:var(--dim);font-size:11px">Table #${ti} \u00b7 id ${t.id} \u00b7 ${t.pq ? '16-bit' : '8-bit'} precision</div>`);
        parts.push('<div class="dqtgrid">');
        for (let k = 0; k < 64; k++) parts.push(`<span>${t.v[k]}</span>`);
        parts.push('</div>');
      });
      parts.push('<p class="hint" style="margin-top:4px">Low values (top-left) = high frequencies preserved. Uniform high values hint at heavy re-compression.</p>');
    }

    if (m.xmp){
      parts.push('<h3>XMP snippet</h3><table class="struct"><tr><td>' +
        esc(m.xmp.slice(0, 900)).replace(/\s+/g, ' ') +
        (m.xmp.length > 900 ? ' \u2026' : '') + '</td></tr></table>');
    }
    if (m.comments && m.comments.length){
      parts.push('<h3>Comments</h3>');
      m.comments.forEach(c => parts.push(`<table class="struct"><tr><td>${esc(c)}</td></tr></table>`));
    }
  }
  else if (m.format === 'PNG'){
    const counts = {};
    m.chunks.forEach(c => counts[c.typ] = (counts[c.typ] || 0) + 1);
    parts.push('<h3>Chunk summary</h3><table class="struct"><tr><th>chunk</th><th>count</th><th>bytes</th></tr>');
    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(t => {
      const bytes = m.chunks.filter(c => c.typ === t).reduce((a, c) => a + c.len, 0);
      parts.push(`<tr><td>${esc(t)}</td><td>${counts[t]}</td><td>${humanSizeSafe(bytes)}</td></tr>`);
    });
    parts.push('</table>');
    parts.push('<h3>Chunk order (first 60)</h3><table class="struct"><tr><th>#</th><th>type</th><th>offset</th><th>len</th></tr>');
    m.chunks.slice(0, 60).forEach((c, i) =>
      parts.push(`<tr><td>${i+1}</td><td>${esc(c.typ)}</td><td>${c.o.toLocaleString()}</td><td>${c.len.toLocaleString()}</td></tr>`));
    parts.push('</table>');
  }
  else {
    parts.push(`<p class="placeholder">${esc(m.note || 'No structural details available for this format.')}</p>`);
  }

  el.innerHTML = parts.join('');

  function kv(k, v){ return `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`; }
}

/* ================= save view ================= */
function saveView(){
  if (!S.view) return;
  S.view.toBlob(b => {
    if (!b) return toast('Nothing to save.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    const base = (S.name.replace(/\.[^.]+$/, '') || 'image');
    a.download = `${base}_forenscope_${S.tool}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

/* ================= wiring ================= */
function wire(){
  $('#btnOpen').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });

  $('#btnSave').addEventListener('click', saveView);
  $('#btnReport').addEventListener('click', () => $('#dlgWrap').classList.remove('hidden'));
  $('#repCancel').addEventListener('click', () => $('#dlgWrap').classList.add('hidden'));
  $('#dlgWrap').addEventListener('click', e => {
    if (e.target === e.currentTarget) $('#dlgWrap').classList.add('hidden');
  });
  $('#repGo').addEventListener('click', async () => {
    const meta = {
      caseId:  $('#repCase').value.trim(),
      analyst: $('#repAnalyst').value.trim(),
      notes:   $('#repNotes').value.trim(),
    };
    $('#dlgWrap').classList.add('hidden');
    if (!S.img) return toast('Load an image first.');
    toast('Building PDF report…');
    try{
      const fname = await generateReport(meta);
      toast('Report saved: ' + fname);
    }catch(err){
      console.error(err);
      toast('PDF generation failed: ' + err.message);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){
      $('#dlgWrap').classList.add('hidden');
      $('#helpWrap').classList.add('hidden');
    }
  });
  $('#btnFit').addEventListener('click', setZoomFit);
  $('#btn100').addEventListener('click', () => setZoom(1));

  const zi = $('#btnZi'), zo = $('#btnZo');
  const zoomStep = mult => {
    const r = S.view.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect();
    const cx = Math.max(r.left, Math.min(r.right, sr.left + sr.width / 2));
    const cy = Math.max(r.top,  Math.min(r.bottom, sr.top + sr.height / 2));
    setZoom(S.zoom * mult, { cx, cy });
  };
  zi.addEventListener('click', () => zoomStep(1.25));
  zo.addEventListener('click', () => zoomStep(0.8));

  $$('#tools .tool').forEach(b =>
    b.addEventListener('click', () => selectTool(b.dataset.t)));

  /* ELA controls */
  const elaQChanged = debounce(async () => { await ensureResave(); renderView(); }, 180);
  $('#elaQ').addEventListener('input', e => {
    S.elaQ = e.target.value / 100;
    $('#elaQOut').textContent = e.target.value;
    cacheInvalidate('ela');
    elaQChanged();
  });
  $('#elaAmp').addEventListener('input', e => {
    S.elaAmp = +e.target.value;
    $('#elaAmpOut').textContent = e.target.value;
    cacheInvalidate('ela');
    renderView();
  });
  $('#elaGray').addEventListener('change', e => {
    S.elaGray = e.target.checked;
    cacheInvalidate('ela');
    renderView();
  });

  $('#gradGain').addEventListener('input', e => {
    S.gradGain = +e.target.value;
    $('#gradGainOut').textContent = e.target.value;
    renderView();
  });
  $('#noiseGain').addEventListener('input', e => {
    S.noiseGain = +e.target.value;
    $('#noiseGainOut').textContent = e.target.value;
    renderView();
  });

  $$('#bitChSel button').forEach(b => b.addEventListener('click', () => {
    S.bitCh = +b.dataset.c;
    $$('#bitChSel button').forEach(x => x.classList.toggle('on', x === b));
    renderView();
  }));
  $$('#bitNSel button').forEach(b => b.addEventListener('click', () => {
    S.bitN = +b.dataset.n;
    $$('#bitNSel button').forEach(x => x.classList.toggle('on', x === b));
    renderView();
  }));

  /* ---------- advanced tools ---------- */
  $('#btnSample').addEventListener('click', () => loadSampleImage());
  const bindRun = (sel, t) => $(sel).addEventListener('click', () => {
    if (!S.img) return toast('Load an image first.');
    ADV.render(t);
  });
  bindRun('#btnRunGhost', 'ghost');
  bindRun('#btnRunCmfd',  'cmfd');
  bindRun('#btnRunPrnu',  'prnu');
  $('#cmfdSim').addEventListener('input', e => { $('#cmfdSimOut').textContent = e.target.value; });
  $('#cmfdMin').addEventListener('input', e => { $('#cmfdMinOut').textContent = e.target.value; });
  $$('#stegoChSel button').forEach(b => b.addEventListener('click', () => {
    S.stegoCh = +b.dataset.c;
    $$('#stegoChSel button').forEach(x => x.classList.toggle('on', x === b));
    if (S.img) ADV.render('stego');
  }));

  /* technique guides */
  document.addEventListener('click', e => {
    const g = e.target.closest('.guide');
    if (g) openHelp(g.dataset.help);
    const cb = e.target.closest('.copybtn');
    if (cb && navigator.clipboard){
      navigator.clipboard.writeText(cb.dataset.copy || '').then(() => toast('Copied to clipboard.'));
    }
  });
  $('#helpClose').addEventListener('click', () => $('#helpWrap').classList.add('hidden'));
  $('#helpWrap').addEventListener('click', e => {
    if (e.target === e.currentTarget) $('#helpWrap').classList.add('hidden');
  });

  /* tabs */
  $$('#tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'scores') updateScoreTab();
  }));

  /* stage wheel-zoom */
  $('#stage').addEventListener('wheel', e => {
    if (!S.view || !e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.25 : 0.8), { cx: e.clientX, cy: e.clientY });
  }, { passive:false });

  /* drag & drop */
  ['dragover', 'drop'].forEach(t =>
    window.addEventListener(t, e => e.preventDefault()));
  window.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* paste */
  window.addEventListener('paste', e => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const it = [...items].find(i => i.type && i.type.startsWith('image/'));
    if (it) loadFile(it.getAsFile());
  });

  /* keyboard shortcuts */
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === '0') setZoomFit();
    else if (e.key === '1') setZoom(1);
    else if (e.key === '+' || e.key === '=') zoomStep(1.25);
    else if (e.key === '-') zoomStep(0.8);
  });

  /* keep fit on resize */
  new ResizeObserver(() => { if (S.fitMode) setZoomFit(); }).observe($('#stage'));
}

/* ================= technique guides ================= */
function openHelp(id){
  const txt = window.HELP && HELP[id];
  if (!txt) return;
  $('#helpTitle').textContent = GUIDE_TITLES[id] || id;
  $('#helpBody').innerHTML = txt.map(p => `<p>${esc(p)}</p>`).join('');
  $('#helpWrap').classList.remove('hidden');
}

wire();
