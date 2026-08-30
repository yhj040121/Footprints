/**
 * actions/text —— action = "text"（契约 §1.2，FR-03/06/13 文本预检）
 *
 * S6-R3：customTags 服务端写入——`field="customTag"` 且审核通过的项，由服务端原子追加到
 * 本人 `user.customTags`（去重、新建单个 1~6 字（S7-R4）、总数 ≤10 个，超上限 1001），出参 `customTags`
 * 返回追加后的完整标签数组；客户端对 customTags 无写权限（契约 §2.4 字段级规则）。
 * S7-R5：新建 customTag 长度与事务写入前各校验一次（创建校验 + appendCustomTags 内再查），
 * 超 6 字 → 1001，杜绝「可创建 7~10 字标签但 commit 拒绝」的脏数据。
 * 入参去重（S6-R3）：texts 内 field+content 组合重复 → 1001。
 */
const { BizError, ok, fail } = require('../lib/errors');
const { FIELD_WHITELIST, MAX_TEXT_CHARS, MAX_TEXT_BYTES, MAX_CUSTOM_TAG_CHARS } = require('../lib/constants');
const { checkText } = require('../lib/security');

// db 懒获取：index.js 顶层 cloud.init() 之后（首次调用时）才创建
function getDb() {
  return require('wx-server-sdk').database();
}

/** 读取本人 user.customTags（无 user 文档 → null） */
async function getUserDoc(openid) {
  try {
    const got = await getDb().collection('user').doc(openid).get();
    return got && got.data ? got.data : null;
  } catch (e) {
    return null;
  }
}

/**
 * S6-R4：服务端原子追加 customTags（数据库事务 runTransaction）。
 * 事务内：重读 user.customTags → 合并去重 → 校验新建单个 ≤6 字（S7-R4）、总数 ≤10 个 → 一次 update 写回；
 * 任一校验失败/异常整体回滚。返回追加后的完整数组。
 * @param {string} openid
 * @param {string[]} tagsToAdd 已审核通过的 customTag 内容（可能含重复）
 * @returns {Promise<string[]>}
 */
async function appendCustomTags(openid, tagsToAdd) {
  const db = getDb();
  const merged = await db.runTransaction(async (transaction) => {
    // 事务内重读（并发安全）
    let u = null;
    try {
      const got = await transaction.collection('user').doc(openid).get();
      u = got && got.data ? got.data : null;
    } catch (e) {
      u = null;
    }
    if (!u) throw new BizError(9000); // 无 user 文档（login 未建档）→ 系统异常（回滚）

    const current = Array.isArray(u.customTags) ? u.customTags : [];
    const seen = new Set(current);
    const result = [...current];
    for (const t of tagsToAdd) {
      if (t.length > MAX_CUSTOM_TAG_CHARS) throw new BizError(1001); // 新建单个 ≤6 字（S7-R4）
      if (seen.has(t)) continue; // 去重（当前已有或本批已加）
      seen.add(t);
      result.push(t);
    }
    if (result.length > 10) throw new BizError(1001); // 总数 ≤10

    // 一次 update 写回（事务内）
    await transaction.collection('user').doc(openid).update({ data: { customTags: result } });
    return result;
  });
  return merged;
}

async function handleText(event, openid) {
  const texts = event.texts;
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > 10) throw new BizError(1001);
  const items = texts.map((item) => {
    const field = item && item.field;
    const content = item && item.content;
    if (!FIELD_WHITELIST.includes(field)) throw new BizError(1001);
    if (typeof content !== 'string' || content.length < 1 || content.length > MAX_TEXT_CHARS) throw new BizError(1001);
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new BizError(1001);
    if (field === 'customTag' && content.length > MAX_CUSTOM_TAG_CHARS) throw new BizError(1001); // 新建 1~6 字（S7-R4）
    return { field, content };
  });

  // S6-R3：入参去重——field+content 组合重复 → 1001
  const seenKeys = new Set();
  for (const it of items) {
    const k = `${it.field}\u0000${it.content}`;
    if (seenKeys.has(k)) throw new BizError(1001);
    seenKeys.add(k);
  }

  const results = [];
  for (const item of items) {
    const { pass } = await checkText(item, openid); // 接口异常/异常返回 → 2004（lib/security）
    results.push({ field: item.field, pass });
  }

  // S6-R3：customTag 审核通过项 → 服务端原子追加 user.customTags；出参补完整数组
  let customTags = [];
  const passedCustomTags = items
    .filter((it, i) => it.field === 'customTag' && results[i].pass)
    .map((it) => it.content);
  if (passedCustomTags.length) {
    customTags = await appendCustomTags(openid, passedCustomTags);
  } else {
    const user = await getUserDoc(openid);
    customTags = user ? (Array.isArray(user.customTags) ? user.customTags : []) : [];
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length) return fail(2001, { pass: false, results, customTags }); // S6 修正：失败出参补全
  return ok({ pass: true, results, customTags });
}

module.exports = { handleText };
