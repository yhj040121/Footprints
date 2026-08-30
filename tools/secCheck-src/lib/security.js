/**
 * lib/security —— 内容安全云调用封装与终审（契约 §1.2/§4.2）
 *
 * S6 修正（内容安全异常映射）：云调用抛异常，或返回非零 errCode/errMsg（未抛异常），
 * 一律映射 2004（暂缓入库，绝不静默放行）；仅 msgSecCheck 明确的业务性「不通过」
 * （errCode=0 且 suggest≠pass）才由调用方按 2001 处理。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');
const { BizError } = require('./errors');

// 当日文本查重缓存：未上架小程序 msgSecCheck 仅 100 次/天（45009=日配额耗尽），
// 同一用户当天重复提交相同内容（反复测试/编辑未改动字段）时复用已通过的结论，不再消耗配额。
// 仅缓存 pass 结论；负结论不缓存（整改后重试仍真实送检）。缓存随自然日（东八区）整体失效。
const TEXT_CACHE_MAX = 50;

function getDb() {
  return require('wx-server-sdk').database();
}

function todayCN() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function textHash(item) {
  return crypto.createHash('sha256').update(`v1\u0000${item.field}\u0000${item.content}`, 'utf8').digest('hex').slice(0, 24);
}

/** 读本人当日查重缓存（无文档/过期/异常 → null，降级为真实送检） */
async function readTextCache(openid) {
  try {
    const got = await getDb().collection('user').doc(openid).get();
    const c = got && got.data && got.data.secTextCache;
    if (!c || c.d !== todayCN() || !Array.isArray(c.h)) return null;
    return c;
  } catch (e) {
    return null;
  }
}

/** 追加当日哈希并裁剪至上限；写失败静默（缓存只是省配额手段，绝不阻塞保存主流程） */
async function writeTextCache(openid, prev, hash) {
  try {
    const today = todayCN();
    const base = prev && prev.d === today ? prev.h : [];
    const h = base.includes(hash) ? base : [...base, hash].slice(-TEXT_CACHE_MAX);
    await getDb().collection('user').doc(openid).update({ data: { secTextCache: { d: today, h } } });
  } catch (e) {
    console.error('[secCheck.security] text cache write skipped:', e && e.errMsg || e);
  }
}

function securityIssue(stage, source) {
  const code = source && (source.errCode || source.errcode || source.code);
  const message = source && (source.errMsg || source.errmsg || source.message);
  return {
    stage,
    // 结构化错误码（如 45009=当日配额耗尽）：前端据此映射中文提示，绝不向用户透出英文 errMsg
    reasonCode: typeof code === 'number' ? code : undefined,
    reason: [code, message].filter((v) => v !== undefined && v !== null && String(v).length)
      .join(' ')
      .slice(0, 120) || 'UNKNOWN_RESPONSE'
  };
}

/**
 * 单段文本 msgSecCheck。
 * 成功判定（S6-R3）：以 errCode===0 且 result.suggest 合法为主——成功尾缀 `:ok` /
 * `openapi success` / 空 errMsg 等官方成功形态均接受（含 `openapi.security.msgSecCheck:ok`）；
 * 云调用抛异常或返回非零 errCode / 异常 errMsg → 2004；仅 result.suggest 明确的业务性
 * 「不通过」（risky/review 等非 pass 值）→ pass=false（调用方 → 2001）。
 * @returns {Promise<{pass: boolean}>}
 * @throws BizError 2004（接口异常/异常返回）
 */
async function checkText(item, openid) {
  let res;
  try {
    res = await cloud.openapi.security.msgSecCheck({ content: item.content, version: 2, scene: 2, openid });
  } catch (e) {
    console.error('[secCheck.security] msgSecCheck error:', e);
    throw new BizError(2004, securityIssue('text', e));
  }
  // S6-R3：errMsg 仅作异常判据——非空且不以官方成功形态结尾（`:ok` / `openapi success`）→ 2004
  const errMsg = res && res.errMsg;
  const abnormal =
    !res ||
    res.errCode !== 0 ||
    (typeof errMsg === 'string' && errMsg.length > 0 && !/^openapi success$|:ok$/i.test(errMsg));
  if (abnormal) {
    console.error('[secCheck.security] msgSecCheck abnormal response:', JSON.stringify(res).slice(0, 500));
    throw new BizError(2004, securityIssue('text', res));
  }
  // result.suggest 合法性：pass → 通过；其他合法业务值（risky/review 等）→ 业务性不通过（2001）
  const suggest = res.result && res.result.suggest;
  if (suggest === 'pass') return { pass: true };
  if (typeof suggest === 'string' && suggest.length > 0) return { pass: false };
  // result 缺失或 suggest 缺失/非法 → 响应形态异常 → 2004（不误判 2001）
  console.error('[secCheck.security] msgSecCheck result invalid:', JSON.stringify(res).slice(0, 500));
  throw new BizError(2004, { stage: 'text', reason: 'RESULT_MISSING' });
}

/**
 * 带当日查重缓存的文本检测（text 预检与 commit 终审共用）：
 * 同一用户当日已检通过的相同 field+content → 直接复用 pass，不调 msgSecCheck；
 * 未命中/缓存异常 → 真实送检，通过后回写缓存。
 * @returns {Promise<{pass: boolean, cached?: boolean}>}
 * @throws BizError 2004（同 checkText）
 */
async function checkTextCached(item, openid) {
  const hash = textHash(item);
  const cached = await readTextCache(openid);
  if (cached && cached.h.includes(hash)) return { pass: true, cached: true };
  const r = await checkText(item, openid);
  if (r.pass) await writeTextCache(openid, cached, hash);
  return r;
}

/** 文本终审：逐项 msgSecCheck，不过 → 2001（results 指明字段）；接口异常/异常返回 → 2004 */
async function textFinalCheck(items, openid) {
  for (const item of items) {
    if (!item.content) continue;
    const { pass } = await checkTextCached(item, openid);
    if (!pass) throw new BizError(2001, { results: [{ field: item.field, pass: false }] });
  }
}

/**
 * 照片终审三元组（契约 §4.2 防替换；S6-R2 隔离区版）：
 *   ① sec-check/task/<photoId>.json 存在且 status=pass 且 openid=当前用户
 *   ② 绑定对象 sec-check/key/<photoId>.json 存在（含 imgKey 隔离 key + travelKey 预生成正式 key，§1.3）
 *   ③ OSS HEAD 隔离区对象 imgKey 存在且大小 >0（受审对象 = 用户上传的原图本体）
 * 任一不符 → 2005；OSS 请求异常 → 3001。
 * @returns {Promise<Array<{photoId, imgKey, travelKey}>>} 按入参顺序解析的绑定（供转正使用）
 */
async function verifyPhotos(photos, openid, client) {
  const resolved = [];
  for (const p of photos) {
    const photoId = p.photoId;
    // ① 审核记录
    let task = null;
    try {
      const obj = await client.get(`sec-check/task/${photoId}.json`);
      task = JSON.parse(obj.content.toString('utf8'));
    } catch (e) {
      throw new BizError(2005);
    }
    if (!task || task.openid !== openid || task.status !== 'pass') throw new BizError(2005);

    // ② 签发绑定（photoId↔imgKey↔travelKey↔openid）
    let bind = null;
    try {
      const obj = await client.get(`sec-check/key/${photoId}.json`);
      bind = JSON.parse(obj.content.toString('utf8'));
    } catch (e) {
      throw new BizError(2005);
    }
    if (!bind || bind.openid !== openid || typeof bind.imgKey !== 'string' || typeof bind.travelKey !== 'string') {
      throw new BizError(2005);
    }

    // ③ OSS HEAD 隔离区对象（受审对象 = 原图本体，转正同字节）
    try {
      const head = await client.head(bind.imgKey);
      const size = head && (head.size || (head.res && head.res.headers && Number(head.res.headers['content-length'])));
      if (!head || head.res.status !== 200 || !(size > 0)) throw new BizError(2005);
    } catch (e) {
      // 对象不存在/为空 → 2005；其余 OSS 异常 → 3001
      if (e instanceof BizError) throw e;
      if (e && (e.status === 404 || e.code === 'NoSuchKey')) throw new BizError(2005);
      console.error('[secCheck.security] HEAD failed:', e);
      throw new BizError(3001);
    }

    resolved.push({ photoId, imgKey: bind.imgKey, travelKey: bind.travelKey });
  }
  return resolved;
}

/**
 * 转正（S6-R2，契约 §1.2 步骤 4）：服务端 CopyObject 隔离区对象 → travel/ 预生成 key（同字节）
 * → HEAD travel 对象确认存在且 >0。任一失败 → 3001（不写库；隔离区对象仍保留供重试）。
 */
async function promotePhotos(resolved, client) {
  for (const r of resolved) {
    try {
      await client.copy(r.travelKey, r.imgKey);
      const head = await client.head(r.travelKey);
      const size = head && (head.size || (head.res && head.res.headers && Number(head.res.headers['content-length'])));
      if (!head || head.res.status !== 200 || !(size > 0)) throw new Error('promote head check failed');
      console.log(`[secCheck.security] promoted: ${r.imgKey} -> ${r.travelKey}`);
    } catch (e) {
      console.error(`[secCheck.security] promote failed: photoId=${r.photoId}`, e);
      throw new BizError(3001);
    }
  }
}

/**
 * 同步图片审核（S7-R2 降级方案，契约预留）：本环境「消息推送」通道不可用，mediaCheckAsync
 * 结果无法回投 → 改为同步 imgSecCheck（v1，Buffer ≤1MB，入参传隔离区对象的缩放版本，
 * 审核内容与原图一致仅尺寸不同）。业务性拒绝以 errCode 87014 为准（抛异常与非抛异常两种形态都处理）；
 * 其余接口异常 → BizError 2004（调用方回退异步路径或按暂缓处理）。
 * @returns {Promise<{pass: boolean}>}
 */
async function checkImageSync(buffer, openid) {
  let res;
  try {
    res = await cloud.openapi.security.imgSecCheck({
      media: { contentType: 'image/jpeg', value: buffer },
    });
  } catch (e) {
    if (e && (e.errCode === 87014 || /87014|risky/i.test(String(e.errMsg || '')))) return { pass: false };
    console.error('[secCheck.security] imgSecCheck error:', e);
    throw new BizError(2004, securityIssue('image', e));
  }
  const errMsg = res && res.errMsg;
  if (res && res.errCode === 87014) return { pass: false };
  const abnormal =
    !res ||
    res.errCode !== 0 ||
    (typeof errMsg === 'string' && errMsg.length > 0 && !/^openapi success$|:ok$/i.test(errMsg));
  if (abnormal) {
    console.error('[secCheck.security] imgSecCheck abnormal response:', JSON.stringify(res).slice(0, 500));
    throw new BizError(2004, securityIssue('image', res));
  }
  return { pass: true };
}

/** 下载签名 URL 内容为 Buffer（10s 超时；非 200 → throw） */
function fetchBuffer(url, timeoutMs = 10000) {
  const u = String(url).replace(/^http:\/\//, 'https://'); // 签名不含协议，强制 https（S7-R2）
  return new Promise((resolve, reject) => {
    const req = https.get(u, (res2) => {
      if (res2.statusCode !== 200) { res2.resume(); return reject(new Error('HTTP ' + res2.statusCode)); }
      const chunks = [];
      res2.on('data', (c) => chunks.push(c));
      res2.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('download timeout')));
  });
}

module.exports = { checkText, checkTextCached, textFinalCheck, verifyPhotos, promotePhotos, checkImageSync, fetchBuffer };
