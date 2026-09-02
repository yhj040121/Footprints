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
  assert.ok(detail.data.publishStatusText.includes('请修改内容后重新发布'));
  detail.onPublishStateTap();
  assert.strictEqual(app.globalData.restoreDraftId, draft.id);
  assert.strictEqual(lastNavigation, '/pages/add/add');

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

  console.log('发布草稿详情回归通过：立即可见、失败可修改、成功无缝转正式记录');
})();
