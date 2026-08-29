/**
 * lib/validate —— 入参校验与日期/标签工具（契约 §1.2 commitSave/commitEdit 共用）
 */
const { BizError } = require('./errors');
const { PRESET_TAGS, MAX_TEXT_CHARS, UUID_RE, KEY_RE, DATE_RE } = require('./constants');

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

/** commitSave/commitEdit 共用入参校验（格式层，1001） */
function validateSaveInput(event) {
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

  // tags：≤10 个、单个 ≤10 字（预设/本人 customTags 校验在 validateTags）
  // S6-R3：重复标签去重（写入去重后数组）
  const rawTags = event.tags === undefined || event.tags === null ? [] : event.tags;
  if (!Array.isArray(rawTags) || rawTags.length > 10) throw new BizError(1001);
  if (rawTags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 10)) throw new BizError(1001);
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

/** tags 合法性：预设 6 个或命中本人 user.customTags（契约 §1.2 commitSave/commitEdit） */
async function validateTags(tags, openid) {
  const custom = new Set(await getUserCustomTags(openid));
  const invalid = tags.filter((t) => !PRESET_TAGS.includes(t) && !custom.has(t));
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

module.exports = { beijingToday, isValidDateString, validateSaveInput, validateTags, getUserCustomTags };
