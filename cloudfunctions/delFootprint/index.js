/**
 * delFootprint —— 删除足迹（连坐清 OSS，两阶段删除）+ 每 6 小时孤儿清理（契约 §1.4 + §5.2，FR-07/12）
 *
 * 调用路径（云函数正常调用，契约 §1.4 S6 修正两阶段删除 + S6-R2 补失败恢复）：
 *   0. 重试入口检测：文档存在但源对象缺失（此前删除中断/失败）→ 先从 sec-check/trash/ 自动恢复
 *   1. openid 过滤查文档（查无 → 1004，前端视为已删除、停止重试）
 *   2. 阶段一：全部待删对象 CopyObject 到 sec-check/trash/（源 key 作为命名的一部分以便恢复）
 *   3. 阶段二：全部复制成功后才删 travel/ 正式对象
 *   4. 阶段三：全部删除成功后才删数据库文档
 *   - 阶段二/三失败 → 立即从 trash 恢复全部原 key 并 HEAD 核验（保证「记录与照片整体原样」），
 *     再返回 3001/9000；恢复失败也 3001（trash 副本仍在，重试入口会自动再恢复）
 *   - 文档删除成功后 trash 副本由生命周期（前缀 sec-check/trash/，1 天）自然清（契约 §3.5）
 *   - 幂等：重试时「copy 已存在（覆盖）/删已删对象」视为成功；文档已删 → 1004
 *
 * 定时触发分支（每 6 小时，04:00 起间隔 6h，控制台配置，非新函数；S6 修正原每日 04:00）：
 *   - §5.2 孤儿清理：分页 list travel/ 全量对象 → 拉全量 footprint photos[].key 集合比对
 *   - 删除「未被引用 且 LastModified 早于 12 小时前」的对象（S6 修正：年龄门槛 24h→12h，
 *     最坏清理时长 ≈ 12h + 6h = 18h < 24h，FR-07 验收 5 严格可达）
 *   - 删除清单写云函数日志；失败对象下次扫描重试
 *   - 数据库为唯一事实源，不建台账、不新增集合
 *
 * 环境变量（仅环境变量描述，绝不写真实值进代码/仓库）：
 *   OSS_AK_ID / OSS_AK_SECRET / OSS_BUCKET / OSS_REGION —— 契约 §1.4「同 1.3 的 OSS 四元组」
 *   （两阶段删除/恢复的 CopyObject 需要子账号 oss:PutObject（写）+ oss:GetObject（读源）；
 *    当前 RAM 子账号为 oss:* 全量授权，已覆盖，无需改权限）
 */
const cloud = require('wx-server-sdk');
const OSS = require('ali-oss');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ENV = {
  OSS_AK_ID: process.env.OSS_AK_ID,
  OSS_AK_SECRET: process.env.OSS_AK_SECRET,
  OSS_BUCKET: process.env.OSS_BUCKET,
  OSS_REGION: process.env.OSS_REGION,
};

/* ---------- 契约 §0.3 错误码 ---------- */
const CODE_MSG = {
  1001: '提交内容有误，请重试',
  1002: '登录态失效，请重新进入小程序',
  1003: '无权操作该数据',
  1004: '记录不存在或已被删除',
  3001: '照片服务不可用，请反馈客服处理',
  9000: '系统繁忙，请反馈客服处理',
};

/* ---------- 常量（契约 §5.2/§6，S6 修正） ---------- */
const ORPHAN_AGE_MS = 12 * 3600 * 1000; // 孤儿清理年龄门槛：LastModified > 12h（S6 修正：24h → 12h）
const LIST_PAGE = 1000; // OSS list 分页大小
const DB_PAGE = 100; // 云函数端 get 分页大小
const DB_CONCURRENCY = 10; // 分页查询并发批次

class BizError extends Error {
  constructor(code) {
    super(CODE_MSG[code] || CODE_MSG[9000]);
    this.code = code;
  }
}

function ok(data) {
  return { code: 0, message: 'OK', data: data || null };
}

function fail(code) {
  return { code, message: CODE_MSG[code] || CODE_MSG[9000], data: null };
}

function ossClient() {
  if (!ENV.OSS_AK_ID || !ENV.OSS_AK_SECRET || !ENV.OSS_BUCKET || !ENV.OSS_REGION) {
    throw new BizError(3001);
  }
  return new OSS({
    region: ENV.OSS_REGION,
    accessKeyId: ENV.OSS_AK_ID,
    accessKeySecret: ENV.OSS_AK_SECRET,
    bucket: ENV.OSS_BUCKET,
  });
}

/**
 * 定时触发器事件判定（S6 修正特权收紧）：
 * 官方 Timer 触发形状 = { Type: 'Timer', TriggerName, Time }，须完全匹配；
 * 且只在无 openid 上下文（index.js 入口判定）时进入该分支——携带用户 OPENID 的
 * callFunction 一律不得进入（走 handleDelete，footprintId 校验 → 1001）。
 */
function isTimerEvent(event) {
  return !!(event && event.Type === 'Timer' && event.TriggerName);
}

/** trash 副本 key：sec-check/trash/<footprintId>/<源key>（源 key 作为命名一部分，恢复 = copy 回源 key） */
function trashKeyFor(footprintId, key) {
  return `sec-check/trash/${footprintId}/${key}`;
}

/**
 * 从 trash 恢复缺失的正式对象（S6-R2 补失败恢复 + S6-R3 强化，契约 §1.4/§5.3）：
 * 对每个 key，HEAD travel/ 对象缺失且 trash 副本存在 → CopyObject 恢复 + HEAD 核验（存在且 >0）。
 * S6-R3：恢复后**逐项 HEAD 核验全部正式 key 都已还原**，任何一项缺失则继续从 trash 重试恢复
 * （循环重试，最多 RESTORE_RETRIES 轮）；重试耗尽仍缺失 → 抛 3001（trash 副本仍在，可下次再恢复）。
 * @returns {Promise<void>} 全部正式 key 已还原
 */
const RESTORE_RETRIES = 3; // 恢复循环重试轮数

async function restoreFromTrash(client, footprintId, keys) {
  let missing = keys.slice();
  for (let attempt = 0; attempt < RESTORE_RETRIES; attempt++) {
    const stillMissing = [];
    for (const k of missing) {
      // 1) HEAD 核验：已存在且 >0 → 已还原，跳过
      let exists = false;
      try {
        const head = await client.head(k);
        const size = head && (head.size || (head.res && head.res.headers && Number(head.res.headers['content-length'])));
        exists = !!(head && head.res.status === 200 && size > 0);
      } catch (e) {
        exists = false;
      }
      if (exists) continue;
      // 2) 缺失 → 从 trash copy 恢复，再 HEAD 核验
      const trashKey = trashKeyFor(footprintId, k);
      let restored = false;
      try {
        await client.copy(k, trashKey); // trash → 原 key
        const head = await client.head(k);
        const size = head && (head.size || (head.res && head.res.headers && Number(head.res.headers['content-length'])));
        restored = !!(head && head.res.status === 200 && size > 0);
      } catch (e) {
        restored = false;
      }
      if (restored) {
        console.log(`[delFootprint] restored from trash: ${k}`);
      } else {
        console.error(`[delFootprint] restore attempt ${attempt + 1} failed: ${k}`);
        stillMissing.push(k);
      }
    }
    if (!stillMissing.length) return; // 全部正式 key 已还原
    missing = stillMissing;
  }
  console.error(`[delFootprint] restore exhausted after ${RESTORE_RETRIES} rounds, still missing:`, missing);
  throw new BizError(3001);
}

/* ==================================================================
 * 正常调用：删除足迹（契约 §1.4 S6 修正两阶段删除）
 * ================================================================== */
async function handleDelete(event, openid) {
  const footprintId = event && event.footprintId;
  if (typeof footprintId !== 'string' || !footprintId) throw new BizError(1001);

  // 1. openid 过滤查文档（越权防护：查无 → 1004，他人数据不暴露，FR-02 验收 3）
  let fp;
  try {
    const res = await db
      .collection('footprint')
      .where({ _openid: openid, _id: footprintId })
      .limit(1)
      .get();
    fp = res.data[0];
  } catch (e) {
    console.error('[delFootprint] query failed:', e);
    throw new BizError(9000);
  }
  if (!fp) throw new BizError(1004);

  const keys = (fp.photos || []).map((p) => p.key).filter((k) => typeof k === 'string' && k);
  const client = ossClient();

  // 重试入口检测（S6-R2 补失败恢复）：文档存在但源对象缺失（此前删除中断/失败）→
  // 先从 sec-check/trash/ 自动恢复全部原 key 并 HEAD 核验，恢复成功后才重新执行删除
  if (keys.length) await restoreFromTrash(client, footprintId, keys);

  // S6 修正两阶段删除 + S6-R3：各阶段 Promise.allSettled **全部落定后**再决定（不因首个失败中断，
  // 避免部分完成状态未处理）；任一失败 → 3001，数据库文档保留（FR-12 验收 4「原样保留」），可重试
  if (keys.length) {
    // 阶段一：全部待删对象复制到 sec-check/trash/（全部落定后检查，有失败 → 3001，trash 残留由生命周期清）
    const trashKeys = keys.map((k) => trashKeyFor(footprintId, k));
    const copyResults = await Promise.allSettled(keys.map((k, i) => client.copy(trashKeys[i], k)));
    if (copyResults.some((r) => r.status === 'rejected')) {
      console.error('[delFootprint] copy to trash failed (allSettled), doc kept for retry:', copyResults);
      throw new BizError(3001);
    }

    // 阶段二：全部复制成功后才删 travel/ 正式对象（allSettled 全部落定后检查）
    const delResults = await Promise.allSettled(keys.map((k) => client.delete(k)));
    if (delResults.some((r) => r.status === 'rejected')) {
      console.error('[delFootprint] OSS delete failed (allSettled), restoring from trash:', delResults);
      await restoreFromTrash(client, footprintId, keys); // 恢复失败会抛 3001（trash 仍可下轮恢复）
      throw new BizError(3001);
    }
  }

  // 阶段三：OSS 全部成功后删数据库文档（删库失败 → 恢复正式对象，保证「记录与照片整体原样」）
  try {
    await db.collection('footprint').doc(footprintId).remove();
  } catch (e) {
    console.error('[delFootprint] remove doc failed, restoring from trash:', e);
    try {
      await restoreFromTrash(client, footprintId, keys); // 恢复成功 → 对象原样，DB 异常可重试（9000）
    } catch (e2) {
      throw e2; // 恢复失败 → 3001（trash 副本仍在，重试入口会自动再恢复）
    }
    throw new BizError(9000);
  }

  return ok({ deleted: true, removedObjects: keys.length });
}

/* ==================================================================
 * 定时触发分支：每 6 小时孤儿清理（§5.2，S6 修正频率与年龄门槛）
 * ================================================================== */
async function cleanupOrphans() {
  const client = ossClient();

  // 1. 分页 list travel/ 全量对象
  const objects = []; // { name, lastModified }
  let marker;
  do {
    let res;
    try {
      const params = { prefix: 'travel/', 'max-keys': LIST_PAGE };
      if (marker) params.marker = marker;
      res = await client.list(params);
    } catch (e) {
      console.error('[delFootprint.cleanup] list travel/ failed:', e);
      return;
    }
    for (const o of res.objects || []) {
      objects.push({ name: o.name, lastModified: new Date(o.lastModified).getTime() });
    }
    marker = res.isTruncated ? res.nextMarker : null;
  } while (marker);

  if (!objects.length) {
    console.log('[delFootprint.cleanup] nothing under travel/');
    return;
  }

  // 2. 拉全量 footprint photos[].key 集合（循环分页，仅取 photos 字段；数据库为唯一事实源）
  const referenced = new Set();
  let skip = 0;
  let page;
  do {
    let res;
    try {
      res = await db.collection('footprint').field({ photos: true }).skip(skip).limit(DB_PAGE).get();
    } catch (e) {
      console.error('[delFootprint.cleanup] query footprint failed:', e);
      return;
    }
    page = res.data;
    for (const d of page) {
      for (const p of d.photos || []) {
        if (p && typeof p.key === 'string') referenced.add(p.key);
      }
    }
    skip += page.length;
  } while (page.length === DB_PAGE);

  // 3. 删除「未被引用 且 LastModified > 12h 前」的对象（S6 修正：12h 宽限保护进行中的保存）
  const now = Date.now();
  const toDelete = objects.filter((o) => !referenced.has(o.name) && now - o.lastModified > ORPHAN_AGE_MS);
  let deleted = 0;
  let failed = 0;
  for (const o of toDelete) {
    try {
      await client.delete(o.name);
      deleted += 1;
    } catch (e) {
      failed += 1;
      console.error(`[delFootprint.cleanup] delete failed, will retry next scan: ${o.name}`, e);
    }
  }
  console.log(
    `[delFootprint.cleanup] done: scanned=${objects.length}, toDelete=${toDelete.length}, deleted=${deleted}, failed=${failed}`
  );
}

/* ==================================================================
 * 入口
 * ================================================================== */
exports.main = async (event) => {
  try {
    const openid = cloud.getWXContext().OPENID;

    // S6 修正（特权分支收紧）：定时分支仅当「无 openid 上下文（Timer 触发非 callFunction）
    // 且事件字段与官方 Timer 形状完全匹配」时进入；携带用户 OPENID 的 callFunction
    // （即使伪造 Timer 形状）一律不得进入此分支，走 handleDelete → footprintId 校验 → 1001。
    if (!openid && isTimerEvent(event)) {
      await cleanupOrphans();
      return ok(null);
    }

    if (!openid) return fail(1002);

    return await handleDelete(event, openid);
  } catch (e) {
    if (e instanceof BizError) return fail(e.code);
    console.error('[delFootprint] unexpected error:', e);
    return fail(9000);
  }
};
