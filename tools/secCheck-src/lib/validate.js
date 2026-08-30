/**
 * lib/validate —— 入参校验与日期/标签工具（契约 §1.2 commitSave/commitEdit 共用）
 */
const { BizError } = require('./errors');
const { MAX_TEXT_CHARS, MAX_CUSTOM_TAG_CHARS, UUID_RE, KEY_RE, DATE_RE } = require('./constants');

// db 懒获取：index.js 顶层 cloud.init() 之后（首次调用时）才创建，避免 require 先于 init
function getDb() {
  return require('wx-server-sdk').database();
}

/** 服务端东八区今天 YYYY-MM-DD（date 不得晚于今天，契约 §0.4） */
function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 真实日历合法性（S6 修正）：YYYY-MM-DD 且为合法日期。
 * 例：2026-02-30 → Date.UTC 回滚到 03-02，回验不等 → false（拒绝，1001）。
 */
function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * commitSave/commitEdit 共用入参校验（格式层，1001）。
 * @param {object} event
 * @param {string[]|Set<string>} [oldTags] commitEdit 原文档 tags——传入时豁免保留项（编辑场景）：
 *        仅对「新增/变更」项执行 3/6 上限，原记录保留项（含历史 4~10 个、7~10 字的存量标签）整体放行。
 *        commitSave 不传 → 全部项按 3/6 校验。
 */
function validateSaveInput(event, oldTags) {
  // date：YYYY-MM-DD 且真实日历合法（S6 修正，拒绝如 02-30），不得晚于服务端今天
  const date = event.date;
  if (typeof date !== 'string' || !isValidDateString(date)) throw new BizError(1001);
  if (date > beijingToday()) throw new BizError(1001);

  // place：1~50 字（必填，FR-03 验收 6 服务端兜底）
  const place = event.place;
  if (typeof place !== 'string' || place.trim().length < 1 || place.length > 50) throw new BizError(1001);

  // lat/lng：同有同无 + 合法范围
  const hasLat = event.lat !== undefined && event.lat !== null;
  const hasLng = event.lng !== undefined && event.lng !== null;
  if (hasLat !== hasLng) throw new BizError(1001);
  let lat = null;
  let lng = null;
  if (hasLat) {
    if (typeof event.lat !== 'number' || typeof event.lng !== 'number') throw new BizError(1001);
    if (!Number.isFinite(event.lat) || !Number.isFinite(event.lng)) throw new BizError(1001);
    if (event.lat < -90 || event.lat > 90 || event.lng < -180 || event.lng > 180) throw new BizError(1001);
    lat = event.lat;
    lng = event.lng;
  }

  // note：≤500 字，缺省 ""
  const note = event.note === undefined || event.note === null ? '' : event.note;
  if (typeof note !== 'string' || note.length > MAX_TEXT_CHARS) throw new BizError(1001);

  // tags：≤3 个、单个 ≤6 字（S7-R4；预设标签已移除，命中本人 customTags 校验在 validateTags/validateTagsEdit）
  // S6-R3：重复标签去重（写入去重后数组）
  // S7-R5：commitEdit 编辑场景豁免——传 oldTags 时，保留项（原文档已有，含 4~10 个、7~10 字存量标签）
  //        整体放行，仅「新增/变更」项执行 3/6；未传（commitSave）则全部项执行 3/6
  const rawTags = event.tags === undefined || event.tags === null ? [] : event.tags;
  if (!Array.isArray(rawTags)) throw new BizError(1001);
  const oldSet = oldTags == null ? null : oldTags instanceof Set ? oldTags : new Set(oldTags);
  const evalTags = oldSet ? rawTags.filter((t) => !oldSet.has(t)) : rawTags; // 仅新增/变更项（无豁免 = 全部）
  if (evalTags.length > 3) throw new BizError(1001);
  if (evalTags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > MAX_CUSTOM_TAG_CHARS)) throw new BizError(1001);
  const tags = [...new Set(rawTags)]; // 去重（顺序保持）

  // photos：0~9 项；S6-R2——每项必须恰好为「旧照片项 { key }」或「新增/替换照片项 { photoId }」之一：
  //   commitSave 全为 { photoId }（travel key 由服务端从绑定对象解析，前端不传 key）；
  //   commitEdit 混合：旧项 { key }（KEY_RE 格式），新增项 { photoId }（UUID v4）
  //   S6-R3：photoId 重复（commitSave）或旧 key 重复（commitEdit）→ 1001
  const photos = event.photos === undefined || event.photos === null ? [] : event.photos;
  if (!Array.isArray(photos) || photos.length > 9) throw new BizError(1001);
  const pidSeen = new Set();
  const keySeen = new Set();
  for (const p of photos) {
    if (!p || typeof p !== 'object') throw new BizError(1001);
    const hasKey = typeof p.key === 'string';
    const hasPhotoId = typeof p.photoId === 'string';
    if (hasKey === hasPhotoId) throw new BizError(1001); // 必须恰有其一（key XOR photoId）
    if (hasKey) {
      if (!KEY_RE.test(p.key)) throw new BizError(1001);
      if (keySeen.has(p.key)) throw new BizError(1001); // commitEdit 重复旧 key → 1001
      keySeen.add(p.key);
    } else {
      if (!UUID_RE.test(p.photoId)) throw new BizError(1001);
      if (pidSeen.has(p.photoId)) throw new BizError(1001); // commitSave 重复 photoId → 1001
      pidSeen.add(p.photoId);
    }
  }

  return { date, place, lat, lng, note, tags, photos };
}

/**
 * commitSave 的 tags 命中校验（S7-R4，契约 §1.2）：全部须命中本人 user.customTags——
 * 预设标签已移除，不再有「预设 6 个」豁免；不满足 → 1001。
 */
async function validateTags(tags, openid) {
  const custom = new Set(await getUserCustomTags(openid));
  const invalid = tags.filter((t) => !custom.has(t));
  if (invalid.length) throw new BizError(1001);
}

/**
 * commitEdit 的 tags 命中校验（S7-R4 契约 §1.2「编辑场景存量标签豁免」；S7-R5 调整顺序）：
 * 先用保留项集合把 tags 分成「新增/变更项」（不在原文档 tags）与「保留项」（原文档已有）；
 * 仅「新增/变更项」须命中本人 user.customTags（格式层 3/6 已由 validateSaveInput(oldTags) 对同一子集执行）；
 * 「保留项」整体放行（历史记录可能带预设移除前/旧规下的 4~10 个、7~10 字存量标签，
 * 编辑其他字段不该被卡住）；不满足 → 1001。
 */
async function validateTagsEdit(tags, openid, oldTags) {
  const old = oldTags instanceof Set ? oldTags : new Set(oldTags || []);
  const changed = tags.filter((t) => !old.has(t)); // 仅新增/变更项（保留项整体放行）
  if (!changed.length) return;
  const custom = new Set(await getUserCustomTags(openid));
  const invalid = changed.filter((t) => !custom.has(t));
  if (invalid.length) throw new BizError(1001);
}

/** 读取本人 user.customTags（无 user 文档时按空处理；S6-R4：数据库异常 → 9000，不误判 1001） */
async function getUserCustomTags(openid) {
  let got;
  try {
    got = await getDb().collection('user').where({ openid }).limit(1).get();
  } catch (e) {
    console.error('[secCheck.validate] getUserCustomTags failed:', e);
    throw new BizError(9000); // S6-R4：DB 异常 → 9000（可重试），仅真实「无标签命中」才走 1001
  }
  const u = got && got.data && got.data[0];
  return Array.isArray(u && u.customTags) ? u.customTags : [];
}

module.exports = { beijingToday, isValidDateString, validateSaveInput, validateTags, validateTagsEdit, getUserCustomTags };
