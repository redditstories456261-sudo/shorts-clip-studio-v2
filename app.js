'use strict';
/* =========================================================================
 * Shorts Clip Studio v2 — vanilla JS, no build step, no dependencies.
 * Flow: upload -> moment detection -> clip editor -> preview -> export
 * ========================================================================= */

// ---------------- Helpers ----------------
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fmt(s) { // seconds -> "MM:SS"
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

function parseTS(str) { // "MM:SS.s" or "SS.s" -> seconds
  const m = String(str).trim().match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
}

function rr(ctx, x, y, w, h, r) { // rounded-rect path
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function coverDraw(ctx, src, x, y, w, h) { // draw src cover-fitting rect
  const sw = src.videoWidth || src.naturalWidth;
  const sh = src.videoHeight || src.naturalHeight;
  if (!sw || !sh) return;
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

const FONT_STACK = 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// ---------------- State ----------------
const state = {
  file: null,
  videoURL: '',
  duration: 0,
  vw: 0, vh: 0,
  clipDur: 30,
  analyzing: false,
  candidates: [],
  clip: null, // {n,start,duration,title,raw,cues,brolls}
  clipCount: 0,
  exporting: false,
  filterOK: true,
  audioGraph: null,
};

const vidMain = document.getElementById('vidMain');
const vidThumb = document.getElementById('vidThumb');
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
try { state.filterOK = (typeof ctx.filter === 'string'); } catch (e) { state.filterOK = false; }

// ---------------- 1. Upload: picker + drag&drop, object URLs (streaming) ----------------
function handleFile(f) {
  if (!f) return;
  if (!String(f.type || '').startsWith('video/')) {
    alert('Sirf video file chunein (MP4 waghera).');
    return;
  }
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  state.file = f;
  state.videoURL = URL.createObjectURL(f);
  vidMain.src = state.videoURL;
  vidThumb.src = state.videoURL;
  vidMain.onloadedmetadata = () => {
    state.duration = vidMain.duration;
    state.vw = vidMain.videoWidth;
    state.vh = vidMain.videoHeight;
    document.getElementById('videoInfo').textContent =
      f.name + ' — ' + fmt(state.duration) + ' — ' + (f.size / 1048576).toFixed(1) +
      ' MB — ' + state.vw + 'x' + state.vh;
    document.getElementById('sec-moments').classList.remove('hidden');
    document.getElementById('analyzeBtn').disabled = false;
  };
  vidMain.onerror = () => alert('Video load nahi ho saki. Koi aur MP4 try karein.');
}

const dz = document.getElementById('dropzone');
document.getElementById('fileInput').addEventListener('change', e => handleFile(e.target.files[0]));
dz.addEventListener('click', e => { if (e.target.tagName !== 'LABEL') document.getElementById('fileInput').click(); });
dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('fileInput').click(); });
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  handleFile(f);
});

// ---------------- Clip-length presets ----------------
document.getElementById('durSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#durSeg button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.clipDur = parseInt(b.dataset.dur, 10);
  document.getElementById('customDur').value = '';
});
document.getElementById('customDur').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  if (v >= 5 && v <= 600) {
    state.clipDur = v;
    document.querySelectorAll('#durSeg button').forEach(x => x.classList.remove('active'));
  }
});

// ---------------- 2. Smart moment detection (Web Audio API, client-side) ----------------
function scoreWindows(audioBuf) {
  // RMS energy per 1-second window + variation bonus; stride-sampled for speed
  const ch = audioBuf.getChannelData(0);
  const sr = audioBuf.sampleRate;
  const per = sr, n = Math.floor(ch.length / per);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    const off = i * per;
    for (let j = off; j < off + per; j += 8) { const v = ch[j]; s += v * v; c++; }
    e[i] = Math.sqrt(s / Math.max(1, c));
  }
  let mx = 0;
  for (let i = 0; i < n; i++) if (e[i] > mx) mx = e[i];
  mx = mx || 1e-6;
  const sc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const en = e[i] / mx, pv = i > 0 ? e[i - 1] / mx : en;
    sc[i] = en * 0.7 + Math.abs(en - pv) * 0.3;
  }
  return sc;
}

function pickCandidates(scores, clipDurSec, maxCount) {
  // Sliding-window sums, then greedy non-overlapping picks (best first)
  const n = scores.length;
  const w = Math.max(1, Math.round(clipDurSec));
  if (n <= w) return [{ start: 0, score: 1 }];
  const sums = [];
  let run = 0;
  for (let k = 0; k < w; k++) run += scores[k];
  sums.push({ start: 0, score: run / w });
  for (let i = 1; i + w <= n; i++) {
    run += scores[i + w - 1] - scores[i - 1];
    sums.push({ start: i, score: run / w });
  }
  let mx = 0;
  for (const s of sums) if (s.score > mx) mx = s.score;
  mx = mx || 1;
  sums.sort((a, b) => b.score - a.score);
  const used = new Uint8Array(n);
  const picked = [];
  for (const c of sums) {
    if (picked.length >= maxCount) break;
    let ok = true;
    for (let k = c.start; k < c.start + w; k++) if (used[k]) { ok = false; break; }
    if (!ok) continue;
    for (let k = c.start; k < c.start + w; k++) used[k] = 1;
    picked.push({ start: c.start, score: c.score / mx });
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

function captureThumb(video, t) {
  // Seek, then snapshot to dataURL. Resolves '' on timeout/failure.
  return new Promise(resolve => {
    let done = false;
    const fin = url => {
      if (done) return; done = true;
      video.removeEventListener('seeked', onS);
      resolve(url);
    };
    const onS = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 480; c.height = 270; // taiz thumbnails (480px)
        c.getContext('2d').drawImage(video, 0, 0, 480, 270);
        fin(c.toDataURL('image/jpeg', 0.72));
      } catch (e) { fin(''); }
    };
    video.addEventListener('seeked', onS);
    try { video.currentTime = clamp(t, 0, Math.max(0, video.duration - 0.3)); }
    catch (e) { fin(''); }
    setTimeout(() => fin(''), 4000);
  });
}

function setAProg(p, txt) {
  const el = document.getElementById('analyzeProg');
  el.classList.remove('hidden');
  el.querySelector('.bar').style.width = (p * 100).toFixed(0) + '%';
  el.querySelector('span').textContent = txt;
}

async function analyze() {
  if (!state.file || state.analyzing || !state.duration) return;
  state.analyzing = true;
  document.getElementById('analyzeBtn').disabled = true;
  document.getElementById('cards').innerHTML = '';
  try {
    setAProg(0.1, 'Audio parh rahe hain…');
    const buf = await state.file.arrayBuffer(); // poori file memory me (limitation)
    setAProg(0.35, 'Audio decode ho raha hai…');
    const AC = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await AC.decodeAudioData(buf);
    if (AC.close) AC.close();
    setAProg(0.7, 'Energy score bana rahe hain…');
    await new Promise(r => setTimeout(r, 30)); // UI paint ka mauqa
    const scores = scoreWindows(audio);
    const count = clamp(Math.round(audio.duration / 60), 3, 12); // lambai ke hisab se
    const cands = pickCandidates(scores, state.clipDur, count);
    state.candidates = cands.map(c => ({ start: c.start, score: c.score, duration: state.clipDur, thumb: '' }));
    for (let i = 0; i < state.candidates.length; i++) {
      const c = state.candidates[i];
      c.thumb = await captureThumb(vidThumb, c.start + 1);
      setAProg(0.85 + 0.15 * (i + 1) / state.candidates.length,
        'Thumbnail ' + (i + 1) + '/' + state.candidates.length);
    }
    renderCards();
    setAProg(1, 'Ho gaya — ' + state.candidates.length + ' tajweez');
    setTimeout(() => document.getElementById('analyzeProg').classList.add('hidden'), 1500);
  } catch (err) {
    console.warn('Audio analysis failed, fallback:', err);
    // Imandaar fallback: barabar waqfon par candidates
    const count = clamp(Math.round(state.duration / 60), 3, 12);
    const step = Math.max(state.clipDur + 5, (state.duration - state.clipDur) / Math.max(1, count));
    state.candidates = [];
    for (let i = 0; i < count; i++) {
      const st = Math.min(i * step, Math.max(0, state.duration - state.clipDur));
      state.candidates.push({
        start: st, score: 0.5, duration: state.clipDur,
        thumb: await captureThumb(vidThumb, Math.min(st + 1, state.duration - 1)),
      });
    }
    renderCards();
    setAProg(1, 'Audio na parh sake — barabar waqfon par tajweez');
    setTimeout(() => document.getElementById('analyzeProg').classList.add('hidden'), 2000);
  }
  state.analyzing = false;
  document.getElementById('analyzeBtn').disabled = false;
}

function renderCards() {
  const box = document.getElementById('cards');
  box.innerHTML = '';
  state.candidates.forEach(c => {
    const wrap = document.createElement('div');
    wrap.className = 'scard';
    const b = document.createElement('button');
    b.className = 'scard-main';
    b.type = 'button';
    const imgHtml = c.thumb
      ? '<img src="' + c.thumb + '" alt="">'
      : '<div style="aspect-ratio:16/9;background:#000"></div>';
    b.innerHTML = imgHtml +
      '<div class="meta">⏱ ' + fmt(c.start) + ' · ' + c.duration + 's<br>' +
      '<span class="score">Score ' + Math.round(c.score * 100) + '%</span></div>';
    const pick = () => {
      document.querySelectorAll('.scard').forEach(x => x.classList.remove('sel'));
      wrap.classList.add('sel');
      selectClip(c.start, c.duration);
    };
    b.addEventListener('click', pick);
    // ✨ AI Title — is card ke clip ke liye titles
    const ai = document.createElement('button');
    ai.className = 'scard-ai';
    ai.type = 'button';
    ai.textContent = '✨';
    ai.title = 'AI Title — is clip ke liye catchy titles banao';
    ai.setAttribute('aria-label', 'AI Title');
    ai.addEventListener('click', async ev => {
      ev.stopPropagation();
      ai.disabled = true;
      try {
        const needSel = !state.clip || Math.abs(state.clip.start - c.start) > 0.05;
        if (needSel) pick();
        document.getElementById('sec-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
        await aiTitles();
      } finally { ai.disabled = false; }
    });
    wrap.appendChild(b);
    wrap.appendChild(ai);
    box.appendChild(wrap);
  });
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);

// ---------------- 3. Clip editor ----------------
function selectClip(start, dur) {
  state.clipCount++;
  const d = clamp(dur, 5, 600);
  const s = clamp(start, 0, Math.max(0, state.duration - d));
  // Purane b-roll ke object URLs saaf karein
  if (state.clip) state.clip.brolls.forEach(b => { if (b.url) URL.revokeObjectURL(b.url); });
  state.clip = { n: state.clipCount, start: s, duration: d, title: '', raw: '', cues: [], brolls: [], framing: 'full' };
  syncEditorFromClip();
  ['sec-editor', 'sec-preview', 'sec-export'].forEach(id => document.getElementById(id).classList.remove('hidden'));
  try { vidMain.currentTime = s; } catch (e) {}
  document.getElementById('sec-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function syncEditorFromClip() {
  const c = state.clip; if (!c) return;
  document.getElementById('clipStart').value = c.start.toFixed(1);
  document.getElementById('clipDur').value = Math.round(c.duration);
  document.getElementById('clipTitle').value = c.title;
  document.getElementById('clipTranscript').value = c.raw;
  document.getElementById('clipFraming').value = c.framing || 'full';
  const sc = document.getElementById('scrub');
  sc.max = c.duration; sc.value = 0;
  updateTimeUI();
  renderBrollList();
}

document.getElementById('newClipBtn').addEventListener('click', () => {
  if (!state.duration) { alert('Pehle video upload karein.'); return; }
  selectClip(0, state.clipDur);
});
document.getElementById('clipFraming').addEventListener('change', e => {
  if (!state.clip) return;
  state.clip.framing = e.target.value; // 'full' = poori 9:16, 'blur' = dhundli background
});
document.getElementById('clipStart').addEventListener('change', e => {
  if (!state.clip) return;
  state.clip.start = clamp(parseFloat(e.target.value) || 0, 0, Math.max(0, state.duration - state.clip.duration));
  try { vidMain.currentTime = state.clip.start; } catch (err) {}
});
document.getElementById('clipDur').addEventListener('change', e => {
  if (!state.clip) return;
  const d = clamp(parseFloat(e.target.value) || 30, 5, 600);
  state.clip.duration = d;
  state.clip.start = clamp(state.clip.start, 0, Math.max(0, state.duration - d));
  document.getElementById('scrub').max = d;
  reparseTranscript();
  updateTimeUI();
});
document.getElementById('clipTitle').addEventListener('input', e => {
  if (state.clip) state.clip.title = e.target.value;
});

// ---- Transcript: "[MM:SS.s] text" per line, warna saada text barabar taqseem ----
let parseTimer = null;
document.getElementById('clipTranscript').addEventListener('input', e => {
  if (!state.clip) return;
  state.clip.raw = e.target.value;
  clearTimeout(parseTimer);
  parseTimer = setTimeout(reparseTranscript, 400);
});

function reparseTranscript() {
  const c = state.clip; if (!c) return;
  c.cues = buildCues(c.raw, c.duration);
  renderKwChips(); // Pixabay keyword suggestions taaza karein
}

function buildCues(raw, clipDur) {
  const lines = String(raw).split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const tsRe = /^\[(\d{1,2}):(\d{2}(?:\.\d+)?)\]\s*(.+)$/;
  const parsed = [];
  let allTs = true;
  for (const l of lines) {
    const m = l.match(tsRe);
    if (!m) { allTs = false; break; }
    const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    if (!isFinite(t) || t < 0 || t > clipDur + 1) { allTs = false; break; }
    parsed.push({ t: clamp(t, 0, clipDur), words: m[3].split(/\s+/).filter(Boolean) });
  }
  if (allTs && parsed.length) {
    parsed.sort((a, b) => a.t - b.t);
    return parsed.filter(p => p.words.length);
  }
  // Fallback: saada text — alfaaz barabar taqseem, har cue me ~6 lafz
  const words = lines.join(' ').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const perCue = 6;
  const cueCount = Math.ceil(words.length / perCue);
  const cues = [];
  for (let i = 0; i < cueCount; i++) {
    cues.push({ t: (i / cueCount) * clipDur, words: words.slice(i * perCue, (i + 1) * perCue) });
  }
  return cues;
}

// *lafz* -> rang (surkh, sabz, peela — baari baari)
const KW_COLORS = ['#ff5252', '#69f06e', '#ffe14d'];
function colorizeWords(words) {
  let ki = 0;
  return words.map(raw => {
    const m = String(raw).match(/^\*(.+)\*$/);
    if (m && m[1]) { const color = KW_COLORS[ki % KW_COLORS.length]; ki++; return { text: m[1], color }; }
    return { text: raw, color: null };
  });
}

function currentCue(clip, t) {
  const cues = clip.cues;
  if (!cues.length) return null;
  let cur = null;
  for (const q of cues) { if (q.t <= t + 1e-6) cur = q; else break; }
  return cur;
}
function cueEnd(clip, cue) {
  const i = clip.cues.indexOf(cue);
  const nxt = clip.cues[i + 1];
  return nxt ? nxt.t : clip.duration;
}

// ---------------- B-roll: upload + waqt + dorania ----------------
let brollSeq = 0;
document.getElementById('brollInput').addEventListener('change', e => {
  if (!state.clip) { alert('Pehle clip chunein.'); e.target.value = ''; return; }
  for (const f of e.target.files) addBroll(f);
  e.target.value = '';
});

function addBroll(f) {
  const isImg = String(f.type || '').startsWith('image/');
  const isVid = String(f.type || '').startsWith('video/');
  if (!isImg && !isVid) { alert('Sirf tasveer ya video: ' + f.name); return; }
  const url = URL.createObjectURL(f);
  const b = {
    id: ++brollSeq, kind: isImg ? 'image' : 'video',
    url, name: f.name, at: 0, dur: 4, img: null, el: null, _active: false,
  };
  if (isImg) { b.img = new Image(); b.img.src = url; }
  else {
    b.el = document.createElement('video');
    b.el.muted = true; b.el.playsInline = true; b.el.preload = 'auto'; b.el.src = url;
  }
  state.clip.brolls.push(b);
  renderBrollList();
}

function renderBrollList() {
  const ul = document.getElementById('brollList');
  ul.innerHTML = '';
  if (!state.clip) return;
  state.clip.brolls.forEach(b => {
    const li = document.createElement('li');
    const th = b.kind === 'image'
      ? '<img class="th" src="' + b.url + '" alt="">'
      : '<img class="th" src="" alt="" data-vid="' + b.id + '">';
    li.innerHTML = th +
      '<span class="nm">' + escapeHtml(b.name) + '</span>' +
      '<label>Waqf (s)<input type="number" min="0" step="0.5" value="' + b.at + '" data-k="at"></label>' +
      '<label>Muddat (s)<input type="number" min="0.5" step="0.5" value="' + b.dur + '" data-k="dur"></label>' +
      '<button class="rm" title="Hatayein">×</button>';
    li.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => {
        b[inp.dataset.k] = Math.max(0, parseFloat(inp.value) || 0);
      });
    });
    li.querySelector('.rm').addEventListener('click', () => {
      if (b.el) b.el.pause();
      if (b.url) URL.revokeObjectURL(b.url);
      state.clip.brolls = state.clip.brolls.filter(x => x.id !== b.id);
      renderBrollList();
    });
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 4. Preview render loop (720x1280 canvas) ----------------
function mainRect() {
  // 16:9 (ya jo bhi) video ko darmiyan me fit karein
  const vw = state.vw, vh = state.vh;
  let w = 720, h = 720 * vh / vw, x = 0, y = (1280 - h) / 2;
  if (h > 1280) { h = 1280; w = 1280 * vw / vh; x = (720 - w) / 2; y = 0; }
  return { x, y, w, h };
}

function drawTitle(text) {
  // Safe margins: upar 60px, sides 40px. Lamba title → font ghatt kar max 2 lines.
  if (!text || !text.trim()) return;
  text = text.trim();
  const SIDE = 40, TOP = 60, maxW = 720 - SIDE * 2; // 640
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return;
  const setF = s => { ctx.font = '700 ' + s + 'px ' + FONT_STACK; };
  let fs = 46, lines = [];
  while (fs >= 20) {
    setF(fs);
    const sp = ctx.measureText(' ').width;
    lines = [];
    let line = '', lw = 0, fits = true;
    for (const w of words) {
      const ww = ctx.measureText(w).width;
      if (ww > maxW) { fits = false; break; } // ek lafz hi bara hai → aur chhota font
      const add = (line ? sp : 0) + ww;
      if (lw + add <= maxW) { line = line ? line + ' ' + w : w; lw += add; }
      else {
        lines.push({ text: line, w: lw });
        if (lines.length >= 2) { fits = false; break; }
        line = w; lw = ww;
      }
    }
    if (fits) {
      if (line) lines.push({ text: line, w: lw });
      if (lines.length >= 1 && lines.length <= 2) break;
      fits = false;
    }
    fs -= 2;
  }
  if (!lines.length) { // aakhri sahara: sab se chhota font, pehli line
    fs = 20; setF(fs);
    lines = [{ text: words[0], w: Math.min(maxW, ctx.measureText(words[0]).width) }];
  }
  const padX = 26, padY = 16;
  const lineH = fs * 1.28;
  const bw = Math.min(720 - SIDE * 2, Math.max(...lines.map(l => l.w)) + padX * 2);
  const bh = lines.length * lineH + padY * 2;
  const bx = (720 - bw) / 2, by = TOP;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  rr(ctx, bx, by, bw, bh, 22); ctx.fill();
  ctx.fillStyle = '#111';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  setF(fs);
  lines.forEach((l, i) => {
    ctx.fillText(l.text, bx + (bw - l.w) / 2, by + padY + lineH * i + lineH / 2 + 2);
  });
  ctx.restore();
}

function drawCaptions(cue, t) {
  const clip = state.clip;
  // Cue change par 150ms fade-in (professional feel)
  const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (state._lastCue !== cue) { state._lastCue = cue; state._cueFadeT = nowMs; }
  const fadeA = clamp((nowMs - (state._cueFadeT || 0)) / 150, 0, 1);

  const words = colorizeWords(cue.words);
  if (!words.length) return;
  const dur = Math.max(0.3, cueEnd(clip, cue) - cue.t);
  const rel = clamp((t - cue.t) / dur, 0, 0.999);
  const activeIdx = Math.min(words.length - 1, Math.floor(rel * words.length));

  ctx.save();
  ctx.globalAlpha = fadeA;
  ctx.font = '700 44px ' + FONT_STACK; // bold system-ui, 44px
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; // halki shadow — parhne me aasani
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  const spaceW = ctx.measureText(' ').width;
  const maxW = 720 - 80; // sides 40px safe margin
  // Lafz lapetein (wrap), aakhri 2 satar dikhayein
  const lines = [];
  let line = [], lw = 0;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w.text).width;
    if (lw + ww > maxW && line.length) { lines.push({ words: line, width: lw - spaceW }); line = []; lw = 0; }
    line.push({ text: w.text, color: w.color, idx: i });
    lw += ww + spaceW;
  });
  if (line.length) lines.push({ words: line, width: lw - spaceW });
  const show = lines.slice(-2);
  let y = 1280 - 120 - (show.length - 1) * 58; // bottom 120px safe margin
  for (const L of show) {
    let x = (720 - L.width) / 2;
    for (const w of L.words) {
      const ww = ctx.measureText(w.text).width;
      const isActive = (w.idx === activeIdx);
      if (isActive) {
        // Peela highlight (karaoke) — shadow band taake pill saaf lage
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.fillStyle = '#ffe14d';
        rr(ctx, x - 9, y - 40, ww + 18, 54, 12); ctx.fill();
        ctx.fillStyle = '#111';
        ctx.fillText(w.text, x, y);
        ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
      } else {
        ctx.lineWidth = 6; // 6px black outline
        ctx.strokeStyle = 'rgba(0,0,0,0.92)';
        ctx.lineJoin = 'round';
        ctx.strokeText(w.text, x, y);
        ctx.fillStyle = w.color || '#ffffff';
        ctx.fillText(w.text, x, y);
      }
      x += ww + spaceW;
    }
    y += 58;
  }
  ctx.restore();
}

function syncBrollVideos(clip, t) {
  // B-roll videos ko waqt par chalana/rokna (preview + export dono)
  for (const b of clip.brolls) {
    if (b.kind !== 'video' || !b.el) continue;
    const active = t >= b.at && t < b.at + b.dur;
    if (active) {
      const want = (t - b.at) % Math.max(0.5, (b.el.duration || 4));
      if (b.el.paused) {
        try { b.el.currentTime = Math.min(want, Math.max(0, (b.el.duration || 1) - 0.1)); } catch (e) {}
        b.el.play().catch(() => {});
      } else if (Math.abs(b.el.currentTime - want) > 0.6) {
        try { b.el.currentTime = want; } catch (e) {}
      }
      b._active = true;
    } else if (b._active) {
      b.el.pause(); b._active = false;
    }
  }
}

function drawBroll(b, t, rect) {
  const span = b.at + b.dur - t;      // khatam hone me kitna baqi
  const since = t - b.at;             // shuru hue kitna guzra
  if (since < 0 || span <= 0) return;
  const fade = 0.35;
  const alpha = clamp(Math.min(since / fade, span / fade), 0, 1);
  if (alpha <= 0) return;
  let src = null;
  if (b.kind === 'image') {
    if (b.img && b.img.complete && b.img.naturalWidth) src = b.img;
  } else if (b.kind === 'video') {
    if (b.el && b.el.readyState >= 2) src = b.el;
  }
  if (!src) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  coverDraw(ctx, src, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function punchZoom(t) {
  // Har 3.5 second me halka slow zoom-in (1.0x → 1.08x, eased) — static shot zinda lage.
  // t clip-relative hai, is liye cut (naya clip) par zoom khud reset ho jaata hai.
  const CYCLE = 3.5;
  const p = clamp((t % CYCLE) / CYCLE, 0, 1);
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
  return 1 + 0.08 * e;
}

function drawFrame(t) {
  const clip = state.clip;
  if (!clip || !state.vw) return;
  const full = (clip.framing || 'full') === 'full';
  const z = punchZoom(t);
  let r;
  if (full) {
    // FULL SCREEN: poora 9:16 frame video se bharein — koi blur nahi, sides crop honge
    const s = Math.max(720 / state.vw, 1280 / state.vh) * z;
    const dw = state.vw * s, dh = state.vh * s;
    try { ctx.drawImage(vidMain, (720 - dw) / 2, (1280 - dh) / 2, dw, dh); } catch (e) {}
    r = { x: 0, y: 0, w: 720, h: 1280 };
  } else {
    // 1) Dhundli background (video ka hi bara, blur copy)
    ctx.save();
    if (state.filterOK) ctx.filter = 'blur(30px) brightness(0.55)';
    const s = Math.max(720 / state.vw, 1280 / state.vh);
    const dw = state.vw * s, dh = state.vh * s;
    try { ctx.drawImage(vidMain, (720 - dw) / 2, (1280 - dh) / 2, dw, dh); } catch (e) {}
    ctx.restore();
    if (!state.filterOK) { // Safari purana: saada gehra parda
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, 720, 1280);
    }
    // 2) Asal video darmiyan me — smooth punch-in zoom ke saath
    r = mainRect();
    const zw = r.w * z, zh = r.h * z;
    try { ctx.drawImage(vidMain, r.x + (r.w - zw) / 2, r.y + (r.h - zh) / 2, zw, zh); } catch (e) {}
  }
  // 3) B-roll overlay (crossfade)
  syncBrollVideos(clip, t);
  for (const b of clip.brolls) drawBroll(b, t, r);
  // 4) Title patti
  drawTitle(clip.title);
  // 5) Karaoke captions
  const cue = currentCue(clip, t);
  if (cue) drawCaptions(cue, t);
  else state._lastCue = null; // agla cue fade-in ke saath aaye
}

function tRel() {
  if (!state.clip) return 0;
  return clamp(vidMain.currentTime - state.clip.start, 0, state.clip.duration);
}

function updateTimeUI() {
  if (!state.clip) return;
  const t = tRel();
  document.getElementById('timeLbl').textContent = fmt(t) + ' / ' + fmt(state.clip.duration);
  const sc = document.getElementById('scrub');
  if (document.activeElement !== sc) sc.value = t;
}

function updatePlayBtn() {
  document.getElementById('playBtn').textContent = vidMain.paused ? '▶ Chalayein' : '⏸ Rokein';
}

// Musalsal render loop (preview hamesha taaza)
(function loop() {
  requestAnimationFrame(loop);
  if (!state.clip || !state.duration) return;
  try { drawFrame(tRel()); } catch (e) {}
  updateTimeUI();
})();

// Controls
document.getElementById('playBtn').addEventListener('click', () => {
  if (!state.clip || state.exporting) return;
  if (vidMain.paused) {
    const t = vidMain.currentTime, s = state.clip.start;
    if (t < s || t >= s + state.clip.duration - 0.2) {
      try { vidMain.currentTime = s; } catch (e) {}
    }
    vidMain.play().catch(() => alert('Play nahi ho saka. Dobara dabayein.'));
  } else {
    vidMain.pause();
  }
});
vidMain.addEventListener('play', updatePlayBtn);
vidMain.addEventListener('pause', updatePlayBtn);
vidMain.addEventListener('timeupdate', () => {
  if (!state.clip) return;
  if (vidMain.currentTime >= state.clip.start + state.clip.duration) {
    vidMain.pause();
    try { vidMain.currentTime = state.clip.start + state.clip.duration - 0.05; } catch (e) {}
  }
});
document.getElementById('scrub').addEventListener('input', e => {
  if (!state.clip) return;
  vidMain.pause();
  try { vidMain.currentTime = state.clip.start + parseFloat(e.target.value); } catch (err) {}
});

// ---------------- 5. Export: canvas.captureStream + MediaRecorder ----------------
function ensureAudioGraph() {
  // Video ki awaz export me shamil karne ke liye (sirf ek dafa banta hai)
  if (state.audioGraph) return state.audioGraph;
  const AC = new (window.AudioContext || window.webkitAudioContext)();
  const src = AC.createMediaElementSource(vidMain);
  const gain = AC.createGain();
  const dest = AC.createMediaStreamDestination();
  src.connect(gain);
  gain.connect(AC.destination); // sunai bhi de
  gain.connect(dest);            // record bhi ho (gain se taake fade lag sake)
  state.audioGraph = { ctx: AC, dest, gain };
  return state.audioGraph;
}

// Export ke waqt awaz par 300ms fade-in/out — katka na lage
function applyExportFade(gainNode, durSec) {
  const ac = gainNode.context, t0 = ac.currentTime + 0.05;
  const up = Math.min(0.3, durSec / 2), dn = Math.min(0.3, durSec / 2);
  const g = gainNode.gain;
  g.cancelScheduledValues(t0);
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(1.0, t0 + up);
  if (durSec > up + dn) g.setValueAtTime(1.0, t0 + durSec - dn);
  g.exponentialRampToValueAtTime(0.0001, t0 + durSec);
}
function resetExportFade(gainNode) {
  try {
    const ac = gainNode.context, t0 = ac.currentTime;
    gainNode.gain.cancelScheduledValues(t0);
    gainNode.gain.setValueAtTime(1.0, t0);
  } catch (e) {}
}

function pickMime() {
  const chain = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=h264', 'video/webm'];
  if (!window.MediaRecorder) return '';
  for (const m of chain) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return '';
}

function setEProg(p, txt) {
  const el = document.getElementById('expProg');
  el.classList.remove('hidden');
  el.querySelector('.bar').style.width = (p * 100).toFixed(0) + '%';
  el.querySelector('span').textContent = txt;
}

function addDownload(name, url, mime) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = url; a.download = name;
  const isMp4 = mime.indexOf('mp4') !== -1;
  a.innerHTML = '<span>⬇ ' + escapeHtml(name) + '</span>' +
    '<span class="dl-fmt">' + (isMp4 ? 'MP4' : 'WebM') + '</span>';
  li.appendChild(a);
  document.getElementById('dlList').prepend(li);
}

async function exportClip() {
  const clip = state.clip;
  if (!clip || state.exporting) return;
  if (!window.MediaRecorder) {
    alert('Maazrat — aapka browser MediaRecorder support nahi karta. Chrome ya Edge istemal karein.');
    return;
  }
  const mime = pickMime();
  if (!mime) {
    alert('Koi supported video format nahi mila. Chrome ya Edge try karein.');
    return;
  }
  state.exporting = true;
  document.getElementById('exportBtn').disabled = true;
  document.getElementById('playBtn').disabled = true;
  document.getElementById('formatNote').textContent = '';
  setEProg(0, 'Tayyari…');

  try {
    const g = ensureAudioGraph();
    if (g.ctx.state === 'suspended') await g.ctx.resume();

    const vs = canvas.captureStream(30);
    const tracks = vs.getVideoTracks().concat(g.dest.stream.getAudioTracks());
    if (!tracks.length) throw new Error('koi track nahi');
    const rec = new MediaRecorder(new MediaStream(tracks), {
      mimeType: mime, videoBitsPerSecond: 8000000,
    });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });

    // B-roll videos reset
    clip.brolls.forEach(b => { if (b.el) { b.el.pause(); b._active = false; } });

    // Clip ke shuru par le jayein
    vidMain.pause();
    try { vidMain.currentTime = clip.start; } catch (e) {}
    await new Promise(r => {
      let done = false;
      const h = () => { if (!done) { done = true; vidMain.removeEventListener('seeked', h); r(); } };
      vidMain.addEventListener('seeked', h);
      setTimeout(() => { if (!done) { done = true; vidMain.removeEventListener('seeked', h); r(); } }, 3000);
    });

    rec.start(250);
    await vidMain.play();
    applyExportFade(g.gain, clip.duration); // 300ms fade-in/out
    setEProg(0.01, 'Record ho raha hai…');

    // Asal waqt me record karein; progress = encoded seconds / total
    await new Promise(resolve => {
      const tick = () => {
        const p = clamp((vidMain.currentTime - clip.start) / clip.duration, 0, 1);
        setEProg(p, p.toFixed(0) * 1 + '% — ' + (p * clip.duration).toFixed(1) + 's / ' + clip.duration.toFixed(0) + 's');
        if (p >= 0.999 || vidMain.currentTime >= clip.start + clip.duration - 0.05) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });

    try { vidMain.pause(); } catch (e) {}
    clip.brolls.forEach(b => { if (b.el) { b.el.pause(); b._active = false; } });
    if (rec.state !== 'inactive') rec.stop();
    await stopped;

    const ext = mime.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const url = URL.createObjectURL(blob);
    const name = 'shorts-clip-' + clip.n + '-' + Math.round(clip.duration) + 's.' + ext;
    addDownload(name, url, mime);

    if (ext === 'webm') {
      document.getElementById('formatNote').textContent =
        'ℹ️ Imandaar note: aapka browser sirf WebM export kar saka (MP4 support nahi). ' +
        'MP4 chahiye to Chrome ya Edge (desktop/Android) me kholein — wahan MP4 milega.';
    } else {
      document.getElementById('formatNote').textContent = '✅ MP4 tayyar hai — har Android phone par chalega.';
    }
    setEProg(1, 'Mukammal — upar download dabayein');
  } catch (err) {
    console.error(err);
    alert('Export me masla aaya: ' + (err && err.message ? err.message : err));
    document.getElementById('expProg').classList.add('hidden');
  }
  if (state.audioGraph && state.audioGraph.gain) resetExportFade(state.audioGraph.gain); // preview ke liye awaz wapas
  state.exporting = false;
  document.getElementById('exportBtn').disabled = false;
  document.getElementById('playBtn').disabled = false;
  updatePlayBtn();
}

document.getElementById('exportBtn').addEventListener('click', exportClip);

/* =========================================================================
 * AI FEATURES (online, v2.1) — Settings + AI titles + AI transcript (vision)
 * + Pixabay B-roll + caption translation.
 * SAKHT USOOL: sirf MUFT/keyless providers — koi paid API nahi.
 * Keys user khud Settings me dalta hai, sirf localStorage me rehti hain.
 * Har fetch me AbortController timeout (60s) + Roman Urdu errors + fallback.
 * ========================================================================= */

const AI_LS_KEY = 'scs2_ai_settings_v1';
function loadAISettings() {
  const d = { groqKey: '', pixabayKey: '', googleKey: '', usePollinations: true, usePuter: false };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(AI_LS_KEY) || '{}')); }
  catch (e) { return d; }
}
function saveAISettings(s) {
  try { localStorage.setItem(AI_LS_KEY, JSON.stringify(s)); } catch (e) {}
}
let aiSet = loadAISettings();

function setStatus(id, msg) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (el) el.textContent = msg || '';
}
function shortErr(e) {
  const m = String((e && e.message) || e || 'namaloom ghalti');
  return m.length > 100 ? m.slice(0, 100) + '…' : m;
}
async function fetchTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 60000);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}

// ---------------- Provider chain ----------------
async function groqChat(messages, models, maxTokens) {
  if (!aiSet.groqKey) throw new Error('Groq key nahi hai');
  let last = null;
  for (const model of models) {
    try {
      const r = await fetchTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiSet.groqKey },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: maxTokens || 800 })
      }, 60000);
      if (!r.ok) { last = new Error('Groq (' + model + '): HTTP ' + r.status); continue; }
      const j = await r.json();
      const mc = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const str = Array.isArray(mc) ? mc.map(p => p.text || '').join(' ') : String(mc || '');
      if (str.trim()) return str.trim();
      last = new Error('Groq (' + model + '): khaali jawab');
    } catch (e) { last = e; }
  }
  throw last || new Error('Groq nakam');
}

async function pollinationsText(prompt) {
  if (!aiSet.usePollinations) throw new Error('Pollinations off hai');
  // Lambi prompt → OpenAI-compatible POST endpoint (GET ki URL limit se bachne ke liye)
  if (String(prompt).length > 1500) {
    const r = await fetchTimeout('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: prompt }], max_tokens: 1000 })
    }, 60000);
    if (!r.ok) throw new Error('Pollinations: HTTP ' + r.status);
    const j = await r.json();
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const t = Array.isArray(c) ? c.map(p => p.text || '').join(' ') : String(c || '');
    if (!t.trim()) throw new Error('Pollinations: khaali jawab');
    return t.trim();
  }
  const r = await fetchTimeout('https://text.pollinations.ai/' + encodeURIComponent(prompt), { method: 'GET' }, 60000);
  if (!r.ok) throw new Error('Pollinations: HTTP ' + r.status);
  const t = await r.text();
  if (!t.trim()) throw new Error('Pollinations: khaali jawab');
  return t.trim();
}

async function pollinationsVision(dataUrls, prompt) {
  if (!aiSet.usePollinations) throw new Error('Pollinations off hai');
  const content = [{ type: 'text', text: prompt }];
  for (const u of dataUrls) content.push({ type: 'image_url', image_url: { url: u } });
  const r = await fetchTimeout('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content }], max_tokens: 1000 })
  }, 60000);
  if (!r.ok) throw new Error('Pollinations: HTTP ' + r.status);
  const j = await r.json();
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const t = Array.isArray(c) ? c.map(p => p.text || '').join(' ') : String(c || '');
  if (!t.trim()) throw new Error('Pollinations: khaali jawab');
  return t.trim();
}

let puterScriptState = null;
function ensurePuter() {
  if (window.puter && window.puter.ai && window.puter.ai.chat) return Promise.resolve(true);
  if (puterScriptState) return puterScriptState;
  puterScriptState = new Promise(res => {
    const s = document.createElement('script');
    s.src = 'https://js.puter.com/v2/';
    s.onload = () => res(!!(window.puter && window.puter.ai && window.puter.ai.chat));
    s.onerror = () => res(false);
    document.head.appendChild(s);
    setTimeout(() => res(!!(window.puter && window.puter.ai && window.puter.ai.chat)), 15000);
  });
  return puterScriptState;
}
function puterText(resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (resp.message && Array.isArray(resp.message.content)) {
    return resp.message.content.map(c => typeof c === 'string' ? c : (c.text || '')).join(' ').trim();
  }
  if (typeof resp.text === 'string') return resp.text;
  return '';
}
async function puterChat(prompt) {
  if (!aiSet.usePuter) throw new Error('Puter off hai');
  const ok = await ensurePuter();
  if (!ok) throw new Error('Puter load nahi ho saka — ad-blocker ya internet check karein');
  try {
    const resp = await window.puter.ai.chat(prompt);
    const t = puterText(resp);
    if (!t) throw new Error('khaali jawab — pehli dafa sign-in popup aa sakta hai');
    return t;
  } catch (e) { throw new Error('Puter: ' + shortErr(e)); }
}

// Text tasks ki chain: Groq -> Pollinations (keyless) -> Puter.js
async function aiText(prompt, statusId) {
  const errs = [];
  if (aiSet.groqKey) {
    try { return await groqChat([{ role: 'user', content: prompt }], ['llama-3.3-70b-versatile'], 800); }
    catch (e) {
      errs.push('Groq: ' + shortErr(e));
      if (statusId) setStatus(statusId, 'Groq nakam — Pollinations try ho raha hai…');
    }
  }
  if (aiSet.usePollinations) {
    try { return await pollinationsText(prompt); }
    catch (e) {
      errs.push('Pollinations: ' + shortErr(e));
      if (statusId) setStatus(statusId, 'Pollinations nakam — agla provider try ho raha hai…');
    }
  }
  if (aiSet.usePuter) {
    try { return await puterChat(prompt); }
    catch (e) { errs.push('Puter: ' + shortErr(e)); }
  }
  throw new Error(errs.length ? errs.join(' | ') : 'Koi AI provider tayyar nahi — ⚙️ Settings check karein');
}

// ---------------- FEATURE 1: AI Titles (3 catchy options, tappable chips) ----------------
function renderTitleChips(titles) {
  const box = document.getElementById('titleChips');
  box.innerHTML = '';
  titles.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = t;
    b.addEventListener('click', () => {
      if (state.clip) { state.clip.title = t; document.getElementById('clipTitle').value = t; }
      box.innerHTML = '';
      setStatus('titleStatus', '✅ Title lag gaya');
    });
    box.appendChild(b);
  });
}

async function aiTitles() {
  const clip = state.clip;
  if (!clip) { setStatus('titleStatus', 'Pehle clip select karein'); return; }
  const btn = document.getElementById('aiTitleBtn');
  if (btn) btn.disabled = true;
  try {
    let raw = String(clip.raw || '').trim();
    if (!raw) {
      setStatus('titleStatus', 'Transcript khaali hai — AI se banane ki koshish…');
      await aiTranscript(true);
      raw = String(state.clip.raw || '').trim();
      if (!raw) { setStatus('titleStatus', 'Transcript nahi ban saka — pehle khud likhein ya 🎙 dabayein'); return; }
    }
    setStatus('titleStatus', 'AI titles bana raha hai… (internet darkar)');
    const prompt = 'Neeche ek video clip ka transcript hai:\n\n' + raw.slice(0, 1500) +
      '\n\nIs clip ke liye 3 catchy, chhote YouTube Shorts titles banao (Roman Urdu/English mix chalega, har title me zyada se zyada 1-2 emoji). Sirf 3 lines likho — har line ek title, koi numbering, koi wazahat nahi.';
    const out = await aiText(prompt, 'titleStatus');
    const titles = out.split('\n')
      .map(s => s.replace(/^[\d\-\)\.\*\u2022\u2013\s]+/, '').trim())
      .filter(s => s.length > 2).slice(0, 3);
    if (!titles.length) throw new Error('AI ne titles nahi diye');
    renderTitleChips(titles);
    setStatus('titleStatus', 'Neeche se pasand wala dabayein 👇');
  } catch (e) { setStatus('titleStatus', 'Nakam: ' + shortErr(e)); }
  finally { if (btn) btn.disabled = false; }
}
document.getElementById('aiTitleBtn').addEventListener('click', aiTitles);

// ---------------- FEATURE 2: AI Transcript — video ke 5 frames se (vision) ----------------
function seekVideo(v, t) {
  return new Promise(res => {
    let done = false;
    const h = () => { if (!done) { done = true; v.removeEventListener('seeked', h); res(); } };
    v.addEventListener('seeked', h);
    try { v.currentTime = clamp(t, 0, Math.max(0, (v.duration || t + 1) - 0.2)); }
    catch (e) { h(); }
    setTimeout(h, 4000);
  });
}
async function captureClipFrames(clip, n) {
  const urls = [];
  const c = document.createElement('canvas');
  const x = c.getContext('2d');
  for (let i = 0; i < n; i++) {
    const t = clip.start + ((i + 0.5) / n) * clip.duration;
    await seekVideo(vidMain, Math.min(t, Math.max(0, state.duration - 0.3)));
    const vw = vidMain.videoWidth || 640, vh = vidMain.videoHeight || 360;
    const w = Math.min(640, vw), h = Math.max(2, Math.round(w * vh / vw));
    c.width = w; c.height = h;
    try { x.drawImage(vidMain, 0, 0, w, h); urls.push(c.toDataURL('image/jpeg', 0.7)); }
    catch (e) { /* frame skip */ }
  }
  if (!urls.length) throw new Error('Frames nahi pakde ja sake');
  return urls;
}
function fmtTs(s) { // seconds -> "MM:SS.s" (cue format)
  const m = Math.floor(s / 60), sec = s - m * 60;
  return String(m).padStart(2, '0') + ':' + sec.toFixed(1).padStart(4, '0');
}
function parseVisionCues(text, clipDur) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\[(\d{1,2}):(\d{2}(?:\.\d+)?)\]\s*(.+)$/);
    if (!m) continue;
    const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    if (!isFinite(t) || t < 0 || t > clipDur + 2) continue;
    const words = m[3].split(/\s+/).filter(Boolean);
    if (words.length) out.push({ t: clamp(t, 0, clipDur), words });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
async function aiTranscript(silent) {
  const clip = state.clip;
  if (!clip) { if (!silent) setStatus('trStatus', 'Pehle clip select karein'); return; }
  const btn = document.getElementById('aiTrBtn');
  if (btn) btn.disabled = true;
  const prevTime = vidMain.currentTime;
  try {
    setStatus('trStatus', 'Video ke 5 frames parh rahe hain…');
    const urls = await captureClipFrames(clip, 5);
    setStatus('trStatus', 'AI transcript likh raha hai… (internet darkar)');
    const vprompt = 'Ye ek video clip ke 5 frames hain, waqt ki tartib me (clip ke shuru se aakhir tak). ' +
      'In frames me jo ho raha hai us ka andaza lagao aur timed captions banao. FORMAT sakhti se follow karo — har line bilkul is tarah:\n' +
      '[MM:SS.s] chhota jumla\n' +
      'Waqt 00:00.0 se shuru karo. Clip ' + Math.round(clip.duration) + ' second lambi hai — 8 se 12 short cues banao. ' +
      'Sirf cue lines likho, koi wazahat nahi.';
    let out = null;
    const errs = [];
    if (aiSet.groqKey) {
      try {
        const content = [{ type: 'text', text: vprompt }];
        for (const u of urls) content.push({ type: 'image_url', image_url: { url: u } });
        out = await groqChat(
          [{ role: 'user', content }],
          ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'],
          1200
        );
      } catch (e) {
        errs.push('Groq: ' + shortErr(e));
        setStatus('trStatus', 'Groq vision nakam — Pollinations try…');
      }
    }
    if (!out && aiSet.usePollinations) {
      try { out = await pollinationsVision(urls, vprompt); }
      catch (e) { errs.push('Pollinations: ' + shortErr(e)); }
    }
    if (!out) throw new Error(errs.length ? errs.join(' | ') : 'Koi vision provider tayyar nahi — ⚙️ Settings me Groq key dalein ya Pollinations on rakhein');
    const cues = parseVisionCues(out, clip.duration);
    if (cues.length >= 2) {
      const raw = cues.map(c => '[' + fmtTs(c.t) + '] ' + c.words.join(' ')).join('\n');
      clip.raw = raw;
      document.getElementById('clipTranscript').value = raw;
      reparseTranscript();
      setStatus('trStatus', '✅ Transcript lag gaya — ⚠️ AI andaza hai, zaroor check kar lo');
    } else {
      clip.raw = out.trim();
      document.getElementById('clipTranscript').value = clip.raw;
      reparseTranscript();
      setStatus('trStatus', '⚠️ AI ka jawab format me nahi tha — text laga diya hai, khud theek kar lo');
    }
  } catch (e) { setStatus('trStatus', 'Nakam: ' + shortErr(e)); }
  finally {
    try { vidMain.currentTime = prevTime; } catch (e2) {}
    if (btn) btn.disabled = false;
  }
}
document.getElementById('aiTrBtn').addEventListener('click', () => aiTranscript(false));

// ---------------- FEATURE 3: Pixabay auto B-roll ----------------
const KW_STOP = new Set(('the,and,hai,ke,ki,ka,ko,me,mein,se,par,ye,yeh,woh,wo,aur,lekin,magar,bhi,nahi,nahin,kya,kyun,kaise,jo,jis,is,us,ne,toh,mer,mera,teri,tera,apka,hum,tum,aap,main,un,in,tha,thi,hain,ga,gi,ge,raha,rahi,rahe,wala,wali,walay,bohat,bahut,zyada,kam,sab,kuch,koi,har,teen,char,are,was,were,been,have,has,does,did,will,would,can,could,should,its,these,those,for,with,from,about,into,over,after,before,between,your,they,their,him,her,his,than,very,just,like,make,made,know,think,come,came,went,said,tell,told,asked,also,well,much,more,most,then,than,when,where,which,while,during,video,clip,short,shorts,been,being,does,doing,down,under,again,once,here,there,only,own,same,such,into,over,under,again,further,then,once').split(','));
function suggestKeywords(raw, n) {
  const words = String(raw || '').replace(/\[.*?\]/g, ' ').replace(/\*/g, ' ')
    .toLowerCase().match(/[a-z\u0600-\u06FF]{4,}/g) || [];
  const freq = {};
  for (const w of words) { if (KW_STOP.has(w)) continue; freq[w] = (freq[w] || 0) + 1; }
  return Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, n || 5);
}
function renderKwChips() {
  const box = document.getElementById('kwChips');
  if (!box) return;
  box.innerHTML = '';
  if (!state.clip) return;
  suggestKeywords(state.clip.raw, 5).forEach(k => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip sm'; b.textContent = k;
    b.addEventListener('click', () => { document.getElementById('pixKw').value = k; });
    box.appendChild(b);
  });
}
async function pixabaySearch(q) {
  if (!aiSet.pixabayKey) throw new Error('Pixabay key nahi hai');
  const url = 'https://pixabay.com/api/?key=' + encodeURIComponent(aiSet.pixabayKey) +
    '&q=' + encodeURIComponent(q) + '&image_type=photo&per_page=6&safesearch=true';
  const r = await fetchTimeout(url, { method: 'GET' }, 30000);
  if (!r.ok) throw new Error('Pixabay: HTTP ' + r.status + ' — key check karein');
  const j = await r.json();
  return (j.hits || []).map(h => ({ preview: h.previewURL, full: h.largeImageURL || h.webformatURL }));
}
function renderPixGrid(hits) {
  const g = document.getElementById('pixGrid');
  g.innerHTML = '';
  hits.forEach(h => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pix';
    const img = document.createElement('img');
    img.src = h.preview; img.alt = ''; img.loading = 'lazy';
    b.appendChild(img);
    b.addEventListener('click', () => pixAddBroll(h, b));
    g.appendChild(b);
  });
}
function addBrollFromURL(url, name, kind, at) {
  const b = {
    id: ++brollSeq, kind, url, name,
    at: clamp(at || 0, 0, state.clip ? state.clip.duration : 0),
    dur: 4, img: null, el: null, _active: false
  };
  if (kind === 'image') { b.img = new Image(); b.img.src = url; }
  else {
    b.el = document.createElement('video');
    b.el.muted = true; b.el.playsInline = true; b.el.preload = 'auto'; b.el.src = url;
  }
  state.clip.brolls.push(b);
  renderBrollList();
}
async function pixAddBroll(h, btn) {
  if (!state.clip) { setStatus('pixStatus', 'Pehle clip select karein'); return; }
  if (btn) btn.disabled = true;
  setStatus('pixStatus', 'Tasveer download ho rahi hai…');
  try {
    const r = await fetchTimeout(h.full, { method: 'GET' }, 60000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob); // blob URL = canvas taint nahi hota
    addBrollFromURL(url, 'pixabay-' + Date.now() + '.jpg', 'image', tRel());
    setStatus('pixStatus', '✅ B-roll lag gaya (maujooda playhead ke waqt par)');
  } catch (e) { setStatus('pixStatus', 'Download nakam: ' + shortErr(e)); }
  finally { if (btn) btn.disabled = false; }
}
document.getElementById('pixBtn').addEventListener('click', async () => {
  const kw = document.getElementById('pixKw').value.trim();
  const btn = document.getElementById('pixBtn');
  if (!kw) { setStatus('pixStatus', 'Pehle keyword likhein (ya neeche chip dabayein)'); return; }
  if (!aiSet.pixabayKey) {
    setStatus('pixStatus', 'Pixabay key nahi hai — ⚙️ Settings me key dalein');
    openSettings();
    return;
  }
  btn.disabled = true;
  try {
    setStatus('pixStatus', 'Pixabay dhoond raha hai… (internet darkar)');
    const hits = await pixabaySearch(kw);
    renderPixGrid(hits);
    setStatus('pixStatus', hits.length ? 'Neeche tasveer dabayein — B-roll me lag jayegi 👇' : 'Kuch nahi mila — aur keyword try karein');
  } catch (e) { setStatus('pixStatus', 'Nakam: ' + shortErr(e)); }
  finally { btn.disabled = false; }
});

// ---------------- FEATURE 4: AI caption translation (10 languages) ----------------
async function translateTranscript() {
  const clip = state.clip;
  if (!clip || !clip.cues.length) { setStatus('langStatus', 'Pehle transcript likhein ya AI se banayein'); return; }
  const sel = document.getElementById('trLang');
  const langName = sel.options[sel.selectedIndex].text;
  const btn = document.getElementById('trBtn');
  btn.disabled = true;
  try {
    setStatus('langStatus', langName + ' me translate ho raha hai… (internet darkar)');
    // NUMBER| text format — taake timestamps mehfooz rahein, sirf text translate ho
    const lines = clip.cues.map((c, i) => (i + 1) + '| ' + c.words.join(' '));
    const prompt = 'Neeche video captions hain — har line NUMBER| text format me hai:\n\n' + lines.join('\n') +
      '\n\nIn sab ko ' + langName + ' me translate karo. RULES (sakhti se): har line ka NUMBER aur "|" bilkul waisa rakho; sirf text translate karo; timestamps mat badlo; koi wazahat ya izafi line nahi — sirf translated lines wapas do.';
    const out = await aiText(prompt, 'langStatus');
    const map = {};
    out.split('\n').forEach(l => {
      const m = String(l).trim().match(/^(\d+)\s*\|\s*(.+)$/);
      if (m) map[parseInt(m[1], 10)] = m[2].trim();
    });
    if (!Object.keys(map).length) throw new Error('AI ka jawab samajh nahi aaya');
    const raw = clip.cues.map((c, i) => '[' + fmtTs(c.t) + '] ' + (map[i + 1] || c.words.join(' '))).join('\n');
    clip.raw = raw;
    document.getElementById('clipTranscript').value = raw;
    reparseTranscript();
    setStatus('langStatus', '✅ Translate ho gaya — check kar lo');
  } catch (e) { setStatus('langStatus', 'Nakam: ' + shortErr(e)); }
  finally { btn.disabled = false; }
}
document.getElementById('trBtn').addEventListener('click', translateTranscript);

// ---------------- Settings modal wiring ----------------
function openSettings() {
  document.getElementById('setGroq').value = aiSet.groqKey || '';
  document.getElementById('setPixabay').value = aiSet.pixabayKey || '';
  document.getElementById('setGoogle').value = aiSet.googleKey || '';
  document.getElementById('setPoll').checked = !!aiSet.usePollinations;
  document.getElementById('setPuter').checked = !!aiSet.usePuter;
  setStatus('setMsg', '');
  document.getElementById('setModal').classList.remove('hidden');
}
function closeSettings() { document.getElementById('setModal').classList.add('hidden'); }
document.getElementById('gearBtn').addEventListener('click', openSettings);
document.getElementById('setClose').addEventListener('click', closeSettings);
document.getElementById('setModal').addEventListener('click', e => { if (e.target.id === 'setModal') closeSettings(); });
document.getElementById('setSave').addEventListener('click', () => {
  aiSet.groqKey = document.getElementById('setGroq').value.trim();
  aiSet.pixabayKey = document.getElementById('setPixabay').value.trim();
  aiSet.googleKey = document.getElementById('setGoogle').value.trim();
  aiSet.usePollinations = document.getElementById('setPoll').checked;
  aiSet.usePuter = document.getElementById('setPuter').checked;
  saveAISettings(aiSet);
  setStatus('setMsg', '✅ Save ho gaya — keys sirf is browser me hain');
});

/* =========================================================================
 * GOOGLE DRIVE IMPORT (online) — Drive share link se video layein.
 * Masla: drive.google.com/file/d/.../view sirf HTML page deta hai, aur
 * direct download URLs par CORS headers nahi hote — static app seedha
 * fetch nahi kar sakta. Hal: Google Drive API v3 (CORS support karta hai)
 * public files ke liye, sirf muft API key chahiye.
 * Key user khud Settings me dalta hai, sirf localStorage me rehti hai.
 * ========================================================================= */

let driveMeta = null; // {id, name, size, mimeType}

function driveFileIdFromLink(link) {
  const s = String(link || '').trim();
  let m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

function openDriveModal() {
  setStatus('driveStatus', '');
  document.getElementById('driveMeta').classList.add('hidden');
  document.getElementById('driveProg').classList.add('hidden');
  document.getElementById('driveKeyHint').classList.add('hidden');
  driveMeta = null;
  document.getElementById('driveModal').classList.remove('hidden');
}
function closeDriveModal() { document.getElementById('driveModal').classList.add('hidden'); }

document.getElementById('driveBtn').addEventListener('click', openDriveModal);
document.getElementById('driveClose').addEventListener('click', closeDriveModal);
document.getElementById('driveModal').addEventListener('click', e => { if (e.target.id === 'driveModal') closeDriveModal(); });
document.getElementById('driveGoSettings').addEventListener('click', () => { closeDriveModal(); openSettings(); });

function setDriveProg(p, txt) {
  const el = document.getElementById('driveProg');
  el.classList.remove('hidden');
  el.querySelector('.bar').style.width = (p * 100).toFixed(0) + '%';
  el.querySelector('span').textContent = txt;
}

async function driveCheck() {
  const btn = document.getElementById('driveFetch');
  setStatus('driveStatus', '');
  document.getElementById('driveMeta').classList.add('hidden');
  document.getElementById('driveKeyHint').classList.add('hidden');
  driveMeta = null;

  const link = document.getElementById('driveLink').value;
  const id = driveFileIdFromLink(link);
  if (!id) {
    setStatus('driveStatus', '❌ Link me file ID nahi mili. Poora Drive share link paste karein.');
    return;
  }
  if (!aiSet.googleKey) {
    document.getElementById('driveKeyHint').classList.remove('hidden');
    setStatus('driveStatus', '⚠️ Google API Key nahi mili.');
    return;
  }

  btn.disabled = true;
  try {
    setStatus('driveStatus', '🔍 File ki maloomat le rahe hain…');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 60000);
    const r = await fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
      '?fields=name,size,mimeType&key=' + encodeURIComponent(aiSet.googleKey),
      { signal: ctl.signal }
    );
    clearTimeout(to);
    if (r.status === 404) throw new Error('NOT_FOUND');
    if (r.status === 403) throw new Error('FORBIDDEN');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!String(j.mimeType || '').startsWith('video/')) {
      setStatus('driveStatus', '❌ Ye video file nahi lag rahi (' + (j.mimeType || 'unknown') + '). Sirf video file ka link dein.');
      return;
    }
    driveMeta = { id, name: j.name || 'video', size: parseInt(j.size || '0', 10), mimeType: j.mimeType };
    document.getElementById('driveName').textContent = '📄 ' + driveMeta.name;
    document.getElementById('driveSize').textContent =
      (driveMeta.size ? (driveMeta.size / 1048576).toFixed(1) + ' MB' : 'size maloom nahi') +
      ' — "' + driveMeta.name + '"';
    document.getElementById('driveMeta').classList.remove('hidden');
    setStatus('driveStatus', '✅ File mil gayi — neeche "Ye video lao" dabayein.');
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m === 'NOT_FOUND') setStatus('driveStatus', '❌ File nahi mili — link check karo, sahi file ka link dein.');
    else if (m === 'FORBIDDEN') setStatus('driveStatus', '❌ Ijazat nahi: ya to file "Anyone with the link" par share nahi, ya API key me Drive API enable nahi hai.');
    else if (e && e.name === 'AbortError') setStatus('driveStatus', '❌ Waqt khatam ho gaya — internet check karke dobara koshish karein.');
    else setStatus('driveStatus', '❌ Nakam: ' + m);
  } finally { btn.disabled = false; }
}
document.getElementById('driveFetch').addEventListener('click', driveCheck);

async function driveDownload() {
  if (!driveMeta) return;
  const btn = document.getElementById('driveConfirm');
  btn.disabled = true;
  document.getElementById('driveProg').classList.remove('hidden');
  try {
    setStatus('driveStatus', '⬇️ Video download ho rahi hai…');
    setDriveProg(0, 'Shuru…');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 10 * 60 * 1000); // bari files ke liye 10 min
    const r = await fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveMeta.id) +
      '?alt=media&key=' + encodeURIComponent(aiSet.googleKey),
      { signal: ctl.signal }
    );
    clearTimeout(to);
    if (r.status === 403) throw new Error('FORBIDDEN');
    if (r.status === 404) throw new Error('NOT_FOUND');
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const total = parseInt(r.headers.get('Content-Length') || driveMeta.size || '0', 10);
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total > 0) setDriveProg(got / total, (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB');
      else setDriveProg(0.5, (got / 1048576).toFixed(1) + ' MB…');
    }
    setDriveProg(1, 'Mukammal — load ho rahi hai…');
    const blob = new Blob(chunks, { type: driveMeta.mimeType || 'video/mp4' });
    const file = new File([blob], driveMeta.name || 'drive-video.mp4', { type: blob.type });
    closeDriveModal();
    handleFile(file); // wohi pipeline jo file picker use karta hai
    setStatus('driveStatus', '');
  } catch (e) {
    const m = String((e && e.message) || e);
    if (m === 'FORBIDDEN') setStatus('driveStatus', '❌ Ijazat nahi: file "Anyone with the link" par share nahi, ya API key me Drive API enable nahi.');
    else if (m === 'NOT_FOUND') setStatus('driveStatus', '❌ File nahi mili — link check karo.');
    else if (e && e.name === 'AbortError') setStatus('driveStatus', '❌ Waqt khatam — file bohat bari ho sakti hai, behtar internet par dobara koshish karein.');
    else setStatus('driveStatus', '❌ Download nakam: ' + m);
    document.getElementById('driveProg').classList.add('hidden');
  } finally { btn.disabled = false; }
}
document.getElementById('driveConfirm').addEventListener('click', driveDownload);
