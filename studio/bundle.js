/**
 * Local creation bundle export. ZIP uses store mode, CRC32 and UTF-8 names.
 * No requests, credentials, executable code or generated art are added.
 */
import { normalizeProject } from './project.js';

export const BUNDLE_MAX_BYTES = 180 * 1024 * 1024;
const encoder = new TextEncoder();
const SOURCE_LABELS = Object.freeze({
  demo: '已有示例素材',
  reference: '参考原图，尚未转换',
  generated: '成品图片（生成或自行导入）',
});
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// A user label is always one filename segment, never an archive path.
function safeStem(value) {
  const clean = value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/gu, '-')
    .replace(/\.\.+/gu, '-').replace(/^[. ]+|[. ]+$/gu, '').trim();
  const short = Array.from(clean).slice(0, 56).join('').replace(/[. ]+$/gu, '');
  return short || '角色';
}

function imageBytes(image) {
  // normalizeProject has already validated MIME, canonical Base64 and 10 MiB size.
  const comma = image.dataUrl.indexOf(',');
  const mimeType = image.dataUrl.slice(5, image.dataUrl.indexOf(';'));
  const encoded = image.dataUrl.slice(comma + 1);
  const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  const bytes = new Uint8Array(size);
  // Decode aligned chunks rather than allocating another full binary string.
  let offset = 0;
  for (let start = 0; start < encoded.length; start += 32768) {
    const part = atob(encoded.slice(start, start + 32768));
    for (let index = 0; index < part.length; index++) bytes[offset++] = part.charCodeAt(index);
  }
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6);
  return { bytes, mimeType, extension };
}

function zipDate(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: (year - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate(),
    time: date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2),
  };
}

function archive(entries, date) {
  const stamp = zipDate(date);
  const parts = [];
  const central = [];
  let offset = 0;
  let centralLength = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // General purpose flag 11: UTF-8.
    header.setUint16(10, stamp.time, true);
    header.setUint16(12, stamp.date, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, entry.bytes.length, true);
    header.setUint32(22, entry.bytes.length, true);
    header.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, entry.bytes);

    const directory = new Uint8Array(46 + name.length);
    const record = new DataView(directory.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, checksum, true);
    record.setUint32(20, entry.bytes.length, true);
    record.setUint32(24, entry.bytes.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);
    centralLength += directory.length;
    offset += local.length + entry.bytes.length;
  }
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, entries.length, true);
  footer.setUint16(10, entries.length, true);
  footer.setUint32(12, centralLength, true);
  footer.setUint32(16, offset, true);
  const total = offset + centralLength + end.length;
  if (total > BUNDLE_MAX_BYTES) throw new RangeError('创作包不能超过 180 MiB，请减少图片或历史版本后重试');
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/**
 * @param {object} input A project accepted by normalizeProject, with a confirmed base.
 * @returns {Promise<{blob: Blob, filename: string, fileCount: number}>}
 * Includes current images as files; all candidates, references and history remain
 * in project.json for lossless restoration. Missing poses never borrow a reference.
 */
export async function buildCreationBundle(input) {
  const project = normalizeProject(input);
  const entries = [];
  const assets = [];
  const now = new Date();
  let estimatedBytes = 22;
  function add(path, bytes) {
    estimatedBytes += bytes.length + 76 + encoder.encode(path).length * 2;
    if (estimatedBytes > BUNDLE_MAX_BYTES) {
      throw new RangeError('创作包不能超过 180 MiB，请减少图片或历史版本后重试');
    }
    entries.push({ path, bytes });
  }
  function addText(path, value) { add(path, encoder.encode(value)); }
  function addImage(image, pathPrefix, role, poseId = null) {
    const { bytes, mimeType, extension } = imageBytes(image);
    const path = `${pathPrefix}.${extension}`;
    add(path, bytes);
    assets.push({
      path, role, imageId: image.id, name: image.name, poseId,
      source: image.source,
      sourceLabel: image.source === 'reference' && role === 'pose'
        ? '手动导入姿态图片' : SOURCE_LABELS[image.source],
      mimeType, byteLength: bytes.length,
    });
    return path;
  }

  // Compact JSON stays within the same 100 MiB boundary as import.
  addText('project.json', JSON.stringify(project));
  addText('persona.txt', project.persona.systemPrompt);
  const basePath = addImage(project.baseImage, `images/base-${safeStem(project.baseImage.name)}`, 'base');
  const selected = new Set(project.selectedPoseIds);
  const bound = new Set(Object.values(project.previewSettings.bindings)
    .filter(value => value?.startsWith('pose:')).map(value => value.slice(5)));
  const results = new Map(project.poses.map(pose => [pose.id, pose]));
  const poses = [];
  for (const [index, definition] of project.poseDefinitions.entries()) {
    const result = results.get(definition.id);
    let path = null;
    if (result?.image) {
      // Fixed numerical prefix guarantees uniqueness even after name sanitizing.
      path = addImage(result.image,
        `images/poses/${String(index + 1).padStart(2, '0')}-${safeStem(definition.name)}`, 'pose', definition.id);
    }
    poses.push({
      id: definition.id, name: definition.name, selected: selected.has(definition.id),
      boundToInteraction: bound.has(definition.id), path,
      status: path ? 'image-present' : 'missing',
      pending: result?.pending || false,
      source: result?.image?.source || null,
    });
    // Let a browser show its progress/busy state when exporting several images.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const missingPoses = poses.filter(pose => !pose.path && (pose.selected || pose.boundToInteraction))
    .map(({ id, name, selected: isSelected, boundToInteraction }) => ({ id, name, selected: isSelected, boundToInteraction }));
  const manifest = {
    schema: 'hamio-creation-bundle', schemaVersion: 1,
    exportedAt: now.toISOString(),
    notice: '角色创作素材包，不是 APK 或 EXE；当前姿态文件不代表已生成动画或可安装桌宠',
    projectFile: 'project.json', personaFile: 'persona.txt',
    personaHasContent: project.persona.systemPrompt.length > 0,
    characterName: project.persona.fields.name || project.baseImage.name || '我的角色',
    baseImage: basePath, images: assets, poses, missingPoses,
    previewSettings: project.previewSettings,
    referencesAndHistory: '仅保存在 project.json 中；未把姿态参考图或历史图片当作当前成品导出',
  };
  addText('manifest.json', JSON.stringify(manifest, null, 2));
  const missing = missingPoses.length ? missingPoses.map(pose => pose.name).join('、') : '无';
  addText('README.txt', [
    'Ha!mio 角色创作包',
    '',
    '这是你的角色设计和素材备份，不是 APK / EXE 安装包，也不会直接运行桌宠。',
    '',
    '怎么继续设计',
    '1. 解压此 ZIP 文件。',
    '2. 打开 Ha!mio 创作间，使用“导入设计”选择 project.json。',
    '3. 继续修改形象、姿态、人设和试养设置。',
    '请保留 project.json；它包含候选图、参考图、修改备注和历史版本。',
    '',
    '包内文件',
    'project.json：可恢复的完整角色设计。',
    'persona.txt：按你填写的设定整理的聊天提示词；未填写人设时为空。',
    'images/：当前选定形象和已有的当前姿态图片，保留原图片字节。',
    'manifest.json：图片来源、姿态对应关系、缺失项和试养设置。',
    '',
    `已选择或绑定到互动、但还缺图片的姿态：${missing}`,
    '缺失姿态不会用参考图补位；未选择的姿态也可在 manifest.json 中查看。',
    '图片标记 demo 表示已有示例；形象标记 reference 表示尚未转换的参考原图，',
    '姿态标记 reference 表示你手动导入的姿态图片；generated 表示成品图片记录。',
    '标记 pending 的姿态仍保留修改前的当前图片，新的修改尚未完成。',
    '姿态参考图和历史版本只保存在 project.json，不会替代当前姿态图片。',
    '“有图片”不代表动作、透明背景、画风或内容已经验收，请继续在创作间检查。',
    '',
    '此包在你的浏览器本地整理，没有调用绘图或聊天接口。',
    '项目中包含你填写的文字和导入的图片；分享前请确认它们适合公开。',
    '',
  ].join('\n'));
  return {
    blob: archive(entries, now),
    filename: `Ha-mio-${safeStem(project.persona.fields.name || project.baseImage.name)}-创作包.zip`,
    fileCount: entries.length,
  };
}
