import { A4, cardSlots, computeLayout, paginate, trimMarks } from './layout.js';
import { buildPdf } from './pdf.js';

const STORAGE_KEY = 'tcg-proxy-generator:v1';
const MAX_COUNT = 999;
const MAX_DPI = 600; // PDFに埋め込む画像の解像度の上限。元画像より大きくはしない
const JPEG_QUALITY = 0.92;
const SVG_NS = 'http://www.w3.org/2000/svg';

const PRESETS = {
  standard: { width: 63, height: 88 },
  japanese: { width: 59, height: 86 },
};
// プレビュー（SVG）での画像の合わせ方。PDF用の画像は rasterize() で同じ見た目に加工する
const FIT_ASPECT = { stretch: 'none', cover: 'xMidYMid slice', contain: 'xMidYMid meet' };
const DEFAULT_SETTINGS = { cardWidth: 63, cardHeight: 88, scale: 100, fit: 'stretch', trimMarks: true };

/**
 * items の各要素:
 * { id, kind: 'url' | 'file', source, name, count, status: 'loading' | 'ready' | 'error',
 *   blob, objectUrl, pixelWidth, pixelHeight, error }
 */
const state = { items: [], settings: { ...DEFAULT_SETTINGS } };
let nextId = 1;
let generating = false;

const $ = (selector) => document.querySelector(selector);
const ui = {
  urlInput: $('#url-input'),
  addUrls: $('#add-urls'),
  urlMessage: $('#url-message'),
  fileInput: $('#file-input'),
  cardList: $('#card-list'),
  listEmpty: $('#list-empty'),
  listNote: $('#list-note'),
  summary: $('#summary'),
  clearAll: $('#clear-all'),
  settings: $('#settings'),
  preset: $('#preset'),
  cardWidth: $('#card-width'),
  cardHeight: $('#card-height'),
  scale: $('#scale'),
  fit: $('#fit'),
  trimMarks: $('#trim-marks'),
  layoutInfo: $('#layout-info'),
  generate: $('#generate'),
  status: $('#status'),
  pages: $('#pages'),
  previewEmpty: $('#preview-empty'),
};

// ---------------------------------------------------------------- カードの追加

const clampCount = (value) => Math.min(MAX_COUNT, Math.max(1, Math.round(Number(value)) || 1));

// 「URL」「URL 4」「URL x4」「4 URL」の形式を受け付ける
function parseUrlLine(line) {
  const text = line.trim();
  let url = text;
  let count = 1;
  let match;
  if ((match = text.match(/^(\S+)\s+[x×*]?\s*(\d+)$/i))) [, url, count] = match;
  else if ((match = text.match(/^(\d+)\s*[x×*]?\s+(\S+)$/i))) [, count, url] = match;
  try {
    const { protocol } = new URL(url);
    if (!['http:', 'https:', 'data:'].includes(protocol)) return null;
  } catch {
    return null;
  }
  return { url, count: clampCount(count) };
}

function addUrlsFromText(text) {
  const rejected = [];
  let added = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseUrlLine(line);
    if (entry) {
      addUrl(entry.url, entry.count);
      added++;
    } else {
      rejected.push(line.trim());
    }
  }
  render();
  return { added, rejected };
}

function addUrl(url, count) {
  const existing = state.items.find((item) => item.kind === 'url' && item.source === url);
  if (existing) {
    existing.count = clampCount(existing.count + count);
    return;
  }
  const item = { id: nextId++, kind: 'url', source: url, name: nameFromUrl(url), count, status: 'loading' };
  state.items.push(item);
  loadItem(item);
}

function addFiles(files) {
  for (const file of files) {
    const item = { id: nextId++, kind: 'file', source: file.name, name: file.name, count: 1, status: 'loading', blob: file };
    state.items.push(item);
    loadItem(item);
  }
  render();
}

function nameFromUrl(url) {
  if (url.startsWith('data:')) return '貼り付けた画像（data URL）';
  try {
    const { hostname, pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : hostname;
  } catch {
    return url;
  }
}

async function loadItem(item) {
  item.status = 'loading';
  try {
    if (item.kind === 'url') item.blob = await fetchImage(item.source);
    let bitmap;
    try {
      bitmap = await createImageBitmap(item.blob);
    } catch {
      throw new Error('画像として読み込めませんでした');
    }
    item.pixelWidth = bitmap.width;
    item.pixelHeight = bitmap.height;
    bitmap.close();
    if (!state.items.includes(item)) return; // 読み込み中に削除された
    item.objectUrl ??= URL.createObjectURL(item.blob);
    item.status = 'ready';
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
  }
  if (state.items.includes(item)) render();
}

async function fetchImage(url) {
  let response;
  try {
    response = await fetch(url.startsWith('data:') ? url : `/api/image?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error('サーバーに接続できません。server.js が起動しているか確認してください');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `画像の取得に失敗しました (HTTP ${response.status})`);
  }
  return response.blob();
}

function removeItem(item) {
  state.items = state.items.filter((other) => other !== item);
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
}

// ---------------------------------------------------------------- 描画

const readyItems = () => state.items.filter((item) => item.status === 'ready');
const currentLayout = () => computeLayout(state.settings);

function render() {
  renderList();
  renderPreview();
  renderSummary();
  saveState();
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function itemHtml(item) {
  const thumb = {
    loading: '<span class="spinner" aria-label="読み込み中"></span>',
    ready: `<img src="${item.objectUrl}" alt="">`,
    error: '!',
  }[item.status];
  const sub = { loading: '読み込み中…', ready: `${item.pixelWidth}×${item.pixelHeight}px`, error: item.error }[item.status];
  const title = item.kind === 'url' && !item.source.startsWith('data:') ? item.source : item.name;
  const retry = item.status === 'error' && item.kind === 'url' ? '<button type="button" class="retry" data-action="retry">再試行</button>' : '';
  return `
    <li class="card-item is-${item.status}" data-id="${item.id}">
      <div class="thumb">${thumb}</div>
      <div class="meta">
        <div class="name" title="${escapeHtml(title)}">${escapeHtml(item.name)}</div>
        <div class="sub">${escapeHtml(sub)} ${retry}</div>
      </div>
      <div class="count">
        <button type="button" data-action="decrement" aria-label="1枚減らす">−</button>
        <input type="number" min="1" max="${MAX_COUNT}" value="${item.count}" aria-label="枚数">
        <button type="button" data-action="increment" aria-label="1枚増やす">+</button>
      </div>
      <button type="button" class="remove" data-action="remove" aria-label="削除" title="削除">×</button>
    </li>`;
}

function renderList() {
  // 枚数入力中に読み込み完了で再描画されてもフォーカスが外れないようにする
  const focusedId = document.activeElement?.closest?.('.card-item')?.dataset.id;
  ui.cardList.innerHTML = state.items.map(itemHtml).join('');
  if (focusedId) ui.cardList.querySelector(`[data-id="${focusedId}"] input`)?.focus();
  ui.listEmpty.hidden = state.items.length > 0;
  ui.clearAll.hidden = state.items.length === 0;
}

function svg(tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function renderPreview() {
  const layout = currentLayout();
  const sequence = layout ? readyItems().flatMap((item) => Array(item.count).fill(item)) : [];
  ui.previewEmpty.hidden = sequence.length > 0;
  if (!sequence.length) {
    ui.pages.replaceChildren();
    return;
  }

  const slots = cardSlots(layout);
  const marks = state.settings.trimMarks ? trimMarks(layout) : [];
  const pages = paginate(sequence, layout.perPage);
  ui.pages.replaceChildren(
    ...pages.map((cards, index) => {
      const page = svg('svg', { class: 'page', viewBox: `0 0 ${A4.width} ${A4.height}`, role: 'img', 'aria-label': `${index + 1}ページ目` });
      cards.forEach((item, slot) => {
        page.append(
          svg('image', {
            href: item.objectUrl,
            x: slots[slot].x,
            y: slots[slot].y,
            width: layout.cardWidth,
            height: layout.cardHeight,
            preserveAspectRatio: FIT_ASPECT[state.settings.fit],
          }),
        );
      });
      for (const line of marks) page.append(svg('line', { ...line, stroke: '#000', 'stroke-width': 0.1 }));

      const figure = document.createElement('figure');
      figure.className = 'page-figure';
      const caption = document.createElement('figcaption');
      caption.textContent = `${index + 1} / ${pages.length} ページ（${cards.length}枚）`;
      figure.append(page, caption);
      return figure;
    }),
  );
}

function renderSummary() {
  const layout = currentLayout();
  const total = readyItems().reduce((sum, item) => sum + item.count, 0);
  ui.summary.textContent = total && layout ? `合計 ${total}枚・${Math.ceil(total / layout.perPage)}ページ` : '';

  const loading = state.items.filter((item) => item.status === 'loading').length;
  const failed = state.items.filter((item) => item.status === 'error').length;
  const notes = [];
  if (loading) notes.push(`${loading}件を読み込み中です`);
  if (failed) notes.push(`読み込めなかった${failed}件は印刷されません`);
  ui.listNote.textContent = notes.join('。');
  ui.listNote.classList.toggle('is-error', failed > 0);

  if (layout) {
    ui.layoutInfo.textContent =
      `1ページに ${layout.perPage}枚（${layout.cols}列×${layout.rows}行）・` +
      `カード ${formatMm(layout.cardWidth)}×${formatMm(layout.cardHeight)}mm`;
  } else {
    ui.layoutInfo.textContent = 'このサイズのカードはA4用紙に収まりません';
  }
  ui.layoutInfo.classList.toggle('is-error', !layout);
  ui.generate.disabled = generating || !layout || total === 0;
}

const formatMm = (value) => String(Number(value.toFixed(2)));

// ---------------------------------------------------------------- 印刷設定

function readNumber(input, fallback) {
  const value = parseFloat(input.value);
  // 入力途中の値（例: 63 と打つ途中の 6）で配置が崩れないよう、範囲外は直前の値を使う
  return value >= Number(input.min) && value <= Number(input.max) ? value : fallback;
}

const matchPreset = (width, height) =>
  Object.keys(PRESETS).find((key) => PRESETS[key].width === width && PRESETS[key].height === height) ?? 'custom';

function writeSettingsToForm() {
  const { cardWidth, cardHeight, scale, fit, trimMarks: marks } = state.settings;
  ui.preset.value = matchPreset(cardWidth, cardHeight);
  ui.cardWidth.value = cardWidth;
  ui.cardHeight.value = cardHeight;
  ui.scale.value = scale;
  ui.fit.value = fit;
  ui.trimMarks.checked = marks;
}

function onSettingsInput(event) {
  const settings = state.settings;
  const preset = PRESETS[ui.preset.value];
  if (event.target === ui.preset && preset) {
    ui.cardWidth.value = preset.width;
    ui.cardHeight.value = preset.height;
  }
  settings.cardWidth = readNumber(ui.cardWidth, settings.cardWidth);
  settings.cardHeight = readNumber(ui.cardHeight, settings.cardHeight);
  settings.scale = readNumber(ui.scale, settings.scale);
  settings.fit = ui.fit.value;
  settings.trimMarks = ui.trimMarks.checked;
  if (event.target === ui.cardWidth || event.target === ui.cardHeight) {
    ui.preset.value = matchPreset(settings.cardWidth, settings.cardHeight);
  }
  renderPreview();
  renderSummary();
  saveState();
}

// ---------------------------------------------------------------- PDF出力

// カード1枚分の画像を、カードの縦横比のJPEGにする
async function rasterize(item, { cardWidth, cardHeight, fit }) {
  const bitmap = await createImageBitmap(item.blob);
  try {
    const aspect = cardWidth / cardHeight;
    const { width: sourceWidth, height: sourceHeight } = bitmap;
    const maxHeight = (cardHeight / 25.4) * MAX_DPI;
    const naturalHeight =
      fit === 'cover' ? Math.min(sourceHeight, sourceWidth / aspect) : Math.max(sourceHeight, sourceWidth / aspect);
    const height = Math.max(1, Math.round(Math.min(naturalHeight, maxHeight)));
    const width = Math.max(1, Math.round(height * aspect));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // 透過部分と contain の余白は白にする
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    if (fit === 'stretch') {
      context.drawImage(bitmap, 0, 0, width, height);
    } else {
      const ratio = (fit === 'cover' ? Math.max : Math.min)(width / sourceWidth, height / sourceHeight);
      const drawWidth = sourceWidth * ratio;
      const drawHeight = sourceHeight * ratio;
      context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    }

    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました'))), 'image/jpeg', JPEG_QUALITY);
    });
    return { data: new Uint8Array(await jpeg.arrayBuffer()), width, height };
  } finally {
    bitmap.close();
  }
}

async function generatePdf() {
  const layout = currentLayout();
  const items = readyItems();
  if (generating || !layout || !items.length) return;

  generating = true;
  ui.generate.disabled = true;
  ui.generate.textContent = 'PDFを作成中…';
  setStatus('');
  try {
    const images = [];
    for (const item of items) images.push(await rasterize(item, state.settings));
    const sequence = items.flatMap((item, index) => Array(item.count).fill(index));
    const slots = cardSlots(layout);
    const lines = state.settings.trimMarks ? trimMarks(layout) : [];
    const pages = paginate(sequence, layout.perPage).map((cards) => ({
      draws: cards.map((image, slot) => ({
        image,
        ...slots[slot],
        width: layout.cardWidth,
        height: layout.cardHeight,
      })),
      lines,
    }));
    const pdf = buildPdf({ pageWidth: A4.width, pageHeight: A4.height, images, pages });
    download(pdf, `proxy-${timestamp()}.pdf`);
    setStatus(`PDFを作成しました（${pages.length}ページ・${formatBytes(pdf.size)}）`);
  } catch (err) {
    console.error(err);
    setStatus(`PDFの作成に失敗しました: ${err.message}`, true);
  } finally {
    generating = false;
    ui.generate.textContent = 'PDFを作成';
    renderSummary();
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

const formatBytes = (bytes) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`);

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('is-error', isError);
}

// ---------------------------------------------------------------- 保存と復元

// 設定とURLのカードだけを保存する（ローカル画像は再読み込みすると消える）
function saveState() {
  const urls = state.items
    .filter((item) => item.kind === 'url' && !item.source.startsWith('data:'))
    .map(({ source, count }) => ({ url: source, count }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings, urls }));
  } catch {
    // プライベートブラウズなどで保存できなくても動作には影響しない
  }
}

function restoreState() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;

  const settings = saved.settings ?? {};
  for (const key of ['cardWidth', 'cardHeight', 'scale']) {
    if (Number.isFinite(settings[key]) && settings[key] > 0) state.settings[key] = settings[key];
  }
  if (settings.fit in FIT_ASPECT) state.settings.fit = settings.fit;
  if (typeof settings.trimMarks === 'boolean') state.settings.trimMarks = settings.trimMarks;
  for (const entry of Array.isArray(saved.urls) ? saved.urls : []) {
    if (typeof entry?.url === 'string' && parseUrlLine(entry.url)) addUrl(entry.url, clampCount(entry.count));
  }
}

// ---------------------------------------------------------------- イベント

function submitUrls() {
  const { added, rejected } = addUrlsFromText(ui.urlInput.value);
  // 読み取れなかった行だけを残して、修正できるようにする
  ui.urlInput.value = rejected.join('\n');
  ui.urlMessage.textContent = rejected.length
    ? `${rejected.length}行をURLとして読み取れませんでした。http:// または https:// で始まる画像のURLを指定してください`
    : added
      ? `${added}件のURLを追加しました`
      : '';
  ui.urlMessage.classList.toggle('is-error', rejected.length > 0);
}

ui.addUrls.addEventListener('click', submitUrls);
ui.urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submitUrls();
  }
});

ui.fileInput.addEventListener('change', () => {
  addFiles([...ui.fileInput.files]);
  ui.fileInput.value = '';
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('is-dragging');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('is-dragging');
  const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
  if (files.length) {
    addFiles(files);
    return;
  }
  // 他のタブから画像をドラッグした場合はURLとして追加する
  const uris = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  if (uris) addUrlsFromText(uris.split(/\r?\n/).filter((line) => !line.startsWith('#')).join('\n'));
});

ui.cardList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = Number(button.closest('.card-item').dataset.id);
  const item = state.items.find((other) => other.id === id);
  if (!item) return;
  switch (button.dataset.action) {
    case 'increment':
    case 'decrement':
      item.count = clampCount(item.count + (button.dataset.action === 'increment' ? 1 : -1));
      button.parentElement.querySelector('input').value = item.count;
      renderPreview();
      renderSummary();
      saveState();
      return;
    case 'remove':
      removeItem(item);
      break;
    case 'retry':
      loadItem(item);
      break;
  }
  render();
});

ui.cardList.addEventListener('input', (event) => {
  const input = event.target;
  const item = state.items.find((other) => other.id === Number(input.closest('.card-item')?.dataset.id));
  if (!item || input.value === '') return;
  item.count = clampCount(input.value);
  renderPreview();
  renderSummary();
  saveState();
});

ui.cardList.addEventListener('change', (event) => {
  const item = state.items.find((other) => other.id === Number(event.target.closest('.card-item')?.dataset.id));
  if (item) event.target.value = item.count;
});

ui.clearAll.addEventListener('click', () => {
  if (!confirm('カード一覧をすべて削除しますか？')) return;
  for (const item of [...state.items]) removeItem(item);
  render();
});

ui.settings.addEventListener('input', onSettingsInput);
ui.settings.addEventListener('submit', (event) => event.preventDefault());
ui.generate.addEventListener('click', generatePdf);

restoreState();
writeSettingsToForm();
render();
