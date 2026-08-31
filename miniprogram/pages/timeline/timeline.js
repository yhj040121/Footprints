// 时间线 tab 页（V1.3）
// 依据：需求 FR-08（时间线/空态/分页）、FR-13（编辑入口）、S8 乐观保存与草稿回滚。
// 契约：§1.3 ossSts.sign 首图缩略图、§2.3 分页 20 条 date desc+createdAt desc。
// V1.3 调整：移除左滑操作层（与长按一并回滚，避免双入口），单条导出/删除入口随之下线；
//          删除入口保留在详情页，单条导出暂未提供 UI（用户拍板"暂不管"）。
const constants = require('../../utils/constants');
const request = require('../../utils/request');
const db = require('../../utils/db');
const drafts = require('../../utils/drafts');
const contentCache = require('../../utils/content-cache');

const STALE_DRAFT_MS = 90 * 1000;

function applyGrouping(list) {
  let prevDate = '';
  list.forEach((item) => {
    item.showDate = item.date !== prevDate;
    prevDate = item.date;
  });
  return list;
}

Page({
  data: {
    list: [],
    hasMore: true,
    loading: true,
    loadingMore: false,
    loginError: false
  },

  onLoad() {
    this._loadedOnce = false;
    this._coverCache = {};
    this.loadFirst();
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(0);
    if (this._loadedOnce) this.loadFirst();
  },

  onPullDownRefresh() {
    db.invalidateFootprintsCache();
    this.loadFirst({ force: true }).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    const d = this.data;
    if (d.loading || d.loadingMore || !d.hasMore || d.loginError) return;
    this.setData({ loadingMore: true });
    const cloudCount = d.list.filter((it) => !it.isDraft).length;
    db.listFootprintsPage(cloudCount, constants.PAGE_SIZE)
      .then((res) => {
        const added = this.attachEditDrafts(this.decorateList(res.list));
        const base = d.list.filter((it) => !it.isDraft);
        const list = applyGrouping(base.concat(added));
        this.setData({ list, hasMore: res.hasMore, loadingMore: false });
        this.signCovers(added);
      })
      .catch(() => {
        this.setData({ loadingMore: false });
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  loadFirst(options) {
    const app = getApp();
    this.setData({ loading: this.data.list.length === 0, loginError: false });
    return Promise.resolve(app.globalData.loginReady)
      .then(() => {
        this._coverCache = Object.assign({}, contentCache.getSignedMap(constants.PROCESS_THUMB), this._coverCache);
        return db.listFootprintsPage(0, constants.PAGE_SIZE, options);
      })
      .then((res) => {
        const list = this.mergeDrafts(this.attachEditDrafts(this.decorateList(res.list)));
        this._loadedOnce = true;
        this.setData({ list, hasMore: res.hasMore, loading: false });
        this.signCovers(list.filter((it) => !it.isDraft));
      })
      .catch(() => {
        this.setData({ loading: false, loginError: true, list: [] });
      });
  },

  onRetryLogin() {
    const app = getApp();
    if (app.globalData.loginFailed && app.relogin) app.relogin();
    this.loadFirst({ force: true });
  },

  decorateList(records) {
    return records.map((rec) => {
      const coverKey = rec.photos && rec.photos.length ? rec.photos[0].key : '';
      const cached = coverKey ? this._coverCache[coverKey] : null;
      const validCover = cached && cached.expireAt > Date.now() + 60000;
      return Object.assign({}, rec, {
        coverKey,
        coverUrl: validCover ? cached.url : '',
        dateYear: (rec.date || '').slice(0, 4),
        dateMd: (rec.date || '').slice(5).replace('-', '.'),
        showDate: false,
        isDraft: false,
        draftStatus: '',
        createdAtTs: this.createdAtTs(rec)
      });
    });
  },

  decorateDraft(d) {
    const photos = d.photos || [];
    const first = photos[0];
    return Object.assign({}, {
      _id: d.id,
      date: d.date,
      place: d.place,
      lat: d.lat,
      lng: d.lng,
      note: d.note || '',
      tags: d.tags || [],
      photos: photos.map((p) => ({ key: '', url: p.tempFilePath })),
      coverKey: '',
      coverUrl: first && first.tempFilePath ? first.tempFilePath : '',
      dateYear: (d.date || '').slice(0, 4),
      dateMd: (d.date || '').slice(5).replace('-', '.'),
      showDate: false,
      isDraft: true,
      draftStatus: d.status || 'syncing',
      draftError: d.error || '',
      createdAtTs: d.createdAt || 0
    });
  },

  mergeDrafts(list) {
    this.sweepStaleDrafts();
    const draftsList = drafts.listAll()
      .filter((d) => !d.editId && (d.status === 'syncing' || d.status === 'failed'))
      .map((d) => this.decorateDraft(d));
    if (!draftsList.length) return list;
    const seen = {};
    list.forEach((it) => { seen[it._id] = true; });
    const merged = list.concat(draftsList.filter((d) => !seen[d._id]));
    merged.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAtTs || 0) - (a.createdAtTs || 0);
    });
    return applyGrouping(merged);
  },

  attachEditDrafts(list) {
    this.sweepStaleDrafts();
    const edits = drafts.listAll().filter((d) => d.editId);
    if (!edits.length) return list;
    const byFootprintId = {};
    edits.forEach((d) => { byFootprintId[d.editId] = d; });
    return list.map((it) => {
      const d = byFootprintId[it._id];
      if (!d) return it;
      const patched = Object.assign({}, it, {
        editDraftId: d.id,
        draftStatus: d.status || 'syncing',
        draftError: d.error || ''
      });
      // 编辑链进行中（syncing）：封面立即用编辑草稿的第一张照片，与新增草稿同样乐观展示——
      // 新图直接显示本地临时路径，旧图沿用 key 走签名（未命中缓存时 signCovers 补签），
      // 不等后台审核/提交完成（后台落定后正式记录刷新，封面自然替换）
      if (d.status === 'syncing') {
        const first = (d.photos || [])[0];
        if (first && first.isOld && first.key) {
          const cached = this._coverCache[first.key];
          patched.coverKey = first.key;
          if (cached) patched.coverUrl = cached.url;
          else patched.coverUrl = '';
        } else if (first && first.tempFilePath) {
          patched.coverKey = '';
          patched.coverUrl = first.tempFilePath;
        }
      }
      return patched;
    });
  },

  sweepStaleDrafts() {
    const now = Date.now();
    const list = drafts.listAll();
    let changed = false;
    list.forEach((d) => {
      if (d.status === 'syncing' && now - (d.createdAt || 0) > STALE_DRAFT_MS) {
        d.status = 'failed';
        d.error = d.error || '保存中断，请点击重试';
        changed = true;
      }
    });
    if (changed) drafts.saveAll(list);
  },

  createdAtTs(rec) {
    const t = rec && rec.createdAt;
    if (!t) return 0;
    if (typeof t === 'number') return t;
    if (t.$date) return t.$date;
    return new Date(t).getTime() || 0;
  },

  signCovers(items) {
    const now = Date.now();
    const needMap = {};
    items.forEach((it) => {
      if (!it.coverKey) return;
      const cached = this._coverCache[it.coverKey];
      if (cached && cached.expireAt > now + 60000) return;
      needMap[it.coverKey] = true;
    });
    const keys = Object.keys(needMap);
    if (!keys.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: keys.map((key) => ({ key, process: constants.PROCESS_THUMB }))
    }).then((data) => {
      const urls = (data && data.urls) || [];
      urls.forEach((u) => {
        this._coverCache[u.key] = { url: u.url, expireAt: u.expireAt || 0 };
      });
      contentCache.setSignedMany(constants.PROCESS_THUMB, urls);
      this.applyCovers();
    }).catch(() => {});
  },

  applyCovers() {
    const patch = {};
    this.data.list.forEach((it, i) => {
      if (!it.coverKey) return;
      const cached = this._coverCache[it.coverKey];
      const url = cached ? cached.url : '';
      if (url !== it.coverUrl) patch['list[' + i + '].coverUrl'] = url;
    });
    if (Object.keys(patch).length) this.setData(patch);
  },


  // 页面空白点击：关闭展开状态（V1.3 已无左滑/长按，保留为空操作以防误触穿透）
  onListTap() {},

  onGoAdd() {
    wx.switchTab({ url: '/pages/add/add' });
  },

  onCardTap(e) {
    const id = e.detail.id;
    const item = this.data.list.find((it) => it._id === id);
    if (e.detail.isDraft || (item && item.isDraft) || drafts.get(id)) {
      getApp().globalData.restoreDraftId = id;
      wx.switchTab({ url: '/pages/add/add' });
      return;
    }
    if (item && item.editDraftId && item.draftStatus === 'failed') {
      getApp().globalData.restoreEditDraftId = item.editDraftId;
      wx.switchTab({ url: '/pages/add/add' });
      return;
    }
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  }
});
