'use strict';

const CONFIG = Object.freeze({
  maxFileBytes: 15 * 1024 * 1024,
  maxRowsPerFile: 50000,
  minPhoneDigits: 11,
  siteUrl: 'https://bit.ly/3jMnw1r',
  previewLimit: 100,
  outputHeaders: ['TELEFONE', 'COLB', 'COLC', 'COLD', 'COLE', 'COLF', ' COLG ', 'COLH', 'COLI', 'COLJ', 'COLK'],
  requiredHeaders: ['Nome', 'Telefone 1', 'Telefone 2', 'Telefone 3', 'Data', 'Valor', 'Informação Adicional 1'],
});

const state = {
  files: [],
  processed: [],
  discarded: [],
  stats: null,
  activePreview: 'valid',
  bySource: new Map(),
};

const els = {
  fileInput: document.querySelector('#fileInput'),
  dropzone: document.querySelector('#dropzone'),
  fileList: document.querySelector('#fileList'),
  clearButton: document.querySelector('#clearButton'),
  processButton: document.querySelector('#processButton'),
  actionHint: document.querySelector('#actionHint'),
  globalAlert: document.querySelector('#globalAlert'),
  resultsSection: document.querySelector('#resultsSection'),
  metrics: document.querySelector('#metrics'),
  previewHead: document.querySelector('#previewHead'),
  previewBody: document.querySelector('#previewBody'),
  previewCount: document.querySelector('#previewCount'),
  validTab: document.querySelector('#validTab'),
  discardedTab: document.querySelector('#discardedTab'),
  exportButton: document.querySelector('#exportButton'),
  exportDiscardedButton: document.querySelector('#exportDiscardedButton'),
  sourceExports: document.querySelector('#sourceExports'),
};

function setAlert(message = '') {
  els.globalAlert.hidden = !message;
  els.globalAlert.textContent = message;
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function normalizeHeader(value) {
  return normalizeText(value).normalize('NFKC').toLocaleLowerCase('pt-BR');
}

function cleanPhone(value) {
  return normalizeText(value).replace(/\D/g, '');
}

function formatDate(value) {
  const raw = normalizeText(value);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[3]}`;
  return raw;
}

function formatCurrency(value) {
  let raw = normalizeText(value);
  if (!raw) return '';
  raw = raw.replace(/^R\$\s*/i, '').trim();
  if (/^-?\d+(?:[.,]\d+)?$/.test(raw)) {
    const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return ` R$ ${parsed.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} `;
    }
  }
  return ` R$ ${raw} `;
}

function detectSource(rows) {
  if (!rows.length) return 'Base não identificada';
  const headers = Object.keys(rows[0]);
  const orthoKey = headers.find(h => normalizeHeader(h) === 'ortodontista');
  if (orthoKey && rows.some(r => normalizeText(r[orthoKey]) !== '')) return 'ORTODONTIA FORTALEZA E RMF';
  return 'OPERADORA FORTALEZA E RMF';
}

function tableToRows(table) {
  const tr = [...table.querySelectorAll('tr')];
  if (!tr.length) return [];
  const matrix = tr.map(row => [...row.querySelectorAll('th,td')].map(cell => normalizeText(cell.textContent)));
  const headers = matrix[0];
  if (!headers.length) return [];
  return matrix.slice(1).filter(row => row.some(Boolean)).map(row => {
    const record = {};
    headers.forEach((header, index) => { record[header] = row[index] ?? ''; });
    return record;
  });
}

function parseHtmlReport(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('Nenhuma tabela foi encontrada no relatório .xls.');
  return tableToRows(table);
}

function detectDelimiter(firstLine) {
  const candidates = [';', ',', '\t'];
  return candidates.map(d => ({ d, n: firstLine.split(d).length })).sort((a,b) => b.n - a.n)[0].d;
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      values.push(field); field = '';
    } else {
      field += ch;
    }
  }
  values.push(field);
  return values;
}

function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter(line => line.trim() !== '');
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseDelimitedLine(lines[0], delimiter).map(normalizeText);
  return lines.slice(1).map(line => parseDelimitedLine(line, delimiter)).map(values => {
    const record = {};
    headers.forEach((h, i) => { record[h] = values[i] ?? ''; });
    return record;
  }).filter(r => Object.values(r).some(v => normalizeText(v) !== ''));
}

function getField(record, expected) {
  const key = Object.keys(record).find(k => normalizeHeader(k) === normalizeHeader(expected));
  return key ? record[key] : '';
}

function validateHeaders(rows) {
  if (!rows.length) throw new Error('A planilha não possui registros.');
  const available = Object.keys(rows[0]).map(normalizeHeader);
  const missing = CONFIG.requiredHeaders.filter(h => !available.includes(normalizeHeader(h)));
  if (missing.length) throw new Error(`Colunas obrigatórias ausentes: ${missing.join(', ')}.`);
}

function decodeFileBuffer(buffer) {
  // Os relatórios do ERP são HTML com extensão .xls e normalmente usam ANSI/Windows-1252.
  // Tentamos UTF-8 estrito primeiro; se houver bytes inválidos, usamos Windows-1252.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

async function parseFile(file) {
  if (file.size > CONFIG.maxFileBytes) throw new Error(`O arquivo excede o limite de ${humanBytes(CONFIG.maxFileBytes)}.`);
  const lower = file.name.toLocaleLowerCase('pt-BR');
  const buffer = await file.arrayBuffer();
  const text = decodeFileBuffer(buffer);
  let rows;
  if (lower.endsWith('.csv')) rows = parseCsv(text);
  else if (lower.endsWith('.xls') || lower.endsWith('.html') || lower.endsWith('.htm')) rows = parseHtmlReport(text);
  else throw new Error('Formato não suportado. Use os relatórios .xls ou .csv.');
  if (rows.length > CONFIG.maxRowsPerFile) throw new Error(`O arquivo possui mais de ${CONFIG.maxRowsPerFile.toLocaleString('pt-BR')} registros.`);
  validateHeaders(rows);
  return { rows, source: detectSource(rows) };
}

function escapeFormulaForCsv(value) {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function quoteCsv(value) {
  const safe = escapeFormulaForCsv(value);
  if (/[;"\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function makeCsv(rows, headers = CONFIG.outputHeaders) {
  const body = [headers.join(';')];
  rows.forEach(row => body.push(headers.map(h => quoteCsv(row[h] ?? '')).join(';')));
  return `\uFEFF${body.join('\r\n')}`;
}

function makeDiscardedCsv(rows) {
  const headers = ['ARQUIVO', 'ORIGEM', 'NOME', 'CAMPO_TELEFONE', 'TELEFONE_ORIGINAL', 'TELEFONE_LIMPO', 'DIGITOS', 'MOTIVO'];
  const body = [headers.join(';')];
  rows.forEach(r => body.push(headers.map(h => quoteCsv(r[h] ?? '')).join(';')));
  return `\uFEFF${body.join('\r\n')}`;
}

function safeFilename(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildOutputRow(record, phone) {
  return {
    TELEFONE: phone,
    COLB: 'ODONTOART: Ola',
    COLC: normalizeText(getField(record, 'Nome')),
    COLD: 'Venc.',
    COLE: formatDate(getField(record, 'Data')),
    COLF: 'Valor',
    ' COLG ': formatCurrency(getField(record, 'Valor')),
    COLH: 'Cod Barras:',
    COLI: normalizeText(getField(record, 'Informação Adicional 1')),
    COLJ: 'Ou no site: ',
    COLK: CONFIG.siteUrl,
  };
}

function renderFiles() {
  els.fileList.replaceChildren();
  state.files.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'file-card';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.file.name;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const size = document.createElement('span'); size.textContent = humanBytes(item.file.size);
    const type = document.createElement('span'); type.className = 'file-type'; type.textContent = item.source || 'Aguardando leitura';
    meta.append(size, type); info.append(name, meta);

    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'remove-file'; remove.setAttribute('aria-label', `Remover ${item.file.name}`); remove.textContent = 'Remover';
    remove.addEventListener('click', () => { state.files.splice(index, 1); resetResults(); updateUi(); });
    card.append(info, remove); els.fileList.appendChild(card);
  });
}

function updateUi() {
  const hasFiles = state.files.length > 0;
  els.clearButton.disabled = !hasFiles;
  els.processButton.disabled = !hasFiles || state.files.some(f => f.loading || f.error);
  els.actionHint.textContent = !hasFiles ? 'Adicione pelo menos uma planilha para continuar.' : state.files.some(f => f.error) ? 'Corrija ou remova os arquivos com erro.' : `${state.files.length} arquivo(s) pronto(s) para processamento.`;
  renderFiles();
}

function resetResults() {
  state.processed = []; state.discarded = []; state.stats = null; state.activePreview = 'valid'; state.bySource = new Map();
  els.resultsSection.hidden = true;
}

async function addFiles(fileList) {
  setAlert('');
  const candidates = [...fileList].filter(Boolean);
  for (const file of candidates) {
    const duplicate = state.files.some(x => x.file.name === file.name && x.file.size === file.size && x.file.lastModified === file.lastModified);
    if (duplicate) continue;
    const item = { file, loading: true, error: '', rows: [], source: 'Lendo…' };
    state.files.push(item); updateUi();
    try {
      const parsed = await parseFile(file);
      item.rows = parsed.rows; item.source = parsed.source; item.loading = false;
    } catch (error) {
      item.loading = false; item.error = error instanceof Error ? error.message : 'Falha ao ler o arquivo.'; item.source = 'Arquivo inválido';
      setAlert(`${file.name}: ${item.error}`);
    }
    updateUi();
  }
  resetResults();
}

function processFiles() {
  const output = [];
  const discarded = [];
  let sourceRows = 0;
  let phonesAnalyzed = 0;

  state.files.forEach(item => {
    sourceRows += item.rows.length;
    item.rows.forEach(record => {
      const name = normalizeText(getField(record, 'Nome'));
      ['Telefone 1', 'Telefone 2', 'Telefone 3'].forEach(phoneField => {
        const original = normalizeText(getField(record, phoneField));
        if (!original) return;
        phonesAnalyzed++;
        const cleaned = cleanPhone(original);
        if (cleaned.length < CONFIG.minPhoneDigits) {
          discarded.push({
            ARQUIVO: item.file.name,
            ORIGEM: item.source,
            NOME: name,
            CAMPO_TELEFONE: phoneField,
            TELEFONE_ORIGINAL: original,
            TELEFONE_LIMPO: cleaned,
            DIGITOS: cleaned.length,
            MOTIVO: `Menos de ${CONFIG.minPhoneDigits} dígitos`,
          });
          return;
        }
        const row = buildOutputRow(record, cleaned);
        row.__source = item.source;
        row.__fileName = item.file.name;
        output.push(row);
      });
    });
  });

  output.sort((a, b) => a.COLC.localeCompare(b.COLC, 'pt-BR', { sensitivity: 'base' }));
  discarded.sort((a, b) => a.NOME.localeCompare(b.NOME, 'pt-BR', { sensitivity: 'base' }));

  const bySource = new Map();
  output.forEach(row => {
    if (!bySource.has(row.__source)) bySource.set(row.__source, []);
    bySource.get(row.__source).push(row);
  });

  state.processed = output;
  state.discarded = discarded;
  state.bySource = bySource;
  state.stats = { files: state.files.length, sourceRows, phonesAnalyzed, valid: output.length, discarded: discarded.length };
  state.activePreview = 'valid';
  renderResults();
}

function metric(label, value, cls = '') {
  const el = document.createElement('div'); el.className = `metric ${cls}`.trim();
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('strong'); v.textContent = Number(value).toLocaleString('pt-BR');
  el.append(l, v); return el;
}

function renderSourceExports() {
  els.sourceExports.replaceChildren();
  for (const [source, rows] of state.bySource.entries()) {
    const exportRows = [...rows];
    const count = exportRows.length;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button source-export';
    button.textContent = `Baixar ${source} (${count.toLocaleString('pt-BR')})`;
    button.addEventListener('click', () => {
      // Exportação isolada: usa somente o conjunto criado para esta origem durante o processamento.
      const currentRows = state.bySource.get(source) || [];
      if (currentRows.length !== count) {
        setAlert(`A quantidade de ${source} mudou após o processamento. Processe novamente antes de exportar.`);
        return;
      }
      downloadText(`${safeFilename(source)}_tratado_${count}.csv`, makeCsv(currentRows));
    });
    els.sourceExports.appendChild(button);
  }
}

function renderResults() {
  els.resultsSection.hidden = false;
  els.metrics.replaceChildren(
    metric('Arquivos', state.stats.files),
    metric('Registros brutos', state.stats.sourceRows),
    metric('Telefones analisados', state.stats.phonesAnalyzed),
    metric('Telefones válidos', state.stats.valid, 'good'),
    metric('Descartados', state.stats.discarded, 'bad'),
  );
  renderSourceExports(); renderPreview();
  els.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPreview() {
  const isValid = state.activePreview === 'valid';
  els.validTab.classList.toggle('active', isValid); els.validTab.setAttribute('aria-selected', String(isValid));
  els.discardedTab.classList.toggle('active', !isValid); els.discardedTab.setAttribute('aria-selected', String(!isValid));
  const rows = isValid ? state.processed : state.discarded;
  const headers = isValid ? ['TELEFONE', 'COLC', 'COLE', ' COLG ', 'COLI', '__source'] : ['NOME', 'CAMPO_TELEFONE', 'TELEFONE_ORIGINAL', 'TELEFONE_LIMPO', 'DIGITOS', 'MOTIVO', 'ORIGEM'];
  const labels = { COLC: 'NOME', COLE: 'VENCIMENTO', ' COLG ': 'VALOR', COLI: 'CÓDIGO DE BARRAS', __source: 'ORIGEM' };

  els.previewHead.replaceChildren(); els.previewBody.replaceChildren();
  const trh = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = labels[h] || h; trh.appendChild(th); });
  els.previewHead.appendChild(trh);
  rows.slice(0, CONFIG.previewLimit).forEach(row => {
    const tr = document.createElement('tr');
    headers.forEach(h => { const td = document.createElement('td'); td.textContent = String(row[h] ?? ''); tr.appendChild(td); });
    els.previewBody.appendChild(tr);
  });
  els.previewCount.textContent = `${rows.length.toLocaleString('pt-BR')} registro(s)`;
}

els.fileInput.addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
els.dropzone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); els.fileInput.click(); } });
['dragenter','dragover'].forEach(name => els.dropzone.addEventListener(name, event => { event.preventDefault(); els.dropzone.classList.add('dragging'); }));
['dragleave','drop'].forEach(name => els.dropzone.addEventListener(name, event => { event.preventDefault(); els.dropzone.classList.remove('dragging'); }));
els.dropzone.addEventListener('drop', event => addFiles(event.dataTransfer.files));
els.clearButton.addEventListener('click', () => { state.files = []; resetResults(); setAlert(''); updateUi(); });
els.processButton.addEventListener('click', processFiles);
els.validTab.addEventListener('click', () => { state.activePreview = 'valid'; renderPreview(); });
els.discardedTab.addEventListener('click', () => { state.activePreview = 'discarded'; renderPreview(); });
els.exportButton.addEventListener('click', () => downloadText('campanha_consolidada_tratada.csv', makeCsv(state.processed)));
els.exportDiscardedButton.addEventListener('click', () => downloadText('telefones_descartados.csv', makeDiscardedCsv(state.discarded)));

updateUi();


// Rolagem inercial real no desktop. CSS smooth não suaviza a rodinha do mouse.
// Mantém áreas internas roláveis, touch e acessibilidade com comportamento nativo.
(function enableInertialDocumentScroll() {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(pointer: fine)');
  if (reducedMotion.matches || !finePointer.matches) return;

  let targetY = window.scrollY;
  let positionY = window.scrollY;
  let velocity = 0;
  let rafId = 0;

  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const clamp = (value) => Math.min(maxScroll(), Math.max(0, value));

  const isNestedScrollable = (node, deltaY) => {
    let el = node instanceof Element ? node : null;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const canScroll = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (canScroll) {
        const canMoveDown = deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
        const canMoveUp = deltaY < 0 && el.scrollTop > 1;
        if (canMoveDown || canMoveUp) return true;
      }
      el = el.parentElement;
    }
    return false;
  };

  const tick = () => {
    const distance = targetY - positionY;
    velocity = velocity * 0.72 + distance * 0.115;
    positionY += velocity;

    if (Math.abs(distance) < 0.35 && Math.abs(velocity) < 0.35) {
      positionY = targetY;
      window.scrollTo(0, Math.round(positionY));
      rafId = 0;
      return;
    }

    window.scrollTo(0, positionY);
    rafId = requestAnimationFrame(tick);
  };

  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (isNestedScrollable(event.target, event.deltaY)) return;

    event.preventDefault();
    const unit = event.deltaMode === 1 ? 34 : event.deltaMode === 2 ? window.innerHeight * 0.9 : 1;
    const delta = event.deltaY * unit;
    const capped = Math.max(-460, Math.min(460, delta));
    targetY = clamp(targetY + capped * 1.15);

    if (!rafId) {
      positionY = window.scrollY;
      rafId = requestAnimationFrame(tick);
    }
  }, { passive: false });

  // Sincroniza quando a posição muda por teclado, barra de rolagem ou navegação.
  window.addEventListener('scroll', () => {
    if (!rafId) {
      positionY = window.scrollY;
      targetY = positionY;
      velocity = 0;
    }
  }, { passive: true });
})();
