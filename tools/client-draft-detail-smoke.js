// 发布草稿详情回归：发布后立刻点卡片必须同步展示本地内容；审核失败可修改；
// 点击与后台成功交错时，draftId 必须无缝映射到正式 footprintId。
const assert = require('assert');

const storage = {};
let lastNavigation = '';
let currentPages = [];
const app = {
  globalData: {
    openid: 'draft_detail_smoke_openid',
    loginReady: Promise.resolve(),
    profile: null
  }
};

global.wx = {
  getStorageSync(key) { return storage[key]; },
  setStorageSync(key, value) { storage[key] = value; },
  removeStorageSync(key) { delete storage[key]; },
  navigateTo({ url }) { lastNavigation = url; },
  switchTab({ url }) { lastNavigation = url; },
  showToast() {},
  getImageInfo() {},
  cloud: {
    database() {
      return {
        collection() {
          return {
            where() { return this; },
            limit() { return this; },
            get() { return Promise.resolve({ data: [] }); }
          };
        }
      };
    }
  }
};
global.getApp = () => app;
global.getCurrentPages = () => currentPages;

let timelineDefinition = null;
global.Page = (definition) => { timelineDefinition = definition; };
require('../miniprogram/pages/timeline/timeline');

let detailDefinition = null;
global.Page = (definition) => { detailDefinition = definition; };
require('../miniprogram/pages/detail/detail');
delete global.Page;

const drafts = require('../miniprogram/utils/drafts');
const save = require('../miniprogram/pages/add/save');

function makeDraft(id) {
  return {
    id,
    clientSaveId: 'client_' + id,
    status: 'syncing',
    createdAt: Date.now(),
    date: '2026-09-02',
    place: '西湖断桥',
    lat: 30.258,
    lng: 120.149,
    address: '浙江省杭州市西湖区',
    province: '浙江省',
    city: '杭州市',
    district: '西湖区',
    cityLabel: '杭州',
    note: '发布后立刻可见',
    tags: [],
    photos: [{
      photoId: 'photo_' + id,
      tempFilePath: 'wxfile://local-' + id + '.jpg',
      width: 1200,
      height: 800,
      status: 'ready'
    }]
  };
}

function makeDetailContext(draftId) {
  return Object.assign({}, detailDefinition, {
    data: Object.assign({}, detailDefinition.data),
    draftId,
    fpId: '',
    loadedOnce: false,
    _photoVersion: 0,
    _layoutVersion: 0,
    _loadSeq: 0,
    _photoItems: [],
    setData(patch) { Object.assign(this.data, patch); },
    signPhotos(fp) { this.renderedPhotos = fp.photos; }
  });
}

(() => {
  const draft = makeDraft('draft_immediate');
  drafts.upsert(draft);

  // 时间线不再拦截「审核中」卡片，而是进入本地草稿详情。
  timelineDefinition.onCardTap.call({
    data: { list: [{ _id: draft.id, isDraft: true, draftStatus: 'syncing' }] }
  }, { detail: { id: draft.id, isDraft: true } });
  assert.strictEqual(lastNavigation, '/pages/detail/detail?draftId=' + draft.id);

  // 详情不发数据库请求，立即用保存瞬间的本地快照渲染完整文字和照片。
  const detail = makeDetailContext(draft.id);
  detail.loadDraftDetail();
  assert.strictEqual(detail.data.loading, false);
  assert.strictEqual(detail.data.notFound, false);
  assert.strictEqual(detail.data.fp.place, draft.place);
  assert.strictEqual(detail.data.fp.note, draft.note);
  assert.strictEqual(detail.data.photoUrls === undefined, false);
  assert.strictEqual(detail.renderedPhotos[0].url, draft.photos[0].tempFilePath);
  assert.strictEqual(detail.data.publishState, 'syncing');

  // 审核失败后内容不消失，并明确引导回表单修改。
  draft.status = 'failed';
  draft.error = '照片未通过审核';
  drafts.upsert(draft);
  detail.loadDraftDetail();
  assert.strictEqual(detail.data.fp.note, draft.note);
  assert.strictEqual(detail.data.publishState, 'failed');
  assert.ok(detail.data.publishStatusText.includes('请在 3 小时内修改'));
  detail.onPublishStateTap();
  assert.strictEqual(app.globalData.restoreDraftId, draft.id);
  assert.strictEqual(lastNavigation, '/pages/add/add');
  detail.onUnload();

  // 成功映射会让尚未刷新的旧卡片/刚打开的详情切到正式记录，不落入空态。
  drafts.markPublished(draft.id, 'fp_official');
  let transitionedTo = '';
  detailDefinition.loadDraftDetail.call({
    draftId: draft.id,
    onDraftPublished(footprintId) { transitionedTo = footprintId; }
  });
  assert.strictEqual(transitionedTo, 'fp_official');

  // 详情已经打开时，保存链成功会主动通知该页原地切换。
  const liveDraft = makeDraft('draft_live');
  drafts.upsert(liveDraft);
  let liveTransition = '';
  currentPages = [{
    route: 'pages/detail/detail',
    draftId: liveDraft.id,
    onDraftPublished(footprintId) { liveTransition = footprintId; }
  }];
  save.finishDraft.call({ _reviewSubmitAt: {} }, {
    draftId: liveDraft.id,
    photoIds: [liveDraft.photos[0].photoId]
  }, { footprintId: 'fp_live' });
  assert.strictEqual(liveTransition, 'fp_live');
  assert.strictEqual(drafts.get(liveDraft.id).status, 'published');

  // 失败保留期从实际失败时刻计算；满三小时由任意一次读取同步清出本地存储。
  const activeFailed = makeDraft('draft_failed_active');
  activeFailed.status = 'failed';
  activeFailed.failedAt = Date.now() - drafts.FAILED_TTL_MS + 1000;
  drafts.upsert(activeFailed);
  assert.ok(drafts.get(activeFailed.id), '未满三小时的失败记录必须保留');

  const expiredFailed = makeDraft('draft_failed_expired');
  expiredFailed.status = 'failed';
  expiredFailed.failedAt = Date.now() - drafts.FAILED_TTL_MS;
  drafts.upsert(expiredFailed);
  assert.strictEqual(drafts.get(expiredFailed.id), null, '满三小时的失败记录必须自动清理');

  // 兼容升级前没有 failedAt 的失败草稿：用 createdAt 估算三小时期限。
  const legacyFailed = makeDraft('draft_failed_legacy');
  legacyFailed.status = 'failed';
  legacyFailed.createdAt = Date.now() - drafts.FAILED_TTL_MS - 1;
  drafts.upsert(legacyFailed);
  assert.strictEqual(drafts.get(legacyFailed.id), null, '旧失败记录也必须按三小时规则清理');

  // 定时器到点后的本地视图清理：新增失败卡片移除，编辑失败只移除徽标，正式记录保留。
  const timeline = Object.assign({}, timelineDefinition, {
    data: {
      list: [
        { _id: expiredFailed.id, date: '2026-09-02', isDraft: true },
        { _id: 'fp_edited', date: '2026-09-01', editDraftId: legacyFailed.id, draftStatus: 'failed' },
        { _id: 'fp_kept', date: '2026-08-31', isDraft: false }
      ]
    },
    setData(patch) { Object.assign(this.data, patch); }
  });
  timeline.removeExpiredDraftsFromView();
  assert.deepStrictEqual(timeline.data.list.map((item) => item._id), ['fp_edited', 'fp_kept']);
  assert.strictEqual(timeline.data.list[0].draftStatus, '');
  assert.strictEqual(timeline.data.list[0].editDraftId, '');

  // 新产生的失败记录必须落准确 failedAt，不能从最初点击发布时间起算。
  const newlyFailed = makeDraft('draft_failed_timestamp');
  newlyFailed.createdAt = Date.now() - 60 * 60 * 1000;
  drafts.upsert(newlyFailed);
  const failedBefore = Date.now();
  const originalConsoleError = console.error;
  console.error = () => {};
  currentPages = [];
  save.failDraft.call({ _reviewSubmitAt: {} }, {
    draftId: newlyFailed.id,
    clientSaveId: newlyFailed.clientSaveId,
    photoIds: []
  }, newlyFailed, { code: 2001, message: '内容未通过审核' });
  console.error = originalConsoleError;
  const storedFailure = drafts.get(newlyFailed.id);
  assert.ok(storedFailure.failedAt >= failedBefore);
  assert.ok(storedFailure.failedAt <= Date.now());

  console.log('发布草稿详情回归通过：立即可见、失败保留三小时、成功无缝转正式记录');
})();
