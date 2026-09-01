// detail 足迹详情页（FR-11 全字段展示 + 原比例照片流；FR-12 删除二次确认）
// 读：db.getFootprint 直连；详情图使用 w_1600，点击预览另签原图 URL；最多展示 9 张且顺序不变。
// 删：delFootprint 云函数；失败保留页面原样，1004 视为已删除直接返回。
const db = require('../../utils/db');
const request = require('../../utils/request');
const constants = require('../../utils/constants');
const contentCache = require('../../utils/content-cache');
const drafts = require('../../utils/drafts');
const pendingDeletions = require('../../utils/pending-deletions');
const photoLayout = require('../../utils/photo-layout');

function formatDotDate(value) {
  return String(value || '').replace(/-/g, '.');
}

function cleanRegionName(value) {
  return String(value || '').trim().replace(
    /(壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|自治州|地区|省|市|盟|县|区)$/u,
    ''
  );
}

function buildRegionText(fp) {
  const result = [];
  [fp && fp.province, fp && fp.city, fp && fp.district].forEach((value) => {
    const part = cleanRegionName(value);
    if (part && result.indexOf(part) < 0) result.push(part);
  });
  if (!result.length) {
    const fallback = cleanRegionName(fp && fp.cityLabel);
    if (fallback) result.push(fallback);
  }
  return result.join(' · ');
}

function buildBelongingText(fp) {
  return cleanRegionName(fp && (fp.belongingArea || fp.cityLabel || fp.city || fp.province));
}

function hasValidCoordinates(fp) {
  if (!fp || fp.lat === null || fp.lat === undefined || fp.lat === '' ||
      fp.lng === null || fp.lng === undefined || fp.lng === '') return false;
  const lat = Number(fp.lat);
  const lng = Number(fp.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function uniqueKeys(keys) {
  return keys.filter((key, index) => key && keys.indexOf(key) === index);
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject });
  });
}

function emptyPhotoPatch() {
  return {
    photoUrls: [],
    photoPreviewUrls: [],
    photoLoading: false,
    photoFailed: false,
    mainPhoto: null,
    stackPhotos: [],
    photoLeft: [],
    photoRight: []
  };
}

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
    networkError: false,
    fp: null,
    dateText: '',
    regionText: '',
    belongingText: '',
    auxiliaryText: '',
    photoCount: 0,
    photoCountText: '',
    hasCoordinates: false,
    photoUrls: [],
    photoPreviewUrls: [],
    photoLoading: false,
    photoFailed: false,
    mainPhoto: null,
    stackPhotos: [],
    photoLeft: [],
    photoRight: [],
    deleting: false,
    editFailed: false,
    editDraftId: '',
    editError: ''
  },

  onLoad(options) {
    this.fpId = options && options.id;
    this.loadedOnce = false;
    this._photoVersion = 0;
    this._layoutVersion = 0;
    this._photoItems = [];
    if (!this.fpId) {
      this.setData(Object.assign({ loading: false, notFound: true }, emptyPhotoPatch()));
      return;
    }
    this.loadDetail();
  },

  onShow() {
    // 编辑返回后刷新：重新取记录并重签 URL（签名 URL 1 小时过期，契约 §3.3 重进重签）。
    if (this.loadedOnce) this.loadDetail();
  },

  loadDetail(options) {
    this.setData({ loading: !this.data.fp, photoFailed: false, networkError: false });
    db.getFootprint(this.fpId, options)
      .then((fp) => {
        this.loadedOnce = true;
        if (!fp) {
          this._photoVersion += 1;
          this._photoItems = [];
          this.setData(Object.assign({ loading: false, notFound: true, fp: null }, emptyPhotoPatch()));
          return;
        }
        const displayFp = this.mergeEditDraftPhotos(fp);
        const photoCount = Math.min((displayFp.photos || []).length, photoLayout.MAX_DETAIL_PHOTOS);
        const regionText = buildRegionText(displayFp);
        const belongingText = buildBelongingText(displayFp);
        const auxiliaryParts = [];
        if (photoCount) auxiliaryParts.push(photoCount + ' 张照片');
        if (belongingText) auxiliaryParts.push('足迹归属：' + belongingText);
        this.setData({
          loading: false,
          notFound: false,
          fp,
          dateText: formatDotDate(fp.date),
          regionText,
          belongingText,
          auxiliaryText: auxiliaryParts.join(' · '),
          photoCount,
          photoCountText: photoCount + ' 张',
          hasCoordinates: hasValidCoordinates(fp)
        });
        this.refreshEditDraftBadge();
        this.signPhotos(displayFp);
      })
      .catch((err) => {
        this.loadedOnce = true;
        this._photoVersion += 1;
        this._photoItems = [];
        this.setData(Object.assign({
          loading: false,
          networkError: !!(err && err.network),
          notFound: !(err && err.network),
          fp: null
        }, emptyPhotoPatch()));
      });
  },

  onRetryLoad() {
    this.loadDetail({ force: true });
  },

  refreshEditDraftBadge() {
    const hit = drafts.listAll().find((d) => d.editId === this.fpId && d.status === 'failed') || null;
    this.setData({
      editFailed: !!hit,
      editDraftId: hit ? hit.id : '',
      editError: hit ? (hit.error || '') : ''
    });
  },

  // 编辑链进行中时立即展示编辑草稿照片；旧图沿用已落库的尺寸，新图直接读取本地临时图尺寸。
  mergeEditDraftPhotos(fp) {
    const draft = drafts.listAll().find((d) => d.editId === this.fpId && d.status === 'syncing');
    if (!draft || !Array.isArray(draft.photos)) return fp;
    const oldPhotos = fp.photos || [];
    return Object.assign({}, fp, {
      photos: draft.photos.map((p) => {
        if (!p.isOld) {
          return { key: '', url: p.tempFilePath, width: p.width, height: p.height };
        }
        const stored = oldPhotos.find((item) => item && item.key === p.key) || {};
        return Object.assign({}, stored, { key: p.key });
      })
    });
  },

  onRetryEdit() {
    if (!this.data.editDraftId) return;
    getApp().globalData.restoreEditDraftId = this.data.editDraftId;
    wx.switchTab({ url: '/pages/add/add' });
  },

  signKeys(keys, process) {
    if (!keys.length) return Promise.resolve([]);
    return request.callFunction('ossSts', {
      action: 'sign',
      items: keys.map((key) => (process ? { key, process } : { key }))
    }).then((data) => (data && data.urls) || []);
  },

  // 页面图签 w_1600，图片预览另签无 process 的原图 URL；两组 URL 均与 photos 保持同序。
  signPhotos(fp) {
    const photos = (fp.photos || []).slice(0, photoLayout.MAX_DETAIL_PHOTOS);
    const version = ++this._photoVersion;
    this._photoItems = [];
    if (!photos.length) {
      this.setData(emptyPhotoPatch());
      return;
    }

    const localUrls = photos.map((photo) => (photo && photo.url ? photo.url : ''));
    const keys = uniqueKeys(photos.map((photo) => (photo && photo.key) || ''));
    const displayByKey = {};
    const previewByKey = {};
    keys.forEach((key) => {
      const display = contentCache.getSigned(constants.PROCESS_FULL, key);
      const original = contentCache.getSigned(constants.PROCESS_ORIGINAL, key);
      if (display) displayByKey[key] = display.url;
      if (original) previewByKey[key] = original.url;
    });

    const makeDisplayUrls = () => photos.map((photo, index) => (
      photo && photo.key ? (displayByKey[photo.key] || '') : localUrls[index]
    ));
    const makePreviewUrls = () => photos.map((photo, index) => {
      if (!photo || !photo.key) return localUrls[index];
      return previewByKey[photo.key] || displayByKey[photo.key] || '';
    });
    const needDisplay = keys.filter((key) => !displayByKey[key]);
    const needPreview = keys.filter((key) => !previewByKey[key]);

    const finishDisplay = () => {
      if (version !== this._photoVersion) return;
      const urls = makeDisplayUrls();
      this.setData({
        photoUrls: urls,
        photoPreviewUrls: makePreviewUrls(),
        photoLoading: false,
        photoFailed: urls.some((url) => !url)
      });
      this.preparePhotoLayout(photos, urls, version);
    };

    this.setData(Object.assign({}, emptyPhotoPatch(), {
      photoUrls: makeDisplayUrls(),
      photoPreviewUrls: makePreviewUrls(),
      photoLoading: needDisplay.length > 0
    }));

    if (needDisplay.length) {
      this.signKeys(needDisplay, constants.PROCESS_FULL)
        .then((signed) => {
          contentCache.setSignedMany(constants.PROCESS_FULL, signed);
          signed.forEach((item) => { displayByKey[item.key] = item.url; });
        })
        .catch(() => {})
        .then(finishDisplay);
    } else {
      finishDisplay();
    }

    if (needPreview.length) {
      this.signKeys(needPreview, constants.PROCESS_ORIGINAL)
        .then((signed) => {
          contentCache.setSignedMany(constants.PROCESS_ORIGINAL, signed);
          signed.forEach((item) => { previewByKey[item.key] = item.url; });
          if (version === this._photoVersion) {
            this.setData({ photoPreviewUrls: makePreviewUrls() });
          }
        })
        .catch(() => {});
    }
  },

  preparePhotoLayout(photos, urls, photoVersion) {
    const layoutVersion = ++this._layoutVersion;
    const tasks = photos.map((photo, index) => {
      const url = urls[index] || '';
      const width = Number(photo && photo.width);
      const height = Number(photo && photo.height);
      const createItem = (w, h) => ({
        index,
        url,
        width: w > 0 ? w : 4,
        height: h > 0 ? h : 3,
        ratio: w > 0 && h > 0 ? w / h : 4 / 3,
        failed: !url,
        ariaLabel: '第 ' + (index + 1) + ' 张照片'
      });
      if (width > 0 && height > 0) return Promise.resolve(createItem(width, height));
      if (!url) return Promise.resolve(createItem(4, 3));
      return getImageInfo(url)
        .then((info) => createItem(Number(info.width), Number(info.height)))
        .catch(() => createItem(4, 3));
    });

    Promise.all(tasks).then((items) => {
      if (photoVersion !== this._photoVersion || layoutVersion !== this._layoutVersion) return;
      this.applyPhotoLayout(items);
    });
  },

  applyPhotoLayout(items) {
    const layout = photoLayout.buildPhotoLayout(items);
    this._photoItems = layout.items;
    this.setData({
      mainPhoto: layout.mainPhoto,
      stackPhotos: layout.stackPhotos,
      photoLeft: layout.photoLeft,
      photoRight: layout.photoRight,
      photoFailed: layout.items.some((item) => item.failed)
    });
  },

  onPhotoLoad(e) {
    const index = Number(e.currentTarget.dataset.index);
    const detail = e.detail || {};
    const width = Number(detail.width);
    const height = Number(detail.height);
    if (!(width > 0 && height > 0)) return;
    let changed = false;
    const next = this._photoItems.map((item) => {
      if (item.index !== index) return item;
      const ratio = width / height;
      if (Math.abs(item.ratio - ratio) < 0.01 && !item.failed) return item;
      changed = true;
      return Object.assign({}, item, { width, height, ratio, failed: false });
    });
    if (changed) this.applyPhotoLayout(next);
  },

  onPhotoError(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.applyPhotoLayout(this._photoItems.map((item) => (
      item.index === index ? Object.assign({}, item, { failed: true }) : item
    )));
  },

  onPreviewPhoto(e) {
    const index = Number(e.currentTarget.dataset.index);
    const merged = this.data.photoPreviewUrls.map((url, i) => url || this.data.photoUrls[i] || '');
    const current = merged[index];
    const urls = merged.filter(Boolean);
    if (!current || !urls.length) {
      wx.showToast({ title: '照片加载失败', icon: 'none' });
      return;
    }
    wx.previewImage({ current, urls });
  },

  onViewMap() {
    if (!this.data.hasCoordinates || !this.data.fp) return;
    getApp().globalData.focusMapFootprintId = this.fpId;
    wx.switchTab({ url: '/pages/map/map' });
  },

  onEdit() {
    if (!this.data.fp) return;
    getApp().globalData.editFootprintId = this.fpId;
    wx.switchTab({ url: '/pages/add/add' });
  },

  onDelete() {
    if (this.data.deleting || !this.data.fp) return;
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
      db.forgetFootprint(footprintId);
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
