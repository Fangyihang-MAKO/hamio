import { generateChibi, generatePoses, getGenerationStatus } from './api.js';

const $ = (id) => document.getElementById(id);
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
  { id: 'sleepy', name: '困倦', description: '困倦地打哈欠，眼睛微微闭起' },
  { id: 'wave', name: '招手', description: '向面前的人轻轻挥手打招呼' },
];
const state = {
  references: [], candidates: [], selectedId: null, base: null, poses: [],
  definitions: DEFAULT_POSES.map((pose) => ({ ...pose })),
  chosenPoses: new Set(['happy', 'shy', 'peek']), redo: new Set(),
  revision: 0, uploadRevision: 0, busy: false, controller: null,
};

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
  cancelPending();
  state.base = null;
  state.poses = [];
  state.redo.clear();
  renderPoses();
  updateControls();
}
function setCandidates(items) {
  clearCharacter();
  state.candidates = items;
  state.selectedId = null;
  renderCandidates();
}
function updateControls() {
  $('generate-chibi').disabled = !state.references.length || state.busy;
  $('use-reference').disabled = !state.references.length || state.busy;
  $('confirm-character').disabled = !state.selectedId || state.busy;
  $('step-two').disabled = !state.base;
  $('step-lock').hidden = Boolean(state.base);
  $('generate-poses').disabled = !state.base || !state.chosenPoses.size || state.busy;
  $('redo-selected').disabled = !state.redo.size || state.busy;
  $('load-pose-examples').disabled = !state.chosenPoses.size || state.busy;
}
function showStep(step, focus = false) {
  $('chibi-panel').hidden = step !== 1;
  $('pose-panel').hidden = step !== 2;
  $('step-one').classList.toggle('is-current', step === 1);
  $('step-two').classList.toggle('is-current', step === 2);
  $('step-one').setAttribute('aria-current', step === 1 ? 'step' : 'false');
  $('step-two').setAttribute('aria-current', step === 2 ? 'step' : 'false');
  if (focus) {
    $('workspace').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    (step === 1 ? $('reference-input') : $('generate-poses')).focus({ preventScroll: true });
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
        resolve({ id: crypto.randomUUID(), name: file.name, dataUrl: reader.result });
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
    poses: poses.map(({ id, name, description }) => ({ id, name, description })),
    revision,
  };
}
async function asDataUrl(image) {
  if (image.dataUrl.startsWith('data:')) return image.dataUrl;
  const response = await fetch(new URL(image.dataUrl, window.location.href));
  if (!response.ok) throw new Error('示例图片读取失败，请刷新后重试');
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
    const results = safeResults(result).map((image, index) => ({ ...image, id: image.id || crypto.randomUUID(), name: `Q 版候选 ${index + 1}`, source: image.source === 'demo' ? 'demo' : 'generated' }));
    setCandidates(results);
    notice('chibi', `已收到 ${results.length} 张图片，请选择喜欢的形象`);
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    notice('chibi', error.code === 'GENERATION_NOT_CONFIGURED' ? '参考图和画风已准备好。图片生成接口待接入，当前没有生成新图片；可使用参考原图，或用下方流萤示例体验流程' : '暂时无法获取图片，请稍后重试。你的参考图仍保留在当前页面', error.code !== 'GENERATION_NOT_CONFIGURED');
  } finally {
    if (revision === state.revision) { state.busy = false; state.controller = null; updateControls(); }
  }
}
function renderPoseOptions() {
  $('pose-options').replaceChildren();
  for (const pose of state.definitions) {
    const label = element('label', 'pose-option');
    const input = element('input'); input.type = 'checkbox'; input.value = pose.id; input.checked = state.chosenPoses.has(pose.id);
    input.addEventListener('change', () => { input.checked ? state.chosenPoses.add(pose.id) : state.chosenPoses.delete(pose.id); updateControls(); });
    label.append(input, element('span', '', pose.name)); $('pose-options').append(label);
  }
}
function updateRedoBar() {
  $('redo-count').textContent = `已选 ${state.redo.size} 个姿态`;
  $('batch-bar').hidden = !state.poses.length;
  updateControls();
}
function renderPoses() {
  const grid = $('pose-grid'); grid.replaceChildren();
  grid.hidden = !state.poses.length;
  $('pose-empty').hidden = Boolean(state.poses.length);
  $('pose-count').textContent = `${state.poses.length} 个姿态`;
  for (const pose of state.poses) {
    const card = element('article', `pose-card${state.redo.has(pose.id) ? ' is-redo-selected' : ''}`);
    const visual = element('div', 'pose-image');
    if (pose.image) {
      const img = element('img'); img.src = pose.image.dataUrl; img.alt = `${pose.name}：${sourceName(pose.image.source)}`;
      visual.append(element('span', 'source-badge', sourceName(pose.image.source)), img);
    } else {
      const placeholder = element('div', 'pose-image-placeholder');
      placeholder.append(element('span', '', '✧'), element('p', '', '等待图片生成接口'));
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
    if (pose.image) {
      const download = element('button', 'download-pose', pose.image.source === 'demo' ? '下载示例 ↓' : '下载图片 ↓'); download.type = 'button';
      download.addEventListener('click', async () => {
        try { const data = await asDataUrl(pose.image); downloadUrl(data, `Ha-mio-${pose.name}-${pose.image.source === 'demo' ? '示例' : '图片'}.${imageExtension(data)}`); }
        catch { notice('pose', '下载未完成，请稍后重试', true); }
      });
      actions.append(download);
    }
    info.append(title, element('p', 'pose-status', statusText), actions);
    card.append(visual, info); grid.append(card);
  }
  updateRedoBar();
}
function upsertPose(definition, changes) {
  let pose = state.poses.find((entry) => entry.id === definition.id);
  if (!pose) { pose = { id: definition.id, name: definition.name, description: definition.description, image: null, pending: false }; state.poses.push(pose); }
  Object.assign(pose, changes);
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
    if (revision !== state.revision || controller.signal.aborted) return;
    const result = await generatePoses(request, { signal: controller.signal });
    if (revision !== state.revision) return;
    const images = safeResults(result);
    for (const definition of definitions) {
      const image = images.find((entry) => entry.poseId === definition.id);
      if (image) { upsertPose(definition, { image: { ...image, source: image.source === 'demo' ? 'demo' : 'generated' }, pending: false }); state.redo.delete(definition.id); }
    }
    notice('pose', '已更新接口返回的对应姿态，未返回的姿态仍保留原图');
  } catch (error) {
    if (revision !== state.revision || error.name === 'AbortError') return;
    notice('pose', error.code === 'GENERATION_NOT_CONFIGURED'
      ? `${definitions.map((pose) => pose.name).join('、')}已标记为待${redo ? '重做' : '生成'}。图片生成接口待接入，当前没有生成新图片，其他姿态保持原样`
      : '暂时无法获取姿态图片，已有图片仍然保留。请稍后重试', error.code !== 'GENERATION_NOT_CONFIGURED');
  } finally {
    if (revision === state.revision) { state.busy = false; state.controller = null; renderPoses(); }
  }
}
function loadPoseExamples() {
  if (state.base?.source !== 'demo') return;
  const definitions = state.definitions.filter((pose) => state.chosenPoses.has(pose.id));
  const unavailable = [];
  for (const definition of definitions) {
    if (definition.sample) upsertPose(definition, { image: { id: `sample-${definition.id}`, dataUrl: definition.sample, source: 'demo' }, pending: false });
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
async function exportProject() {
  if (!state.base) return;
  const button = $('export-project'); button.disabled = true;
  const revision = state.revision;
  try {
    const base = { ...state.base, dataUrl: await asDataUrl(state.base) };
    const poses = await Promise.all(state.poses.map(async (pose) => ({ ...pose, image: pose.image ? { ...pose.image, dataUrl: await asDataUrl(pose.image) } : null })));
    if (revision !== state.revision) return;
    const payload = {
      schema: 'hamio-character-studio', schemaVersion: 1, edition: 'interface-preview',
      notice: '角色设计草稿，不是桌宠安装包；source=demo 为已有示例，source=reference 为未转换原图',
      createdAt: new Date().toISOString(), description: $('description').value.trim(),
      style: document.querySelector('input[name="style"]:checked').value,
      requestedCount: Number(document.querySelector('input[name="count"]:checked').value),
      references: state.references.map((reference) => ({ ...reference })), baseImage: base,
      poseDefinitions: state.definitions.map(({ id, name, description }) => ({ id, name, description })),
      selectedPoseIds: [...state.chosenPoses], poses,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); downloadUrl(url, 'Ha-mio-角色设计草稿.json');
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice('pose', '设计草稿已导出，包含当前图片和姿态设置；这是 JSON 文件，不是桌宠安装包');
  } catch { notice('pose', '保存未完成，请稍后重试', true); }
  finally { button.disabled = false; }
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
  $('base-preview').src = state.base.dataUrl;
  $('base-name').textContent = state.base.name;
  $('base-source').textContent = sourceName(state.base.source);
  $('download-base').textContent = state.base.source === 'reference' ? '下载原图 ↓' : state.base.source === 'demo' ? '下载示例 ↓' : '下载图片 ↓';
  $('load-pose-examples').hidden = state.base.source !== 'demo';
  notice('pose', state.base.source === 'demo' ? '当前使用已有流萤示例。选好姿态后，可查看对应示例图片，或体验生成与逐张重做的入口' : state.base.source === 'reference' ? '当前形象是上传的参考原图，尚未转换为 Q 版。图片接口接入后才能生成不同姿态' : '选择一个或多个姿态，再开始生成');
  updateControls(); showStep(2, true);
});
$('step-one').addEventListener('click', () => showStep(1));
$('step-two').addEventListener('click', () => { if (state.base) showStep(2); });
$('change-character').addEventListener('click', () => { showStep(1, true); notice('chibi', '再次确认同一张形象，会保留已有姿态。选择其他形象时会清空姿态，如需保留，请先在第二步保存设计 JSON'); });
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
  const pose = { id: `custom-${crypto.randomUUID()}`, name, description: description || name };
  state.definitions.push(pose); state.chosenPoses.add(pose.id);
  $('custom-pose-name').value = ''; $('custom-pose-description').value = '';
  renderPoseOptions(); updateControls(); notice('pose', `已添加并选中“${name}”，接入图片接口后可生成`);
});
$('export-project').addEventListener('click', exportProject);
$('reset-project').addEventListener('click', () => {
  if ((state.references.length || state.candidates.length || state.base) && !window.confirm('重新开始会清空本页的图片和设计。确定继续吗？')) return;
  state.uploadRevision += 1; clearCharacter(); state.references = []; state.candidates = []; state.selectedId = null;
  state.definitions = DEFAULT_POSES.map((pose) => ({ ...pose })); state.chosenPoses = new Set(['happy', 'shy', 'peek']);
  $('description').value = ''; $('custom-pose-name').value = ''; $('custom-pose-description').value = ''; $('reference-input').value = '';
  document.querySelector('input[name="style"][value="soft"]').checked = true;
  document.querySelector('input[name="count"][value="4"]').checked = true;
  notice('chibi', ''); notice('pose', ''); renderReferences(); renderCandidates(); renderPoseOptions(); showStep(1, true);
});
const apiStatus = getGenerationStatus();
$('api-label').textContent = apiStatus.label;
renderReferences(); renderCandidates(); renderPoseOptions(); renderPoses();
