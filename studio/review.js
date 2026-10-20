/**
 * Advisory creation overview. Reads the current project without mutating it.
 * "ready" means these inputs are present; it does not certify image decoding,
 * image quality, AI availability, or a runnable desktop-pet installer.
 */
const filled = value => typeof value === 'string' && value.trim().length > 0;
const hasImage = image => filled(image?.dataUrl);
const list = value => Array.isArray(value) ? value : [];

export function assessCreationProject(project = {}) {
  const data = project && typeof project === 'object' ? project : {};
  const fields = data.persona?.fields || {};
  const baseReady = hasImage(data.baseImage);
  const checks = [{
    id: 'base',
    label: '确认角色形象',
    detail: baseReady ? '已确认一张基础形象' : '先选定并确认一张角色形象',
    status: baseReady ? 'ready' : 'missing',
    step: 1,
    target: list(data.candidates).length ? 'confirm-character' : 'reference-input',
  }];

  // Selection is the user's current drawing plan. Unselected completed poses
  // remain in the project and preview, but do not complete selected missing ones.
  const selectedIds = [...new Set(list(data.selectedPoseIds).filter(filled))];
  const poses = new Map(list(data.poses).map(pose => [pose?.id, pose]));
  const definitions = new Map(list(data.poseDefinitions).map(pose => [pose?.id, pose]));
  const selected = selectedIds.map(id => ({ id, pose: poses.get(id) }));
  const missing = selected.filter(({ pose }) => !hasImage(pose?.image));
  const pending = selected.filter(({ pose }) => hasImage(pose?.image) && pose.pending === true);
  const firstUnfinished = missing[0] || pending[0];
  const poseName = item => definitions.get(item.id)?.name || item.pose?.name || item.id;
  const presentCount = selected.length - missing.length;
  let poseDetail = '未选择要补充的姿态，可只保留基础形象';
  if (selected.length) {
    poseDetail = `所选 ${presentCount}/${selected.length} 个姿态已有当前图片`;
    if (missing.length) poseDetail += `；${missing.length} 个缺图，先补「${poseName(missing[0])}」`;
    if (pending.length) poseDetail += `；${pending.length} 个沿用上一版，待更新`;
  }
  checks.push({
    id: 'poses',
    label: '准备所选姿态',
    detail: poseDetail,
    status: !selected.length ? 'optional' : missing.length ? 'missing' : pending.length ? 'pending' : 'ready',
    step: 2,
    target: 'pose-options',
    ...(firstUnfinished ? { poseId: firstUnfinished.id } : {}),
  });

  const nameReady = filled(fields.name);
  const characterReady = filled(data.persona?.brief) || filled(fields.personality);
  checks.push({
    id: 'persona',
    label: '写下基本人设',
    detail: !nameReady ? '给角色起一个名字' : !characterReady ? '补一句角色描述或性格设定' : '已填写名字和角色描述或性格',
    status: nameReady && characterReady ? 'ready' : 'missing',
    step: 3,
    target: !nameReady ? 'persona-name' : 'persona-brief',
  });

  const speechReady = filled(fields.speech);
  const greetingReady = filled(fields.greeting);
  checks.push({
    id: 'speech',
    label: '确定说话感觉',
    detail: !speechReady ? '写下她的说话方式' : !greetingReady ? '补上见面时的第一句招呼' : '已填写说话方式和第一句招呼',
    status: speechReady && greetingReady ? 'ready' : 'missing',
    step: 3,
    target: !speechReady ? 'persona-speech' : 'persona-greeting',
  });

  return {
    checks,
    next: !baseReady ? checks[0] : checks.find(check => check.status === 'missing') || checks.find(check => check.status === 'pending') || null,
    readyCount: checks.filter(check => check.status === 'ready').length,
  };
}
