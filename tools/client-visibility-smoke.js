// 客户端可见性回归（S10）：新建足迹后立刻打开详情不得误报「记录不存在」。
// 模型：云函数写入即时落库（服务端视图），客户端 SDK 读有可见性延迟；
// LIST_LAG / POINT_LAG 分别模拟列表读（时间线等 where 查询）与点查（详情 where {_id}）的延迟。
// 关键场景 B：列表读已见新记录、点查仍处于延迟窗口——修复前 mergeRecentFootprints
// 会在列表可见时删除 recentWrites 快照，紧随其后的详情点查查无即误报「记录不存在」。
const assert = require('assert');
const crypto = require('crypto');

const OPENID = 'visibility_smoke_openid';
const storage = {};
const serverRows = []; // { row, writtenAt }
let LIST_LAG = 0;
let POINT_LAG = 0;

function visibleRows(kind) {
  const lag = kind === 'list' ? LIST_LAG : POINT_LAG;
  const t = Date.now();
  return serverRows.filter((e) => t - e.writtenAt >= lag).map((e) => Object.assign({}, e.row));
}

const chainProto = {
  where(cond) { this._cond = cond || {}; return this; },
  orderBy() { return this; },
  field() { return this; },
  skip() { return this; },
  limit() { return this; },
  get() {
    const cond = this._cond || {};
    const kind = cond._id ? 'point' : 'list';
    const rows = visibleRows(kind).filter((r) => {
      if (cond._id && r._id !== cond._id) return false;
      if (cond._openid === '{openid}' || !cond._openid) return true;
      return r._openid === cond._openid;
    });
    return Promise.resolve({ data: rows });
  }
};

global.wx = {
  getStorageSync: (k) => storage[k],
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  showToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  switchTab: () => {},
  navigateTo: () => {}
};

global.wx.cloud = {
  init() {},
  callFunction({ name, data }) {
    return new Promise((resolve) => setTimeout(() => {
      if (name === 'secCheck' && data.action === 'text') {
        resolve({ result: { code: 0, message: 'OK', data: { pass: true, results: [] } } });
      } else if (name === 'secCheck' && data.action === 'commitSave') {
        const fid = crypto.createHash('sha256')
          .update(OPENID + ':' + data.clientSaveId).digest('hex').slice(0, 32);
        serverRows.push({
          writtenAt: Date.now(),
          row: {
            _id: fid, _openid: OPENID, date: data.date, place: data.place,
            lat: data.lat || null, lng: data.lng || null,
            address: data.address || '', province: data.province || '',
            city: data.city || '', district: data.district || '',
            adcode: data.adcode || '', cityLabel: data.cityLabel || '',
            locationSource: data.locationSource || '', note: data.note || '',
            tags: [], photos: [], createdAt: Date.now()
          }
        });
        resolve({ result: { code: 0, message: 'OK', data: { footprintId: fid, createdAt: Date.now() } } });
      } else {
        resolve({ result: { code: 0, message: 'OK', data: null } });
      }
    }, 50));
  },
  database() {
    return {
      collection() { return Object.create(chainProto); },
      command: { exists() { return {}; }, gte() { return { and() { return {}; } }; } }
    };
  }
};

global.getApp = () => ({
  globalData: { openid: OPENID, loginReady: Promise.resolve(), profile: null }
});
global.getCurrentPages = () => [];

const save = require('../miniprogram/pages/add/save');
const db = require('../miniprogram/utils/db');
const constants = require('../miniprogram/utils/constants');
const CONTENT_KEY = 'footprints_content_cache_v1';

function buildPage() {
  return Object.assign({
    data: {
      saving: false, isEdit: false, editId: '',
      date: '2026-09-01', place: '西塘古镇', note: '刚记录',
      address: '浙江省嘉兴市', province: '浙江省', city: '嘉兴市',
      district: '', adcode: '', cityLabel: '嘉兴', locationSource: 'choose',
      photos: []
    },
    _lat: 30.9, _lng: 120.8,
    _clientSaveId: null, _formDirty: true, _saveSeq: 0, _seq: 0,
    _reviewSubmitAt: {}, _removedKeys: [], _origin: null, _needReset: false,
    resetForm() {},
    setData(patch) { Object.assign(this.data, patch); }
  }, save);
}

async function createAndOpenDetail(name, listLag, pointLag, reopen) {
  LIST_LAG = listLag; POINT_LAG = pointLag;
  serverRows.length = 0;
  Object.keys(storage).forEach((k) => delete storage[k]);

  const page = buildPage();
  save.onSave.call(page);
  await new Promise((r) => setTimeout(r, 600)); // 等后台链 commitSave + finishDraft

  // 时间线刷新（finishDraft → refreshTimeline → loadFirst(force) 的等价读）
  const pageRes = await db.listFootprintsPage(0, constants.PAGE_SIZE, { force: true });
  const card = (pageRes.list || [])[0];
  assert.ok(card, '[' + name + '] 时间线应立即显示新记录');

  // 用户立刻点卡片 → 详情（点查处于延迟窗口）
  const detail = await db.getFootprint(card._id);
  assert.ok(detail && detail._id === card._id,
    '[' + name + '] 立刻打开详情不得误报「记录不存在」');

  if (reopen) {
    // 模拟下拉刷新清缓存后再次打开（点查仍不可见）
    db.invalidateFootprintsCache();
    const detail2 = await db.getFootprint(card._id);
    assert.ok(detail2 && detail2._id === card._id,
      '[' + name + '] 刷新后再开不得误报「记录不存在」');
  }
  return card._id;
}

(async () => {
  // A：列表/点查对称延迟——时间线卡片来自近期写入快照，详情走同一快照兜底
  await createAndOpenDetail('A 对称延迟', 5000, 5000, true);

  // B（核心回归）：列表立即可见、点查仍延迟——列表不得删除详情兜底快照
  await createAndOpenDetail('B 列表先见/点查滞后', 0, 8000, true);

  // C：列表延迟、点查立即可见
  await createAndOpenDetail('C 列表滞后/点查先见', 8000, 0, false);

  // D：两者都立即可见
  await createAndOpenDetail('D 全立即可见', 0, 0, false);

  // E：S9 修复前写入的历史毒缓存（detail:<id> = null）必须被自愈——命中 null 视为未命中
  LIST_LAG = 0; POINT_LAG = 0;
  const cardId = await createAndOpenDetail('E 毒缓存自愈前置', 0, 0, false);
  // 直接把 null 毒条目写入内容缓存（模拟旧版本行为残留）
  const cached = { owner: OPENID, entries: {} };
  cached.entries['detail:' + cardId] = { savedAt: Date.now(), value: null };
  storage[CONTENT_KEY] = cached;
  const healed = await db.getFootprint(cardId);
  assert.ok(healed && healed._id === cardId, '历史 null 毒缓存应视为未命中并回源数据库');

  // F：带照片的近期写入——数据库点查已可见时，正式 key 版本才切换；窗口期保留本地乐观图
  LIST_LAG = 0; POINT_LAG = 0;
  serverRows.length = 0;
  Object.keys(storage).forEach((k) => delete storage[k]);
  db.rememberFootprint({
    _id: 'fp_photos_recent', date: '2026-09-01', place: '鼋头渚',
    lat: 31.2, lng: 120.2, note: '', tags: [],
    photos: [{ url: 'wxfile://local.jpg' }], createdAt: Date.now()
  });
  serverRows.push({
    writtenAt: Date.now() - 10000, // 数据库早已可见
    row: {
      _id: 'fp_photos_recent', _openid: OPENID, date: '2026-09-01', place: '鼋头渚',
      lat: 31.2, lng: 120.2, note: '', tags: [],
      photos: [{ key: 'travel/2026/09/01/bbbbbbbbbbbbbbbb.jpg' }], createdAt: Date.now() - 10000
    }
  });
  const list = await db.listFootprintsPage(0, constants.PAGE_SIZE, { force: true });
  assert.strictEqual(list.list[0].photos[0].url, 'wxfile://local.jpg', '窗口期列表保留本地乐观图');
  const detailPhotos = await db.getFootprint('fp_photos_recent', { force: true });
  assert.strictEqual(detailPhotos.photos[0].url, 'wxfile://local.jpg', '窗口期详情保留本地乐观图');

  console.log('客户端可见性回归通过：列表/点查可见性错位、刷新再开、毒缓存自愈、照片乐观窗口');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
