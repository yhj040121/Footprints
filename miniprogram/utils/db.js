// 数据访问层：足迹/用户资料的「读」与 user 本人资料的「写」（契约 §0.1：读走 db SDK 直连，footprint 写一律走云函数）
// USE_MOCK=true 时全部路由到 utils/mock/ 本地存储，联调切 false 即用真实云数据库，页面代码零改动。
const config = require('./config');
const store = require('./mock/store');
const seed = require('./mock/seed');
const dateUtil = require('./date');

const COLLECTION = 'footprint';
const USER_COLLECTION = 'user';

let mockSeeded = false;
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

// ---------- 足迹读 ----------

// 时间线分页（契约 §2.3：date desc, createdAt desc，每页 20 条）
// 返回 { list, hasMore }
function listFootprintsPage(skip, limit) {
  limit = limit || 20;
  if (config.USE_MOCK) {
    ensureMockSeed();
    const all = sortDesc(store.getFootprints());
    return Promise.resolve({
      list: all.slice(skip, skip + limit),
      hasMore: skip + limit < all.length
    });
  }
  return db().collection(COLLECTION)
    .orderBy('date', 'desc')
    .orderBy('createdAt', 'desc')
    .skip(skip)
    .limit(limit)
    .get()
    .then((res) => ({ list: res.data, hasMore: res.data.length === limit }));
}

// 日历：某月全部记录（'YYYY-MM'）
function listByMonth(yearMonth) {
  const range = dateUtil.monthRange(yearMonth);
  return listByRange(range.first, range.last);
}

// 日期范围（闭区间，导出 FR-15 也用）
// 客户端 SDK 单次 get 上限 20 条：循环分页拉到不足一页为止（契约 §2.3）
function listByRange(startDate, endDate) {
  if (config.USE_MOCK) {
    ensureMockSeed();
    return Promise.resolve(sortDesc(store.getFootprints().filter((f) => f.date >= startDate && f.date <= endDate)));
  }
  const _ = db().command;
  const all = [];
  const step = () => db().collection(COLLECTION)
    .where({ date: _.gte(startDate).and(_.lte(endDate)) })
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
}

// 地图：全部含经纬度的记录（客户端 SDK 单次上限 20 条，循环分页，契约 §2.3）
function listWithLocation() {
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
    .where({ lat: _.exists(true) })
    .field({ date: true, place: true, lat: true, lng: true, note: true, photos: true, createdAt: true })
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
}

// 详情：按 id 取单条（安全规则兜底非本人返回空）
// S6-R3：区分「记录不存在/无权限」与「网络/服务端异常」——前者返回 null，后者抛 { network:true }，
// 供详情页断网时展示「网络错误」而非误报「记录不存在」
function getFootprint(id) {
  if (config.USE_MOCK) {
    ensureMockSeed();
    return Promise.resolve(store.getFootprints().find((f) => f._id === id) || null);
  }
  return db().collection(COLLECTION).doc(id).get()
    .then((res) => res.data || null)
    .catch((err) => {
      const msg = (err && err.errMsg) || '';
      if (/not exist|not found|does not exist|permission|deny|invalid/i.test(msg)) return null;
      const e = new Error(msg || '网络异常，请稍后重试');
      e.network = true;
      throw e;
    });
}

// 我的页统计（FR-14）：已记录天数 / 足迹数 / 照片张数
function stats() {
  if (config.USE_MOCK) {
    ensureMockSeed();
    const all = store.getFootprints();
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
    .field({ date: true, photos: true })
    .skip(all.length)
    .limit(20)
    .get()
    .then((res) => {
      all.push.apply(all, res.data);
      return res.data.length === 20 ? step() : all;
    });
  return step().then(() => {
    const days = {};
    let photos = 0;
    all.forEach((f) => {
      days[f.date] = true;
      photos += (f.photos || []).length;
    });
    return { days: Object.keys(days).length, footprints: all.length, photos };
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
    return Promise.resolve({ avatarUrl: u.avatarUrl, nickname: u.nickname, customTags: u.customTags || [] });
  }
  return db().collection(USER_COLLECTION).limit(1).get().then((res) => {
    const u = res.data[0] || {};
    return { avatarUrl: u.avatarUrl || null, nickname: u.nickname || null, customTags: u.customTags || [] };
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
  stats,
  getProfile
};
