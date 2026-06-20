/* ============================================================
   OCR Studio — script.js
   100% client-side PDF → OCR → TXT pipeline
   ============================================================ */

'use strict';

// ── Configure PDF.js worker ──────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ────────────────────────────────────────────────────
const state = {
  files: [],          // { id, file, name, size }
  results: {},        // { id: { name, text } }
  mode: 'a',          // 'a' | 'b'
  lang: 'eng',
  processing: false,
  cancelled: false,
  activeResultId: null,
  startTime: null,
  totalPages: 0,
  donePages: 0,
  worker: null,       // legacy single-worker ref (kept for compat)
  workerPool: [],     // array of Tesseract workers running in parallel
  poolSize: 1,
};

// ── Auto-detect safe worker pool size ────────────────────────
function getOptimalWorkerCount() {
  const cores = navigator.hardwareConcurrency || 2;
  // Leave 1 core free for the UI thread so the page doesn't freeze.
  // Cap at 4 — Tesseract's own per-worker overhead means more than
  // that gives diminishing returns and risks memory pressure on
  // lower-end devices.
  return Math.max(1, Math.min(4, cores - 1));
}

function showWorkerIndicator() {
  const n = getOptimalWorkerCount();
  if (n <= 1) {
    dom.workerIndicator.classList.add('is-single');
    dom.workerIndicatorText.textContent = 'Single-core mode — pages processed one at a time';
  } else {
    dom.workerIndicatorText.textContent = `Fast mode — ${n} pages OCR'd in parallel on this device`;
  }
}

// ── DOM refs ─────────────────────────────────────────────────
const dom = {
  dropZone:        document.getElementById('drop-zone'),
  fileInput:       document.getElementById('file-input'),
  browseBtn:       document.getElementById('browse-btn'),
  fileListSection: document.getElementById('file-list-section'),
  fileList:        document.getElementById('file-list'),
  fileCount:       document.getElementById('file-count'),
  clearAllBtn:     document.getElementById('clear-all-btn'),
  langSelect:      document.getElementById('lang-select'),
  modeABtn:        document.getElementById('mode-a-btn'),
  modeBBtn:        document.getElementById('mode-b-btn'),
  modeDesc:        document.getElementById('mode-desc'),
  processBtn:      document.getElementById('process-btn'),
  workerIndicator:     document.getElementById('worker-indicator'),
  workerIndicatorText: document.getElementById('worker-indicator-text'),
  progressWorkerLine:  document.getElementById('progress-worker-line'),
  progressSection: document.getElementById('progress-section'),
  cancelBtn:       document.getElementById('cancel-btn'),
  progressFile:    document.getElementById('progress-file'),
  progressPct:     document.getElementById('progress-pct'),
  progressBarOuter:document.getElementById('progress-bar-outer'),
  progressBar:     document.getElementById('progress-bar'),
  progressPage:    document.getElementById('progress-page'),
  progressEta:     document.getElementById('progress-eta'),
  progressLog:     document.getElementById('progress-log'),
  statsSection:    document.getElementById('stats-section'),
  statPdfs:        document.getElementById('stat-pdfs'),
  statPages:       document.getElementById('stat-pages'),
  statChars:       document.getElementById('stat-chars'),
  statTime:        document.getElementById('stat-time'),
  resultsSection:  document.getElementById('results-section'),
  resultActions:   document.getElementById('result-actions'),
  resultTabs:      document.getElementById('result-tabs'),
  previewName:     document.getElementById('preview-name'),
  textPreview:     document.getElementById('text-preview'),
  copyBtn:         document.getElementById('copy-btn'),
  themeToggle:     document.getElementById('theme-toggle'),
};

// ── Utilities ────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function formatCharCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// ── Toast ────────────────────────────────────────────────────
const icons = {
  success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m10.29 3.86-8.5 15A1 1 0 0 0 2.66 20.5h17.67a1 1 0 0 0 .87-1.5l-8.5-15a1 1 0 0 0-1.71 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

function showToast(type, title, msg, duration = 3800) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <span class="toast-icon toast-icon--${type}">${icons[type]}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
    </div>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

// ── Theme ────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('ocr-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ocr-theme', next);
}
dom.themeToggle.addEventListener('click', toggleTheme);
initTheme();

// ── File Management ──────────────────────────────────────────
function addFiles(fileList) {
  const added = [];
  for (const file of fileList) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('warning', 'Invalid file', `"${file.name}" is not a PDF.`);
      continue;
    }
    // Duplicate check
    if (state.files.some(f => f.name === file.name && f.size === file.size)) {
      showToast('info', 'Already added', `"${file.name}" is already in the list.`);
      continue;
    }
    const entry = { id: uid(), file, name: file.name, size: file.size };
    state.files.push(entry);
    added.push(entry);
  }
  if (added.length) renderFileList();
}

function removeFile(id) {
  state.files = state.files.filter(f => f.id !== id);
  renderFileList();
}

function clearAllFiles() {
  state.files = [];
  renderFileList();
}

function renderFileList() {
  const { files } = state;
  if (files.length === 0) {
    dom.fileListSection.hidden = true;
    dom.processBtn.disabled = true;
    return;
  }
  dom.fileListSection.hidden = false;
  dom.processBtn.disabled = state.processing;
  dom.fileCount.textContent = files.length;

  dom.fileList.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.id = f.id;
    li.innerHTML = `
      <span class="file-item-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </span>
      <span class="file-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="file-item-size">${formatBytes(f.size)}</span>
      <button class="file-item-remove" data-id="${f.id}" aria-label="Remove ${escapeHtml(f.name)}" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    dom.fileList.appendChild(li);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// File list click delegation
dom.fileList.addEventListener('click', e => {
  const btn = e.target.closest('.file-item-remove');
  if (btn) removeFile(btn.dataset.id);
});

// Clear all
dom.clearAllBtn.addEventListener('click', clearAllFiles);

// ── Drop Zone ────────────────────────────────────────────────
dom.dropZone.addEventListener('click', e => {
  if (e.target !== dom.browseBtn) dom.fileInput.click();
});
dom.dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
});
dom.browseBtn.addEventListener('click', e => { e.stopPropagation(); dom.fileInput.click(); });
dom.fileInput.addEventListener('change', () => { addFiles(dom.fileInput.files); dom.fileInput.value = ''; });

dom.dropZone.addEventListener('dragenter', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
dom.dropZone.addEventListener('dragover',  e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
dom.dropZone.addEventListener('dragleave', e => {
  if (!dom.dropZone.contains(e.relatedTarget)) dom.dropZone.classList.remove('drag-over');
});
dom.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dom.dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

// ── Mode Toggle ──────────────────────────────────────────────
function setMode(m) {
  state.mode = m;
  dom.modeABtn.classList.toggle('mode-btn--active', m === 'a');
  dom.modeBBtn.classList.toggle('mode-btn--active', m === 'b');
  dom.modeABtn.setAttribute('aria-pressed', m === 'a');
  dom.modeBBtn.setAttribute('aria-pressed', m === 'b');
  dom.modeDesc.textContent = m === 'a' ? 'Each PDF → separate .txt file' : 'All PDFs → one combined.txt';
}
dom.modeABtn.addEventListener('click', () => setMode('a'));
dom.modeBBtn.addEventListener('click', () => setMode('b'));

// ── Lang Select ──────────────────────────────────────────────
dom.langSelect.addEventListener('change', () => { state.lang = dom.langSelect.value; });

// ── OCR Worker Pool Management ───────────────────────────────
// Multiple Tesseract workers run in parallel, each in its own Web
// Worker thread. This does not change the OCR engine, language data,
// or recognition settings in any way — it only lets independent pages
// be recognized concurrently instead of one-at-a-time, so accuracy is
// identical to a single worker. Pool size is auto-detected from the
// device's CPU core count (see getOptimalWorkerCount).
async function createWorkerPool(lang, size) {
  await terminateWorkerPool();
  const pool = [];
  for (let i = 0; i < size; i++) {
    const worker = await Tesseract.createWorker(lang, 1, { logger: () => {} });
    pool.push(worker);
  }
  state.workerPool = pool;
  state.poolSize = size;
  return pool;
}

async function terminateWorkerPool() {
  if (state.workerPool.length) {
    await Promise.all(state.workerPool.map(w => w.terminate().catch(() => {})));
    state.workerPool = [];
  }
}

// ── PDF Page → Canvas → OCR ──────────────────────────────────
async function pdfPageToImageData(page) {
  const viewport = page.getViewport({ scale: 2.0 }); // 2x for better OCR accuracy
  const canvas = document.createElement('canvas');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function ocrCanvas(worker, canvas) {
  const { data: { text } } = await worker.recognize(canvas);
  // Free canvas memory
  canvas.width = 0;
  canvas.height = 0;
  return text.trim();
}

// ── Progress Helpers ─────────────────────────────────────────
function logEntry(msg, cls = '') {
  const li = document.createElement('li');
  li.className = `progress-log-item${cls ? ' ' + cls : ''}`;
  li.textContent = msg;
  dom.progressLog.appendChild(li);
  dom.progressLog.scrollTop = dom.progressLog.scrollHeight;
}

function setProgress(pct, fileLabel, pageCurrent, pageTotal) {
  const p = Math.min(100, Math.max(0, Math.round(pct)));
  dom.progressBar.style.width = p + '%';
  dom.progressPct.textContent = p + '%';
  dom.progressBarOuter.setAttribute('aria-valuenow', p);
  if (fileLabel) dom.progressFile.textContent = fileLabel;
  if (pageTotal !== undefined) {
    dom.progressPage.textContent = `Page ${pageCurrent} / ${pageTotal}`;
  }
  // ETA
  if (state.startTime && state.donePages > 0) {
    const elapsed = Date.now() - state.startTime;
    const rate = elapsed / state.donePages; // ms per page
    const remaining = (state.totalPages - state.donePages) * rate;
    dom.progressEta.textContent = remaining > 1000
      ? `~${formatDuration(remaining)} left`
      : 'Almost done…';
  }
}

// ── Main Processing ──────────────────────────────────────────
dom.processBtn.addEventListener('click', startProcessing);
dom.cancelBtn.addEventListener('click', () => {
  state.cancelled = true;
  dom.cancelBtn.disabled = true;
  dom.cancelBtn.textContent = 'Cancelling…';
  logEntry('⚠ Cancellation requested…', 'error');
});

async function startProcessing() {
  if (!state.files.length) return;
  if (state.processing) return;

  // Reset
  state.processing = true;
  state.cancelled = false;
  state.results = {};
  state.donePages = 0;
  state.totalPages = 0;
  state.startTime = Date.now();
  state.activeResultId = null;

  // UI
  dom.processBtn.disabled = true;
  dom.progressSection.hidden = false;
  dom.statsSection.hidden = true;
  dom.resultsSection.hidden = true;
  dom.progressLog.innerHTML = '';
  dom.progressWorkerLine.textContent = '';
  dom.cancelBtn.disabled = false;
  dom.cancelBtn.textContent = 'Cancel';
  dom.progressEta.textContent = 'Estimating…';
  dom.dropZone.classList.add('scanning');
  setProgress(0, 'Initialising…', 0, 0);

  const lang = dom.langSelect.value;
  logEntry(`Language: ${dom.langSelect.options[dom.langSelect.selectedIndex].text}`);

  try {
    // Count total pages first for accurate ETA
    logEntry('Counting pages…');
    for (const entry of state.files) {
      if (state.cancelled) break;
      try {
        const bytes = await entry.file.arrayBuffer();
        const pdf   = await pdfjsLib.getDocument({ data: bytes }).promise;
        state.totalPages += pdf.numPages;
        pdf.destroy();
      } catch (_) {
        state.totalPages += 1; // fallback
      }
    }

    // Init Tesseract worker pool — size auto-detected from CPU cores
    const poolSize = getOptimalWorkerCount();
    logEntry(`Loading OCR engine (${poolSize} parallel worker${poolSize > 1 ? 's' : ''})…`);
    const pool = await createWorkerPool(lang, poolSize);
    logEntry('OCR engine ready ✓', 'done');

    dom.progressWorkerLine.innerHTML = poolSize > 1
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg> Running ${poolSize} pages in parallel`
      : `Running in single-core mode`;

    // Process each file
    const collectedTexts = []; // for mode B

    for (let fi = 0; fi < state.files.length; fi++) {
      if (state.cancelled) break;

      const entry = state.files[fi];
      logEntry(`📄 Processing: ${entry.name}`, 'active');

      let pageTexts = [];
      let numPages = 0;

      try {
        const bytes  = await entry.file.arrayBuffer();
        const pdf    = await pdfjsLib.getDocument({ data: bytes }).promise;
        numPages = pdf.numPages;
        pageTexts = new Array(numPages).fill('');

        // Render all pages to canvases first (rendering is cheap/serial —
        // PDF.js needs one page open at a time per document). Each canvas
        // is then handed to whichever pool worker is free, so multiple
        // pages get OCR'd at the same time. Results are written back by
        // page index, so final order is identical to serial processing —
        // nothing about the recognition itself changes.
        let nextPageToRender = 1;
        let pagesCompleted = 0;
        let inFlight = 0;

        await new Promise((resolveAll) => {
          // dispatch() fills every free worker slot with the next
          // unrendered page. It's called once at start, then once each
          // time a worker finishes (so it always tries to refill).
          // Using a loop here instead of mutual recursion keeps the call
          // stack flat even for PDFs with hundreds of pages.
          const dispatch = () => {
            while (inFlight < pool.length && nextPageToRender <= numPages && !state.cancelled) {
              runPage(nextPageToRender++);
            }
            if (inFlight === 0) resolveAll();
          };

          const runPage = (pg) => {
            const worker = pool[(pg - 1) % pool.length];
            inFlight++;

            (async () => {
              try {
                const page   = await pdf.getPage(pg);
                const canvas = await pdfPageToImageData(page);
                page.cleanup();

                const text = await ocrCanvas(worker, canvas);
                pageTexts[pg - 1] = text;
              } catch (pageErr) {
                pageTexts[pg - 1] = '';
                logEntry(`  ⚠ Page ${pg} failed: ${pageErr.message}`, 'error');
              } finally {
                pagesCompleted++;
                state.donePages++;
                inFlight--;
                const globalPct = (state.donePages / state.totalPages) * 100;
                setProgress(globalPct, `${entry.name} — Page ${pagesCompleted}/${numPages}`, pagesCompleted, numPages);
                dispatch(); // this worker is free — try to give it more work
              }
            })();
          };

          dispatch();
        });

        pdf.destroy();
      } catch (pdfErr) {
        logEntry(`  ✗ Failed to load PDF: ${pdfErr.message}`, 'error');
        showToast('error', 'PDF Error', `"${entry.name}" could not be read.`);
        continue;
      }

      const combined = pageTexts
        .map((t, i) => `--- Page ${i + 1} ---\n${t}`)
        .join('\n\n');

      state.results[entry.id] = {
        name: entry.name.replace(/\.pdf$/i, '.txt'),
        text: combined,
        pages: numPages,
        chars: combined.length,
      };

      collectedTexts.push({ name: entry.name, text: combined });
      logEntry(`  ✓ Done (${numPages} pages, ${formatCharCount(combined.length)} chars)`, 'done');
    }

    // Mode B: merge
    if (state.mode === 'b' && !state.cancelled) {
      const mergedText = collectedTexts
        .map(c => `========== ${c.name} ==========\n\n${c.text}`)
        .join('\n\n\n');
      state.results = {
        combined: {
          name: 'combined.txt',
          text: mergedText,
          pages: state.totalPages,
          chars: mergedText.length,
        },
      };
    }

    setProgress(100, 'Complete ✓', state.totalPages, state.totalPages);

    if (!state.cancelled) {
      logEntry('✅ All files processed!', 'done');
      renderResults();
      showStats();
      showToast('success', 'OCR Complete', `Processed ${state.files.length} PDF(s).`);
    } else {
      logEntry('✗ Processing cancelled.', 'error');
      showToast('warning', 'Cancelled', 'Processing was stopped.');
    }

  } catch (err) {
    console.error(err);
    logEntry(`Fatal error: ${err.message}`, 'error');
    showToast('error', 'Processing failed', err.message);
  } finally {
    state.processing = false;
    dom.processBtn.disabled = state.files.length === 0;
    dom.dropZone.classList.remove('scanning');
    dom.cancelBtn.disabled = true;
    // Keep worker alive for potential re-use, terminate on next run
  }
}

// ── Render Results ───────────────────────────────────────────
function renderResults() {
  const ids = Object.keys(state.results);
  if (!ids.length) return;

  dom.resultsSection.hidden = false;
  dom.resultActions.innerHTML = '';
  dom.resultTabs.innerHTML  = '';

  // Download buttons
  if (ids.length > 1) {
    // Mode A: individual + ZIP
    const zipBtn = document.createElement('button');
    zipBtn.className = 'btn-ghost btn-sm';
    zipBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download ZIP`;
    zipBtn.addEventListener('click', downloadZip);
    dom.resultActions.appendChild(zipBtn);
  } else {
    // Mode B or single file
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-ghost btn-sm';
    dlBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download`;
    const firstId = ids[0];
    dlBtn.addEventListener('click', () => downloadSingle(firstId));
    dom.resultActions.appendChild(dlBtn);
  }

  // Tabs (Mode A with multiple files)
  if (ids.length > 1) {
    dom.resultTabs.hidden = false;
    for (const id of ids) {
      const r = state.results[id];
      const tab = document.createElement('button');
      tab.className = 'result-tab';
      tab.role = 'tab';
      tab.setAttribute('aria-selected', 'false');
      tab.title = r.name;
      tab.textContent = r.name.replace('.txt','');
      tab.dataset.id = id;

      // Per-file download
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn-ghost btn-sm';
      dlBtn.innerHTML = `⬇`;
      dlBtn.title = `Download ${r.name}`;
      dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadSingle(id); });

      tab.addEventListener('click', () => activateTab(id));
      dom.resultTabs.appendChild(tab);
    }
  } else {
    dom.resultTabs.hidden = true;
  }

  // Show first result
  activateTab(ids[0]);
}

function activateTab(id) {
  state.activeResultId = id;
  const r = state.results[id];
  if (!r) return;

  // Update tab states
  for (const tab of dom.resultTabs.querySelectorAll('.result-tab')) {
    const isActive = tab.dataset.id === id;
    tab.setAttribute('aria-selected', isActive);
    tab.classList.toggle('result-tab--active', isActive);
  }

  dom.previewName.textContent = r.name;
  dom.textPreview.textContent = r.text || '(No text extracted)';
  dom.copyBtn.hidden = false;
}

// ── Download ─────────────────────────────────────────────────
function downloadSingle(id) {
  const r = state.results[id];
  if (!r) return;
  const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, r.name);
}

async function downloadZip() {
  const zip = new JSZip();
  for (const [, r] of Object.entries(state.results)) {
    zip.file(r.name, r.text);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  triggerDownload(blob, 'ocr-results.zip');
  showToast('success', 'ZIP ready', 'All text files downloaded.');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Copy ─────────────────────────────────────────────────────
dom.copyBtn.addEventListener('click', async () => {
  const id = state.activeResultId;
  if (!id || !state.results[id]) return;
  try {
    await navigator.clipboard.writeText(state.results[id].text);
    const orig = dom.copyBtn.innerHTML;
    dom.copyBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
    setTimeout(() => { dom.copyBtn.innerHTML = orig; }, 1800);
    showToast('success', 'Copied', 'Text copied to clipboard.');
  } catch (_) {
    showToast('error', 'Copy failed', 'Could not access clipboard.');
  }
});

// ── Stats ─────────────────────────────────────────────────────
function showStats() {
  const elapsed = Date.now() - state.startTime;
  const totalChars = Object.values(state.results).reduce((s, r) => s + r.chars, 0);
  const totalPages = Object.values(state.results).reduce((s, r) => s + r.pages, 0);

  dom.statPdfs.textContent  = state.files.length;
  dom.statPages.textContent = totalPages;
  dom.statChars.textContent = formatCharCount(totalChars);
  dom.statTime.textContent  = formatDuration(elapsed);
  dom.statsSection.hidden = false;
}

// ── Prevent body drop ────────────────────────────────────────
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  if (!e.target.closest('#drop-zone')) e.preventDefault();
});

// ── Initial state ─────────────────────────────────────────────
dom.processBtn.disabled = true;
showWorkerIndicator();
