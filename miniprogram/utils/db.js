// 数据访问层：足迹/用户资料的「读」与 user 本人资料的「写」（契约 §0.1：读走 db SDK 直连，footprint 写一律走云函数）
// S7-R1：客户端所有查询显式携带 _openid:'{openid}'——自定义安全规则要求「查询条件是规则的子集」，
//        预设权限会自动注入 _openid 而自定义规则不会（官方《数据库安全规则》升级指引），
//        缺 _openid 的查询在自定义规则下会 -502003。此修复同时兼容预设权限（恒等过滤，无副作用）。
// USE_MOCK=true 时全部路由到 utils/mock/ 本地存储，联调切 false 即用真实云数据库，页面代码零改动。
const config = require('./config');
const store = require('./mock/store');
const seed = require('./mock/seed');
const dateUtil = require('./date');
const contentCache = require('./content-cache');
const pendingDeletions = require('./pending-deletions');

const COLLECTION = 'footprint';
const USER_COLLECTION = 'user';

let mockSeeded = false;
const RECENT_WRITE_TTL_MS = 2 * 60 * 1000;
const recentWrites = {};

function cloneFootprint(record) {
  return Object.assign({}, record, {
    photos: (record.photos || []).map((photo) => Object.assign({}, photo)),
    tags: (record.tags || []).slice()
  });
}

function createdAtMs(record) {
  return dateUtil.tsOf(record) || Date.now();
}

function sameFootprintShape(a, b) {
  if (!a || !b || a._id !== b._id) return false;
  const fields = [
    'date', 'place', 'note', 'lat', 'lng', 'address', 'province', 'city',
    'district', 'adcode', 'cityLabel', 'locationSource'
  ];
  if (fields.some((field) => (a[field] == null ? '' : a[field]) !== (b[field] == null ? '' : b[field]))) {
    return false;
  }
  if (JSON.stringify(a.tags || []) !== JSON.stringify(b.tags || [])) return false;
  const aPhotos = a.photos || [];
  const bPhotos = b.photos || [];
  if (aPhotos.length !== bPhotos.length) return false;
  // 新增照片在乐观记录里只有本地 url，无法与服务端生成的 travel key 做等值判断；
  // 此时宁可保留短期乐观版本，也不能误切回仍是旧照片的客户端快照。
  if (bPhotos.some((photo) => !photo || !photo.key)) return bPhotos.length === 0;
  return aPhotos.every((photo, index) => photo && photo.key === bPhotos[index].key);
}

function getRecentFootprint(id) {
  const entry = recentWrites[id];
  if (!entry) return null;
  if (entry.expireAt <= Date.now()) {
    delete recentWrites[id];
    return null;
  }
  return cloneFootprint(entry.record);
}

// 云函数刚写成功而客户端数据库尚未可见时，用本次保存快照填补短暂空窗；
// 一旦客户端读到内容一致的正式记录，立即切回数据库版本（含正式照片 key）。
function rememberFootprint(record) {
  if (!record || !record._id) return;
  const next = cloneFootprint(record);
  if (!next.createdAt) next.createdAt = Date.now();
  recentWrites[next._id] = { record: next, expireAt: Date.now() + RECENT_WRITE_TTL_MS };
}

function forgetFootprint(id) {
  if (id) delete recentWrites[id];
}

function mergeRecentFootprints(list, predicate) {
  const result = (list || []).map((item) => Object.assign({}, item));
  Object.keys(recentWrites).forEach((id) => {
    const recent = getRecentFootprint(id);
    if (!recent || (predicate && !predicate(recent))) return;
    const index = result.findIndex((item) => item && item._id === id);
    if (index >= 0 && sameFootprintShape(result[index], recent)) {
      delete recentWrites[id];
      return;
    }
    const optimistic = Object.assign({}, recent, { _recentWrite: true });
    if (index >= 0) result[index] = optimistic;
    else result.push(optimistic);
  });
  return result;
}

function ensureMockSeed() {
  if (!config.USE_MOCK) return;
  if (!mockSeeded) {
    mockSeeded = true;
    if (store.getFootprints().length === 0) {
      store.saveFootprints(seed.buildSeed());
    }
  }
}

function db() {
  return wx.cloud.database();
}

function sortDesc(list) {
  return list.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return dateUtil.tsOf(b) - dateUtil.tsOf(a);
  });
}

// 读缓存命中时立即返回；强制刷新或缓存过期时读取数据源并覆盖缓存。
function readThrough(cacheKey, options, loader) {
  const opts = options || {};
  if (!opts.force) {
    const cached = contentCache.getContent(cacheKey);
    if (cached.hit) return Promise.resolve(cached.value);
  }
  return loader().then((value) => {
    contentCache.setContent(cacheKey, value);
    return value;
  });
}

// ---------- 足迹读 ----------

// 时间线分页（契约 §2.3：date desc, createdAt desc，每页 20 条）
// 返回 { list, hasMore }
function listFootprintsPage(skip, limit, options) {
  limit = limit || 20;
  return readThrough('page:' + skip + ':' + limit, options, () => {
    if (config.USE_MOCK) {
      ensureMockSeed();
      const all = sortDesc(store.getFootprints());
      return Promise.resolve({
        list: all.slice(skip, skip + limit),
        hasMore: skip + limit < all.length
      });
    }
    return db().collection(COLLECTION)
      .where({ _openid: '{openid}' })
      .orderBy('date', 'desc')
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(limit)
      .get()
      .then((res) => ({ list: res.data, hasMore: res.data.length === limit }));
  }).then((res) => {
    const cloudList = (res && res.list) || [];
    if (skip !== 0) return Object.assign({}, res, { cloudCount: cloudList.length });
    const merged = sortDesc(mergeRecentFootprints(cloudList));
    return {
      list: merged.slice(0, limit),
      hasMore: !!res.hasMore || merged.length > limit,
      cloudCount: cloudList.length
    };
  });
}

// 日历：某月全部记录（'YYYY-MM'）
function listByMonth(yearMonth) {
  const range = dateUtil.monthRange(yearMonth);
  return listByRange(range.first, range.last);
}

// 日期范围（闭区间，导出 FR-15 也用）
// 客户端 SDK 单次 get 上限 20 条：循环分页拉到不足一页为止（契约 §2.3）
function listByRange(startDate, endDate, options) {
  return readThrough('range:' + startDate + ':' + endDate, options, () => {
    if (config.USE_MOCK) {
      ensureMockSeed();
      return Promise.resolve(sortDesc(store.getFootprints().filter((f) => f.date >= startDate && f.date <= endDate)));
    }
    const _ = db().command;
    const all = [];
    const step = () => db().collection(COLLECTION)
      .where({ _openid: '{openid}', date: _.gte(startDate).and(_.lte(endDate)) })
      .orderBy('date', 'desc')
      .orderBy('createdAt', 'desc')
      .skip(all.length)
      .limit(20)
      .get()
      .then((res) => {
        all.push.apply(all, res.data);
        return res.data.length === 20 ? step() : all;
      });
    return step();
  }).then((list) => pendingDeletions.filter(mergeRecentFootprints(
    list,
    (record) => record.date >= startDate && record.date <= endDate
  )));
}

// 地图：全部含经纬度的记录（客户端 SDK 单次上限 20 条，循环分页，契约 §2.3）
function listWithLocation(options) {
  return readThrough('with-location', options, () => {
    if (config.USE_MOCK) {
      ensureMockSeed();
      return Promise.resolve(
        store.getFootprints()
          .filter((f) => typeof f.lat === 'number' && typeof f.lng === 'number')
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : dateUtil.tsOf(a) - dateUtil.tsOf(b)))
      );
    }
    const _ = db().command;
    const all = [];
    const step = () => db().collection(COLLECTION)
      .where({ _openid: '{openid}', lat: _.exists(true) })
      .field({ date: true, place: true, lat: true, lng: true, address: true, province: true, city: true, district: true, adcode: true, cityLabel: true, locationSource: true, note: true, photos: true, createdAt: true })
      .orderBy('date', 'asc')
      .orderBy('createdAt', 'asc')
      .skip(all.length)
      .limit(20)
      .get()
      .then((res) => {
        all.push.apply(all, res.data);
        return res.data.length === 20 ? step() : all;
      });
    // exists(true) 无法排除 null：lat/lng 必须成对且都是 number 才进 marker（契约 §0.4 同有同无）
    return step().then((list) =>
      list.filter((f) => typeof f.lat === 'number' && typeof f.lng === 'number')
    );
  }).then((list) => pendingDeletions.filter(mergeRecentFootprints(
    list,
    (record) => typeof record.lat === 'number' && typeof record.lng === 'number'
  ).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : createdAtMs(a) - createdAtMs(b)))));
}

// 详情：按 id 取单条（S7-R1：doc().get() 在自定义规则下不满足子集检查，改 where({_id, _openid})）
// S6-R3：区分「记录不存在/无权限」与「网络/服务端异常」——前者返回 null，后者抛 { network:true }，
// 供详情页断网时展示「网络错误」而非误报「记录不存在」
function getFootprint(id, options) {
  return readThrough('detail:' + id, options, () => {
    if (config.USE_MOCK) {
      ensureMockSeed();
      return Promise.resolve(store.getFootprints().find((f) => f._id === id) || null);
    }
    return db().collection(COLLECTION).where({ _id: id, _openid: '{openid}' }).limit(1).get()
      .then((res) => (res.data && res.data[0]) || null)
      .catch((err) => {
        const msg = (err && err.errMsg) || '';
        if (/not exist|not found|does not exist|permission|deny|invalid/i.test(msg)) return null;
        const e = new Error(msg || '网络异常，请稍后重试');
        e.network = true;
        throw e;
      });
  }).then((record) => {
    if (pendingDeletions.isPending(id)) return null;
    const recent = getRecentFootprint(id);
    if (!recent) return record;
    if (record && sameFootprintShape(record, recent)) {
      delete recentWrites[id];
      return record;
    }
    return recent;
  });
}

// 我的页统计（FR-14）：已记录天数 / 足迹数 / 照片张数
function stats(options) {
  return readThrough('stats', options, () => {
    if (config.USE_MOCK) {
      ensureMockSeed();
      const all = pendingDeletions.filter(mergeRecentFootprints(store.getFootprints()));
      const days = {};
      let photos = 0;
      all.forEach((f) => {
        days[f.date] = true;
        photos += (f.photos || []).length;
      });
      return Promise.resolve({ days: Object.keys(days).length, footprints: all.length, photos });
    }
    // 循环分页拉 date/photos 本地累计（契约 §2.3）
    const all = [];
    const step = () => db().collection(COLLECTION)
      .where({ _openid: '{openid}' })
      .field({ date: true, photos: true })
      .skip(all.length)
      .limit(20)
      .get()
      .then((res) => {
        all.push.apply(all, res.data);
        return res.data.length === 20 ? step() : all;
      });
    return step().then(() => {
      const visible = pendingDeletions.filter(mergeRecentFootprints(all));
      const days = {};
      let photos = 0;
      visible.forEach((f) => {
        days[f.date] = true;
        photos += (f.photos || []).length;
      });
      return { days: Object.keys(days).length, footprints: visible.length, photos };
    });
  });
}

// ---------- 用户资料（契约 §0.1：user 本人资料前端 db SDK 直写） ----------

function getProfile() {
  const app = getApp();
  if (app && app.globalData && app.globalData.profile) {
    return Promise.resolve(app.globalData.profile);
  }
  if (config.USE_MOCK) {
    const u = store.getUser();
    return Promise.resolve({ avatarUrl: u.avatarUrl, nickname: u.nickname });
  }
  return db().collection(USER_COLLECTION).where({ _openid: '{openid}' }).limit(1).get().then((res) => {
    const u = res.data[0] || {};
    return { avatarUrl: u.avatarUrl || null, nickname: u.nickname || null };
  });
}

// 更新本人头像/昵称/自定义标签：S6-R4 起 user 集合客户端整体 write:false，
// 头像/昵称走 login action=updateProfile（服务端写，见 mine.js saveProfile），customTags 走 secCheck.text，
// 客户端不再直写 user 数据库，故此处不再提供 updateProfile。
module.exports = {
  listFootprintsPage,
  listByMonth,
  listByRange,
  listWithLocation,
  getFootprint,
  rememberFootprint,
  forgetFootprint,
  stats,
  getProfile,
  invalidateFootprintsCache: contentCache.invalidateContent
};
