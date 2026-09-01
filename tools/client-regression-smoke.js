// 客户端关键回归：近期写入空窗、地图主动刷新、编辑地址字段完整回传。
const assert = require('assert');

const storage = {};
let dbRows = [];
const chain = {
  where() { return this; },
  orderBy() { return this; },
  field() { return this; },
  skip() { return this; },
  limit() { return this; },
  get() { return Promise.resolve({ data: dbRows.slice() }); }
};

global.wx = {
  getStorageSync(key) { return storage[key]; },
  setStorageSync(key, value) { storage[key] = value; },
  removeStorageSync(key) { delete storage[key]; },
  cloud: {
    database() {
      return {
        collection() { return chain; },
        command: {
          exists() { return {}; },
          gte() { return { and() { return {}; } }; }
        }
      };
    }
  }
};

global.getApp = () => ({
  globalData: {
    openid: 'client_smoke_openid',
    loginReady: Promise.resolve(),
    profile: null
  }
});

let currentPages = [];
global.getCurrentPages = () => currentPages;

const db = require('../miniprogram/utils/db');
const save = require('../miniprogram/pages/add/save');
let calendarPage = null;
global.Page = (definition) => { calendarPage = definition; };
require('../miniprogram/pages/calendar/calendar');
delete global.Page;

(async () => {
  const recent = {
    _id: 'fp_recent',
    date: '2026-09-01',
    place: '西塘古镇',
    lat: 30.947,
    lng: 120.889,
    address: '浙江省嘉兴市嘉善县西塘古镇',
    province: '浙江省',
    city: '嘉兴市',
    district: '嘉善县',
    adcode: '330421',
    cityLabel: '嘉兴',
    locationSource: 'choose',
    note: '刚刚发布',
    tags: [],
    photos: [{ url: 'wxfile://recent.jpg' }],
    createdAt: Date.now()
  };

  // 云数据库暂时查无结果时，详情、时间线、地图和统计仍须立即看到近期写入。
  dbRows = [];
  db.rememberFootprint(recent);
  const detail = await db.getFootprint(recent._id, { force: true });
  assert.strictEqual(detail && detail._id, recent._id);
  assert.strictEqual(detail.address, recent.address);

  const firstPage = await db.listFootprintsPage(0, 20, { force: true });
  assert.strictEqual(firstPage.list.length, 1);
  assert.strictEqual(firstPage.cloudCount, 0);

  const mapList = await db.listWithLocation({ force: true });
  assert.strictEqual(mapList.length, 1);
  assert.strictEqual(mapList[0]._id, recent._id);

  const summary = await db.stats({ force: true });
  assert.deepStrictEqual(summary, { days: 1, footprints: 1, photos: 1 });

  // 新记录处于近期写入阶段时只有本地 url，日历格子和当日卡片也必须立即显示首图。
  const calendarContext = {
    data: {
      cells: [{ date: recent.date, inMonth: true }],
      selectedDate: recent.date,
      dayRecords: []
    },
    setData(patch) { Object.assign(this.data, patch); }
  };
  const calendarEntry = calendarPage._buildEntry.call(calendarContext, [recent]);
  calendarPage._paint.call(calendarContext, calendarEntry, false);
  calendarPage._renderDayList.call(calendarContext, calendarEntry);
  assert.strictEqual(calendarContext.data.cells[0].thumb, 'wxfile://recent.jpg');
  assert.strictEqual(calendarContext.data.cells[0].loading, false);
  assert.strictEqual(calendarContext.data.dayRecords[0].coverUrl, 'wxfile://recent.jpg');

  // 新照片的正式 key 无法由客户端预知：客户端数据库即使短暂返回旧快照，也不能覆盖本地新图。
  dbRows = [Object.assign({}, recent, { photos: [{ key: 'travel/2026/09/01/aaaaaaaaaaaaaaaa.jpg' }] })];
  const official = await db.getFootprint(recent._id, { force: true });
  assert.strictEqual(official.photos[0].url, 'wxfile://recent.jpg');

  // 编辑快照必须完整携带地址组，提交时即使无坐标也要显式传 null，不能把旧值意外清空。
  const page = {
    data: {
      date: recent.date,
      place: recent.place,
      note: recent.note,
      address: recent.address,
      province: recent.province,
      city: recent.city,
      district: recent.district,
      adcode: recent.adcode,
      cityLabel: recent.cityLabel,
      locationSource: recent.locationSource,
      photos: [{ uid: 1, key: 'travel/2026/09/01/aaaaaaaaaaaaaaaa.jpg', isOld: true }]
    },
    _lat: null,
    _lng: null,
    _origin: Object.assign({}, recent),
    _removedKeys: []
  };
  const snap = save.buildEditSnapshot.call(page);
  assert.strictEqual(snap.address, recent.address);
  assert.strictEqual(snap.origin.cityLabel, recent.cityLabel);

  let payload = null;
  await save.runEditSave.call({
    throwIfCancelled() {},
    commitEditSnap(next) { payload = next; return Promise.resolve(true); },
    issueAndUpload() { throw new Error('不应上传旧照片'); },
    submitReviews() { throw new Error('不应审核旧照片'); },
    startPollReviews() { throw new Error('不应轮询旧照片'); }
  }, {}, snap);
  assert.strictEqual(payload.lat, null);
  assert.strictEqual(payload.lng, null);
  assert.strictEqual(payload.address, recent.address);
  assert.strictEqual(payload.province, recent.province);
  assert.strictEqual(payload.locationSource, recent.locationSource);

  // 编辑落定必须主动刷新时间线、地图与当前详情。
  const calls = { timeline: 0, map: 0, detail: 0 };
  const mapPage = { route: 'pages/map/map', loadRecords(keepView) { assert.strictEqual(keepView, true); calls.map++; } };
  currentPages = [
    { route: 'pages/timeline/timeline', loadFirst(options) { assert.strictEqual(options.force, true); calls.timeline++; } },
    mapPage,
    { route: 'pages/detail/detail', fpId: recent._id, loadDetail(options) { assert.strictEqual(options.force, true); calls.detail++; } }
  ];
  save.finishEdit.call({ _editChains: {}, _reviewSubmitAt: {} }, {
    editId: recent._id,
    draftId: 'edit_regression',
    photoIds: []
  });
  assert.deepStrictEqual(calls, { timeline: 1, map: 1, detail: 1 });
  assert.strictEqual(mapPage._pendingFocusId, recent._id);

  calls.timeline = 0;
  calls.map = 0;
  calls.detail = 0;
  save.finishDraft.call({ _reviewSubmitAt: {} }, {
    draftId: 'draft_regression',
    photoIds: []
  }, { footprintId: recent._id });
  assert.deepStrictEqual(calls, { timeline: 1, map: 1, detail: 0 });
  assert.strictEqual(mapPage._pendingFocusId, recent._id);

  db.rememberFootprint(recent);
  db.forgetFootprint(recent._id);
  db.invalidateFootprintsCache();
  dbRows = [];
  assert.strictEqual(await db.getFootprint(recent._id, { force: true }), null);

  console.log('客户端回归通过：近期写入、日历本地图、地图刷新、编辑地址字段');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
