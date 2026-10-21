'use strict';
const petButton = document.getElementById('pet-button');
const petPose = petButton.querySelector('.pet-pose');
const petImage = document.getElementById('pet-image');
const transitionImage = document.getElementById('pet-transition');
const petSpeech = document.getElementById('pet-speech');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motionToggle = document.getElementById('motion-toggle');
let motionOverride = null;
const motionEnabled = () => motionOverride ?? !reducedMotion.matches;
const expressions = {
  idle: {src:'assets/idle.png',alt:'银发、薄荷色发尾的流萤，安静地看着你'},
  shy: {src:'assets/shy.png',alt:'被摸头后，流萤害羞地红了脸'}
};
const decoded = new Map();
function prepareImage(name) {
  if (!decoded.has(name)) {
    const picture = new Image();
    picture.src = expressions[name].src;
    decoded.set(name, picture.decode().catch(error => { decoded.delete(name); throw error; }));
  }
  return decoded.get(name);
}
prepareImage('shy').catch(() => {});
let desiredExpression = 'idle';
let swapVersion = 0;
let fade;
let nod;
async function showExpression(name) {
  if (desiredExpression === name) return;
  desiredExpression = name;
  const version = ++swapVersion;
  try {
    await prepareImage(name);
    if (version !== swapVersion) return;
    fade?.cancel();
    nod?.cancel();
    const expression = expressions[name];
    if (motionEnabled() && !document.hidden) {
      // Whole sprites share one pivot; facial proportions never change.
      transitionImage.src = expression.src;
      fade = transitionImage.animate([{opacity:0},{opacity:1}], {duration:110,easing:'ease-in-out',fill:'forwards'});
      nod = petPose.animate([
        {transform:'translateY(0) rotate(0)'},
        {transform:'translateY(2px) rotate(.6deg)',offset:.48},
        {transform:'translateY(0) rotate(0)'}
      ], {duration:320,easing:'ease-in-out'});
      await fade.finished;
    }
    if (version !== swapVersion) return;
    petImage.src = expression.src;
    petImage.alt = expression.alt;
    fade?.cancel();
    transitionImage.style.opacity = '0';
  } catch (_) {
    if (version === swapVersion) desiredExpression = petImage.src.endsWith('shy.png') ? 'shy' : 'idle';
  }
}
// Match the app's three independent rhythms, sized for the larger website sprite.
let frame = 0;
let lastFrame = 0;
let elapsed = 0;
let inView = true;
function movePet(now) {
  elapsed += lastFrame ? Math.min((now - lastFrame) / 1000, .05) : 0;
  lastFrame = now;
  const x = Math.sin(elapsed * 1.2) * 2.8;
  const y = Math.sin(elapsed * 1.8) * 4;
  const angle = Math.sin(elapsed * 1.4) * 1.3;
  petButton.style.transform = `translate3d(${x.toFixed(3)}px,${y.toFixed(3)}px,0) rotate(${angle.toFixed(3)}deg)`;
  frame = requestAnimationFrame(movePet);
}
function syncMotion() {
  cancelAnimationFrame(frame);
  lastFrame = 0;
  motionToggle.textContent = motionEnabled() ? '暂停晃动' : '开启晃动';
  motionToggle.setAttribute('aria-pressed', String(motionEnabled()));
  motionToggle.hidden = false;
  petButton.classList.toggle('motion-active', motionEnabled());
  if (!motionEnabled()) {
    petButton.style.transform = 'none';
    nod?.cancel();
    if (fade?.playState === 'running') fade.finish();
  } else if (!document.hidden && inView) frame = requestAnimationFrame(movePet);
}
document.addEventListener('visibilitychange', syncMotion);
reducedMotion.addEventListener('change', syncMotion);
motionToggle.addEventListener('click', () => { motionOverride = !motionEnabled(); syncMotion(); });
new IntersectionObserver(entries => { inView = entries[0].isIntersecting; syncMotion(); }).observe(petButton);
syncMotion();
let petTimer;
let responseIndex = 0;
const greetings = ['欸……突然靠这么近，会害羞的呀', '真的……今天也会陪着我呐？', '那就……再待一小会儿，好吗？'];
petButton.addEventListener('click', () => {
  clearTimeout(petTimer);
  showExpression('shy');
  petSpeech.textContent = greetings[responseIndex++ % greetings.length];
  petTimer = setTimeout(() => {
    showExpression('idle');
    petSpeech.textContent = '我就在这里……偷偷陪着你呀';
  }, 5000);
});
document.querySelectorAll('a[download][href^="downloads/"]').forEach(link => link.addEventListener('click', () => {
  const statusId = link.dataset.downloadStatus || 'download-status';
  const status = document.getElementById(statusId);
  if (status) status.textContent = '已发起下载，请查看浏览器下载记录。微信内无法下载时，请在浏览器中打开';
  const starPrompt = document.querySelector(`[data-star-prompt="${statusId}"]`);
  if (starPrompt) starPrompt.hidden = false;
}));

const supportDialog = document.getElementById('support-dialog');
const supportClose = supportDialog.querySelector('.support-close');
let supportOpener = null;
document.querySelectorAll('[data-open-support]').forEach(button => button.addEventListener('click', () => {
  if (supportDialog.open) return;
  supportOpener = button;
  supportDialog.showModal();
  document.body.classList.add('support-open');
  supportClose.focus({preventScroll:true});
}));
supportClose.addEventListener('click', () => supportDialog.close());
supportDialog.addEventListener('click', event => {
  if (event.target !== supportDialog) return;
  const bounds = supportDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) supportDialog.close();
});
// Native dialog handles Escape and keeps keyboard focus inside the modal.
supportDialog.addEventListener('close', () => {
  document.body.classList.remove('support-open');
  if (supportOpener?.isConnected) supportOpener.focus({preventScroll:true});
  supportOpener = null;
});
