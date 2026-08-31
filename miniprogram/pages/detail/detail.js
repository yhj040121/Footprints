// detail 足迹详情页（FR-11 全字段展示 + 照片预览；FR-12 删除二次确认）
// 读：db.getFootprint 直连（契约 §0.1）；照片 URL：ossSts.sign 运行时按需签发（§1.3，process 白名单 w_1600）
// 删：delFootprint 云函数（§1.4）；失败保留页面原样，1004 视为已删除直接返回（§0.3）
const db = require('../../utils/db');
const request = require('../../utils/request');
const constants = require('../../utils/constants');
const dateUtil = require('../../utils/date');
const contentCache = require('../../utils/content-cache');
const drafts = require('../../utils/drafts');
const pendingDeletions = require('../../utils/pending-deletions');

// 乐观删除状态变化后刷新仍在页面栈中的数据页；不在栈中的页面由各自 onShow 兜底。
function refreshDataPages() {
  try {
    const pages = getCurrentPages() || [];
    pages.forEach((page) => {
      if (!page) return;
      if (page.route === 'pages/timeline/timeline' && typeof page.loadFirst === 'function') {
        page.loadFirst({ force: true });
      } else if (page.route === 'pages/calendar/calendar' && typeof page._loadMonth === 'function') {
        const ym = page._ym();
        if (page._cache) delete page._cache[ym];
        page._loadMonth(ym);
      } else if (page.route === 'pages/map/map' && typeof page.loadRecords === 'function') {
        page.loadRecords(true);
      } else if (page.route === 'pages/export/export' && typeof page.load === 'function') {
        page.load({ force: true });
      } else if (page.route === 'pages/mine/mine' && typeof page.refresh === 'function') {
        page.refresh();
      }
    });
  } catch (e) { /* 页面栈不可用时由 onShow 重新拉取 */ }
}

Page({
  data: {
    loading: true,
    notFound: false,
    networkError: false, // 断网/服务端异常 → 与「记录不存在」区分（S6-R3）
    fp: null,          // footprint 文档
    dateText: '',      // YYYY/MM/DD 大标题
    photoUrls: [],     // 与 fp.photos 同序的签名 URL
    photoFailed: false,
    deleting: false,
    editFailed: false, // 乐观编辑链失败 → 徽标提示，点击恢复编辑表单（S8）
    editDraftId: '',
    editError: ''
  },

  onLoad(options) {
    this.fpId = options && options.id;
    this.loadedOnce = false;
    if (!this.fpId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.loadDetail();
  },

  onShow() {
    // 编辑返回后刷新：重新取记录并重签 URL（签名 URL 1 小时过期，契约 §3.3 重进重签）
    if (this.loadedOnce) {
      this.loadDetail();
    }
  },

  loadDetail(options) {
    this.setData({ loading: !this.data.fp, photoFailed: false, networkError: false });
    db.getFootprint(this.fpId, options)
      .then((fp) => {
        this.loadedOnce = true;
        if (!fp) {
          this.setData({ loading: false, notFound: true, fp: null, photoUrls: [] });
          return;
        }
        this.setData({
          loading: false,
          notFound: false,
          fp,
          dateText: dateUtil.displayDate(fp.date)
        });
        this.refreshEditDraftBadge();
        this.signPhotos(this.mergeEditDraftPhotos(fp));
      })
      .catch((err) => {
        this.loadedOnce = true;
        // 断网/服务端异常：展示「网络错误」而非误报「记录不存在」（S6-R3）
        this.setData({
          loading: false,
          networkError: !!(err && err.network),
          notFound: !(err && err.network),
          fp: null,
          photoUrls: []
        });
      });
  },

  onRetryLoad() {
    this.loadDetail({ force: true });
  },

  // 乐观编辑链失败徽标：本条记录存在 failed 编辑草稿时展示，点击恢复编辑表单重试（S8）
  refreshEditDraftBadge() {
    const hit = drafts.listAll().find((d) => d.editId === this.fpId && d.status === 'failed') || null;
    this.setData({
      editFailed: !!hit,
      editDraftId: hit ? hit.id : '',
      editError: hit ? (hit.error || '') : ''
    });
  },

  // 编辑链进行中（syncing）：详情页立即用编辑草稿的照片列表乐观展示——新图直接显示本地临时路径、
  // 旧图沿用 key 走签名（未命中缓存时 signPhotos 补签），不等后台审核/提交完成；
  // 后台落定后 loadDetail(force) 刷新为正式数据（FR-11 顺序与内容一致）
  mergeEditDraftPhotos(fp) {
    const draft = drafts.listAll().find((d) => d.editId === this.fpId && d.status === 'syncing');
    if (!draft || !draft.photos || !draft.photos.length) return fp;
    return Object.assign({}, fp, {
      photos: draft.photos.map((p) => (p.isOld
        ? { key: p.key }
        : { key: '', url: p.tempFilePath }))
    });
  },

  onRetryEdit() {
    if (!this.data.editDraftId) return;
    getApp().globalData.restoreEditDraftId = this.data.editDraftId;
    wx.switchTab({ url: '/pages/add/add' });
  },

  // 照片列表签名：兼容「key 项（云端照片，签名 URL）」与「本地路径项（编辑乐观图，直显）」混合，
  // 返回的 photoUrls 与 photos 同序（FR-11 验收 2 顺序一致）；本地项不参与签名
  signPhotos(fp) {
    const photos = fp.photos || [];
    const localUrls = photos.map((p) => (p && p.url ? p.url : ''));
    const keys = [];
    const keyIndex = [];
    photos.forEach((p, i) => {
      if (p && p.key) {
        keys.push(p.key);
        keyIndex.push(i);
      }
    });
    if (!keys.length) {
      this.setData({ photoUrls: localUrls, photoFailed: false });
      return;
    }
    const byKey = {};
    keys.forEach((key) => {
      const cached = contentCache.getSigned(constants.PROCESS_FULL, key);
      if (cached) byKey[key] = cached.url;
    });
    const urls = photos.map((p, i) => (p && p.key ? (byKey[p.key] || '') : (localUrls[i] || '')));
    this.setData({ photoUrls: urls, photoFailed: false });
    const need = keys.filter((key) => !byKey[key]);
    if (!need.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: need.map((key) => ({ key, process: constants.PROCESS_FULL }))
    }).then((data) => {
      // 按 photos 原顺序取 url，保证预览左右滑动顺序与记录一致（FR-11 验收 2）
      const signed = (data && data.urls) || [];
      signed.forEach((u) => { byKey[u.key] = u.url; });
      contentCache.setSignedMany(constants.PROCESS_FULL, signed);
      const finalUrls = photos.map((p, i) => (p && p.key ? (byKey[p.key] || '') : (localUrls[i] || '')));
      this.setData({ photoUrls: finalUrls, photoFailed: finalUrls.some((u) => !u) });
    }).catch(() => {
      this.setData({ photoUrls: urls, photoFailed: urls.some((u) => !u) });
    });
  },

  onPreviewPhoto(e) {
    const index = e.currentTarget.dataset.index;
    const current = this.data.photoUrls[index];
    const urls = this.data.photoUrls.filter(Boolean);
    if (!current || !urls.length) {
      wx.showToast({ title: '照片加载失败', icon: 'none' });
      return;
    }
    // FR-11：点第 n 张大图预览，可左右滑全部，顺序与记录一致
    wx.previewImage({ current, urls });
  },

  onEdit() {
    if (!this.data.fp) return;
    // add 是 tab 页，wx.navigateTo 无法进入：globalData 交接 id 后 switchTab，add 页 onShow 读取进入编辑模式（FR-13）
    getApp().globalData.editFootprintId = this.fpId;
    wx.switchTab({ url: '/pages/add/add' });
  },

  onDelete() {
    if (this.data.deleting || !this.data.fp) return;
    // FR-12：二次确认弹窗必须明示「照片将一并删除」
    wx.showModal({
      title: '删除这条足迹？',
      content: '删除后不可恢复，照片将一并删除。',
      confirmText: '删除',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.doDelete();
      }
    });
  },

  // 乐观删除：交互立即完成，delFootprint 两阶段删除在后台推进；失败时再恢复记录。
  // 1004 视为成功；3001/9000/传输异常后台重试，传输终态不明时强制回读裁定。
  doDelete() {
    if (this._deleteStarted) return;
    this._deleteStarted = true;
    const footprintId = this.fpId;
    this.setData({ deleting: true });
    pendingDeletions.mark(footprintId);
    db.invalidateFootprintsCache();
    refreshDataPages();
    wx.showToast({ title: '已删除', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 360);

    let settled = false;
    const success = () => {
      if (settled) return;
      settled = true;
      pendingDeletions.clear(footprintId);
      db.invalidateFootprintsCache();
      refreshDataPages();
    };
    const restore = () => {
      if (settled) return;
      settled = true;
      pendingDeletions.clear(footprintId);
      db.invalidateFootprintsCache();
      refreshDataPages();
      wx.showToast({ title: '删除未完成，记录已恢复', icon: 'none', duration: 4000 });
    };
    // 回读裁定：记录已不在 = 删除成功；仍在或回读失败 = 解除乐观隐藏并恢复。
    const reRead = () => {
      db.getFootprint(footprintId, { force: true })
        .then((fp) => (fp ? restore() : success()))
        .catch(restore);
    };
    const send = (retriesLeft) => {
      request.callFunction('delFootprint', { footprintId })
        .then(success)
        .catch((err) => {
          if (request.isNotFound(err)) return success();
          if ((request.isTransport(err) || request.isRetryable(err)) && retriesLeft > 0) {
            setTimeout(() => send(retriesLeft - 1), 1500);
            return;
          }
          if (request.isTransport(err)) return reRead();
          restore();
        });
    };
    send(3);
  },

  onBack() {
    wx.navigateBack();
  }
});
