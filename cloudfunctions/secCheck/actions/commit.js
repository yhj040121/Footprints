/**
 * actions/commit —— action = "commitSave" / "commitEdit"（契约 §1.2，FR-07/13；写库唯一入口）
 *
 * commitSave 幂等（S6 修正，契约 §5.1；S6-R2 修正 _id 写法）：
 *   - 主幂等 = 数据库确定性 _id = hash(openid + clientSaveId)（十六进制）：
 *     **`_id` 必须放进 add() 的 data 内**（参照 login 建档的正确写法；放参数顶层不生效，
 *     会生成随机 _id 导致幂等失效）。主键冲突 → 回读该 _id 且校验 _openid=本人 → 返回原 footprintId。
 *   - 辅助标记 sec-check/commit/<clientSaveId>.json 记录 { footprintId, createdAt, openid }，
 *     命中时核验归属（openid 匹配）再返回，防跨用户碰撞；归属不符视为未命中。
 *
 * S6-R2 隔离区转正（契约 §1.2 步骤 3-5 / §4.2 字节级绑定）：
 *   - photos 只收 { photoId }（前端不传 key）；travel key 由服务端从绑定对象解析
 *   - 三元组校验通过后服务端 CopyObject 隔离区 → travel/（同字节；失败 3001 不写库）
 *   - commitEdit 归属校验改 where({_id, _openid}) 过滤查询：查无 → 1004，DB 异常 → 9000，
 *     不得先读完整文档再比对 owner（防泄露记录存在性）
 */
const { BizError, ok } = require('../lib/errors');
const { UUID_RE, KEY_RE, deterministicFootprintId } = require('../lib/constants');
const { ossClient } = require('../lib/oss');
const { validateSaveInput, validateTags, validateTagsEdit } = require('../lib/validate');
const { textFinalCheck, verifyPhotos, promotePhotos } = require('../lib/security');

// db 懒获取：index.js 顶层 cloud.init() 之后（首次调用时）才创建，避免 require 先于 init
function getDb() {
  return require('wx-server-sdk').database();
}

/** 主键冲突判定（add 指定 _id 已存在） */
function isDuplicateKeyError(e) {
  if (!e) return false;
  if (e.errCode === -502001) return true;
  const msg = String(e.errMsg || e.message || '');
  return /duplicate|already exists|E11000/i.test(msg);
}

/** 按 _id 回读文档（查无/异常 → null；不校验归属，调用方按需校验） */
async function readFootprintDoc(id) {
  try {
    const got = await getDb().collection('footprint').doc(id).get();
    return got && got.data ? got.data : null;
  } catch (e) {
    return null;
  }
}

/** 回读本人 footprint：查无、异常或非本人 → null */
async function getOwnedFootprint(id, openid) {
  const doc = await readFootprintDoc(id);
  return doc && doc._openid === openid ? doc : null;
}

/** 时间戳统一为毫秒整数（serverDate 可能返回 Date 对象） */
function toMs(ts) {
  if (!ts) return Date.now();
  if (typeof ts === 'object' && ts.getTime) return ts.getTime();
  return Number(ts);
}

/* ==================================================================
 * action = "commitSave"
 * 顺序（任一失败即整体失败、不写库）：
 *   1. 幂等：辅助标记命中核验归属 → 确定性 _id 主幂等（add 冲突回读）
 *   2. 文本终审：place/note/tags（S7-R4：预设已移除，tags 全部按自定义标签重审）重过 msgSecCheck
 *   3. 照片终审（S6-R2）：task pass+openid / 绑定对象（imgKey+travelKey）/ HEAD 隔离区 >0
 *   4. 转正（S6-R2）：服务端 CopyObject 隔离区 → travel/（同字节；失败 3001 不写库）
 *   5. 写 footprint（data 内指定确定性 _id，photos[].key=travelKey，createdAt=serverDate）
 *      → 写 commit 标记（含 openid）
 * ================================================================== */
async function handleCommitSave(event, openid) {
  const clientSaveId = event.clientSaveId;
  if (typeof clientSaveId !== 'string' || !UUID_RE.test(clientSaveId)) throw new BizError(1001);
  const client = ossClient();
  const commitKey = `sec-check/commit/${clientSaveId}.json`;
  const footprintId = deterministicFootprintId(openid, clientSaveId); // S6 修正：确定性 _id

  // ---- 步骤 1：幂等 ----
  // 1a. 辅助标记命中且归属本人 → 直接返回原结果（不重复建记录）
  let marker = null;
  try {
    const obj = await client.get(commitKey);
    marker = JSON.parse(obj.content.toString('utf8'));
  } catch (e) {
    // 404 → 未命中，继续正常流程
  }
  if (marker) {
    // S6 修正：标记必须记录 openid；命中时核验归属，防跨用户碰撞
    if (marker.openid === openid) {
      const existing = await getOwnedFootprint(footprintId, openid);
      if (!existing) throw new BizError(1004); // 幂等命中但文档已删 → 1004
      return ok({ footprintId, createdAt: toMs(existing.createdAt) });
    }
    // 旧版标记兼容（S6 修正前写入、无 openid 字段）：回读标记内 footprintId 文档并校验归属
    if (!marker.openid && typeof marker.footprintId === 'string') {
      const doc = await readFootprintDoc(marker.footprintId);
      if (!doc) throw new BizError(1004); // 命中但文档已删 → 1004
      if (doc._openid === openid) return ok({ footprintId: marker.footprintId, createdAt: toMs(doc.createdAt) });
      // 文档非本人 → 标记为他人伪造/碰撞 → 忽略，走正常流程
    }
  }

  // 1b. 主幂等（S6 修正）：确定性 _id 文档已存在（辅助标记缺失/过期场景）→ 直接返回原结果
  const existingDoc = await getOwnedFootprint(footprintId, openid);
  if (existingDoc) {
    console.log(`[secCheck.commitSave] deterministic id hit: ${footprintId}`);
    return ok({ footprintId, createdAt: toMs(existingDoc.createdAt) });
  }

  // ---- 入参校验（格式层，1001；photos 只收 {photoId}，S6-R2） ----
  const input = validateSaveInput(event);
  await validateTags(input.tags, openid);

  // ---- 步骤 2：文本终审（不信任前端预检，FR-02 验收 7） ----
  // S7-R4：预设标签已移除，tags 全部命中本人 customTags（validateTags），全部按自定义标签重审
  await textFinalCheck(
    [
      { field: 'place', content: input.place },
      { field: 'note', content: input.note },
    ].concat(input.tags.map((t) => ({ field: 'customTag', content: t }))),
    openid
  );

  // ---- 步骤 3：照片终审（S6-R2 三元组，返回绑定供转正） ----
  let resolved = []; // [{ photoId, imgKey, travelKey }]
  if (input.photos.length) resolved = await verifyPhotos(input.photos, openid, client);

  // ---- 步骤 4：转正（S6-R2）CopyObject 隔离区 → travel/（同字节；失败 3001 不写库） ----
  if (resolved.length) await promotePhotos(resolved, client);

  // ---- 步骤 5：add（S6-R2 修正：_id 必须放进 data 内，参照 login；放顶层不生效）→ 写 commit 标记 ----
  try {
    await getDb().collection('footprint').add({
      data: {
        _id: footprintId, // S6-R2 修正：data 内指定确定性 _id（主幂等原子写）
        _openid: openid, // 云函数管理端 add 不自动带 _openid；客户端 read 规则 doc._openid==auth.openid 依赖它
        date: input.date,
        place: input.place,
        lat: input.lat,
        lng: input.lng,
        note: input.note,
        tags: input.tags,
        photos: resolved.map((r) => ({ key: r.travelKey })), // S6-R2：入库 key = 预绑定 travel key
        createdAt: getDb().serverDate(), // 前端传的 createdAt 一律忽略
      },
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      // 并发/中断后同 clientSaveId 已写入 → 幂等命中：回读该 _id 且校验 _openid=本人 → 返回原 footprintId
      const existing = await getOwnedFootprint(footprintId, openid);
      if (!existing) throw new BizError(9000); // _id 已被非本人占用（hash 碰撞，理论不可达）→ 系统异常
      console.log(`[secCheck.commitSave] duplicate key, idempotent hit: ${footprintId}`);
      return ok({ footprintId, createdAt: toMs(existing.createdAt) });
    }
    console.error('[secCheck.commitSave] add footprint failed:', e);
    throw new BizError(9000);
  }

  // 回读真实 createdAt（毫秒整数）供返回与幂等标记使用
  let createdAt = Date.now();
  const got = await getOwnedFootprint(footprintId, openid);
  if (got) createdAt = toMs(got.createdAt);

  // 写 commit 标记（S6 修正：必须记录 openid，供命中时核验归属）
  try {
    await client.put(commitKey, Buffer.from(JSON.stringify({ footprintId, createdAt, openid }), 'utf8'), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    // 标记写失败 → 删除刚写入的文档，整体失败、无残留（重试同 clientSaveId 重新走全流程）
    console.error('[secCheck.commitSave] write commit marker failed, rollback doc:', e);
    try {
      await getDb().collection('footprint').doc(footprintId).remove();
    } catch (e2) {
      console.error('[secCheck.commitSave] rollback doc failed:', e2);
    }
    throw new BizError(3001);
  }

  return ok({ footprintId, createdAt });
}

/* ==================================================================
 * action = "commitEdit"（FR-13；S6-R2 隔离区转正版）
 * 顺序：where 过滤查文档验归属（1004/9000，S6 修正）→ 解析照片（旧项 key / 新增项 photoId 三元组）
 *       → removedKeys 差集校验 → 变更文本重审（未变跳过）→ 转正 CopyObject 新增项（失败 3001 不动）
 *       → 更新文档（createdAt 不动）→ 更新成功后删 removedKeys（失败只记日志，定时扫描兜底）
 * 任何校验失败 → 原文档与原照片一律不动
 * ================================================================== */
async function handleCommitEdit(event, openid) {
  const footprintId = event.footprintId;
  if (typeof footprintId !== 'string' || !footprintId) throw new BizError(1001);

  // 查文档验归属（S6 修正）：where({_id, _openid}) 过滤查询——查无 → 1004（越权与不存在同语义，
  // 不泄露记录存在性）；数据库异常 → 9000。不得先读完整文档再比对 owner。
  let fp;
  try {
    const res = await getDb()
      .collection('footprint')
      .where({ _id: footprintId, _openid: openid })
      .limit(1)
      .get();
    fp = res.data[0];
  } catch (e) {
    console.error('[secCheck.commitEdit] query footprint failed:', e);
    throw new BizError(9000);
  }
  if (!fp) throw new BizError(1004);

  const input = validateSaveInput(event, new Set(fp.tags || [])); // S7-R5：豁免保留项格式层 3/6（存量标签整体放行）
  // S7-R4：编辑场景存量标签豁免——新增项须命中本人 customTags，保留项（原文档已有）放行
  await validateTagsEdit(input.tags, openid, new Set(fp.tags || []));

  const client = ossClient();
  const oldKeys = (fp.photos || []).map((p) => p.key).filter((k) => typeof k === 'string');

  // S6-R4：变更文本重审（先于照片，对齐契约 §1.2 顺序）——与原文比对，未变文本跳过；
  // 保留标签/日期不重审（FR-13；S7-R4：预设清单已移除，仅新增项重审）
  const diffItems = [];
  if (input.place !== (fp.place || '')) diffItems.push({ field: 'place', content: input.place });
  if (input.note !== (fp.note || '')) diffItems.push({ field: 'note', content: input.note });
  const oldTags = new Set(fp.tags || []);
  for (const t of input.tags) {
    if (oldTags.has(t)) continue; // S7-R4：预设清单已移除；保留项不重审（豁免口径），仅新增项重审
    diffItems.push({ field: 'customTag', content: t });
  }
  await textFinalCheck(diffItems, openid);

  // 解析最终照片序列：
  //   旧照片项 { key } —— 须属于该记录，直接保留；
  //   新增/替换照片项 { photoId } —— 三元组校验（S6-R2，只读）→ 得预绑定 travelKey
  const newKeys = [];
  const newPhotoIds = [];
  for (const p of input.photos) {
    if (p.photoId) {
      newPhotoIds.push(p.photoId);
    } else {
      if (!oldKeys.includes(p.key)) throw new BizError(1001); // 旧项 key 不属于该记录 → 1001
      newKeys.push(p.key);
    }
  }
  let resolved = []; // [{ photoId, imgKey, travelKey }]
  if (newPhotoIds.length) {
    resolved = await verifyPhotos(
      newPhotoIds.map((id) => ({ photoId: id })),
      openid,
      client
    );
    for (const r of resolved) newKeys.push(r.travelKey);
  }

  // S6 修正：removedKeys 必须恰好等于「原 photos 与最终 photos 的差集」
  const removedKeys = event.removedKeys === undefined || event.removedKeys === null ? [] : event.removedKeys;
  if (!Array.isArray(removedKeys) || removedKeys.some((k) => typeof k !== 'string' || !KEY_RE.test(k))) {
    throw new BizError(1001);
  }
  const expectedRemoved = oldKeys.filter((k) => !newKeys.includes(k));
  const removedSet = new Set(removedKeys);
  if (removedKeys.length !== expectedRemoved.length || expectedRemoved.some((k) => !removedSet.has(k))) {
    throw new BizError(1001);
  }

  // 转正（S6-R2）：CopyObject 新增照片 隔离区 → travel/（同字节；失败 3001，原文档原照片不动）
  if (resolved.length) await promotePhotos(resolved, client);

  // 更新文档（整单覆盖；createdAt 不动）
  try {
    await getDb().collection('footprint').doc(footprintId).update({
      data: {
        date: input.date,
        place: input.place,
        lat: input.lat,
        lng: input.lng,
        note: input.note,
        tags: input.tags,
        photos: newKeys.map((k) => ({ key: k })),
      },
    });
  } catch (e) {
    console.error('[secCheck.commitEdit] update footprint failed:', e);
    throw new BizError(9000);
  }

  // 更新成功后删 removedKeys：失败只记日志，交定时扫描兜底（不回滚文档，契约 §5.3）
  for (const k of removedKeys) {
    try {
      await client.delete(k);
    } catch (e) {
      console.error(`[secCheck.commitEdit] delete removed key failed (scan will cover): ${k}`, e);
    }
  }

  return ok({ footprintId });
}

module.exports = { handleCommitSave, handleCommitEdit };
