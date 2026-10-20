/** Local, versioned project files. This module does not fetch URLs or execute content. */
import { normalizePersonaDraft, compilePersonaPrompt } from './persona.js';

export const PROJECT_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const SCHEMA = 'hamio-character-studio';
const IMAGE_SOURCES = ['demo', 'reference', 'generated'];

export const DEFAULT_PREVIEW_SETTINGS = Object.freeze({
  size: 70, opacity: 100, sway: 40,
  position: Object.freeze({ x: 0.55, y: 0.65 }),
  bindings: Object.freeze({ click: null, drag: null, work: null, rest: null }),
});

const own = (record, key) => Object.hasOwn(record, key);
const field = (record, key, fallback) => own(record, key) ? record[key] : fallback;
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}必须是一个对象`);
  }
  return value;
}
function text(value, label, max, { required = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${label}必须是文字`);
  if (value.length > max) throw new RangeError(`${label}不能超过 ${max} 个字符`);
  if (required && !value.trim()) throw new TypeError(`${label}不能为空`);
  return value;
}
function identifier(value, label) { return text(value, label, 120, { required: true }); }
function array(value, label, max) {
  if (!Array.isArray(value)) throw new TypeError(`${label}必须是列表`);
  if (value.length > max) throw new RangeError(`${label}最多 ${max} 项`);
  return value;
}
function unique(items, label) {
  const ids = new Set();
  for (const item of items) {
    const id = typeof item === 'string' ? item : item.id;
    if (ids.has(id)) throw new TypeError(`${label}包含重复标识`);
    ids.add(id);
  }
  return ids;
}
function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label}必须在 ${min} 到 ${max} 之间`);
  }
  return value;
}

export function normalizePreviewSettings(value = {}, knownPoseIds) {
  const settings = record(value, '试养设置');
  const position = record(field(settings, 'position', {}), '桌宠位置');
  const bindings = record(field(settings, 'bindings', {}), '互动绑定');
  const normalizedBindings = {};
  for (const key of ['click', 'drag', 'work', 'rest']) {
    const binding = field(bindings, key, null);
    if (binding !== null && binding !== 'base') {
      if (typeof binding !== 'string' || !binding.startsWith('pose:')) {
        throw new TypeError('互动绑定只能是默认、选定形象或已定义姿态');
      }
      const poseId = identifier(binding.slice(5), '互动绑定姿态标识');
      if (knownPoseIds && !knownPoseIds.has(poseId)) throw new TypeError('互动绑定姿态未在姿态定义中找到');
    }
    normalizedBindings[key] = binding;
  }
  return {
    size: number(field(settings, 'size', 70), '角色大小', 30, 100),
    opacity: number(field(settings, 'opacity', 100), '不透明度', 20, 100),
    sway: number(field(settings, 'sway', 40), '晃动幅度', 0, 100),
    position: {
      x: number(field(position, 'x', 0.55), '横向位置', 0, 1),
      y: number(field(position, 'y', 0.65), '纵向位置', 0, 1),
    },
    bindings: normalizedBindings,
  };
}

function imageData(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label}缺少内嵌图片`);
  // Check length first so a large hostile input is rejected before regex/decoding.
  if (value.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 40) {
    throw new RangeError(`${label}不能超过 10 MiB`);
  }
  const match = /^data:image\/(png|jpeg|webp);base64,/u.exec(value);
  if (!match) throw new TypeError(`${label}只能是内嵌的 PNG、JPEG 或 WebP 图片`);
  const encoded = value.slice(match[0].length);
  // A flat expression avoids regex stack exhaustion on legitimate multi-MiB files.
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new TypeError(`${label}的 Base64 编码不完整`);
  }
  const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (size > IMAGE_MAX_BYTES) throw new RangeError(`${label}不能超过 10 MiB`);
  // Reject noncanonical trailing bits while decoding only a tiny header.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((encoded.endsWith('==') && (alphabet.indexOf(encoded.at(-3)) & 15)) ||
      (encoded.endsWith('=') && !encoded.endsWith('==') && (alphabet.indexOf(encoded.at(-2)) & 3))) {
    throw new TypeError(`${label}的 Base64 编码不完整`);
  }
  const header = atob(encoded.slice(0, 16));
  const valid = match[1] === 'png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : match[1] === 'jpeg' ? header.startsWith('\xff\xd8\xff')
      : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!valid) throw new TypeError(`${label}的图片格式与内容不一致`);
  return value;
}

function image(value, label, { reference = false } = {}) {
  const item = record(value, label);
  const source = field(item, 'source', reference ? 'reference' : undefined);
  if (!IMAGE_SOURCES.includes(source)) throw new TypeError(`${label}的图片来源不正确`);
  const result = {
    id: identifier(field(item, 'id'), `${label}标识`),
    name: text(field(item, 'name', ''), `${label}名称`, 240),
    dataUrl: imageData(field(item, 'dataUrl'), label), source,
  };
  if (own(item, 'poseId')) result.poseId = identifier(item.poseId, `${label}姿态标识`);
  return result;
}

function poseIdentity(value) {
  const item = record(value, '姿态定义');
  return {
    id: identifier(field(item, 'id'), '姿态标识'),
    name: text(field(item, 'name'), '姿态名称', 18, { required: true }),
    description: text(field(item, 'description', ''), '姿态描述', 180),
  };
}

function definition(value) {
  const item = record(value, '姿态定义');
  const pose = poseIdentity(item);
  const reference = field(item, 'referenceImage', null);
  const referenceImage = reference === null ? null : image(reference, '姿态参考图', { reference: true });
  if (referenceImage?.poseId && referenceImage.poseId !== pose.id) {
    throw new TypeError('姿态参考图与姿态标识不一致');
  }
  return { ...pose, referenceImage, editNote: text(field(item, 'editNote', ''), '姿态修改备注', 600) };
}

function savedDate(value, label) {
  const date = text(value, label, 40);
  if (!Number.isFinite(Date.parse(date))) throw new TypeError(`${label}格式不正确`);
  return new Date(date).toISOString();
}

function withinSize(value, label) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROJECT_MAX_BYTES) {
    throw new RangeError(`${label}不能超过 100 MiB，请减少图片数量或压缩图片后重试`);
  }
  return value;
}

function normalizedPersona(value) {
  const item = record(value, '人设');
  const source = field(item, 'source', 'manual');
  if (!['manual', 'demo', 'generated'].includes(source)) throw new TypeError('人设来源不正确');
  const draft = normalizePersonaDraft(item);
  return { ...draft, source, systemPrompt: compilePersonaPrompt(draft) };
}

/** Whitelist imported values; older versions migrate without inventing art or a persona. */
function normalizeProjectFields(value, { incomplete = false } = {}) {
  const raw = record(value, '项目文件');
  if (field(raw, 'schema') !== SCHEMA) throw new TypeError('这不是 Ha!mio 角色设计文件');
  if (![1, 2, 3, 4].includes(field(raw, 'schemaVersion'))) {
    throw new TypeError('此项目版本暂不支持，请使用支持该版本的创作间');
  }
  const rawBase = field(raw, 'baseImage', incomplete ? null : undefined);
  const baseImage = incomplete && rawBase === null ? null : image(rawBase, '选定形象');
  const references = array(field(raw, 'references', []), '参考图', 4)
    .map(value => image(value, '参考图', { reference: true }));
  unique(references, '参考图');
  const candidates = array(field(raw, 'candidates', baseImage ? [baseImage] : []), '候选形象', 6)
    .map(value => image(value, '候选形象'));
  unique(candidates, '候选形象');
  const chosen = baseImage && candidates.find(candidate => candidate.id === baseImage.id);
  if (baseImage && (!chosen || chosen.dataUrl !== baseImage.dataUrl || chosen.source !== baseImage.source)) {
    throw new TypeError('选定形象与候选形象不一致');
  }
  const poseDefinitions = array(field(raw, 'poseDefinitions', []), '姿态定义', 12).map(definition);
  const knownPoses = unique(poseDefinitions, '姿态定义');
  const selectedPoseIds = array(field(raw, 'selectedPoseIds', []), '选中姿态', 12)
    .map(value => identifier(value, '选中姿态标识'));
  unique(selectedPoseIds, '选中姿态');
  if (selectedPoseIds.some(id => !knownPoses.has(id))) throw new TypeError('选中姿态未在姿态定义中找到');
  const poses = array(field(raw, 'poses', []), '姿态结果', 12).map(value => {
    const item = record(value, '姿态结果');
    const pose = poseIdentity(item);
    if (!knownPoses.has(pose.id)) throw new TypeError('姿态结果未在姿态定义中找到');
    const picture = field(item, 'image', null);
    const normalizedImage = picture === null ? null : image(picture, '姿态图片');
    if (normalizedImage?.poseId && normalizedImage.poseId !== pose.id) {
      throw new TypeError('姿态图片与姿态标识不一致');
    }
    const history = array(field(item, 'history', []), '姿态历史版本', 4)
      .map(value => image(value, '姿态历史图片'));
    const historyIds = unique(history, '姿态历史版本');
    if (normalizedImage && historyIds.has(normalizedImage.id)) throw new TypeError('姿态历史版本不能包含当前图片');
    if (history.some(picture => picture.poseId && picture.poseId !== pose.id)) {
      throw new TypeError('姿态历史图片与姿态标识不一致');
    }
    const pending = field(item, 'pending', false);
    if (typeof pending !== 'boolean') throw new TypeError('姿态等待状态必须为布尔值');
    return { ...pose, image: normalizedImage, history, pending };
  });
  unique(poses, '姿态结果');
  unique(poses.filter(pose => pose.image).map(pose => pose.image), '姿态图片');
  const style = field(raw, 'style', 'soft');
  if (!['soft', 'sticker', 'reference'].includes(style)) throw new TypeError('画风设置不正确');
  const requestedCount = field(raw, 'requestedCount', 4);
  if (![2, 4, 6].includes(requestedCount)) throw new TypeError('候选数量只能为 2、4 或 6');
  let createdAt;
  if (own(raw, 'createdAt')) {
    createdAt = savedDate(raw.createdAt, '保存时间');
  }
  const result = {
    schema: SCHEMA, schemaVersion: 4, edition: 'interface-preview',
    notice: '角色设计草稿，不是桌宠安装包；source=demo 为已有示例，source=reference 为未转换原图',
    ...(createdAt ? { createdAt } : {}),
    description: text(field(raw, 'description', ''), '形象描述', 600),
    style, requestedCount, references, candidates, baseImage,
    poseDefinitions, selectedPoseIds, poses,
    persona: normalizedPersona(field(raw, 'persona', {})),
    previewSettings: normalizePreviewSettings(field(raw, 'previewSettings', {}), knownPoses),
  };
  return withinSize(result, '项目文件');
}

/** Export/import projects still require a confirmed image belonging to the candidates. */
export function normalizeProject(value) {
  return normalizeProjectFields(value);
}

/** Local-only progress may have no confirmed image, candidates, or pictures at all. */
export function normalizeDraft(value) {
  const raw = record(value, '本地草稿');
  if (field(raw, 'schema') !== 'hamio-studio-draft' || field(raw, 'schemaVersion') !== 1) {
    throw new TypeError('本地草稿格式或版本不受支持');
  }
  const project = normalizeProjectFields(field(raw, 'project'), { incomplete: true });
  const selectedId = field(raw, 'selectedId', null);
  if (selectedId !== null) {
    identifier(selectedId, '草稿选中形象标识');
    if (!project.candidates.some(candidate => candidate.id === selectedId)) {
      throw new TypeError('草稿选中形象未在候选形象中找到');
    }
  }
  const step = number(field(raw, 'step', 1), '草稿步骤', 1, 4);
  if (!Number.isInteger(step)) throw new TypeError('草稿步骤必须是 1 到 4 的整数');
  return withinSize({
    schema: 'hamio-studio-draft', schemaVersion: 1,
    savedAt: savedDate(field(raw, 'savedAt'), '草稿保存时间'),
    project, selectedId, step,
    customPoseName: text(field(raw, 'customPoseName', ''), '自定义姿态名称', 18),
    customPoseDescription: text(field(raw, 'customPoseDescription', ''), '自定义姿态描述', 180),
  }, '本地草稿');
}

export function parseProject(value) {
  if (typeof value !== 'string') throw new TypeError('项目文件必须是 JSON 文本');
  if (value.length > PROJECT_MAX_BYTES || new TextEncoder().encode(value).byteLength > PROJECT_MAX_BYTES) {
    throw new RangeError('项目文件不能超过 100 MiB');
  }
  let raw;
  try { raw = JSON.parse(value); }
  catch { throw new TypeError('项目文件不是有效的 JSON，请选择导出的角色设计文件'); }
  return normalizeProject(raw);
}
