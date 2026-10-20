import { generateChibi, generatePoses, getGenerationStatus } from './api.js';
import { PERSONA_FIELDS, createPersonaDraft, getFireflyPersonaExample, normalizePersonaDraft, compilePersonaPrompt, refinePersona } from './persona.js';
import { createPetPreview } from './preview.js?v=workflow-1';
import { parseProject, normalizeProject, normalizeDraft, PROJECT_MAX_BYTES } from './project.js?v=workflow-1';
import { createDraftStore } from './drafts.js?v=workflow-1';
import { assessCreationProject } from './review.js?v=delivery-1';
import { buildCreationBundle } from './bundle.js?v=delivery-1';

const $ = (id) => document.getElementById(id);
function createId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  // Public HTTP origins omit randomUUID, but still expose getRandomValues.
  // These local image/pose IDs must not depend on clocks or Math.random.
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('浏览器不支持生成安全的图片标识，请使用较新的浏览器');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXAMPLES = [
  { id: 'sample-idle', name: '安静的流萤', dataUrl: '../assets/idle.png', source: 'demo' },
  { id: 'sample-happy', name: '开心的流萤', dataUrl: '../assets/happy.png', source: 'demo' },
  { id: 'sample-shy', name: '害羞的流萤', dataUrl: '../assets/shy.png', source: 'demo' },
  { id: 'sample-clap', name: '鼓掌的流萤', dataUrl: '../assets/clap_closed.png', source: 'demo' },
];
const DEFAULT_POSES = [
  { id: 'happy', name: '开心', description: '开心地微笑，动作自然可爱', sample: '../assets/happy.png' },
  { id: 'shy', name: '害羞', description: '脸颊微红，有一点局促的害羞神态', sample: '../assets/shy.png' },
  { id: 'clap', name: '鼓掌', description: '闭眼微笑，双手在胸前轻轻鼓掌', sample: '../assets/clap_closed.png' },
  { id: 'peek', name: '探头', description: '从屏幕一侧好奇地探出头', sample: '../assets/peek.png' },
  { id: 'drag', name: '被提起', description: '被轻轻提起时发懵，手脚微微张开；保留原来的人物比例' },
  { id: 'sleepy', name: '困倦', description: '困倦地打哈欠，眼睛微微闭起' },
  { id: 'wave', name: '招手', description: '向面前的人轻轻挥手打招呼' },
];
const state = {
  references: [], candidates: [], selectedId: null, base: null, poses: [],
  definitions: DEFAULT_POSES.map((pose) => ({ ...pose })),
  chosenPoses: new Set(['happy', 'shy', 'peek']), redo: new Set(),
  revision: 0, uploadRevision: 0, busy: false, controller: null,
  step: 1,
};
const persona = { draft: createPersonaDraft(), source: 'manual', revision: 0, busy: false, controller: null };
let petPreview = null;
let importAttempt = 0;
let exporting = false;
const poseUploads = new Map();
const embeddedImages = new Map();
const draftStore = createDraftStore();
let draftReady = false;
let draftTimer = 0;
let draftRevision = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notice(panel, text, error = false) {
  const target = $(panel + '-notice');
  target.textContent = text;
  target.hidden = !text;
  target.classList.toggle('error', error);
}
function sourceName(source) {
  return source === 'demo' ? '已有素材示例' : source === 'reference' ? '参考原图 · 未转 Q 版' : '接口返回图片';
}
function cancelPending() {
  state.revision += 1;
  state.controller?.abort();
  state.controller = null;
  state.busy = false;
  updateControls();
}
function clearCharacter() {
  // A later image read must not overwrite a character chosen in the meantime.
  state.uploadRevision += 1;
  importAttempt += 1;
  cancelPending();
  state.base = null;
  state.poses = [];
  state.definitions = state.definitions.map(definition => ({ ...definition, referenceImage: null, editNote: '' }));
  poseUploads.clear();
  state.redo.clear();
  petPreview?.reset();
  resetPersona();
  renderPoses();
  updateControls();
}
function setCandidates(items) {
  clearCharacter();
  state.candidates = items;
  state.selectedId = null;
  renderCandidates();
  scheduleDraft();
}
function updateControls() {
  $('generate-chibi').disabled = !state.references.length || state.busy;
  $('use-reference').disabled = !state.references.length || state.busy;
  $('confirm-character').disabled = !state.selectedId || state.busy;
  $('step-two').disabled = !state.base;
  $('step-three').disabled = !state.base;
  $('step-four').disabled = !state.base;
  $('continue-trial').disabled = !state.base || state.busy;
  $('trial-step-lock').hidden = Boolean(state.base);
  $('continue-persona').disabled = !state.base || state.busy;
  $('persona-step-lock').hidden = Boolean(state.base);
  $('step-lock').hidden = Boolean(state.base);
  $('generate-poses').disabled = !state.base || !state.chosenPoses.size || state.busy;
  $('redo-selected').disabled = !state.redo.size || state.busy;
  $('load-pose-examples').disabled = !state.chosenPoses.size || state.busy;
  $('export-bundle').disabled = !state.base || exporting;
  renderCreationReview();
}
function creationReview() {
  // Keep this cheap during typing; image data and history do not need cloning.
  return assessCreationProject({
    baseImage: state.base, selectedPoseIds: [...state.chosenPoses],
    poseDefinitions: state.definitions, poses: state.poses, persona: persona.draft,
  });
}
function goToCheck(check) {
  if (check.step > 1 && !state.base) check = creationReview().checks[0];
  showStep(check.step);
  let target = check.target && $(check.target);
  if (check.id === 'base') target = state.selectedId ? $('confirm-character') : state.candidates.length ? $('candidate-grid') : $('reference-input');
  if (check.poseId) {
    const card = [...$('pose-grid').querySelectorAll('.pose-card')]
      .find(node => node.dataset.poseId === check.poseId);
    target = card?.querySelector(check.status === 'pending' ? '.pose-edit-note' : '.pose-result-input') || card || target;
  }
  target ||= $('workspace');
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  if (!target.matches('input,textarea,button,select,a')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  (target.closest('.pose-card, .form-section') || target).scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'center',
  });
}
function renderCreationReview() {
  const review = creationReview();
  $('creation-next-hint').textContent = review.next
    ? review.next.status === 'pending' ? '还有姿态想再调整，已有图片会继续保留' : `接下来：${review.next.label}`
    : '设计已记录，去试玩或导出创作包';
  $('review-next').textContent = !state.base ? '从这里开始 →' : review.next ? '继续完善 →' : '去试玩 →';
  const checkpoints = $('creation-checkpoints');
  const list = $('delivery-checklist');
  checkpoints.replaceChildren(); list.replaceChildren();
  for (const check of review.checks) {
    const symbol = check.status === 'ready' ? '✓' : check.status === 'pending' ? '↻' : check.status === 'optional' ? '—' : '·';
    const makeSymbol = () => { const node = element('span', 'check-symbol', symbol); node.setAttribute('aria-hidden', 'true'); return node; };
    const button = element('button', 'creation-checkpoint'); button.type = 'button';
    button.dataset.checkId = check.id; button.dataset.status = check.status;
    const copy = element('span');
    copy.append(element('strong', '', check.label), element('small', '', check.detail));
    button.append(makeSymbol(), copy);
    button.addEventListener('click', () => goToCheck(check));
    checkpoints.append(button);
    const row = element('li'); row.dataset.checkId = check.id; row.dataset.status = check.status;
    const details = element('div');
    details.append(element('strong', '', check.label), element('p', '', check.detail));
    const action = element('button', 'text-link', check.status === 'ready' ? '查看 ↗' : check.status === 'optional' ? '添加 ↗' : '去补充 →');
    action.type = 'button'; action.setAttribute('aria-label', `${action.textContent}：${check.label}`);
    action.addEventListener('click', () => goToCheck(check));
    row.append(makeSymbol(), details, action); list.append(row);
  }
}
function showStep(step, focus = false) {
  if (step > 1 && !state.base) return;
  state.step = step;
  $('chibi-panel').hidden = step !== 1;
  $('pose-panel').hidden = step !== 2;
  $('persona-panel').hidden = step !== 3;
  $('trial-panel').hidden = step !== 4;
  $('step-one').classList.toggle('is-current', step === 1);
  $('step-two').classList.toggle('is-current', step === 2);
  $('step-three').classList.toggle('is-current', step === 3);
  $('step-four').classList.toggle('is-current', step === 4);
  $('step-one').setAttribute('aria-current', step === 1 ? 'step' : 'false');
  $('step-two').setAttribute('aria-current', step === 2 ? 'step' : 'false');
  $('step-three').setAttribute('aria-current', step === 3 ? 'step' : 'false');
  $('step-four').setAttribute('aria-current', step === 4 ? 'step' : 'false');
  if (step === 3) renderPersonaPreview();
  petPreview?.setActive(step === 4);
  if (focus) {
    $('workspace').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    (step === 1 ? $('reference-input') : step === 2 ? $('generate-poses') : step === 3 ? $('persona-brief') : $('trial-back')).focus({ preventScroll: true });
  }
}
function renderReferences() {
  $('reference-list').replaceChildren();
  for (const reference of state.references) {
    const item = element('div', 'reference-item');
    const img = element('img'); img.src = reference.dataUrl; img.alt = reference.name;
    const remove = element('button', '', '×');
    remove.type = 'button'; remove.setAttribute('aria-label', `移除参考图 ${reference.name}`);
    remove.addEventListener('click', () => {
      state.uploadRevision += 1;
      state.references = state.references.filter((entry) => entry.id !== reference.id);
      setCandidates([]);
      renderReferences();
      notice('chibi', '参考图片已更新，请重新选择形象');
      $('reference-input').focus();
    });
    item.append(img, remove); $('reference-list').append(item);
  }
  updateControls();
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取这张图片'));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        if (!image.width || !image.height || image.width * image.height > 50000000) {
          reject(new Error('图片尺寸过大，请缩小后重新上传')); return;
        }
        try { resolve({ id: createId(), name: file.name, dataUrl: reader.result }); }
        catch (error) { reject(error); }
      };
      image.onerror = () => reject(new Error('图片无法打开，请换一张 PNG、JPG 或 WebP'));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function acceptFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const uploadRevision = ++state.uploadRevision;
  const available = 4 - state.references.length;
  if (!available) { notice('chibi', '最多上传 4 张参考图，请先移除一张再添加', true); return; }
  const messages = [];
  const accepted = [];
  if (files.length > available) messages.push(`最多保留 4 张参考图，本次只处理前 ${available} 张`);
  for (const file of files.slice(0, available)) {
    if (!TYPES.has(file.type)) { messages.push(`${file.name}：请选择 PNG、JPG 或 WebP 图片`); continue; }
    if (file.size > MAX_FILE_BYTES) { messages.push(`${file.name}：超过 10 MB，请压缩后上传`); continue; }
    try { accepted.push(await readImage(file)); }
    catch (error) { messages.push(`${file.name}：${error.message}`); }
    if (uploadRevision !== state.uploadRevision) return;
  }
  if (accepted.length) {
    state.references.push(...accepted);
    setCandidates([]); renderReferences();
    messages.unshift(`已添加 ${accepted.length} 张参考图。图片生成尚未接入，也可以直接用参考原图体验下一步`);
  }
  notice('chibi', messages.join('；'), !accepted.length);
  scheduleDraft();
}
function renderCandidates() {
  const grid = $('candidate-grid'); grid.replaceChildren();
  grid.hidden = !state.candidates.length;
  $('candidate-empty').hidden = Boolean(state.candidates.length);
  const origin = state.candidates[0]?.source;
  $('candidate-count').textContent = state.candidates.length ? `${state.candidates.length} 张${origin === 'demo' ? '已有示例' : origin === 'reference' ? '参考原图' : '候选'}` : '等你的灵感';
  for (const candidate of state.candidates) {
    const selected = candidate.id === state.selectedId;
    const card = element('article', `candidate-card${selected ? ' is-selected' : ''}`);
    const button = element('button', 'candidate-select'); button.type = 'button';
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `选择 ${candidate.name}，${sourceName(candidate.source)}`);
    const visual = element('div', 'candidate-visual');
    const badge = element('span', 'source-badge', sourceName(candidate.source));
    const img = element('img'); img.src = candidate.dataUrl; img.alt = candidate.name;
    visual.append(badge, img);
    const meta = element('div', 'candidate-meta');
    const title = element('div'); title.append(element('strong', '', candidate.name), element('small', '', selected ? '这一张，很心动' : '点击选择这个形象'));
    meta.append(title, element('span', 'selection-circle', '✓'));
    button.append(visual, meta);
    button.addEventListener('click', () => {
      if (state.selectedId !== candidate.id) clearCharacter();
      state.selectedId = candidate.id;
      renderCandidates();
      const activeButton = [...grid.querySelectorAll('button')].find((entry) => entry.getAttribute('aria-pressed') === 'true');
      activeButton?.focus({ preventScroll: true });
    });
    card.append(button); grid.append(card);
  }
  $('selection-note').textContent = state.selectedId ? `已选好形象${origin === 'reference' ? '（原图未经过 Q 版转换）' : origin === 'demo' ? '（已有流萤示例）' : ''}` : '选好一个形象，再进入姿态设计';
  updateControls();
}
function getPoseRequest(poses, revision) {
  return {
    baseImage: { id: state.base.id, dataUrl: state.base.dataUrl, source: state.base.source },
    poses: poses.map(({ id, name, description, referenceImage, editNote }) => ({
      id, name, description, editNote: editNote || '', referenceImage: referenceImage || null,
      currentImage: state.poses.find(pose => pose.id === id)?.image || null,
    })),
    revision,
  };
}
async function asDataUrl(image) {
  if (image.dataUrl.startsWith('data:')) return image.dataUrl;
  if (!embeddedImages.has(image.dataUrl)) embeddedImages.set(image.dataUrl, (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    let blob;
    try {
      const response = await fetch(new URL(image.dataUrl, window.location.href), { signal: controller.signal, cache: 'force-cache' });
      if (!response.ok) throw new Error('示例图片读取失败，请点击「立即保存」重试');
      blob = await response.blob();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('示例图片读取超时，请检查网络后点击「立即保存」重试');
      throw error;
    } finally { clearTimeout(timeout); }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  })().catch(error => { embeddedImages.delete(image.dataUrl); throw error; }));
  return embeddedImages.get(image.dataUrl);
}
function safeResults(result) {
  if (!result || !Array.isArray(result.images)) throw new Error('图片接口没有返回可用结果');
  const images = result.images.filter((image) => image && typeof image.dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(image.dataUrl));
  if (!images.length) throw new Error('图片接口没有返回有效的图片数据');
  return images;
}
async function requestChibi() {
  if (!state.references.length || state.busy) return;
  state.busy = true; state.controller = new AbortController();
  const revision = state.revision;
  updateControls();
  try {
    const result = await generateChibi({
      references: state.references.map(({ id, name, dataUrl }) => ({ id, name, dataUrl })),
      description: $('description').value.trim(),
      style: document.querySelector('input[name="style"]:checked').value,
      count: Number(document.querySelector('input[name="count"]:checked').value),
    }, { signal: state.controller.signal });
    if (revision !== state.revision) return;
    const results = safeResults(result).map((image, index) => ({ ...image, id: image.id || createId(), name: `Q 版候选 ${index + 1}`, source: image.source === 'demo' ? 'demo' : 'generated' }));
    setCandidates(results);
    notice('chibi', `已收到 ${results.length} 张图片，请选择喜欢的形象`);
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    notice('chibi', error.code === 'GENERATION_NOT_CONFIGURED' ? '参考图和画风已准备好。图片生成接口待接入，当前没有生成新图片；可使用参考原图，或用下方流萤示例体验流程' : '暂时无法获取图片，请稍后重试。你的参考图仍保留在当前页面', error.code !== 'GENERATION_NOT_CONFIGURED');
  } finally {
    if (revision === state.revision) { state.busy = false; state.controller = null; updateControls(); scheduleDraft(); }
  }
}
function renderPoseOptions() {
  $('pose-options').replaceChildren();
  for (const pose of state.definitions) {
    const label = element('label', 'pose-option');
    const input = element('input'); input.type = 'checkbox'; input.value = pose.id; input.checked = state.chosenPoses.has(pose.id);
    input.addEventListener('change', () => { input.checked ? state.chosenPoses.add(pose.id) : state.chosenPoses.delete(pose.id); renderPoses(); updateControls(); });
    label.append(input, element('span', '', pose.name)); $('pose-options').append(label);
  }
}
function updateRedoBar() {
  $('redo-count').textContent = `已选 ${state.redo.size} 个姿态`;
  $('batch-bar').hidden = !state.poses.length;
  updateControls();
}
function renderPoses() {
  if (state.base) for (const definition of state.definitions) {
    if (state.chosenPoses.has(definition.id) && !state.poses.some(pose => pose.id === definition.id)) upsertPose(definition, {});
  }
  const grid = $('pose-grid'); grid.replaceChildren();
  grid.hidden = !state.poses.length;
  $('pose-empty').hidden = Boolean(state.poses.length);
  $('pose-count').textContent = `${state.poses.length} 个姿态`;
  for (const pose of state.poses) {
    const definition = state.definitions.find(entry => entry.id === pose.id);
    const card = element('article', `pose-card${state.redo.has(pose.id) ? ' is-redo-selected' : ''}`);
    card.dataset.poseId = pose.id;
    const visual = element('div', 'pose-image');
    if (pose.image) {
      const img = element('img'); img.src = pose.image.dataUrl; img.alt = `${pose.name}：当前使用的姿态`;
      visual.append(element('span', 'source-badge', pose.image.source === 'reference' ? '手动导入图片' : sourceName(pose.image.source)), img);
    } else {
      const placeholder = element('div', 'pose-image-placeholder');
      placeholder.append(element('span', '', '✧'), element('p', '', '上传已有姿态，或等待绘图接入'));
      visual.append(placeholder);
    }
    const info = element('div', 'pose-info');
    const title = element('div', 'pose-title');
    const checkboxLabel = element('label');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = state.redo.has(pose.id);
    checkbox.setAttribute('aria-label', `选择重做 ${pose.name}`);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? state.redo.add(pose.id) : state.redo.delete(pose.id);
      card.classList.toggle('is-redo-selected', checkbox.checked); updateRedoBar();
    });
    checkboxLabel.append(checkbox, element('span', '', '选中重做'));
    title.append(element('strong', '', pose.name), checkboxLabel);
    const statusText = pose.pending ? (pose.image ? '待重做 · 保留上一版，接口待接入' : '待生成 · 图片接口待接入') : pose.image?.source === 'demo' ? '已有示例图片，未执行新生成' : pose.image ? '图片已就绪' : '尚无图片';
    const actions = element('div', 'pose-actions');
    const redo = element('button', '', '↻ 只重做这张'); redo.type = 'button'; redo.disabled = state.busy;
    redo.addEventListener('click', () => requestPoses([pose.id], true));
    actions.append(redo);
    const importLabel = element('label', 'pose-file-button', '导入姿态图片 ↑');
    const resultInput = element('input', 'pose-result-input'); resultInput.type = 'file'; resultInput.accept = 'image/png,image/jpeg,image/webp';
    resultInput.setAttribute('aria-label', `导入 ${pose.name} 的姿态图片`);
    resultInput.addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; acceptPoseImage(pose.id, file, false); });
    importLabel.append(resultInput); actions.append(importLabel);
    if (pose.image) {
      const download = element('button', 'download-pose', pose.image.source === 'demo' ? '下载示例 ↓' : '下载图片 ↓'); download.type = 'button';
      download.addEventListener('click', async () => {
        try { const data = await asDataUrl(pose.image); downloadUrl(data, `Ha-mio-${pose.name}-${pose.image.source === 'demo' ? '示例' : '图片'}.${imageExtension(data)}`); }
        catch { notice('pose', '下载未完成，请稍后重试', true); }
      });
      actions.append(download);
    }
    const edit = element('div', 'pose-edit');
    const noteLabel = element('label', 'field-label', '这张想怎样调整？');
    const noteInput = element('textarea', 'pose-edit-note'); noteInput.maxLength = 600; noteInput.rows = 2;
    noteInput.value = definition?.editNote || ''; noteInput.placeholder = '例如：保持画风和头的倾斜，只把手藏到背后';
    noteInput.setAttribute('aria-label', `修改 ${pose.name} 的要求`);
    noteInput.addEventListener('input', () => { if (state.busy) cancelPending(); definition.editNote = noteInput.value; });
    noteLabel.append(noteInput); edit.append(noteLabel);
    const referenceBox = element('div', 'pose-reference');
    if (definition?.referenceImage) {
      const reference = element('img'); reference.src = definition.referenceImage.dataUrl; reference.alt = `${pose.name}的姿势参考`;
      const remove = element('button', 'text-link', '移除参考'); remove.type = 'button';
      remove.addEventListener('click', () => { if (state.busy) cancelPending(); poseUploads.delete(`${pose.id}:reference`); definition.referenceImage = null; renderPoses(); });
      referenceBox.append(reference, element('span', '', '仅参考姿势，不替换人物'), remove);
    }
    const referenceLabel = element('label', 'pose-file-button', definition?.referenceImage ? '更换姿势参考' : '＋ 添加姿势参考图');
    const referenceInput = element('input', 'pose-reference-input'); referenceInput.type = 'file'; referenceInput.accept = 'image/png,image/jpeg,image/webp';
    referenceInput.setAttribute('aria-label', `上传 ${pose.name} 的姿势参考`);
    referenceInput.addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; acceptPoseImage(pose.id, file, true); });
    referenceLabel.append(referenceInput); referenceBox.append(referenceLabel); edit.append(referenceBox);
    info.append(title, element('p', 'pose-status', statusText), edit, actions);
    if (pose.history?.length) {
      const comparison = element('div', 'pose-comparison');
      const current = element('div', 'pose-version'); const currentImage = element('img'); currentImage.src = pose.image.dataUrl; currentImage.alt = `${pose.name}当前版本`;
      current.append(element('strong', '', '当前使用'), currentImage);
      const previous = element('div', 'pose-version'); const previousImage = element('img'); previousImage.src = pose.history[0].dataUrl; previousImage.alt = `${pose.name}之前的版本`;
      const versionSelect = element('select', 'pose-history-select'); versionSelect.setAttribute('aria-label', `对比 ${pose.name} 的旧版本`);
      pose.history.forEach((item, index) => { const option = element('option', '', `旧版 ${index + 1}${index === 0 ? '（最近）' : ''}`); option.value = String(index); versionSelect.append(option); });
      versionSelect.addEventListener('change', () => { previousImage.src = pose.history[Number(versionSelect.value)].dataUrl; });
      const restore = element('button', 'button subtle pose-restore', '用回这一版'); restore.type = 'button';
      restore.addEventListener('click', () => {
        if (state.busy) cancelPending();
        replacePoseImage(definition, pose.history[Number(versionSelect.value)]);
        renderPoses(); notice('pose', `已恢复“${pose.name}”的旧版本，被替换的版本也已保留`);
      });
      previous.append(versionSelect, previousImage, restore); comparison.append(current, previous); info.append(comparison);
    }
    card.append(visual, info); grid.append(card);
  }
  updateRedoBar();
}
function upsertPose(definition, changes) {
  let pose = state.poses.find((entry) => entry.id === definition.id);
  if (!pose) { pose = { id: definition.id, name: definition.name, description: definition.description, image: null, history: [], pending: false }; state.poses.push(pose); }
  Object.assign(pose, changes);
}
function replacePoseImage(definition, image) {
  upsertPose(definition, {});
  const pose = state.poses.find(entry => entry.id === definition.id);
  if (pose.image?.id === image.id && pose.image.dataUrl === image.dataUrl) { pose.pending = false; return; }
  pose.history = [pose.image, ...(pose.history || [])].filter(item => item && item.id !== image.id)
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 4);
  pose.image = image; pose.pending = false; state.redo.delete(definition.id);
}
async function acceptPoseImage(id, file, referenceOnly) {
  if (!file || !state.base) return;
  if (!TYPES.has(file.type) || file.size > MAX_FILE_BYTES) { notice('pose', '请选择不超过 10 MB 的 PNG、JPG 或 WebP 图片', true); return; }
  if (state.busy) cancelPending();
  const revision = state.revision;
  const key = `${id}:${referenceOnly ? 'reference' : 'result'}`;
  const token = Symbol(); poseUploads.set(key, token);
  try {
    const picture = { ...await readImage(file), source: 'reference', ...(!referenceOnly ? { poseId: id } : {}) };
    if (revision !== state.revision || poseUploads.get(key) !== token) return;
    const definition = state.definitions.find(entry => entry.id === id);
    if (!definition) return;
    if (referenceOnly) definition.referenceImage = picture;
    else replacePoseImage(definition, picture);
    renderPoses(); scheduleDraft();
    notice('pose', referenceOnly ? `已添加“${definition.name}”的姿势参考，绘图接入后会随修改要求一起提交；参考图不会直接变成结果` : `已导入“${definition.name}”的图片${state.poses.find(pose => pose.id === id).history.length ? '，原版本已保留，可在下方对比' : ''}；这是你提供的素材，没有执行 AI 生成`);
  } catch (error) { if (revision === state.revision && poseUploads.get(key) === token) notice('pose', error.message, true); }
}
async function requestPoses(ids = [...state.chosenPoses], redo = false) {
  if (!state.base || state.busy || !ids.length) return;
  const definitions = state.definitions.filter((pose) => ids.includes(pose.id));
  if (!definitions.length) return;
  state.busy = true; state.controller = new AbortController();
  const revision = state.revision;
  const controller = state.controller;
  updateControls();
  for (const definition of definitions) upsertPose(definition, { pending: true });
  renderPoses();
  try {
    const request = getPoseRequest(definitions, revision);
    request.baseImage.dataUrl = await asDataUrl(state.base);
    for (const pose of request.poses) {
      if (pose.referenceImage) pose.referenceImage = { ...pose.referenceImage, dataUrl: await asDataUrl(pose.referenceImage) };
      if (pose.currentImage) pose.currentImage = { ...pose.currentImage, dataUrl: await asDataUrl(pose.currentImage) };
    }
    if (revision !== state.revision || controller.signal.aborted) return;
    const result = await generatePoses(request, { signal: controller.signal });
    if (revision !== state.revision) return;
    const images = safeResults(result);
    for (const definition of definitions) {
      const image = images.find((entry) => entry.poseId === definition.id);
      if (image) replacePoseImage(definition, { ...image, source: image.source === 'demo' ? 'demo' : 'generated' });
    }
    notice('pose', '已更新接口返回的对应姿态，未返回的姿态仍保留原图');
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    notice('pose', error.code === 'GENERATION_NOT_CONFIGURED'
      ? `${definitions.map((pose) => pose.name).join('、')}已标记为待${redo ? '重做' : '生成'}。图片生成接口待接入，当前没有生成新图片，其他姿态保持原样`
      : '暂时无法获取姿态图片，已有图片仍然保留。请稍后重试', error.code !== 'GENERATION_NOT_CONFIGURED');
  } finally {
    if (revision === state.revision) { state.busy = false; state.controller = null; renderPoses(); scheduleDraft(); }
  }
}
function loadPoseExamples() {
  if (state.base?.source !== 'demo') return;
  const definitions = state.definitions.filter((pose) => state.chosenPoses.has(pose.id));
  const unavailable = [];
  for (const definition of definitions) {
    if (definition.sample) replacePoseImage(definition, { id: `sample-${definition.id}`, dataUrl: definition.sample, source: 'demo' });
    else { unavailable.push(definition.name); upsertPose(definition, { pending: true }); }
  }
  notice('pose', `已展示选中姿态对应的现有流萤素材，没有执行 AI 生成${unavailable.length ? `。${unavailable.join('、')}暂无示例，保留为待生成` : '。可以勾选不满意的姿态，体验单独重做流程'}`);
  renderPoses();
}
function imageExtension(dataUrl) {
  return dataUrl.startsWith('data:image/webp') ? 'webp' : dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png';
}
function downloadUrl(url, filename) {
  const anchor = element('a'); anchor.href = url; anchor.download = filename; anchor.hidden = true;
  document.body.append(anchor); anchor.click(); anchor.remove();
}

function invalidatePersonaRequest() {
  persona.revision += 1;
  persona.controller?.abort();
  persona.controller = null;
  persona.busy = false;
  $('persona-suggestion')?.remove();
}
function setPersonaDraft(draft, source = 'manual') {
  invalidatePersonaRequest();
  persona.draft = normalizePersonaDraft(draft);
  persona.source = source;
  $('persona-brief').value = persona.draft.brief;
  for (const field of PERSONA_FIELDS) $('persona-' + field).value = persona.draft.fields[field];
  renderPersonaPreview();
}
function resetPersona() {
  setPersonaDraft(createPersonaDraft());
  notice('persona', '');
}
function readPersonaInputs() {
  return normalizePersonaDraft({
    brief: $('persona-brief').value,
    fields: Object.fromEntries(PERSONA_FIELDS.map((field) => [field, $('persona-' + field).value])),
  });
}
function personaPreviewLines(draft) {
  const rows = [];
  if (draft.fields.greeting.trim()) rows.push({ label: draft.fields.name || '角色', text: draft.fields.greeting, user: false });
  for (const line of draft.fields.examples.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^([^：:]{1,40})[：:]\s*(.*)$/u);
    if (match) {
      rows.push({ label: match[1], text: match[2], user: ['用户', '我', '你'].includes(match[1]) });
    } else if (rows.length && rows.at(-1).example) {
      rows.at(-1).text += '\n' + line;
    } else {
      rows.push({ label: '台词示例', text: line, user: false });
    }
    rows.at(-1).example = true;
  }
  return rows.slice(0, 5);
}
function renderPersonaPreview() {
  const prompt = compilePersonaPrompt(persona.draft);
  const name = persona.draft.fields.name || '还没起名的朋友';
  const avatar = $('persona-avatar');
  if (state.base) avatar.src = state.base.dataUrl;
  else avatar.removeAttribute('src');
  avatar.alt = '当前选中的角色形象';
  $('persona-character-name').textContent = name;
  $('persona-source').textContent = persona.source === 'demo' ? '流萤人设示例 · 可修改' : persona.source === 'generated' ? '已采纳 AI 人设草稿' : '手动设定 · 本地整理';
  $('persona-use-example').hidden = state.base?.source !== 'demo';
  $('prompt-preview').value = prompt;
  $('prompt-count').textContent = `${prompt.length} 字`;
  $('copy-prompt').disabled = !prompt;
  $('download-prompt').disabled = !prompt;
  $('persona-ai-refine').disabled = persona.busy || !prompt;
  $('persona-ai-refine').textContent = persona.busy ? '正在完善人设…' : 'AI 帮我完善';
  const preview = $('persona-dialogue');
  preview.replaceChildren();
  const lines = personaPreviewLines(persona.draft);
  if (!lines.length) {
    preview.append(element('p', 'persona-preview-empty', '写下开场白或台词示例，就能在这里看看说话的感觉'));
  }
  for (const line of lines) {
    const bubble = element('div', `persona-dialogue-message${line.user ? ' is-user' : ''}`);
    bubble.append(element('strong', 'persona-dialogue-label', line.label), element('p', '', line.text));
    preview.append(bubble);
  }
}
function editPersona() {
  invalidatePersonaRequest();
  persona.draft = readPersonaInputs();
  persona.source = 'manual';
  notice('persona', '');
  renderPersonaPreview();
}
async function requestPersona() {
  if (!state.base || persona.busy || !compilePersonaPrompt(persona.draft)) return;
  invalidatePersonaRequest();
  const revision = persona.revision;
  const characterRevision = state.revision;
  persona.busy = true;
  const controller = new AbortController();
  persona.controller = controller;
  renderPersonaPreview();
  try {
    const result = await refinePersona({ draft: persona.draft, characterId: state.base.id }, { signal: controller.signal });
    if (persona.revision !== revision || state.revision !== characterRevision) return;
    const suggestion = element('div', 'persona-suggestion'); suggestion.id = 'persona-suggestion';
    suggestion.append(element('h3', '', result.source === 'demo' ? '示例人设建议' : 'AI 人设建议'));
    const preview = element('textarea'); preview.readOnly = true; preview.rows = 8;
    preview.setAttribute('aria-label', '待采纳的人设提示词');
    preview.value = compilePersonaPrompt(result.draft);
    const actions = element('div', 'persona-actions');
    const accept = element('button', 'button secondary', '采纳这版建议'); accept.type = 'button';
    accept.addEventListener('click', () => { setPersonaDraft(result.draft, result.source); notice('persona', '已采纳人设建议，你还可以继续修改'); });
    const dismiss = element('button', 'button subtle', '保留我的设定'); dismiss.type = 'button';
    dismiss.addEventListener('click', () => { suggestion.remove(); notice('persona', '已保留你的设定'); });
    actions.append(accept, dismiss); suggestion.append(preview, actions);
    $('persona-notice').after(suggestion);
    notice('persona', '先查看建议，再决定是否采纳。当前设定尚未改变');
  } catch (error) {
    if (persona.revision !== revision || state.revision !== characterRevision || error.name === 'AbortError') return;
    notice('persona', error.code === 'PERSONA_NOT_CONFIGURED'
      ? 'AI 人设接口尚未接入。你填写的内容已经在右侧整理成提示词，可以继续编辑、复制或保存；当前没有调用模型'
      : '暂时无法获取人设建议，你填写的内容仍然保留', error.code !== 'PERSONA_NOT_CONFIGURED');
  } finally {
    if (persona.revision === revision) { persona.busy = false; persona.controller = null; renderPersonaPreview(); }
  }
}
function downloadPrompt() {
  const prompt = compilePersonaPrompt(persona.draft);
  if (!prompt) return;
  const url = URL.createObjectURL(new Blob([prompt], { type: 'text/plain;charset=utf-8' }));
  downloadUrl(url, 'Ha-mio-角色人设提示词.txt');
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  notice('persona', '人设提示词已下载，可在之后接入的聊天服务中使用');
}
function projectSnapshot() {
  return structuredClone({
    schema: 'hamio-character-studio', schemaVersion: 4, edition: 'interface-preview',
    createdAt: new Date().toISOString(), description: $('description').value,
    style: document.querySelector('input[name="style"]:checked').value,
    requestedCount: Number(document.querySelector('input[name="count"]:checked').value),
    references: state.references, candidates: state.candidates, baseImage: state.base,
    poseDefinitions: state.definitions.map(({ id, name, description, referenceImage, editNote }) => ({ id, name, description, referenceImage: referenceImage || null, editNote: editNote || '' })),
    selectedPoseIds: [...state.chosenPoses], poses: state.poses,
    persona: { ...normalizePersonaDraft(persona.draft), source: persona.source },
    previewSettings: petPreview.getSettings(),
  });
}
async function embedProjectImages(snapshot) {
  const embed = async image => image ? { ...image, dataUrl: await asDataUrl(image) } : null;
  [snapshot.baseImage, snapshot.references, snapshot.candidates, snapshot.poseDefinitions, snapshot.poses] = await Promise.all([
    embed(snapshot.baseImage),
    Promise.all(snapshot.references.map(embed)),
    Promise.all(snapshot.candidates.map(embed)),
    Promise.all(snapshot.poseDefinitions.map(async definition => ({ ...definition, referenceImage: await embed(definition.referenceImage) }))),
    Promise.all(snapshot.poses.map(async pose => ({ ...pose, image: await embed(pose.image), history: await Promise.all((pose.history || []).map(embed)) }))),
  ]);
  return snapshot;
}
async function exportDesign(asBundle = false) {
  if (!state.base || exporting) return;
  exporting = true;
  for (const id of ['export-project', 'persona-export', 'trial-export', 'export-bundle']) $(id).disabled = true;
  const revision = state.revision;
  const panel = state.step === 4 ? 'trial' : state.step === 3 ? 'persona' : 'pose';
  const snapshot = projectSnapshot();
  const status = $('bundle-status');
  if (asBundle) {
    status.hidden = false; status.classList.remove('error');
    status.textContent = '正在整理图片、提示词和设计备份…';
    $('export-bundle').textContent = '正在整理创作包…';
  }
  try {
    // Allow the progress message to paint before decoding larger local images.
    if (asBundle) await new Promise(resolve => window.setTimeout(resolve, 0));
    await embedProjectImages(snapshot);
    if (revision !== state.revision) return;
    const payload = normalizeProject(snapshot);
    const bundle = asBundle ? await buildCreationBundle(payload) : null;
    if (revision !== state.revision) return;
    const blob = bundle?.blob || new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    if (!asBundle && blob.size > PROJECT_MAX_BYTES) throw new Error('项目超过 100 MB，请缩小图片后再保存');
    const url = URL.createObjectURL(blob); downloadUrl(url, bundle?.filename || 'Ha-mio-角色设计草稿.json');
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (asBundle) {
      status.textContent = `创作包已交给浏览器下载，共 ${bundle.fileCount} 个文件。解压后导入 project.json 可继续编辑；这不是桌宠安装包`;
    } else notice(panel, '项目已导出，包含图片、姿势参考、修改要求、旧版本、人设与互动设置。可通过“导入设计”继续；这不是安装包');
  } catch (error) {
    const message = error.message || '保存未完成，请稍后重试';
    if (asBundle) { status.hidden = false; status.textContent = `创作包未导出：${message}。当前设计仍然保留`; status.classList.add('error'); }
    else notice(panel, message, true);
  }
  finally {
    exporting = false;
    for (const id of ['export-project', 'persona-export', 'trial-export', 'export-bundle']) $(id).disabled = !state.base;
    $('export-bundle').textContent = '导出创作包 ZIP ↓';
    if (asBundle && revision !== state.revision) status.textContent = '设计已切换，本次导出已取消，请按当前设计重新导出';
  }
}
function exportProject() { return exportDesign(); }
function validateImportedImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => { image.src = ''; reject(new Error('项目内有图片无法读取，请检查文件')); }, 15000);
    image.onload = () => {
      clearTimeout(timer);
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 50000000) reject(new Error('项目内图片尺寸过大，请使用不超过 5000 万像素的图片'));
      else resolve();
    };
    image.onerror = () => { clearTimeout(timer); reject(new Error('项目内有损坏的图片，当前设计未改变')); };
    image.src = dataUrl;
  });
}
function syncBaseSummary() {
  if (!state.base) return;
  $('base-preview').src = state.base.dataUrl;
  $('base-name').textContent = state.base.name;
  $('base-source').textContent = sourceName(state.base.source);
  $('download-base').textContent = state.base.source === 'reference' ? '下载原图 ↓' : state.base.source === 'demo' ? '下载示例 ↓' : '下载图片 ↓';
  $('load-pose-examples').hidden = state.base.source !== 'demo';
}
function projectImages(project) {
  return new Set([
    project.baseImage?.dataUrl, ...project.references.map(x => x.dataUrl), ...project.candidates.map(x => x.dataUrl),
    ...project.poseDefinitions.map(x => x.referenceImage?.dataUrl),
    ...project.poses.flatMap(x => [x.image?.dataUrl, ...(x.history || []).map(image => image.dataUrl)]),
  ].filter(Boolean));
}
function hasCurrentDesign() {
  return Boolean(state.references.length || state.candidates.length || state.base || $('description').value.trim() ||
    $('custom-pose-name').value.trim() || $('custom-pose-description').value.trim() || compilePersonaPrompt(persona.draft) ||
    document.querySelector('input[name="style"]:checked').value !== 'soft' || document.querySelector('input[name="count"]:checked').value !== '4');
}
function adoptProject(project, { selectedId = project.baseImage?.id || null, step = 4, customPoseName = '', customPoseDescription = '' } = {}) {
  clearCharacter();
  state.references = project.references; state.candidates = project.candidates;
  state.selectedId = selectedId; state.base = project.baseImage;
  state.definitions = project.poseDefinitions.map(definition => {
    const sample = DEFAULT_POSES.find(x => x.id === definition.id)?.sample;
    return { ...definition, ...(sample ? { sample } : {}) };
  });
  state.chosenPoses = new Set(project.selectedPoseIds); state.poses = project.poses;
  $('description').value = project.description;
  $('custom-pose-name').value = customPoseName; $('custom-pose-description').value = customPoseDescription;
  document.querySelector(`input[name="style"][value="${project.style}"]`).checked = true;
  document.querySelector(`input[name="count"][value="${project.requestedCount}"]`).checked = true;
  setPersonaDraft(project.persona, project.persona.source);
  syncBaseSummary(); renderReferences(); renderCandidates(); renderPoseOptions(); renderPoses();
  petPreview.setSettings(project.previewSettings);
  showStep(state.base ? step : 1);
}
async function importProject(file) {
  if (!file) return;
  const attempt = ++importAttempt;
  try {
    if (file.size > PROJECT_MAX_BYTES) throw new Error('项目文件不能超过 100 MB');
    notice('project', '正在读取并检查项目，当前设计会保留到确认导入为止');
    const project = parseProject(await file.text());
    const imageData = projectImages(project);
    // Decode one at a time to avoid a large memory spike from a whole sprite set.
    for (const dataUrl of imageData) {
      if (attempt !== importAttempt) return;
      await validateImportedImage(dataUrl);
    }
    if (attempt !== importAttempt) return;
    if (hasCurrentDesign() && !window.confirm('导入会替换当前设计和本地自动草稿。如需保留，请先导出文件。确定导入吗？')) {
      notice('project', '已取消导入，当前设计没有改变'); return;
    }
    adoptProject(project);
    notice('chibi', '已恢复项目中的候选图片，可以继续选择和编辑');
    notice('pose', '已恢复项目中的姿态与待生成状态');
    notice('trial', '已恢复试养设置。这里只预览项目中的图片和台词，不会执行 AI 对话');
    notice('project', '项目已导入，图片、人设和试养设置均已恢复；文件仅在当前浏览器内读取');
    showStep(4, true);
    scheduleDraft();
  } catch (error) {
    if (attempt === importAttempt) notice('project', error.message || '项目无法读取，当前设计没有改变', true);
  }
}
function draftStatus(message, error = false) {
  $('draft-status').textContent = message;
  $('draft-status').classList.toggle('error', error);
}
function scheduleDraft() {
  renderCreationReview();
  if (!draftReady) return;
  draftRevision += 1; clearTimeout(draftTimer);
  draftStatus('有新修改，正在准备保存…');
  draftTimer = window.setTimeout(flushDraft, 700);
}
async function flushDraft() {
  clearTimeout(draftTimer); draftTimer = 0;
  if (!draftReady) return;
  const revision = draftRevision;
  const snapshot = {
    schema: 'hamio-studio-draft', schemaVersion: 1, savedAt: new Date().toISOString(),
    project: projectSnapshot(), selectedId: state.selectedId, step: state.step,
    customPoseName: $('custom-pose-name').value, customPoseDescription: $('custom-pose-description').value,
  };
  draftStatus('正在保存到此浏览器…');
  try {
    await embedProjectImages(snapshot.project);
    if (revision !== draftRevision) return;
    await draftStore.save(normalizeDraft(snapshot));
    if (revision === draftRevision) draftStatus('已自动保存 · 刷新后可恢复 · 仅在此浏览器');
  } catch (error) {
    if (revision === draftRevision) draftStatus(`草稿未保存：${error.message || '本地存储不可用'}。请保留页面或导出备份`, true);
  }
}
async function bootstrapDraft() {
  document.body.inert = true;
  try {
    const draft = await draftStore.load();
    if (draft) {
      for (const dataUrl of projectImages(draft.project)) await validateImportedImage(dataUrl);
      adoptProject(draft.project, draft);
      draftStatus('已恢复上次草稿 · 后续修改会自动保存在此浏览器');
    } else draftStatus('本地自动保存已开启 · 图片与人设不会上传');
  } catch (error) { draftStatus(`未能恢复本地草稿：${error.message || '存储不可用'}。你仍可继续编辑或导入文件`, true); }
  finally { draftReady = true; document.body.inert = false; }
}

$('reference-input').addEventListener('change', (event) => {
  const files = Array.from(event.target.files); event.target.value = ''; acceptFiles(files);
});
for (const name of ['dragenter', 'dragover']) $('upload-zone').addEventListener(name, (event) => { event.preventDefault(); $('upload-zone').classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) $('upload-zone').addEventListener(name, (event) => { event.preventDefault(); $('upload-zone').classList.remove('drag-over'); });
$('upload-zone').addEventListener('drop', (event) => acceptFiles(event.dataTransfer.files));
$('generate-chibi').addEventListener('click', requestChibi);
$('load-examples').addEventListener('click', () => {
  setCandidates(EXAMPLES.map((image) => ({ ...image })));
  notice('chibi', '这里展示的是 4 张已有流萤素材，用于体验选择流程；不是根据参考图新生成的 Q 版候选');
});
$('use-reference').addEventListener('click', () => {
  setCandidates(state.references.map((reference, index) => ({ ...reference, name: `参考原图 ${index + 1}`, source: 'reference' })));
  notice('chibi', '这些图片保持上传时的原样，没有经过 Q 版转换。选择一张即可体验姿态设计');
});
$('confirm-character').addEventListener('click', () => {
  const candidate = state.candidates.find((image) => image.id === state.selectedId);
  if (!candidate) return;
  if (state.base?.id !== candidate.id) { clearCharacter(); state.base = { ...candidate }; }
  syncBaseSummary(); renderPoses();
  notice('pose', state.base.source === 'demo' ? '当前使用已有流萤示例。选好姿态后，可查看对应示例图片，或体验生成与逐张重做的入口' : state.base.source === 'reference' ? '当前形象是上传的参考原图，尚未转换为 Q 版。图片接口接入后才能生成不同姿态' : '选择一个或多个姿态，再开始生成');
  updateControls(); showStep(2, true);
});
$('step-one').addEventListener('click', () => showStep(1));
$('step-two').addEventListener('click', () => { if (state.base) showStep(2); });
$('step-three').addEventListener('click', () => showStep(3));
$('step-four').addEventListener('click', () => showStep(4));
$('continue-persona').addEventListener('click', () => showStep(3, true));
$('continue-trial').addEventListener('click', () => showStep(4, true));
$('persona-back').addEventListener('click', () => showStep(2, true));
$('trial-back').addEventListener('click', () => showStep(3, true));
$('change-character').addEventListener('click', () => { showStep(1, true); notice('chibi', '再次确认同一张形象，会保留已有姿态和人设。选择其他形象会清空这些设置，如需保留，请先保存设计 JSON'); });
$('download-base').addEventListener('click', async () => {
  if (!state.base) return;
  const base = { ...state.base };
  try {
    const data = await asDataUrl(base);
    const kind = base.source === 'reference' ? '原图' : base.source === 'demo' ? '示例' : '图片';
    downloadUrl(data, `Ha-mio-${kind}.${imageExtension(data)}`);
  } catch { notice('pose', '图片未能下载，请稍后重试', true); }
});
$('generate-poses').addEventListener('click', () => requestPoses());
$('load-pose-examples').addEventListener('click', loadPoseExamples);
$('redo-selected').addEventListener('click', () => requestPoses([...state.redo], true));
$('add-pose').addEventListener('click', () => {
  const name = $('custom-pose-name').value.trim();
  const description = $('custom-pose-description').value.trim();
  if (!name) { notice('pose', '先给这个姿态起个名字吧', true); $('custom-pose-name').focus(); return; }
  if (state.definitions.some((pose) => pose.name === name)) { notice('pose', '已经有这个名字的姿态了，可以直接在上方勾选', true); return; }
  if (state.definitions.length >= 12) { notice('pose', '这一版最多设计 12 种姿态', true); return; }
  const pose = { id: `custom-${createId()}`, name, description: description || name };
  state.definitions.push(pose); state.chosenPoses.add(pose.id);
  $('custom-pose-name').value = ''; $('custom-pose-description').value = '';
  renderPoseOptions(); renderPoses(); updateControls(); notice('pose', `已添加并选中“${name}”，可以添加参考、导入图片或准备生成要求`);
});
$('export-project').addEventListener('click', exportProject);
$('persona-export').addEventListener('click', exportProject);
$('trial-export').addEventListener('click', exportProject);
$('export-bundle').addEventListener('click', () => exportDesign(true));
$('review-next').addEventListener('click', () => {
  const next = creationReview().next;
  if (next) goToCheck(next);
  else showStep(4, true);
});
$('project-input').addEventListener('change', (event) => {
  const file = event.target.files[0]; event.target.value = ''; importProject(file);
});
$('persona-brief').addEventListener('input', editPersona);
for (const field of PERSONA_FIELDS) $('persona-' + field).addEventListener('input', editPersona);
$('persona-use-example').addEventListener('click', () => {
  if (state.base?.source !== 'demo') return;
  if (compilePersonaPrompt(persona.draft) && !window.confirm('载入示例会替换当前人设文字。要载入流萤示例吗？')) return;
  setPersonaDraft(getFireflyPersonaExample(), 'demo');
  notice('persona', '已载入预先写好的流萤人设示例，可以自由修改；没有调用 AI');
});
$('persona-ai-refine').addEventListener('click', requestPersona);
$('download-prompt').addEventListener('click', downloadPrompt);
$('copy-prompt').addEventListener('click', async () => {
  const prompt = compilePersonaPrompt(persona.draft);
  if (!prompt) return;
  try { await navigator.clipboard.writeText(prompt); notice('persona', '人设提示词已复制'); }
  catch {
    $('prompt-preview').focus(); $('prompt-preview').select();
    notice('persona', '浏览器未允许自动复制，已选中提示词，请手动复制或下载 TXT');
  }
});
$('reset-project').addEventListener('click', async () => {
  if (hasCurrentDesign() && !window.confirm('重新开始会清空当前设计和此浏览器的自动草稿。已导出的文件不受影响，确定继续吗？')) return;
  draftRevision += 1; clearTimeout(draftTimer); draftTimer = 0;
  const resetRevision = draftRevision;
  state.uploadRevision += 1; clearCharacter(); state.references = []; state.candidates = []; state.selectedId = null;
  state.definitions = DEFAULT_POSES.map((pose) => ({ ...pose })); state.chosenPoses = new Set(['happy', 'shy', 'peek']);
  $('description').value = ''; $('custom-pose-name').value = ''; $('custom-pose-description').value = ''; $('reference-input').value = '';
  document.querySelector('input[name="style"][value="soft"]').checked = true;
  document.querySelector('input[name="count"][value="4"]').checked = true;
  notice('chibi', ''); notice('pose', ''); notice('trial', ''); notice('project', '');
  $('bundle-status').hidden = true; $('bundle-status').textContent = '';
  renderReferences(); renderCandidates(); renderPoseOptions(); showStep(1, true);
  try { await draftStore.clear(); if (resetRevision === draftRevision) draftStatus('本地草稿已清除 · 可以重新开始'); }
  catch (error) { if (resetRevision === draftRevision) draftStatus(`未能清除旧草稿：${error.message}。请点击“立即保存”覆盖为空白设计`, true); }
});
const apiStatus = getGenerationStatus();
$('api-label').textContent = apiStatus.label;
petPreview = createPetPreview({
  root: $('trial-panel'),
  getData: () => ({ baseImage: state.base, poses: state.poses, persona: persona.draft }),
  onSettingsChange: scheduleDraft,
});
renderPersonaPreview();
renderReferences(); renderCandidates(); renderPoseOptions(); renderPoses();
document.addEventListener('input', scheduleDraft);
document.addEventListener('change', scheduleDraft);
document.addEventListener('click', event => {
  if (!event.target.closest('#reset-project, #draft-save')) queueMicrotask(scheduleDraft);
});
$('draft-save').addEventListener('click', () => { draftRevision += 1; flushDraft(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && draftTimer) flushDraft(); });
window.addEventListener('pagehide', () => { if (draftTimer) flushDraft(); });
bootstrapDraft();
