/**
 * actions/push —— 消息推送回投分支（mediaCheckAsync 异步结果，契约 §1.2/§4.1）
 *
 * S6 修正（特权分支收紧）：推送分支仅在「无 openid 上下文（推送触发非 callFunction）
 * 且事件字段与官方推送形状完全匹配」时进入；携带用户 OPENID 的 callFunction 一律不得进入
 * （由 index.js 以 `!openid && isPushEvent(event)` 判定）。
 */
const { ok } = require('../lib/errors');
const { ossClient } = require('../lib/oss');

/** 推送事件可能是 Buffer/字符串/对象 */
function normalizeEvent(raw) {
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return null;
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  return raw || null;
}

/**
 * 是否为 mediaCheckAsync 消息推送回投（无 action 字段，官方形状完全匹配）：
 *   - 官方推送：{ Event: 'wxa_media_check', TraceId, Result, ... }（可能包在 EventData 内）
 *   - 兜底形状：必须含 TraceId + Result 且绝无 action（callFunction 必带 action）
 */
function isPushEvent(raw) {
  let e = normalizeEvent(raw);
  if (!e) return false;
  if (e.EventData) e = normalizeEvent(e.EventData) || e;
  if (e.Event === 'wxa_media_check' || e.event === 'wxa_media_check') return true;
  if (e.action !== undefined) return false; // callFunction 必带 action → 一律非推送
  const trace = e.TraceId || e.trace_id || e.traceId;
  const result = e.Result || e.result;
  return !!(trace && result);
}

/** 回投结果 → 任务状态（非零 errcode → error；suggest 未明确 pass → reject，从严） */
function resolveStatus(result) {
  const errcode = result.errcode !== undefined ? result.errcode : result.errcode2 !== undefined ? result.errcode2 : undefined;
  const suggest = result.Suggest || result.suggest;
  if (errcode !== undefined && errcode !== 0) return 'error';
  if (suggest === 'pass') return 'pass';
  if (suggest === 'risky' || suggest === 'review') return 'reject';
  return 'error';
}

async function handlePush(raw) {
  let e = normalizeEvent(raw);
  if (!e) return;
  if (e.EventData) e = normalizeEvent(e.EventData) || e;

  const traceId = e.TraceId || e.trace_id || e.traceId;
  if (!traceId) {
    console.warn('[secCheck.push] no traceId in push event:', JSON.stringify(e).slice(0, 500));
    return;
  }
  const result = e.Result || e.result || {};
  const pushOpenid = e.Openid || e.openid || e.FromUserName || '';
  const status = resolveStatus(result);

  const client = ossClient();
  let photoId = null;
  try {
    const obj = await client.get(`sec-check/task/_trace/${traceId}.json`);
    const map = JSON.parse(obj.content.toString('utf8'));
    if (!map || !map.photoId) return;
    if (pushOpenid && map.openid && pushOpenid !== map.openid) return; // 回投 openid 不匹配 → 忽略
    photoId = map.photoId;
  } catch (e) {
    console.warn(`[secCheck.push] trace reverse map not found: ${traceId}`);
    return;
  }

  try {
    const obj = await client.get(`sec-check/task/${photoId}.json`);
    const task = JSON.parse(obj.content.toString('utf8'));
    // 仅更新「仍 pending 且 traceId 一致」的当前任务，防止旧回投覆盖重试后的新任务
    if (task && task.openid === (pushOpenid || task.openid) && task.traceId === traceId && task.status === 'pending') {
      task.status = status;
      task.updatedAt = Date.now();
      await client.put(`sec-check/task/${photoId}.json`, Buffer.from(JSON.stringify(task), 'utf8'), {
        headers: { 'Content-Type': 'application/json' },
      });
      console.log(`[secCheck.push] task updated: photoId=${photoId} status=${status}`);
    }
  } catch (e) {
    console.warn(`[secCheck.push] task not found for photoId=${photoId}`);
  }
}

module.exports = { normalizeEvent, isPushEvent, handlePush };
