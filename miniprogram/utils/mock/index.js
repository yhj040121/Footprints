// mock 云函数调度：USE_MOCK=true 时由 utils/request.js 的 rawCall 路由到这里
// 行为对齐接口契约 §1（信封 / 错误码 / 幂等 / S6-R2 隔离区转正时序均可本地跑通）
const store = require('./store');
const seed = require('./seed');

const ASSET_KEY = 'mock_asset_map_v1';
let seeded = false;
const submitTime = {}; // photoId → 提交时间戳（imagePoll 据此返回 pending/pass）
const keyBindings = {};  // photoId → { checkKey, travelKey }（S6-R2：issueUpload 签发的隔离 key 与预绑定 travel key）

function ensureSeed() {
  if (seeded) return;
  seeded = true;
  if (store.getFootprints().length === 0) {
    store.saveFootprints(seed.buildSeed());
  }
}

function latency() {
  return new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));
}

function ok(data) {
  return { code: 0, message: '', data: data === undefined ? null : data };
}

function fail(code, message, data) {
  return { code, message, data: data || null };
}

// 新上传照片的 key → 本地持久文件路径（oss.js mock 上传时登记，sign 时还原展示）
function registerAsset(key, savedPath) {
  let map = {};
  try { map = wx.getStorageSync(ASSET_KEY) || {}; } catch (e) { /* ignore */ }
  map[key] = savedPath;
  try { wx.setStorageSync(ASSET_KEY, map); } catch (e) { /* ignore */ }
}

function assetUrlFor(key) {
  let map = {};
  try { map = wx.getStorageSync(ASSET_KEY) || {}; } catch (e) { /* ignore */ }
  if (map[key]) return map[key];
  // 种子数据：travel/YYYY/MM/DD/mockNN.jpg → /assets/mock/mNN.png
  const m = /mock(\d+)\./.exec(key);
  if (m) return '/assets/mock/m' + m[1] + '.png';
  return '/assets/mock/m1.png';
}

// 提交转正（契约 §1.2 commitSave S6-R2）：photos 只带 photoId，travel key 从签发绑定解析；
// 同时把 mock 上传时登记的「隔离 key → 本地文件」资产映射转正到 travel key，供 sign 展示
function resolveTravelKey(p) {
  if (p.key) return p.key; // 编辑场景旧照片项
  const b = keyBindings[p.photoId];
  if (!b) return 'travel/1970/01/01/0000000000000000.jpg';
  let map = {};
  try { map = wx.getStorageSync(ASSET_KEY) || {}; } catch (e) { /* ignore */ }
  if (map[b.checkKey]) {
    map[b.travelKey] = map[b.checkKey];
    try { wx.setStorageSync(ASSET_KEY, map); } catch (e) { /* ignore */ }
  }
  return b.travelKey;
}

function rand16() {
  let s = '';
  for (let i = 0; i < 16; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0];
  return s;
}

// 违规测试口径：文本含「违规」二字即拦截（便于自测 FR-06）
function textRejected(content) {
  return /违规/.test(content || '');
}

const handlers = {
  // §1.1 login + action=updateProfile（头像/昵称/自定义标签删除）
  login(data) {
    const user = store.getUser();
    if (data && data.action === 'updateProfile') {
      const patch = {};
      if (typeof data.avatarUrl === 'string') patch.avatarUrl = data.avatarUrl;
      if (typeof data.nickname === 'string') patch.nickname = data.nickname;
      if (Array.isArray(data.removeCustomTags)) {
        const removing = data.removeCustomTags.filter((tag) => typeof tag === 'string');
        patch.customTags = (user.customTags || []).filter((tag) => removing.indexOf(tag) < 0);
      }
      const next = Object.assign({}, user, patch);
      store.saveUser(next);
      return ok({
        profile: {
          avatarUrl: next.avatarUrl,
          nickname: next.nickname,
          customTags: next.customTags || []
        }
      });
    }
    return ok({
      openid: user.openid,
      isNewUser: false,
      profile: {
        avatarUrl: user.avatarUrl,
        nickname: user.nickname,
        customTags: user.customTags || []
      }
    });
  },

  // §1.2 secCheck
  secCheck(data) {
    const action = data.action;
    if (action === 'text') {
      const results = (data.texts || []).map((t) => ({ field: t.field, pass: !textRejected(t.content) }));
      const pass = results.every((r) => r.pass);
      if (!pass) return fail(2001, '文本包含不适宜内容，请修改后再试', { pass, results });
      // S6-R3：customTag 通过 → 服务端原子追加到 user.customTags（去重、单个 ≤10 字、总数 ≤10 个，超限 1001），
      // 返回追加后的完整数组；客户端对 customTags 无写权限（§2.4）
      let customTags = null;
      const tagTexts = (data.texts || []).filter((t) => t.field === 'customTag' && t.content);
      if (tagTexts.length) {
        const user = store.getUser();
        let custom = (user.customTags || []).slice();
        for (let k = 0; k < tagTexts.length; k++) {
          const c = tagTexts[k].content.trim();
          if (!c) continue;
          if (c.length > 10) return fail(1001, '单个标签最多 10 字');
          if (custom.indexOf(c) < 0) {
            if (custom.length >= 10) return fail(1001, '自定义标签最多 10 个');
            custom.push(c);
          }
        }
        store.saveUser(Object.assign({}, user, { customTags: custom }));
        customTags = custom;
      }
      return ok({ pass, results, customTags });
    }
    if (action === 'imageSubmit') {
      // S6-R2：对隔离区对象本体送审，只收 photoId（不再接收 base64 审核副本）
      if (!data.photoId) return fail(1001, '提交内容不完整或格式不正确');
      submitTime[data.photoId] = Date.now();
      return ok({ checkId: data.photoId, status: 'pending' });
    }
    if (action === 'imagePoll') {
      const results = (data.checkIds || []).map((id) => {
        const t = submitTime[id];
        if (!t) return { checkId: id, status: 'error' };
        // mock：提交满约 2.5 秒后视为审核通过
        return { checkId: id, status: Date.now() - t > 2500 ? 'pass' : 'pending' };
      });
      return ok({ results });
    }
    if (action === 'commitSave') {
      if (!data.clientSaveId || !data.date || !data.place) {
        return fail(1001, '提交内容不完整或格式不正确');
      }
      const map = store.getCommitMap();
      if (map[data.clientSaveId]) {
        const existed = store.getFootprints().find((f) => f._id === map[data.clientSaveId].footprintId);
        if (existed) return ok(map[data.clientSaveId]); // 幂等命中，不重复建记录
        return fail(1004, '记录不存在或已被删除');
      }
      const textResults = [];
      ['place', 'note'].forEach((field) => {
        if (textRejected(data[field])) textResults.push({ field, pass: false });
      });
      (data.tags || []).forEach((t) => {
        if (textRejected(t)) textResults.push({ field: 'customTag', pass: false });
      });
      if (textResults.length) return fail(2001, '文本包含不适宜内容，请修改后再试', { results: textResults });
      const createdAt = Date.now();
      const doc = {
        _id: 'mock_fp_' + createdAt + '_' + ((Math.random() * 1000) | 0),
        date: data.date,
        place: data.place,
        lat: typeof data.lat === 'number' ? data.lat : null,
        lng: typeof data.lng === 'number' ? data.lng : null,
        note: data.note || '',
        tags: data.tags || [],
        photos: (data.photos || []).map((p) => ({ key: resolveTravelKey(p) })),
        createdAt
      };
      const list = store.getFootprints();
      list.push(doc);
      store.saveFootprints(list);
      map[data.clientSaveId] = { footprintId: doc._id, createdAt };
      store.saveCommitMap(map);
      return ok(map[data.clientSaveId]);
    }
    if (action === 'commitEdit') {
      const list = store.getFootprints();
      const idx = list.findIndex((f) => f._id === data.footprintId);
      if (idx < 0) return fail(1004, '记录不存在或已被删除');
      if (textRejected(data.note) || textRejected(data.place)) {
        return fail(2001, '文本包含不适宜内容，请修改后再试', { results: [{ field: 'note', pass: false }] });
      }
      list[idx] = Object.assign({}, list[idx], {
        date: data.date,
        place: data.place,
        lat: typeof data.lat === 'number' ? data.lat : null,
        lng: typeof data.lng === 'number' ? data.lng : null,
        note: data.note || '',
        tags: data.tags || [],
        photos: (data.photos || []).map((p) => ({ key: resolveTravelKey(p) }))
        // createdAt 不动（契约 §1.2）
      });
      store.saveFootprints(list);
      return ok({ footprintId: data.footprintId });
    }
    return fail(1001, '提交内容不完整或格式不正确');
  },

  // §1.3 ossSts
  ossSts(data) {
    if (data.action === 'issueUpload') {
      // S6-R2 隔离区签发：返回隔离 key 的 PostObject 表单（原图直传 sec-check/img/），
      // 同时预生成 travel key 并落绑定（不下发前端；commit 时服务端从绑定解析）
      const openid = store.getUser().openid;
      const uploads = (data.items || []).map((it) => {
        const d = (it.date || '').replace(/-/g, '/');
        const ext = it.ext || 'jpg';
        const checkKey = 'sec-check/img/' + openid + '/' + it.photoId + '.' + ext;
        keyBindings[it.photoId] = { checkKey, travelKey: 'travel/' + d + '/' + rand16() + '.' + ext };
        return {
          photoId: it.photoId,
          key: checkKey,
          host: 'https://mock.oss.local',
          policy: 'mock-policy',
          signature: 'mock-signature',
          OSSAccessKeyId: 'mock-ak-id',
          securityToken: 'mock-token',
          expireAt: Date.now() + 900 * 1000
        };
      });
      return ok({ uploads, expireAt: Date.now() + 900 * 1000 });
    }
    if (data.action === 'sign') {
      const urls = (data.items || []).map((it) => ({
        key: it.key,
        url: assetUrlFor(it.key),
        expireAt: Date.now() + 3600 * 1000
      }));
      return ok({ urls });
    }
    return fail(1001, '提交内容不完整或格式不正确');
  },

  // §1.4 delFootprint
  delFootprint(data) {
    const list = store.getFootprints();
    const target = list.find((f) => f._id === data.footprintId);
    if (!target) return fail(1004, '记录不存在或已被删除');
    store.saveFootprints(list.filter((f) => f._id !== data.footprintId));
    return ok({ deleted: true, removedObjects: (target.photos || []).length });
  }
};

// 统一入口：模拟网络延迟 + 返回契约信封
function call(name, data) {
  ensureSeed();
  const handler = handlers[name];
  return latency().then(() => {
    if (!handler) return fail(9000, '系统繁忙，请稍后再试');
    try {
      return handler(data || {});
    } catch (e) {
      return fail(9000, '系统繁忙，请稍后再试');
    }
  });
}

module.exports = { call, registerAsset };
