/**
 * smoke.js —— 溪山行旅 云函数全量冒烟测试（S6-R4 纳入仓库，S7 移至 tools/）
 *
 * 运行：node tools/smoke.js
 * 说明：用内存 mock 替代 wx-server-sdk / ali-oss / @alicloud/pop-core，不依赖真实云环境与 OSS。
 *      覆盖 4 个云函数（login/secCheck/ossSts/delFootprint）的契约关键路径与回归：
 *        login：建档幂等 + updateProfile（avatarUrl ≤64KB / MIME 仅 jpeg|png|webp /
 *                nickname 去空白 / 未传字段不动 / 未知 action 1001 / 回读失败 9000 /
 *                更新 0 条 9000）
 *        secCheck：text 文本预检 + customTags 事务追加/去重/上限 + imageSubmit 隔离区送审 +
 *                  imagePoll + commitSave（确定性 _id 幂等 + 隔离区转正）+ commitEdit（where 过滤 +
 *                  文本先于照片 + removedKeys 差集 + 转正）+ 内容安全 2004 + 推送特权收紧
 *        ossSts：issueUpload 隔离区签发/冻结/复用/去重 + sign 批量 in 归属核验
 *        delFootprint：两阶段删除 + allSettled 部分失败恢复 + 重试入口自动恢复 + 定时收紧
 *      退出码：0 = 全绿，1 = 有用例失败。
 */
const Module = require('module');
const crypto = require('crypto');
const path = require('path');

process.env.OSS_AK_ID = 'test_ak';
process.env.OSS_AK_SECRET = 'test_sk';
process.env.OSS_BUCKET = 'inkfootprints';
process.env.OSS_REGION = 'oss-cn-hangzhou';
process.env.OSS_STS_ROLE_ARN = 'acs:ram::123:role/test';

/* ---------------- 内存 store 与开关 ---------------- */
const store = {
  footprintDocs: new Map(),
  userDocs: new Map(),
  failRemoveDoc: false,
  failUserQuery: false,
  failUserDocGet: false,
  lastWhere: null,
};
const ossStore = new Map();
const failFlags = { copy: false, delete: false, deleteKeys: null };
const textBehavior = { mode: 'pass' }; // pass | ok | risky | abnormal | throw

const cmd = {
  addToSet: (v) => ({ $addToSet: v }),
  in: (arr) => ({ $in: arr }),
};

/* ---------------- mock：wx-server-sdk ---------------- */
const wxSdkMock = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC',
  init() {},
  _openid: 'o_openid_a',
  getWXContext() {
    return { OPENID: this._openid };
  },
  database() {
    return {
      command: cmd,
      serverDate: () => new Date(Date.now()),
      runTransaction: async (fn) => {
        // 简化事务语义：单线程 mock 下无真实回滚，事务内 get/update 直接操作 store
        const tx = {
          collection(name) {
            const colDocs = name === 'user' ? store.userDocs : store.footprintDocs;
            return {
              doc(id) {
                return {
                  get: async () => {
                    const d = colDocs.get(id);
                    if (!d) throw new Error('document not found');
                    return { data: JSON.parse(JSON.stringify(d)) };
                  },
                  update: async ({ data }) => {
                    const d = colDocs.get(id);
                    if (!d) throw new Error('document not found');
                    Object.assign(d, data);
                    return { stats: { updated: 1 } };
                  },
                };
              },
            };
          },
        };
        return fn(tx);
      },
      collection(name) {
        let q = {};
        let fields = null;
        return {
          where(cond) {
            q = cond || {};
            store.lastWhere = { name, q: JSON.parse(JSON.stringify(q)) };
            return this;
          },
          limit() {
            return this;
          },
          field(f) {
            fields = f;
            return this;
          },
          skip() {
            return this;
          },
          get: async () => {
            if (name === 'user') {
              if (store.failUserQuery) throw new Error('db down');
              const all = [...store.userDocs.values()];
              let rows = all;
              if (q.openid) rows = rows.filter((d) => d.openid === q.openid);
              if (q._id) rows = rows.filter((d) => d._id === q._id);
              return { data: rows };
            }
            const all = [...store.footprintDocs.values()];
            let rows = all;
            if (q._id) rows = rows.filter((d) => d._id === q._id);
            if (q._openid) rows = rows.filter((d) => d._openid === q._openid);
            if (q['photos.key']) {
              const cond = q['photos.key'];
              if (cond && cond.$in) rows = rows.filter((d) => (d.photos || []).some((p) => p.key && cond.$in.includes(p.key)));
              else rows = rows.filter((d) => (d.photos || []).some((p) => p.key === cond));
            }
            if (fields && fields.photos) rows = rows.map((d) => ({ photos: d.photos }));
            return { data: rows };
          },
          add: async ({ data }) => {
            const id = data && data._id;
            if (!id || typeof id !== 'string') return { _id: 'AUTO_RANDOM' };
            const colDocs = name === 'user' ? store.userDocs : store.footprintDocs;
            if (colDocs.has(id)) {
              const e = new Error('duplicate key');
              e.errCode = -502001;
              throw e;
            }
            colDocs.set(id, { _id: id, ...data });
            return { _id: id };
          },
          doc(id) {
            const colDocs = name === 'user' ? store.userDocs : store.footprintDocs;
            return {
              get: async () => {
                if (name === 'user' && store.failUserDocGet) {
                  store.failUserDocGet = false;
                  throw new Error('db down');
                }
                const d = colDocs.get(id);
                if (!d) throw new Error('document not found');
                return { data: JSON.parse(JSON.stringify(d)) };
              },
              update: async ({ data }) => {
                const d = colDocs.get(id);
                if (!d) throw new Error('document not found');
                for (const [k, v] of Object.entries(data)) {
                  if (v && v.$addToSet !== undefined) {
                    d[k] = Array.isArray(d[k]) ? d[k] : [];
                    if (!d[k].includes(v.$addToSet)) d[k].push(v.$addToSet);
                  } else {
                    d[k] = v;
                  }
                }
                return { stats: { updated: 1 } };
              },
              remove: async () => {
                if (store.failRemoveDoc) {
                  store.failRemoveDoc = false;
                  throw new Error('db down');
                }
                colDocs.delete(id);
                return { stats: { removed: 1 } };
              },
            };
          },
        };
      },
    };
  },
  openapi: { security: {} },
};
wxSdkMock.openapi.security.msgSecCheck = async () => {
  if (textBehavior.mode === 'throw') throw new Error('network');
  if (textBehavior.mode === 'abnormal') return { errCode: 40001, errMsg: 'invalid appid' };
  if (textBehavior.mode === 'risky') return { errCode: 0, errMsg: 'openapi success', result: { suggest: 'risky' } };
  if (textBehavior.mode === 'ok') return { errCode: 0, errMsg: 'openapi.security.msgSecCheck:ok', result: { suggest: 'pass' } };
  return { errCode: 0, errMsg: 'openapi success', result: { suggest: 'pass' } };
};
wxSdkMock.openapi.security.mediaCheckAsync = async () => ({ errCode: 0, trace_id: 'trace_1' });

/* ---------------- mock：ali-oss / @alicloud/pop-core ---------------- */
function makeOss() {
  return {
    put: async (key, buf) => {
      ossStore.set(key, { content: Buffer.from(buf) });
      return { res: { status: 200 } };
    },
    get: async (key) => {
      if (!ossStore.has(key)) {
        const e = new Error('NoSuchKey');
        e.code = 'NoSuchKey';
        e.status = 404;
        throw e;
      }
      return { content: ossStore.get(key).content, res: { status: 200 } };
    },
    head: async (key) => {
      if (!ossStore.has(key)) {
        const e = new Error('NoSuchKey');
        e.code = 'NoSuchKey';
        throw e;
      }
      return { size: ossStore.get(key).content.length, res: { status: 200, headers: {} } };
    },
    delete: async (key) => {
      if (failFlags.delete) throw new Error('delete failed');
      if (failFlags.deleteKeys && failFlags.deleteKeys.has(key)) throw new Error('delete failed');
      ossStore.delete(key);
      return { res: { status: 204 } };
    },
    copy: async (dest, src) => {
      if (failFlags.copy) throw new Error('copy failed');
      if (!ossStore.has(src)) {
        const e = new Error('NoSuchKey');
        e.code = 'NoSuchKey';
        throw e;
      }
      ossStore.set(dest, { content: Buffer.from(ossStore.get(src).content) });
      return { res: { status: 200 } };
    },
    list: async () => ({ objects: [], isTruncated: false }),
    signatureUrl: (key, opts) => `https://signed/${key}?e=${opts && opts.expires}`,
  };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return wxSdkMock;
  if (request === 'ali-oss') return makeOss;
  if (request === '@alicloud/pop-core') {
    return {
      RPCClient: function () {
        return {
          request: async () => ({
            Credentials: { AccessKeyId: 'STS_AK', AccessKeySecret: 'STS_SK', SecurityToken: 'STS_TOKEN' },
          }),
        };
      },
    };
  }
  return origLoad.apply(this, arguments);
};

/* ---------------- 载入 4 个云函数 ---------------- */
const ROOT = path.resolve(__dirname, '..', 'cloudfunctions');
const loginMain = require(path.join(ROOT, 'login', 'index.js')).main;
const secCheckMain = require(path.join(ROOT, 'secCheck', 'index.js')).main;
const ossStsMain = require(path.join(ROOT, 'ossSts', 'index.js')).main;
const delMain = require(path.join(ROOT, 'delFootprint', 'index.js')).main;

/* ---------------- 断言与调用 ---------------- */
let passed = 0;
let failed = 0;
function assert(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok: ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${name}${extra ? ' | ' + JSON.stringify(extra) : ''}`);
  }
}
async function call(fn, event, openid) {
  wxSdkMock._openid = openid === undefined ? 'o_openid_a' : openid;
  return fn(event);
}

const openid = 'o_openid_a';
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PID2 = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CID = '11111111-2222-4333-8444-555555555555';
const hash = (a, b) => crypto.createHash('sha256').update(`${a}:${b}`).digest('hex').slice(0, 32);

(async () => {
  store.userDocs.set(openid, { _id: openid, _openid: openid, openid, customTags: ['沙漠'], createdAt: Date.now() });

  console.log('=== login：建档幂等 + updateProfile ===');
  const l1 = await call(loginMain, {}, openid);
  assert('login 复用已有 user（isNewUser=false）', l1.code === 0 && l1.data.isNewUser === false, l1);
  const avatarB64 = `data:image/png;base64,${Buffer.alloc(1024, 1).toString('base64')}`;
  const up1 = await call(loginMain, { action: 'updateProfile', avatarUrl: avatarB64, nickname: '  旅人  ' }, openid);
  assert('updateProfile 更新头像昵称并去空白', up1.code === 0 && up1.data.profile.nickname === '旅人' && up1.data.profile.avatarUrl === avatarB64, up1);
  const bigAvatar = `data:image/png;base64,${Buffer.alloc(65 * 1024, 1).toString('base64')}`;
  const up2 = await call(loginMain, { action: 'updateProfile', avatarUrl: bigAvatar }, openid);
  assert('avatarUrl 超 64KB → 1001', up2.code === 1001, up2);
  const up3 = await call(loginMain, { action: 'updateProfile', nickname: '  ' }, openid);
  assert('nickname 去空白后为空 → 1001', up3.code === 1001, up3);
  const up4 = await call(loginMain, { action: 'updateProfile', nickname: '新昵称' }, openid);
  assert('仅更新昵称（未传头像不动）', up4.code === 0 && up4.data.profile.nickname === '新昵称' && up4.data.profile.avatarUrl === avatarB64, up4);
  const up5 = await call(loginMain, { action: 'updateProfile', avatarUrl: 'not-a-dataurl' }, openid);
  assert('avatarUrl 非 dataURL → 1001', up5.code === 1001, up5);
  const up6 = await call(loginMain, { action: 'deleteAll', nickname: 'x' }, openid);
  assert('未知 action → 1001（不落入普通登录，无副作用）', up6.code === 1001 && store.userDocs.size === 1, up6);
  const up7 = await call(loginMain, { action: 'updateProfile', avatarUrl: `data:image/gif;base64,${Buffer.alloc(16, 1).toString('base64')}` }, openid);
  assert('avatarUrl MIME 不在 jpeg|png|webp → 1001', up7.code === 1001, up7);
  const webpB64 = `data:image/webp;base64,${Buffer.alloc(1024, 1).toString('base64')}`;
  const up8 = await call(loginMain, { action: 'updateProfile', avatarUrl: webpB64 }, openid);
  assert('avatarUrl MIME webp → 通过', up8.code === 0 && up8.data.profile.avatarUrl === webpB64, up8);
  store.failUserDocGet = true;
  const up9 = await call(loginMain, { action: 'updateProfile', nickname: '回读失败' }, openid);
  assert('updateProfile 回读失败 → 9000（不返回空 profile）', up9.code === 9000 && up9.data === null, up9);
  assert('回读失败时更新已生效（仅出参 9000）', store.userDocs.get(openid).nickname === '回读失败', store.userDocs.get(openid));
  const up10 = await call(loginMain, { action: 'updateProfile', nickname: 'x' }, 'o_no_user');
  assert('update 未命中任何文档 → 9000', up10.code === 9000, up10);

  console.log('=== secCheck：customTags 事务追加（去重/上限） ===');
  const t1 = await call(secCheckMain, { action: 'text', texts: [{ field: 'customTag', content: '星空' }] });
  assert('customTag 通过 → 事务追加并出参完整数组', t1.code === 0 && t1.data.customTags.includes('星空') && t1.data.customTags.includes('沙漠') && t1.data.customTags.length === 2, t1);
  const t2 = await call(secCheckMain, { action: 'text', texts: [{ field: 'customTag', content: '星空' }] });
  assert('重复标签去重', t2.code === 0 && t2.data.customTags.length === 2, t2);
  const t3 = await call(secCheckMain, { action: 'text', texts: [{ field: 'customTag', content: '这个标签超过了十个字长度' }] });
  assert('单个标签 >10 字 → 1001', t3.code === 1001, t3);
  store.userDocs.set(openid, { ...store.userDocs.get(openid), customTags: Array.from({ length: 10 }, (_, i) => `标签${i}`) });
  const t4 = await call(secCheckMain, { action: 'text', texts: [{ field: 'customTag', content: '新标签' }] });
  assert('总数超 10 → 1001（事务回滚）', t4.code === 1001 && store.userDocs.get(openid).customTags.length === 10, t4);
  store.userDocs.set(openid, { ...store.userDocs.get(openid), customTags: ['沙漠'] });

  console.log('=== secCheck：texts 去重 / 内容安全 2004 / 推送特权 ===');
  const d1 = await call(secCheckMain, { action: 'text', texts: [{ field: 'place', content: '无锡' }, { field: 'place', content: '无锡' }] });
  assert('texts 重复项 → 1001', d1.code === 1001, d1);
  textBehavior.mode = 'abnormal';
  const t5 = await call(secCheckMain, { action: 'text', texts: [{ field: 'place', content: 'x' }] });
  assert('内容安全异常返回 → 2004', t5.code === 2004, t5);
  textBehavior.mode = 'ok';
  const t6 = await call(secCheckMain, { action: 'text', texts: [{ field: 'place', content: '无锡' }] });
  assert('errMsg=:ok 形态 → 通过', t6.code === 0 && t6.data.pass === true, t6);
  textBehavior.mode = 'pass';
  const pushShape = { Event: 'wxa_media_check', TraceId: 'trace_1', Result: { Suggest: 'pass' } };
  const p1 = await call(secCheckMain, pushShape, openid);
  assert('携带 OPENID 的推送形状 → 1001（不进推送分支）', p1.code === 1001, p1);
  const p2 = await call(secCheckMain, pushShape, '');
  assert('无 OPENID + 官方推送 → 推送分支 ok', p2.code === 0, p2);

  console.log('=== secCheck：隔离区转正 + 幂等 + 去重 ===');
  const issue1 = await call(ossStsMain, { action: 'issueUpload', items: [{ photoId: PID, ext: 'jpg', date: '2026-08-29' }] });
  const imgKey = issue1.data.uploads[0].key;
  assert('issueUpload 下发隔离 key', issue1.code === 0 && imgKey.startsWith(`sec-check/img/${openid}/${PID}`), issue1);
  const travelKey = JSON.parse(ossStore.get(`sec-check/key/${PID}.json`).content).travelKey;
  assert('travel key 不下发', !issue1.data.uploads[0].key.includes('travel/'));
  const dupIssue = await call(ossStsMain, { action: 'issueUpload', items: [{ photoId: PID, ext: 'jpg', date: '2026-08-29' }, { photoId: PID, ext: 'jpg', date: '2026-08-29' }] });
  assert('issueUpload 重复 photoId → 1001', dupIssue.code === 1001, dupIssue);
  ossStore.set(imgKey, { content: Buffer.from('a') });
  const rSubmit = await call(secCheckMain, { action: 'imageSubmit', photoId: PID });
  assert('imageSubmit 隔离区送审 pending', rSubmit.code === 0 && rSubmit.data.status === 'pending', rSubmit);
  const dupPoll = await call(secCheckMain, { action: 'imagePoll', checkIds: [PID, PID] });
  assert('imagePoll 重复 checkId → 1001', dupPoll.code === 1001, dupPoll);
  const t1Task = JSON.parse(ossStore.get(`sec-check/task/${PID}.json`).content);
  t1Task.status = 'pass';
  ossStore.set(`sec-check/task/${PID}.json`, { content: Buffer.from(JSON.stringify(t1Task)) });

  const baseSave = { clientSaveId: CID, date: '2026-08-29', place: '无锡', note: '', tags: ['山水'], photos: [{ photoId: PID }] };
  const dupPhoto = await call(secCheckMain, { action: 'commitSave', ...baseSave, photos: [{ photoId: PID }, { photoId: PID }] });
  assert('commitSave 重复 photoId → 1001', dupPhoto.code === 1001, dupPhoto);
  const c1 = await call(secCheckMain, { action: 'commitSave', ...baseSave });
  const fid = hash(openid, CID);
  assert('commitSave 转正 + 确定性 _id', c1.code === 0 && c1.data.footprintId === fid, c1);
  assert('文档 photos[].key = travelKey', store.footprintDocs.get(fid).photos[0].key === travelKey);
  assert('travel 对象已转正', ossStore.has(travelKey));
  const c2 = await call(secCheckMain, { action: 'commitSave', ...baseSave });
  assert('重试幂等命中同 footprintId', c2.code === 0 && c2.data.footprintId === fid, c2);

  console.log('=== secCheck：commitEdit 顺序/where/差集 ===');
  const e0 = await call(secCheckMain, { action: 'commitEdit', ...baseSave, footprintId: fid, photos: [], removedKeys: [] }, 'o_other');
  assert('越权 commitEdit → 1004', e0.code === 1004, e0);
  const e1 = await call(secCheckMain, { action: 'commitEdit', footprintId: fid, date: '2026-08-29', place: '无锡', note: '改备注', tags: ['山水'], photos: [{ key: travelKey }], removedKeys: [] });
  assert('commitEdit 正常（无照片变更）', e1.code === 0, e1);

  console.log('=== ossSts.sign 批量 in 查询 ===');
  const s1 = await call(ossStsMain, { action: 'sign', items: [{ key: travelKey }] });
  assert('本人 key → 正常签发', s1.code === 0, s1);
  assert('sign 使用 photos.key $in 查询', store.lastWhere && store.lastWhere.q['photos.key'] && store.lastWhere.q['photos.key'].$in, store.lastWhere);
  const s2 = await call(ossStsMain, { action: 'sign', items: [{ key: 'travel/2026/08/29/ffffffffffffffff.jpg' }] });
  assert('非本人 key → 1003', s2.code === 1003, s2);

  console.log('=== delFootprint：两阶段删除 + allSettled 恢复 ===');
  const dfid = 'fp_all_1';
  const k1 = 'travel/2026/08/29/aaaaaaaaaaaaaaaa.jpg';
  const k2 = 'travel/2026/08/29/bbbbbbbbbbbbbbbb.jpg';
  store.footprintDocs.set(dfid, { _id: dfid, _openid: openid, photos: [{ key: k1 }, { key: k2 }] });
  ossStore.set(k1, { content: Buffer.from('x') });
  ossStore.set(k2, { content: Buffer.from('y') });
  failFlags.deleteKeys = new Set([k2]);
  const del1 = await call(delMain, { footprintId: dfid });
  failFlags.deleteKeys = null;
  assert('阶段二部分失败 → 3001', del1.code === 3001, del1);
  assert('文档保留', store.footprintDocs.has(dfid));
  assert('全部正式 key 已恢复', ossStore.has(k1) && ossStore.has(k2));
  const del2 = await call(delMain, { footprintId: dfid });
  assert('重试删除成功', del2.code === 0 && del2.data.deleted === true, del2);
  assert('删除后文档与对象不存在', !store.footprintDocs.has(dfid) && !ossStore.has(k1));
  const timerShape = { Type: 'Timer', TriggerName: 't6h', Time: '2026-08-29T04:00:00Z' };
  const del3 = await call(delMain, timerShape, openid);
  assert('携带 OPENID 的 Timer → 1001', del3.code === 1001, del3);

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('smoke harness error:', e);
  process.exit(2);
});
