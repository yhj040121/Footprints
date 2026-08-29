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

  // 3. 10 分钟签名 URL 供 mediaCheckAsync 拉取（受审对象 = 原图本体）
  let url;
  try {
    url = client.signatureUrl(imgKey, { expires: 600 });
  } catch (e) {
    console.error('[secCheck.imageSubmit] sign url failed:', e);
    throw new BizError(3001);
  }

  // 4. mediaCheckAsync 云调用（media_type=2 图片，version=2，scene=2）
  //    S6 修正：非零 errCode 的异常返回（未抛异常）同样 → 2004（暂缓入库，不误判为业务不通过）
  //    S6-R2：返回字段兼容 traceId 与 trace_id
  let traceId;
  try {
    const res = await cloud.openapi.security.mediaCheckAsync({
      media_url: url,
      media_type: 2,
      version: 2,
      scene: 2,
      openid,
    });
    const tid = res && (res.traceId || res.trace_id);
    if (!res || res.errCode !== 0 || !tid) {
      console.error('[secCheck.imageSubmit] invalid mediaCheckAsync response:', JSON.stringify(res));
      throw new Error('invalid mediaCheckAsync response');
    }
    traceId = tid;
  } catch (e) {
    console.error('[secCheck.imageSubmit] mediaCheckAsync error:', e);
    throw new BizError(2004); // 接口异常 → 2004
  }

  // 5. 落审核记录（任务对象，含 openid/status/traceId/时间戳）+ traceId 反向映射（回投定位用）
  const task = { photoId, openid, status: 'pending', traceId, createdAt: Date.now() };
  try {
    const jsonBuf = Buffer.from(JSON.stringify(task), 'utf8');
    await client.put(`sec-check/task/${photoId}.json`, jsonBuf, { headers: { 'Content-Type': 'application/json' } });
    await client.put(`sec-check/task/_trace/${traceId}.json`, Buffer.from(JSON.stringify({ photoId, openid }), 'utf8'), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[secCheck.imageSubmit] write task failed:', e);
    throw new BizError(3001);
  }

  return ok({ checkId: photoId, status: 'pending' });
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
        return { checkId, status: ['pending', 'pass', 'reject', 'error'].includes(s) ? s : 'pending' };
      } catch (e) {
        return { checkId, status: 'error' }; // 无审核记录（未提交过/已过期清理）
      }
    })
  );
  return ok({ results });
}

module.exports = { handleImageSubmit, handleImagePoll };
