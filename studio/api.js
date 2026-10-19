/**
 * Ha!mio image-generation boundary. This release deliberately has no adapter.
 * Images stay in this browser. No request, key, or fake generation is hidden here.
 * A later server adapter can implement jobs/polling without changing the UI.
 */
export class GenerationUnavailableError extends Error {
  constructor() {
    super('图片生成接口尚未接入。可以先用示例体验选择形象与姿态的流程。');
    this.name = 'GenerationUnavailableError';
    this.code = 'GENERATION_NOT_CONFIGURED';
  }
}

let activeAdapter = null;

/** Install a trusted server adapter in application code, never through URL params. */
export function setGenerationAdapter(adapter) {
  if (adapter !== null && (
    typeof adapter !== 'object' ||
    typeof adapter.generateChibi !== 'function' ||
    typeof adapter.generatePoses !== 'function'
  )) throw new TypeError('Adapter must implement generateChibi and generatePoses');
  activeAdapter = adapter;
}

export function getGenerationStatus() {
  return {
    configured: activeAdapter !== null,
    label: activeAdapter ? '图片生成服务已接入' : '图片生成接口待接入',
  };
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error('生成请求已取消');
    error.name = 'AbortError';
    error.code = 'GENERATION_ABORTED';
    throw error;
  }
}

function validImageSource(value) {
  if (typeof value !== 'string') return false;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value);
}

function validateResult(result) {
  if (!result || !Array.isArray(result.images) || result.images.length === 0) {
    throw new TypeError('生成接口未返回图片');
  }
  const ids = new Set();
  for (const image of result.images) {
    if (!image || typeof image.id !== 'string' || !image.id || ids.has(image.id) ||
        !validImageSource(image.dataUrl) || !['generated', 'demo'].includes(image.source)) {
      throw new TypeError('生成接口返回的图片格式不正确');
    }
    ids.add(image.id);
  }
  // Keep provider metadata and temporary credentials out of saved user projects.
  return { images: result.images.map(image => ({
    id: image.id,
    dataUrl: image.dataUrl,
    source: image.source,
    ...(typeof image.poseId === 'string' ? { poseId: image.poseId } : {}),
  })) };
}

async function generate(method, request, { signal } = {}) {
  abortIfNeeded(signal);
  const adapter = activeAdapter;
  if (!adapter) throw new GenerationUnavailableError();
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('生成请求必须是一个对象');
  }
  // Capture the selected character and poses before a caller edits its state.
  const snapshot = structuredClone(request);
  const result = await adapter[method](snapshot, { signal });
  abortIfNeeded(signal);
  return validateResult(result);
}

export function generateChibi(request, options = {}) {
  return generate('generateChibi', request, options);
}

export function generatePoses(request, options = {}) {
  return generate('generatePoses', request, options);
}
