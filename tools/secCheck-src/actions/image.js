/**
 * actions/image —— action = "imageSubmit" / "imagePoll"（契约 §1.2，FR-06；S6-R2 隔离区版）
 *
 * imageSubmit（S6-R2）：不再接收 base64 审核副本（原图已先由前端 wx.uploadFile 直传隔离区
 * sec-check/img/，凭证由 ossSts.issueUpload 签发）。本 action 对**对象本体**送审：
 *   1. 读绑定对象 sec-check/key/<photoId>.json 取隔离 key（无绑定 → 1001：未先 issueUpload）
 *   2. OSS HEAD 隔离区对象存在且大小 >0（无 → 1001：原图未上传/已过期清理）
 *   3. 生成 10 分钟签名 URL → mediaCheckAsync（返回字段兼容 traceId 与 trace_id）
 *   4. 落任务对象 sec-check/task/<photoId>.json + traceId 反向映射
 * 收到 legacy 字段（image/ext）一律忽略（契约 S6-R2 废止说明）。
 */
const cloud = require('wx-server-sdk');
const { BizError, ok } = require('../lib/errors');
const { UUID_RE } = require('../lib/constants');
const { ossClient } = require('../lib/oss');
const { checkImageSync, fetchBuffer } = require('../lib/security');

/** 落审核任务对象（S7-R2：同步/异步两路共用；err 仅调试用，S7 验收后移除） */
async function writeTaskRow(client, photoId, openid, status, traceId, err) {
  const task = { photoId, openid, status, traceId: traceId || null, createdAt: Date.now() };
  if (err) task.err = String(err).slice(0, 300);
  await client.put(`sec-check/task/${photoId}.json`, Buffer.from(JSON.stringify(task), 'utf8'), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (traceId) {
    await client.put(`sec-check/task/_trace/${traceId}.json`, Buffer.from(JSON.stringify({ photoId, openid }), 'utf8'), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** action = "imageSubmit"：HEAD 隔离区对象 → 10min 签名 URL → mediaCheckAsync → 落任务对象 */
async function handleImageSubmit(event, openid) {
  const photoId = event.photoId;
  if (typeof photoId !== 'string' || !UUID_RE.test(photoId)) throw new BizError(1001);
  // S6-R2：image/ext 为 legacy 字段，一律忽略（不再写审核副本，受审对象 = 隔离区原图本体）

  const client = ossClient();

  // 1. 从绑定对象解析隔离 key（photoId↔imgKey↔travelKey↔openid，§1.3）
  let imgKey = null;
  try {
    const obj = await client.get(`sec-check/key/${photoId}.json`);
    const bind = JSON.parse(obj.content.toString('utf8'));
    if (bind && bind.openid === openid && typeof bind.imgKey === 'string') imgKey = bind.imgKey;
  } catch (e) {
    imgKey = null;
  }
  if (!imgKey) throw new BizError(1001); // 未先 issueUpload（无绑定）→ 1001

  // 2. HEAD 隔离区对象存在且 >0（原图未上传/已过期清理 → 1001）
  try {
    const head = await client.head(imgKey);
    const size = head && (head.size || (head.res && head.res.headers && Number(head.res.headers['content-length'])));
    if (!head || head.res.status !== 200 || !(size > 0)) throw new BizError(1001);
  } catch (e) {
    if (e instanceof BizError) throw e;
    if (e && (e.status === 404 || e.code === 'NoSuchKey')) throw new BizError(1001);
    console.error('[secCheck.imageSubmit] HEAD isolated object failed:', e);
    throw new BizError(3001);
  }

  // 3. 同步审核优先（S7-R2 降级，契约预留）：消息推送回投通道在本环境不可用，
  //    改为服务端拉取隔离区对象的缩放版本（w_320 优先，>1MB 再降档重试一次，≤1MB）走同步 imgSecCheck。
  //    业务拒绝 → 落 reject 任务并立即返回终态；下载失败/缩放仍>1MB → 按 error 返回（前端提示更换图片，
  //    不再回退异步 mediaCheckAsync——该通道回投不可用，pending 任务会成为死等的根源）
  try {
    let buffer = null;
    for (const w of [320, 480]) {
      const u = client.signatureUrl(imgKey, { expires: 600, process: 'image/resize,w_' + w });
      const b = await fetchBuffer(u);
      buffer = b;
      if (b.length <= 1024 * 1024) break;
    }
    if (buffer && buffer.length <= 1024 * 1024) {
      const r = await checkImageSync(buffer, openid);
      const status = r.pass ? 'pass' : 'reject';
      await writeTaskRow(client, photoId, openid, status, null);
      console.log('[secCheck.imageSubmit] sync audit done:', photoId, status);
      return ok({ checkId: photoId, status });
    }
    console.error('[secCheck.imageSubmit] resized buffer still >1MB, mark error');
    await writeTaskRow(client, photoId, openid, 'error', null, 'SYNC_FAIL: resize still >1MB');
    return ok({ checkId: photoId, status: 'error', err: 'SYNC_FAIL: resize still >1MB' });
  } catch (e) {
    // S7-R2 调试：同步失败直接返回错误（不再回退异步），失败原因写入任务便于 imagePoll 读取
    const why = (e && (e.errMsg || e.message)) || String(e);
    console.error('[secCheck.imageSubmit] sync audit failed:', why);
    await writeTaskRow(client, photoId, openid, 'error', null, 'SYNC_FAIL: ' + why);
    return ok({ checkId: photoId, status: 'error', err: 'SYNC_FAIL: ' + why });
  }
}

/** action = "imagePoll"：批量读审核记录状态（pending/pass/reject/error） */
async function handleImagePoll(event, openid) {
  const checkIds = event.checkIds;
  if (!Array.isArray(checkIds) || checkIds.length < 1 || checkIds.length > 9) throw new BizError(1001);
  // S6 修正：checkId 须为本会话提交过的 photoId，格式校验收紧为 UUID v4
  if (checkIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) throw new BizError(1001);
  // S6-R4：入参去重——checkIds 重复 → 1001
  if (new Set(checkIds).size !== checkIds.length) throw new BizError(1001);

  const client = ossClient();
  const results = await Promise.all(
    checkIds.map(async (checkId) => {
      try {
        const obj = await client.get(`sec-check/task/${checkId}.json`);
        const task = JSON.parse(obj.content.toString('utf8'));
        if (!task || task.openid !== openid) return { checkId, status: 'error' }; // 非本会话提交 → 不泄露他人状态
        const s = task.status;
        const r2 = { checkId, status: ['pending', 'pass', 'reject', 'error'].includes(s) ? s : 'pending' };
        if (task.err) r2.err = task.err; // S7-R2 调试透出，验收后移除
        return r2;
      } catch (e) {
        return { checkId, status: 'error' }; // 无审核记录（未提交过/已过期清理）
      }
    })
  );
  return ok({ results });
}

module.exports = { handleImageSubmit, handleImagePoll };
