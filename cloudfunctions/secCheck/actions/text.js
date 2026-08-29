/**
 * actions/text —— action = "text"（契约 §1.2，FR-03/06/13 文本预检）
 *
 * S6-R3：customTags 服务端写入——`field="customTag"` 且审核通过的项，由服务端原子追加到
 * 本人 `user.customTags`（去重、单个 ≤10 字、总数 ≤10 个，超上限 1001），出参 `customTags`
 * 返回追加后的完整标签数组；客户端对 customTags 无写权限（契约 §2.4 字段级规则）。
 * 入参去重（S6-R3）：texts 内 field+content 组合重复 → 1001。
 */
const { BizError, ok, fail } = require('../lib/errors');
const { FIELD_WHITELIST, MAX_TEXT_CHARS, MAX_TEXT_BYTES } = require('../lib/constants');
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
 * S6-R3：服务端原子追加 customTags。
 * 校验：单个 ≤10 字（超 → 1001）、去重（当前已有/批内重复跳过）、总数 ≤10 个（超 → 1001）。
 * 追加用 addToSet（原子去重）；返回追加后的完整数组。
 * @param {string} openid
 * @param {string[]} tagsToAdd 已审核通过的 customTag 内容（可能含重复）
 * @returns {Promise<string[]>}
 */
async function appendCustomTags(openid, tagsToAdd) {
  const user = await getUserDoc(openid);
  if (!user) throw new BizError(9000); // 无 user 文档（login 未建档）→ 系统异常
  const current = Array.isArray(user.customTags) ? [...user.customTags] : []; // 拷贝，防引用共享

  const seen = new Set(current);
  const toAppend = [];
  for (const t of tagsToAdd) {
    if (t.length > 10) throw new BizError(1001); // 单个 ≤10 字（§2.1）
    if (seen.has(t)) continue; // 去重（当前已有或本批已加）
    seen.add(t);
    toAppend.push(t);
  }
  if (current.length + toAppend.length > 10) throw new BizError(1001); // 总数 ≤10

  const cmd = getDb().command;
  for (const t of toAppend) {
    await getDb().collection('user').doc(openid).update({
      data: { customTags: cmd.addToSet(t) }, // addToSet：原子去重追加
    });
  }
  return [...current, ...toAppend];
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
