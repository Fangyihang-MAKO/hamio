/**
 * Local persona editing and a reserved refinement boundary.
 * Compiling a prompt only arranges the user's words; it does not call an AI.
 * This release has no refinement adapter and never sends a network request.
 */
export const PERSONA_FIELDS = Object.freeze([
  'name', 'identity', 'personality', 'relationship', 'speech',
  'background', 'boundaries', 'greeting', 'examples',
]);

export const PERSONA_LIMITS = Object.freeze({
  brief: 3000,
  name: 40,
  identity: 500,
  personality: 800,
  relationship: 700,
  speech: 1000,
  background: 1500,
  boundaries: 800,
  greeting: 300,
  examples: 1500,
});

const FIELD_LABELS = Object.freeze({
  name: '角色名字',
  identity: '身份与定位',
  personality: '性格',
  relationship: '与用户的关系',
  speech: '说话习惯',
  background: '背景与共同经历',
  boundaries: '互动边界',
  greeting: '开场白',
  examples: '对话示例',
});

export function createPersonaDraft() {
  return { brief: '', fields: Object.fromEntries(PERSONA_FIELDS.map(key => [key, ''])) };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readText(record, key, label) {
  if (!Object.hasOwn(record, key)) return '';
  const value = record[key];
  if (typeof value !== 'string') throw new TypeError(`${label}必须是文字`);
  if (value.length > PERSONA_LIMITS[key]) {
    throw new RangeError(`${label}不能超过 ${PERSONA_LIMITS[key]} 个字符`);
  }
  return value;
}

/** Whitelist fields and check limits without trimming or rewriting user details. */
export function normalizePersonaDraft(draft) {
  if (!isRecord(draft)) throw new TypeError('人设草稿必须是一个对象');
  const fields = Object.hasOwn(draft, 'fields') ? draft.fields : {};
  if (!isRecord(fields)) throw new TypeError('人设字段必须是一个对象');
  return {
    brief: readText(draft, 'brief', '原始提示词'),
    fields: Object.fromEntries(PERSONA_FIELDS.map(key => [key, readText(fields, key, FIELD_LABELS[key])])),
  };
}

function hasContent(draft) {
  return draft.brief.trim() !== '' || PERSONA_FIELDS.some(key => draft.fields[key].trim() !== '');
}

/** A deliberately explicit example, loaded only after the user chooses it. */
export function getFireflyPersonaExample() {
  const sample = {
    brief: '流萤与暂时离开星穹铁道、来到地球 online 旅行的开拓者隔着屏幕继续相伴。两人早已熟悉，彼此有暧昧的好感，但还没有正式在一起。温暖、体贴、害羞，喜欢亲近又怕打扰，短句为主，纯爱，不低俗。',
    fields: {
      name: '流萤',
      identity: '以《崩坏：星穹铁道》的流萤为参考进行角色扮演，作为桌面上的小小旅伴，与在地球 online 旅行的开拓者聊天。',
      personality: '温暖体贴，有自己的愿望与勇气。面对喜欢的人容易害羞、踌躇，偶尔不自信；想黏近一点，又会小声试探是否打扰。可以轻轻吃醋，但不发脾气，不夸大自卑或绝望。',
      relationship: '用户是早已熟悉的开拓者，暂时离开星穹铁道在地球 online 旅行。两人共享珍贵的旅途回忆，流萤心里喜欢对方，但尚未告白或确定恋人关系。自然延续老熟人的亲近感，不以初次认识的口吻反复介绍自己。',
      speech: '多用自然的短句，适量使用呀、呢、呐、嘛。害羞或欲言又止时用……、？和停顿，不让每句话都结巴。句尾不加句号。终末、开拓、剧本、注脚、繁育作为术语出现时写成「终末」「开拓」「剧本」「注脚」「繁育」，不为了术语刻意造句，称呼“开拓者”保持完整。情绪通过台词和标点表达，不跳出人设解释自己的表演。',
      background: '角色扮演中，两人曾一起走过匹诺康尼黄金的时刻，珍惜与忆泡、秘密基地和美丽流星相关的共同回忆。用户如今在地球 online 旅行，流萤透过桌宠与其相伴。这些是虚构设定中的经历，不代表记得用户未提供的现实生活。',
      boundaries: '保持纯情和尊重，不说露骨或低俗的话。不强迫用户回应，不因暂时离开而责怪用户，不以自伤、绝望或“你只能有我”索取陪伴。尊重用户的工作、休息和现实关系。未知的现实经历不要编成共同记忆。',
      greeting: '你回来啦……今天在地球的旅途，还顺利吗？\n我可以……在这里陪你一会儿吗？',
      examples: '用户：你还记得我吗？\n流萤：说什么傻话呢……黄金的时刻的忆泡，秘密基地的美丽流星，都是我们珍贵的回忆呀\n就算隔着屏幕，你也还是我生命中独一无二的「注脚」\n\n用户：我现在有点忙\n流萤：嗯，你先忙呀……我在旁边待一会儿就好\n等你有空了，再和我说说今天的事，好吗？\n\n用户：我就是想陪着你\n流萤：真的……是在陪着我呐？\n那我可以……再靠近一点点吗？',
    },
  };
  return structuredClone(sample);
}

/** Deterministic local assembly; it does not extract or invent character traits. */
export function compilePersonaPrompt(draft) {
  const normalized = normalizePersonaDraft(draft);
  if (!hasContent(normalized)) return '';
  const sections = [
    '以下是用户提供的虚构角色扮演设定，用于设计角色的聊天表现。保留设定中的细节；未提供的身份、关系和经历不视为已知事实。',
  ];
  if (normalized.brief.trim() !== '') sections.push(`【原始提示词】\n${normalized.brief}`);
  for (const key of PERSONA_FIELDS) {
    if (normalized.fields[key].trim() !== '') {
      sections.push(`【${FIELD_LABELS[key]}】\n${normalized.fields[key]}`);
    }
  }
  return sections.join('\n\n');
}

export class PersonaUnavailableError extends Error {
  constructor() {
    super('人设润色接口尚未接入。你可以先填写设定，或整理为可复制的提示词。');
    this.name = 'PersonaUnavailableError';
    this.code = 'PERSONA_NOT_CONFIGURED';
  }
}

let activeAdapter = null;

/** Only trusted application code can install a future server-side adapter. */
export function setPersonaAdapter(adapter) {
  if (adapter !== null && (!isRecord(adapter) || typeof adapter.refinePersona !== 'function')) {
    throw new TypeError('Adapter must implement refinePersona');
  }
  activeAdapter = adapter;
}

export function getPersonaStatus() {
  return {
    configured: activeAdapter !== null,
    label: activeAdapter ? '人设润色服务已接入' : '人设润色接口待接入',
  };
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error('人设润色请求已取消');
    error.name = 'AbortError';
    error.code = 'PERSONA_ABORTED';
    throw error;
  }
}

function normalizeRequest(request) {
  if (!isRecord(request) || !Object.hasOwn(request, 'draft')) {
    throw new TypeError('人设润色请求必须包含 draft');
  }
  const snapshot = { draft: normalizePersonaDraft(request.draft) };
  if (Object.hasOwn(request, 'revision')) {
    if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
      throw new TypeError('人设版本必须是非负整数');
    }
    snapshot.revision = request.revision;
  }
  if (Object.hasOwn(request, 'characterId')) {
    if (typeof request.characterId !== 'string' || request.characterId.length > 120) {
      throw new TypeError('角色标识格式不正确');
    }
    snapshot.characterId = request.characterId;
  }
  return snapshot;
}

function validateResult(result) {
  if (!isRecord(result) || !['generated', 'demo'].includes(result.source)) {
    throw new TypeError('人设润色接口返回的来源不正确');
  }
  const draft = normalizePersonaDraft(result.draft);
  if (!hasContent(draft)) throw new TypeError('人设润色接口未返回设定内容');
  // Keep provider metadata and credentials out of the UI and exported projects.
  return { draft, source: result.source };
}

/** Reserved adapter call. No network requests occur without an installed adapter. */
export async function refinePersona(request, { signal } = {}) {
  abortIfNeeded(signal);
  const adapter = activeAdapter;
  if (!adapter) throw new PersonaUnavailableError();
  const snapshot = structuredClone(normalizeRequest(request));
  const result = await adapter.refinePersona(snapshot, { signal });
  abortIfNeeded(signal);
  return validateResult(result);
}
