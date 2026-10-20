/** Browser-only pet rehearsal. Uses only the selected character's existing images. */
const DEFAULT_SETTINGS = Object.freeze({ size: 70, opacity: 100, sway: 40, position: Object.freeze({ x: .55, y: .65 }), bindings: Object.freeze({ click: null, drag: null, work: null, rest: null }) });
const INTERACTIONS = Object.freeze([
  { key: 'click', label: '点击角色', autoIds: ['shy', 'happy'], missing: '害羞或开心姿态' },
  { key: 'drag', label: '拖动角色', autoIds: ['drag'], missing: '拖拽姿态' },
  { key: 'work', label: '模拟工作', autoIds: ['peek'], missing: '探头姿态' },
  { key: 'rest', label: '模拟休息', autoIds: ['sleepy', 'sleep'], missing: '困倦或睡觉姿态' },
]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numeric = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
const binding = value => value === 'base' || (typeof value === 'string' && value.startsWith('pose:') && value.length <= 125 && value.slice(5).trim()) ? value : null;
export function normalizePreviewSettings(value = {}) {
  return {
    size: Math.round(numeric(value?.size, 70, 30, 100)),
    opacity: Math.round(numeric(value?.opacity, 100, 20, 100)),
    sway: Math.round(numeric(value?.sway, 40, 0, 100)),
    position: { x: numeric(value?.position?.x, .55, 0, 1), y: numeric(value?.position?.y, .65, 0, 1) },
    bindings: Object.fromEntries(INTERACTIONS.map(({ key }) => [key, binding(value?.bindings?.[key])])),
  };
}

export function createPetPreview({ root, getData, onSettingsChange = () => {} }) {
  const $ = id => root.querySelector('#' + id);
  const arena = $('trial-arena');
  const pet = $('trial-pet');
  const body = $('trial-pet-body');
  const imageLayers = [$('trial-image-a'), $('trial-image-b')];
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let settings = normalizePreviewSettings();
  let options = [];
  let selected = 'base';
  let active = false;
  let renderedSource = '';
  let requestedSource = '';
  let visibleLayer = 0;
  let imageRevision = 0;
  let layoutFrame = 0;
  let drag = null;
  let suppressClick = false;
  let sizePx = 200;
  let data = { baseImage: null, poses: [], persona: { fields: {} } };
  let greeting = '';
  let bubbleWasShown = false;
  let scenario = 'daily';
  let workSide = 'left';
  let lastTrigger = 'daily';
  const bindingSelects = {};
  const bindingHints = {};
  const scenarioButtons = {};
  let interactionStatus;

  function sourceLabel(source) {
    return source === 'demo' ? '已有素材示例' : source === 'reference' ? '参考原图 · 未转 Q 版' : '当前角色图片';
  }
  function currentOption() { return options.find(option => option.id === selected) || options[0]; }
  function reportSettings() { onSettingsChange(getSettings()); }
  function getSettings() { return { ...settings, position: { ...settings.position }, bindings: { ...settings.bindings } }; }
  function notice(message, error = false) {
    $('trial-notice').textContent = message;
    $('trial-notice').hidden = !message;
    $('trial-notice').classList.toggle('error', error);
  }
  function syncMotion() {
    const paused = !active || document.hidden || media.matches;
    arena.classList.toggle('motion-paused', paused);
    arena.classList.toggle('motion-none', settings.sway === 0 || media.matches);
    body.style.setProperty('--trial-sway-angle', `${settings.sway * .04}deg`);
    body.style.setProperty('--trial-sway-rise', `${settings.sway * .05}px`);
    $('trial-motion-status').textContent = media.matches ? '跟随系统：减少动态效果' : settings.sway === 0 ? '晃动已关闭' : paused ? '预览已暂停' : '轻轻晃动中';
  }
  function arrangeBubble(left, top) {
    const speech = $('trial-speech');
    if (speech.hidden) return;
    const gap = 6;
    const x = clamp(left + sizePx / 2 - speech.offsetWidth / 2, 10, Math.max(10, arena.clientWidth - speech.offsetWidth - 10));
    let y = top - speech.offsetHeight - gap;
    if (y < 10) y = Math.min(top + sizePx - 8, arena.clientHeight - speech.offsetHeight - 12);
    speech.style.left = `${x}px`;
    speech.style.top = `${Math.max(10, y)}px`;
  }
  function layout() {
    layoutFrame = 0;
    if (!arena.clientWidth || !arena.clientHeight) return;
    const requestedSide = Math.min(360, arena.clientWidth * .76, arena.clientHeight * .78) * settings.size / 100;
    const angle = settings.sway * .04 * Math.PI / 180;
    const rise = settings.sway * .05;
    // The rotation pivot is at 50% / 75%. Reserve its furthest corner's
    // horizontal excursion, the complete vertical bob, and a 10 px soft-shadow
    // allowance. Keep the artwork's size stable when changing sway strength.
    // Position and pointer math use this complete envelope, not the raw image.
    const excursionRatio = .75 * Math.sin(angle);
    const arenaLimit = Math.min(arena.clientWidth, arena.clientHeight);
    const fittedSide = Math.max(1, (arenaLimit - 2 * (rise + 11)) / (1 + 2 * excursionRatio));
    const imageSide = Math.min(Math.max(1, requestedSide - 24), fittedSide);
    const padding = Math.max(12, Math.ceil(imageSide * excursionRatio + rise + 10));
    sizePx = imageSide + 2 * padding;
    pet.style.width = `${sizePx}px`;
    pet.style.height = `${sizePx}px`;
    pet.style.padding = `${padding}px`;
    // Work mode uses the complete safe envelope at the edge. The image remains
    // contained, including transparent margins, shadows and its sway excursion.
    const positionX = scenario === 'work' ? (workSide === 'left' ? 0 : 1) : settings.position.x;
    const left = (arena.clientWidth - sizePx) * positionX;
    const top = (arena.clientHeight - sizePx) * settings.position.y;
    pet.style.left = `${left}px`;
    pet.style.top = `${top}px`;
    arrangeBubble(left, top);
  }
  function scheduleLayout() {
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(layout);
  }
  function syncControls() {
    for (const key of ['size', 'opacity', 'sway']) {
      $('trial-' + key).value = String(settings[key]);
      $('trial-' + key + '-value').textContent = `${settings[key]}%`;
    }
    pet.style.opacity = String(settings.opacity / 100);
    syncMotion();
    scheduleLayout();
  }
  function setSettings(next) {
    settings = normalizePreviewSettings(next);
    renderBindings();
    syncControls();
    if (active && INTERACTIONS.some(({ key }) => key === lastTrigger)) runInteraction(lastTrigger);
  }
  function showGreeting() {
    bubbleWasShown = true;
    $('trial-speech').hidden = false;
    $('trial-speech-source').textContent = greeting ? '你填写的开场白' : '预览提示';
    $('trial-speech-text').textContent = greeting || '还没有写开场白，回到第三步补上一句吧';
    scheduleLayout();
  }
  async function displayImage(option) {
    if (!option) {
      imageRevision += 1;
      requestedSource = renderedSource = '';
      imageLayers.forEach(image => { image.classList.remove('is-visible'); image.removeAttribute('src'); });
      pet.hidden = true;
      return;
    }
    const source = option.image.dataUrl;
    if (source === requestedSource) return;
    requestedSource = source;
    const revision = ++imageRevision;
    try {
      // The current frame remains visible until the replacement has fully decoded.
      const nextImage = new Image();
      nextImage.src = source;
      await nextImage.decode();
      if (revision !== imageRevision) return;
      const oldLayer = imageLayers[visibleLayer];
      const nextIndex = renderedSource ? 1 - visibleLayer : visibleLayer;
      const nextLayer = imageLayers[nextIndex];
      nextLayer.src = source;
      await nextLayer.decode();
      if (revision !== imageRevision) return;
      nextLayer.alt = `${data.persona?.fields?.name || '当前角色'} · ${option.name}`;
      nextLayer.classList.add('is-visible');
      if (oldLayer !== nextLayer) oldLayer.classList.remove('is-visible');
      visibleLayer = nextIndex;
      renderedSource = source;
      pet.hidden = false;
      notice('');
      scheduleLayout();
    } catch {
      if (revision !== imageRevision) return;
      requestedSource = '';
      notice('这张姿态图片暂时无法打开，已保留上一个画面。可以选择其他姿态', true);
      if (!renderedSource) pet.hidden = true;
    }
  }
  function selectPose(id, sayGreeting = false) {
    if (!options.some(option => option.id === id)) return;
    selected = id;
    const option = currentOption();
    for (const button of $('trial-pose-options').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.poseId === selected));
    $('trial-current-pose').textContent = `当前：${option.name}${option.pending ? ' · 保留的上一版' : ''}`;
    pet.setAttribute('aria-label', `${data.persona?.fields?.name || '角色'}，${option.name}。拖动移动，轻点或回车触发互动`);
    pet.dataset.peek = String(scenario === 'work' && option.id === 'pose:peek');
    displayImage(option);
    if (sayGreeting) showGreeting();
  }
  function resolveBinding(key) {
    const value = settings.bindings[key];
    if (value !== null) return options.find(option => option.id === value);
    const definition = INTERACTIONS.find(item => item.key === key);
    for (const id of definition.autoIds) {
      const option = options.find(item => item.id === `pose:${id}`);
      if (option) return option;
    }
    return undefined;
  }
  function setInteractionStatus(message, fallback = false) {
    interactionStatus.textContent = message;
    interactionStatus.classList.toggle('is-fallback', fallback);
  }
  function syncScenario() {
    arena.classList.toggle('is-work-scenario', scenario === 'work');
    arena.classList.toggle('is-rest-scenario', scenario === 'rest');
    pet.dataset.edge = scenario === 'work' ? workSide : '';
    for (const [key, button] of Object.entries(scenarioButtons)) {
      button.disabled = !options.length;
      button.setAttribute('aria-pressed', String(key === 'daily' ? scenario === 'daily' : key === 'rest' ? scenario === 'rest' : scenario === 'work' && key === `work-${workSide}`));
    }
    scheduleLayout();
  }
  function runInteraction(key, sayGreeting = false) {
    if (!options.length) return false;
    const definition = INTERACTIONS.find(item => item.key === key);
    const option = resolveBinding(key);
    const fallbackOption = key === 'drag' ? currentOption() : options.find(item => item.id === 'base') || options[0];
    const chosen = option || fallbackOption;
    lastTrigger = key;
    selectPose(chosen.id, sayGreeting);
    const label = key === 'click' ? '点击互动' : key === 'drag' ? '拖动中' : key === 'work' ? `模拟工作 · 靠${workSide === 'left' ? '左' : '右'}` : '模拟休息';
    if (option) {
      const picture = option.id === 'base' ? '保持基础形象' : `使用「${option.name}」${option.pending ? '（保留的上一版）' : ''}`;
      setInteractionStatus(`${label}：${picture}。${key === 'drag' ? '松手后回到基础形象' : '展示已有静态姿态与轻晃'}`);
    } else {
      const missing = settings.bindings[key] === null ? `还没有${definition.missing}图片` : '绑定的姿态暂缺图片';
      const fallback = key === 'drag' ? '拖动时保留当前图片，松手后回到基础形象' : '先保持基础形象';
      setInteractionStatus(`${label}：${missing}，${fallback}。可在互动映射中选择已有姿态`, true);
    }
    syncScenario();
    return Boolean(option);
  }
  function resumeDaily(message = '恢复日常：显示基础形象，可点击或拖动互动') {
    scenario = 'daily';
    lastTrigger = 'daily';
    selectPose(options.find(option => option.id === 'base')?.id || options[0]?.id);
    setInteractionStatus(message);
    syncScenario();
  }
  function renderBindings() {
    for (const definition of INTERACTIONS) {
      const { key } = definition;
      const select = bindingSelects[key];
      const value = settings.bindings[key];
      select.replaceChildren();
      const entries = [{ id: '', name: '自动匹配' }, { id: 'base', name: '保持基础形象' }, ...options.filter(option => option.id !== 'base')];
      if (value && !entries.some(option => option.id === value)) {
        const pose = (data.poses || []).find(item => `pose:${item.id}` === value);
        entries.push({ id: value, name: `已绑定姿态缺图：${pose?.name || value.slice(5)}`, unavailable: true });
      }
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name;
        option.disabled = Boolean(entry.unavailable);
        select.append(option);
      }
      select.value = value ?? '';
      const resolved = resolveBinding(key);
      bindingHints[key].textContent = resolved ? `${value === null ? '自动匹配：' : '使用：'}${resolved.name}` : `${value === null ? `暂无${definition.missing}图` : '绑定的姿态暂缺图片'} · ${key === 'drag' ? '拖动时保留当前图片' : '保持基础形象'}`;
      bindingHints[key].classList.toggle('is-fallback', !resolved);
    }
  }
  function createInteractionControls() {
    const fieldset = document.createElement('fieldset');
    fieldset.id = 'trial-bindings';
    fieldset.className = 'form-section trial-bindings';
    const legend = document.createElement('legend');
    legend.className = 'field-label';
    legend.textContent = '互动对应姿态';
    fieldset.append(legend);
    for (const { key, label: labelText } of INTERACTIONS) {
      const row = document.createElement('div');
      row.className = 'trial-binding-row';
      const label = document.createElement('label');
      label.htmlFor = `trial-binding-${key}`;
      label.textContent = labelText;
      const select = document.createElement('select');
      select.id = `trial-binding-${key}`;
      select.setAttribute('aria-describedby', `trial-binding-${key}-hint`);
      const hint = document.createElement('p');
      hint.id = `trial-binding-${key}-hint`;
      hint.className = 'trial-binding-hint';
      bindingSelects[key] = select;
      bindingHints[key] = hint;
      select.addEventListener('change', () => {
        settings.bindings[key] = binding(select.value);
        renderBindings();
        if (lastTrigger === key) runInteraction(key);
        reportSettings();
      });
      row.append(label, select, hint);
      fieldset.append(row);
    }
    $('trial-pose-options').closest('fieldset').after(fieldset);
    const section = document.createElement('section');
    section.className = 'trial-scenarios';
    section.setAttribute('aria-label', '手动模拟互动场景');
    const heading = document.createElement('p');
    heading.className = 'trial-scenario-heading';
    heading.textContent = '试一个情境';
    const note = document.createElement('span');
    note.textContent = '手动模拟';
    heading.append(note);
    const actions = document.createElement('div');
    actions.className = 'trial-scenario-actions';
    for (const [key, label] of [['work-left', '工作 · 靠左'], ['work-right', '工作 · 靠右'], ['rest', '休息一下'], ['daily', '恢复日常']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `trial-${key}`;
      button.textContent = label;
      button.addEventListener('click', () => {
        stopDrag(null, true);
        if (key === 'daily') { resumeDaily(); return; }
        if (key.startsWith('work-')) {
          scenario = 'work';
          workSide = key.slice(5);
          runInteraction('work');
        } else {
          scenario = 'rest';
          runInteraction('rest');
        }
      });
      scenarioButtons[key] = button;
      actions.append(button);
    }
    interactionStatus = document.createElement('p');
    interactionStatus.id = 'trial-interaction-status';
    interactionStatus.className = 'trial-interaction-status';
    interactionStatus.setAttribute('role', 'status');
    interactionStatus.setAttribute('aria-live', 'polite');
    interactionStatus.textContent = '日常陪伴：点击或拖动角色，试试她的反应';
    section.append(heading, actions, interactionStatus);
    arena.before(section);
  }
  function renderPoseOptions() {
    const container = $('trial-pose-options');
    container.replaceChildren();
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.poseId = option.id;
      button.textContent = option.name;
      button.setAttribute('aria-pressed', String(option.id === selected));
      button.addEventListener('click', () => {
        scenario = 'daily';
        lastTrigger = 'manual';
        selectPose(option.id);
        setInteractionStatus(`手动查看「${option.name}」：这是一张静态姿态图片`);
        syncScenario();
      });
      container.append(button);
    }
    const missing = (data.poses || []).filter(pose => !pose.image?.dataUrl).length;
    $('trial-pose-count').textContent = `${options.length} 个可用`;
    $('trial-pose-note').textContent = options.length === 1 ? '目前只有基础形象，可以拖动与调整；准备好其他姿态后，这里会自动增加' : `这里可逐张查看已有图片${missing ? `，另有 ${missing} 个姿态等待图片` : ''}；轻点角色会触发下方设定的互动`;
  }
  function refresh() {
    data = getData() || {};
    const previousGreeting = greeting;
    greeting = typeof data.persona?.fields?.greeting === 'string' ? data.persona.fields.greeting.trim() : '';
    options = [];
    if (data.baseImage?.dataUrl) options.push({ id: 'base', name: '基础形象', image: data.baseImage });
    for (const pose of data.poses || []) {
      if (pose.image?.dataUrl) options.push({ id: `pose:${pose.id}`, name: pose.name || '未命名姿态', image: pose.image, pending: Boolean(pose.pending) });
    }
    if (!options.some(option => option.id === selected)) selected = options[0]?.id || 'base';
    $('trial-character-name').textContent = data.persona?.fields?.name || '你的角色';
    $('trial-character-source').textContent = data.baseImage ? sourceLabel(data.baseImage.source) : '先到第一步确认形象';
    $('trial-arena-empty').hidden = options.length > 0;
    $('trial-say-greeting').disabled = !options.length;
    renderPoseOptions();
    renderBindings();
    if (INTERACTIONS.some(({ key }) => key === lastTrigger) && lastTrigger !== 'drag') runInteraction(lastTrigger);
    else selectPose(selected);
    if (!options.length) displayImage(null);
    if (options.length && (!bubbleWasShown || greeting !== previousGreeting)) showGreeting();
    if (!options.length) $('trial-speech').hidden = true;
    syncControls();
    syncScenario();
  }
  function stopDrag(event, cancelled = false) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const ending = drag;
    suppressClick = ending.moved || cancelled;
    drag = null;
    pet.classList.remove('is-dragging');
    if (pet.hasPointerCapture(ending.pointerId)) pet.releasePointerCapture(ending.pointerId);
    if (ending.moved) {
      resumeDaily(ending.fallback ? '已松手，回到基础形象。刚才没有可用的拖拽姿态图，拖动时保留了原来的图片' : '已松手，回到基础形象');
      reportSettings();
    }
  }
  function setActive(value) {
    active = Boolean(value);
    if (!active) stopDrag(null, true);
    syncMotion();
    if (active) { refresh(); scheduleLayout(); }
  }
  function reset() {
    stopDrag(null, true);
    imageRevision += 1;
    selected = 'base';
    requestedSource = renderedSource = '';
    visibleLayer = 0;
    imageLayers.forEach(image => { image.classList.remove('is-visible'); image.removeAttribute('src'); });
    pet.hidden = true;
    bubbleWasShown = false;
    greeting = '';
    scenario = 'daily';
    workSide = 'left';
    lastTrigger = 'daily';
    $('trial-speech').hidden = true;
    setSettings(DEFAULT_SETTINGS);
    setInteractionStatus('日常陪伴：点击或拖动角色，试试她的反应');
    syncScenario();
    notice('');
  }

  createInteractionControls();
  renderBindings();
  for (const key of ['size', 'opacity', 'sway']) {
    $('trial-' + key).addEventListener('input', event => {
      settings = normalizePreviewSettings({ ...settings, [key]: Number(event.target.value) });
      syncControls(); reportSettings();
    });
  }
  $('trial-home').addEventListener('click', () => { settings.position = { ...DEFAULT_SETTINGS.position }; resumeDaily('回到初始位置，显示基础形象'); reportSettings(); });
  $('trial-reset').addEventListener('click', () => { resumeDaily('已恢复默认大小、透明度、晃动和互动映射'); setSettings(DEFAULT_SETTINGS); reportSettings(); });
  $('trial-say-greeting').addEventListener('click', showGreeting);
  pet.addEventListener('dragstart', event => event.preventDefault());
  pet.addEventListener('pointerdown', event => {
    if (!active || !options.length || drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
    suppressClick = false;
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: pet.offsetLeft, startTop: pet.offsetTop, moved: false };
    pet.setPointerCapture(event.pointerId);
  });
  pet.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      scenario = 'daily';
      drag.fallback = !runInteraction('drag');
    }
    pet.classList.add('is-dragging');
    settings.position = {
      x: clamp((drag.startLeft + dx) / Math.max(1, arena.clientWidth - sizePx), 0, 1),
      y: clamp((drag.startTop + dy) / Math.max(1, arena.clientHeight - sizePx), 0, 1),
    };
    layout();
  });
  pet.addEventListener('pointerup', event => stopDrag(event));
  pet.addEventListener('pointercancel', event => stopDrag(event, true));
  pet.addEventListener('lostpointercapture', event => stopDrag(event, true));
  pet.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    runInteraction('click', true);
  });
  pet.addEventListener('keydown', event => {
    // A cancelled pointer gesture must not consume the next keyboard activation.
    if (event.key === 'Enter' || event.key === ' ') suppressClick = false;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!directions[event.key]) return;
    event.preventDefault();
    if (scenario === 'work') {
      settings.position.x = workSide === 'left' ? 0 : 1;
      resumeDaily('方向键移动：显示基础形象');
    }
    const [x, y] = directions[event.key];
    const amount = event.shiftKey ? 30 : 10;
    settings.position = { x: clamp(settings.position.x + x * amount / Math.max(1, arena.clientWidth - sizePx), 0, 1), y: clamp(settings.position.y + y * amount / Math.max(1, arena.clientHeight - sizePx), 0, 1) };
    layout(); reportSettings();
  });
  document.addEventListener('visibilitychange', syncMotion);
  media.addEventListener('change', syncMotion);
  new ResizeObserver(scheduleLayout).observe(arena);
  syncControls();
  return { refresh, setActive, getSettings, setSettings, reset };
}
