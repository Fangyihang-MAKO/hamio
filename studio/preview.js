/** Browser-only pet rehearsal. Uses only the selected character's existing images. */
const DEFAULT_SETTINGS = Object.freeze({ size: 70, opacity: 100, sway: 40, position: Object.freeze({ x: .55, y: .65 }) });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numeric = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
export function normalizePreviewSettings(value = {}) {
  return {
    size: Math.round(numeric(value?.size, 70, 30, 100)),
    opacity: Math.round(numeric(value?.opacity, 100, 20, 100)),
    sway: Math.round(numeric(value?.sway, 40, 0, 100)),
    position: { x: numeric(value?.position?.x, .55, 0, 1), y: numeric(value?.position?.y, .65, 0, 1) },
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

  function sourceLabel(source) {
    return source === 'demo' ? '已有素材示例' : source === 'reference' ? '参考原图 · 未转 Q 版' : '当前角色图片';
  }
  function currentOption() { return options.find(option => option.id === selected) || options[0]; }
  function reportSettings() { onSettingsChange(getSettings()); }
  function getSettings() { return { ...settings, position: { ...settings.position } }; }
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
    const left = (arena.clientWidth - sizePx) * settings.position.x;
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
    syncControls();
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
    pet.setAttribute('aria-label', `${data.persona?.fields?.name || '角色'}，${option.name}。拖动移动，轻点或回车切换已有姿态`);
    displayImage(option);
    if (sayGreeting) showGreeting();
  }
  function cyclePose() {
    if (!options.length) return;
    const index = options.findIndex(option => option.id === selected);
    selectPose(options[(index + 1) % options.length].id, true);
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
      button.addEventListener('click', () => selectPose(option.id));
      container.append(button);
    }
    const missing = (data.poses || []).filter(pose => !pose.image?.dataUrl).length;
    $('trial-pose-count').textContent = `${options.length} 个可用`;
    $('trial-pose-note').textContent = options.length === 1 ? '目前只有基础形象，可以拖动与调整；准备好其他姿态后，这里会自动增加' : `只切换当前角色已有的图片${missing ? `，另有 ${missing} 个姿态等待图片` : '，轻点角色也能切换'}`;
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
    if (!options.some(option => option.id === selected)) selected = 'base';
    $('trial-character-name').textContent = data.persona?.fields?.name || '你的角色';
    $('trial-character-source').textContent = data.baseImage ? sourceLabel(data.baseImage.source) : '先到第一步确认形象';
    $('trial-arena-empty').hidden = options.length > 0;
    $('trial-say-greeting').disabled = !options.length;
    renderPoseOptions();
    selectPose(selected);
    if (!options.length) displayImage(null);
    if (options.length && (!bubbleWasShown || greeting !== previousGreeting)) showGreeting();
    if (!options.length) $('trial-speech').hidden = true;
    syncControls();
  }
  function stopDrag(event, cancelled = false) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const ending = drag;
    suppressClick = ending.moved || cancelled;
    drag = null;
    pet.classList.remove('is-dragging');
    if (pet.hasPointerCapture(ending.pointerId)) pet.releasePointerCapture(ending.pointerId);
    if (ending.moved) reportSettings();
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
    $('trial-speech').hidden = true;
    setSettings(DEFAULT_SETTINGS);
    notice('');
  }

  for (const key of ['size', 'opacity', 'sway']) {
    $('trial-' + key).addEventListener('input', event => {
      settings = normalizePreviewSettings({ ...settings, [key]: Number(event.target.value) });
      syncControls(); reportSettings();
    });
  }
  $('trial-home').addEventListener('click', () => { settings.position = { ...DEFAULT_SETTINGS.position }; scheduleLayout(); reportSettings(); });
  $('trial-reset').addEventListener('click', () => { setSettings(DEFAULT_SETTINGS); reportSettings(); });
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
    drag.moved = true;
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
    cyclePose();
  });
  pet.addEventListener('keydown', event => {
    // A cancelled pointer gesture must not consume the next keyboard activation.
    if (event.key === 'Enter' || event.key === ' ') suppressClick = false;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!directions[event.key]) return;
    event.preventDefault();
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
