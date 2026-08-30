// 时间线 tab 页（index 0）
// 依据：需求 FR-08（时间线/左滑/空态/分页）、FR-12（删除二次确认）、FR-15②（单条导出）
// 契约：§1.3 ossSts.sign、§1.4 delFootprint、§2.3 分页 20 条 date desc+createdAt desc、§6 定值
const constants = require('../../utils/constants');
const config = require('../../utils/config');
const request = require('../../utils/request');
const db = require('../../utils/db');
const drafts = require('../../utils/drafts');
const contentCache = require('../../utils/content-cache');

const ACTION_WIDTH_RPX = 300; // 左滑展开操作区宽：「导出」「删除」各约 150rpx
const INK_COLOR = '#35322C';  // 弹窗确认按钮墨色（对齐色板 --color-action-bg）
const STALE_DRAFT_MS = 90 * 1000; // 后台链路中断（杀进程/切后台挂起）：syncing 草稿超过该时长标 failed

// 同日分组：同一天只在第一条左侧显示日期（就地修改 list）
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
    list: [],            // footprint + 展示字段（coverKey/coverUrl/showDate/dateYear/dateMd/offsetX/animating）
    hasMore: true,
    loading: true,       // 首屏加载中
    loadingMore: false,  // 触底追加中
    loginError: false,   // 登录/首屏加载失败 → 「网络不可用」重试态（FR-01 验收 4）
    expandedId: '',      // 当前左滑展开的记录 id（同时最多一条）
    // 导出进度弹层（FR-15②）
    exportVisible: false,
    exportPhase: 'running', // running | summary
    exportText: '',
    exportFailedCount: 0
  },

  onLoad() {
    this._loadedOnce = false;
    this._coverCache = {};   // key → { url, expireAt }，避免重复签（签名有效期 1h，临期重签）
    this._touch = null;
    this._exportCtx = null;
    this._failedUrls = [];
    this._cardWidth = 0;
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this._actionPx = Math.round((ACTION_WIDTH_RPX / 750) * info.windowWidth);
    this._cardWidthFallback = info.windowWidth * 0.75;
    this.loadFirst();
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(0);
    // 非首次进入（从详情/新增返回）时刷新第一页
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
    // 分页 offset 按已加载的「云端记录」计数（草稿不入云、不计入 skip，避免因草稿混排导致的偏移漏数据）
    const cloudCount = d.list.filter((it) => !it.isDraft).length;
    db.listFootprintsPage(cloudCount, constants.PAGE_SIZE)
      .then((res) => {
        const added = this.attachEditDrafts(this.decorateList(res.list));
        // 追加云端页：草稿仅在首屏 mergeDrafts 合并，追加页不重新混排（避免草稿重复/排序抖动）
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

  // ---------- load ----------

  loadFirst(options) {
    const app = getApp();
    // 已有内容时静默刷新，避免切换 tab 出现整页骨架闪烁。
    this.setData({ loading: this.data.list.length === 0, loginError: false });
    return Promise.resolve(app.globalData.loginReady)
      .then(() => {
        this._coverCache = Object.assign({}, contentCache.getSignedMap(constants.PROCESS_THUMB), this._coverCache);
        return db.listFootprintsPage(0, constants.PAGE_SIZE, options);
      })
      .then((res) => {
        const list = this.mergeDrafts(this.attachEditDrafts(this.decorateList(res.list)));
        this._loadedOnce = true;
        this.setData({ list, hasMore: res.hasMore, loading: false, expandedId: '' });
        this.measureCard();
        this.signCovers(list.filter((it) => !it.isDraft));
      })
      .catch(() => {
        // 登录失败或首屏查询失败：统一给「网络不可用」重试入口，不白屏
        this.setData({ loading: false, loginError: true, list: [] });
      });
  },

  onRetryLogin() {
    const app = getApp();
    if (app.globalData.loginFailed && app.relogin) app.relogin(); // loadFirst 会 await 新的 loginReady
    this.loadFirst({ force: true });
  },

  // 记录 → 列表条目（补展示字段；封面 URL 命中缓存则直接回填）
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
        offsetX: 0,
        animating: false,
        isDraft: false,
        draftStatus: '',
        createdAtTs: this.createdAtTs(rec)
      });
    });
  },

  // 草稿 → 列表条目（isDraft 标识；封面用本地 tempFilePath 直接展示，不参与 sign）
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
      offsetX: 0,
      animating: false,
      isDraft: true,
      draftStatus: d.status || 'syncing',
      draftError: d.error || '',
      createdAtTs: d.createdAt || 0
    });
  },

  // 把本人草稿（syncing/failed）并入首屏列表，统一按 date desc, createdAt desc 排序（与云端口径一致）
  // 编辑草稿（带 editId）不单独成卡：失败状态由 attachEditDrafts 挂到对应记录上
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
    // 排序后重新归组（草稿与记录混排，日期归属需重建）
    return applyGrouping(merged);
  },

  // 编辑草稿（乐观编辑链）状态挂到对应记录上：syncing 无表现；failed 由卡片徽标提示，
  // 点击卡片恢复编辑表单重试。编辑中的记录仍按云端（旧）内容展示
  attachEditDrafts(list) {
    this.sweepStaleDrafts();
    const edits = drafts.listAll().filter((d) => d.editId);
    if (!edits.length) return list;
    const byFootprintId = {};
    edits.forEach((d) => { byFootprintId[d.editId] = d; });
    return list.map((it) => {
      const d = byFootprintId[it._id];
      if (!d) return it;
      return Object.assign({}, it, {
        editDraftId: d.id,
        draftStatus: d.status || 'syncing',
        draftError: d.error || ''
      });
    });
  },

  // 后台链路中断（杀进程/切后台挂起）：把超过阈值的 syncing 草稿标记为 failed，供用户点击处理
  sweepStaleDrafts() {
    const now = Date.now();
    const list = drafts.listAll(); // 单个引用：就地修改后统一写回（listAll 每次深拷贝，需复用同一数组）
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

  // 统一取 createdAt 时间戳（云端 serverDate 可能是 $date / Date / number）
  createdAtTs(rec) {
    const t = rec && rec.createdAt;
    if (!t) return 0;
    if (typeof t === 'number') return t;
    if (t.$date) return t.$date;
    return new Date(t).getTime() || 0;
  },

  // 批量签首图缩略图（契约 §1.3 sign，process=PROCESS_THUMB；一次一页 ≤20 张 <500ms 口径内）
  signCovers(items) {
    const now = Date.now();
    const needMap = {};
    items.forEach((it) => {
      if (!it.coverKey) return;
      const cached = this._coverCache[it.coverKey];
      if (cached && cached.expireAt > now + 60000) return; // 缓存有效（留 60s 余量）
      needMap[it.coverKey] = true;
    });
    const keys = Object.keys(needMap);
    if (!keys.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: keys.map((key) => ({ key, process: constants.PROCESS_THUMB }))
    }).then((data) => {
      const urls = data.urls || [];
      urls.forEach((u) => {
        this._coverCache[u.key] = { url: u.url, expireAt: u.expireAt || 0 };
      });
      contentCache.setSignedMany(constants.PROCESS_THUMB, urls);
      this.applyCovers();
    }).catch(() => {
      // 封面签名失败静默降级：卡片显示「无图」占位，下次进页自动重签
    });
  },

  // 把缓存中的签名 URL 回填到列表条目
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

  measureCard() {
    wx.createSelectorQuery().in(this).select('.swipe-card')
      .boundingClientRect((rect) => {
        if (rect && rect.width) this._cardWidth = rect.width;
      }).exec();
  },

  // ---------- navigate / empty ----------

  onGoAdd() {
    wx.switchTab({ url: '/pages/add/add' });
  },

  onCardTap(e) {
    const id = e.detail.id;
    if (this.data.expandedId) { this.collapseAll(); return; } // 点任意卡片先收起展开项
    // 草稿卡：恢复进表单（无云端记录，不打开详情页）
    const item = this.data.list.find((it) => it._id === id);
    if (e.detail.isDraft || (item && item.isDraft) || drafts.get(id)) {
      getApp().globalData.restoreDraftId = id;
      wx.switchTab({ url: '/pages/add/add' });
      return;
    }
    // 编辑失败的记录：恢复编辑表单重试（乐观编辑链的失败落点，卡片带失败徽标）
    if (item && item.editDraftId && item.draftStatus === 'failed') {
      getApp().globalData.restoreEditDraftId = item.editDraftId;
      wx.switchTab({ url: '/pages/add/add' });
      return;
    }
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  onListTap() {
    if (this.data.expandedId) this.collapseAll(); // 点其他区域收起（FR-08）
  },

  noop() {}, // 遮罩层拦截滚动的空处理器

  // ---------- swipe (FR-08 左滑) ----------

  onTouchStart(e) {
    const ds = e.currentTarget.dataset;
    const t = e.touches[0];
    const item = this.data.list[ds.index];
    if (!item) return;
    if (this.data.expandedId && this.data.expandedId !== ds.id) this.collapseAll();
    this._touch = {
      id: ds.id,
      index: ds.index,
      startX: t.clientX,
      startY: t.clientY,
      base: item.offsetX || 0,
      horizontal: false
    };
    this.setData({ ['list[' + ds.index + '].animating']: false });
  },

  onTouchMove(e) {
    const touch = this._touch;
    if (!touch) return;
    const t = e.touches[0];
    const dx = t.clientX - touch.startX;
    const dy = t.clientY - touch.startY;
    if (!touch.horizontal) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      touch.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!touch.horizontal) { this._touch = null; return; } // 竖向滚动不接管
    }
    let offset = touch.base + dx;
    if (offset > 0) offset = 0;
    if (offset < -this._actionPx) offset = -this._actionPx;
    this.setData({ ['list[' + touch.index + '].offsetX']: offset });
  },

  onTouchEnd() {
    const touch = this._touch;
    this._touch = null;
    if (!touch || !touch.horizontal) return;
    const item = this.data.list[touch.index];
    if (!item) return;
    const threshold = (this._cardWidth || this._cardWidthFallback) / 3; // 阈值 = 卡片宽 1/3
    const open = item.offsetX <= -threshold;
    const patch = {};
    patch['list[' + touch.index + '].offsetX'] = open ? -this._actionPx : 0;
    patch['list[' + touch.index + '].animating'] = true;
    if (open) patch.expandedId = touch.id;
    else if (this.data.expandedId === touch.id) patch.expandedId = '';
    this.setData(patch);
  },

  collapseAll() {
    const patch = { expandedId: '' };
    this.data.list.forEach((it, i) => {
      if (it.offsetX) {
        patch['list[' + i + '].offsetX'] = 0;
        patch['list[' + i + '].animating'] = true;
      }
    });
    this.setData(patch);
  },

  // ---------- delete (FR-12) ----------

  onDeleteTap(e) {
    const id = e.currentTarget.dataset.id;
    this.collapseAll();
    const item = this.data.list.find((it) => it._id === id);
    if (item && item.isDraft) {
      this.confirmRemoveDraft(id);
      return;
    }
    wx.showModal({
      title: '删除足迹',
      content: '删除后不可恢复，照片将一并删除。',
      confirmText: '删除',
      confirmColor: INK_COLOR,
      success: (res) => { if (res.confirm) this.doDelete(id); }
    });
  },

  // 删除本地草稿（S8）：无云端记录，仅清本地 + 列表；调 confirm 后直接删，不走云函数
  confirmRemoveDraft(id) {
    wx.showModal({
      title: '删除草稿',
      content: '该条尚未保存成功，删除后不可恢复。',
      confirmText: '删除',
      confirmColor: INK_COLOR,
      success: (res) => {
        if (!res.confirm) return;
        drafts.remove(id);
        this.removeFromList(id);
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  // §5.4（S6-R4 细化）删除传输异常终态：无应答重发至明确终态；1004 = 已删除成功；3001/9000 可重试；
  // 重试耗尽（3 次，间隔 2s）仍无终态 → 回读：不存在 = 已删除；存在/回读失败 = 「结果未确认」+再试一次
  doDelete(id) {
    wx.showLoading({ title: '删除中', mask: true });
    const finish = () => { wx.hideLoading(); };
    const success = () => {
      finish();
      db.invalidateFootprintsCache();
      this.removeFromList(id);
      wx.showToast({ title: '已删除', icon: 'success' });
    };
    const unconfirmed = () => {
      finish();
      wx.showModal({
        title: '结果未确认',
        content: '删除结果未确认，请再试一次',
        confirmText: '再试一次',
        cancelText: '取消',
        success: (r) => { if (r.confirm) this.doDelete(id); }
      });
    };
    const reRead = () => {
      db.getFootprint(id, { force: true })
        .then((fp) => (fp ? unconfirmed() : success()))
        .catch(() => unconfirmed());
    };
    const send = (retriesLeft) => {
      request.callFunction('delFootprint', { footprintId: id })
        .then(success)
        .catch((err) => {
          if (request.isNotFound(err)) return success(); // 1004：已删除成功（§0.3 / §5.4）
          if (err && err.transport && retriesLeft > 0) { // 无应答：重发到终态（间隔 2s，最多 3 次）
            setTimeout(() => send(retriesLeft - 1), 2000);
            return;
          }
          if (err && err.transport) return reRead(); // 重试耗尽仍无终态 → 回读裁定
          finish();
          let tip = (err && err.message) || '删除失败';
          if (!(err && err.transport) && request.isRetryable(err)) tip += '，请重试';
          wx.showToast({ title: tip, icon: 'none' });
        });
    };
    send(3); // 初始 1 次 + 至多 3 次重试（每次间隔 2s）
  },

  removeFromList(id) {
    const list = this.data.list.filter((it) => it._id !== id);
    applyGrouping(list); // 首条被删后需把日期标到下一条
    this.setData({ list, expandedId: '' });
  },

  // ---------- export (FR-15②) ----------

  onExportTap(e) {
    const id = e.currentTarget.dataset.id;
    this.collapseAll();
    const rec = this.data.list.find((it) => it._id === id);
    if (!rec) return;
    // 草稿未入库：照片尚未转正，无云端 key，无法导出
    if (rec.isDraft) {
      wx.showToast({ title: '草稿保存成功后才能导出', icon: 'none' });
      return;
    }
    const photos = rec.photos || [];
    if (!photos.length) {
      wx.showToast({ title: '该条记录没有照片', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '导出照片',
      content: '将该记录的 ' + photos.length + ' 张照片保存到相册？',
      confirmText: '导出',
      confirmColor: INK_COLOR,
      success: (res) => { if (res.confirm) this.startExport(photos.map((p) => p.key)); }
    });
  },

  startExport(keys) {
    this._exportCtx = { cancelled: false };
    this._failedUrls = [];
    this._exportAgg = { total: keys.length, ok: 0, fail: 0 }; // 整次导出累计上下文（S6-R3）
    this.setData({ exportVisible: true, exportPhase: 'running', exportText: '准备中…', exportFailedCount: 0 });
    request.callFunction('ossSts', {
      action: 'sign',
      items: keys.map((key) => ({ key, process: constants.PROCESS_FULL }))
    }).then((data) => {
      this.runExport((data.urls || []).map((u) => u.url), false);
    }).catch((err) => {
      // 签发失败：全部记未处理，汇总展示错误文案
      this.finishExport([], (err && err.message) || '签发下载地址失败');
    });
  },

  // 累计化导出（S6-R3）：整次导出用 _exportAgg 累计总数/成功/失败；
  // 失败张重试（isRetry）只翻转对应项状态，汇总始终按原总数计算（如「成功 8/失败 0」而非「1/0」）
  runExport(urls, isRetry) {
    const ctx = this._exportCtx;
    const agg = this._exportAgg;
    const batch = urls.length;
    if (isRetry) agg.fail = Math.max(0, agg.fail - batch); // 重试这批此前计失败，先回退再重判

    // mock 降级：USE_MOCK 且 sign 返回本地包路径（/assets/...）时，包内路径无法真实写入相册，
    // 此处按进度口径逐张模拟并全部计成功，便于走通交互；真机联调（USE_MOCK=false）不受影响。
    const mockDegrade = config.USE_MOCK && urls.every((u) => typeof u === 'string' && u.indexOf('/assets/') === 0);
    const failedUrls = [];
    let i = 0;
    const step = () => {
      if (ctx.cancelled || i >= batch) {
        this.finishExport(failedUrls);
        return;
      }
      const url = urls[i];
      i += 1;
      this.setData({ exportText: '正在保存 ' + (agg.ok + agg.fail + 1) + '/' + agg.total });
      const done = () => { agg.ok += 1; step(); };
      const fail = (err) => {
        if (err && err.authDenied) {
          // 相册授权被拒：当前及后续记未处理，引导去设置，不崩溃
          this.finishExport(failedUrls);
          this.guideAlbumSetting();
          return;
        }
        agg.fail += 1;
        failedUrls.push(url);
        step();
      };
      if (mockDegrade) { setTimeout(done, 300); return; }
      this.saveOnePhoto(url).then(done).catch(fail);
    };
    step();
  },

  // 下载 + 写相册；本地路径（mock 已上传文件）跳过 downloadFile 直接保存
  saveOnePhoto(url) {
    return new Promise((resolve, reject) => {
      const save = (filePath) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: (err) => {
            const msg = (err && err.errMsg) || '';
            if (/auth|deny|denied|authorize/.test(msg)) reject({ authDenied: true, errMsg: msg });
            else reject(err);
          }
        });
      };
      if (!/^https?:\/\//.test(url)) { save(url); return; }
      wx.downloadFile({ url, success: (res) => save(res.tempFilePath), fail: reject });
    });
  },

  finishExport(failedUrls, note) {
    this._failedUrls = failedUrls.slice();
    const agg = this._exportAgg;
    const pending = Math.max(0, agg.total - agg.ok - agg.fail);
    this.setData({
      exportPhase: 'summary',
      exportFailedCount: failedUrls.length,
      exportText: '成功 ' + agg.ok + ' / 失败 ' + agg.fail + ' / 未处理 ' + pending + (note ? '（' + note + '）' : '')
    });
  },

  onExportCancel() {
    if (this._exportCtx) this._exportCtx.cancelled = true;
  },

  // 仅重试失败张（FR-15 验收 4）：累计上下文保留，只翻转这部分的状态
  onExportRetry() {
    const urls = this._failedUrls || [];
    if (!urls.length) return;
    this._exportCtx = { cancelled: false };
    this.setData({ exportPhase: 'running', exportFailedCount: 0 });
    this.runExport(urls, true);
  },

  onExportClose() {
    this.setData({ exportVisible: false });
  },

  guideAlbumSetting() {
    wx.showModal({
      title: '需要相册权限',
      content: '保存照片被拒绝，请在设置中开启相册写入权限',
      confirmText: '去设置',
      confirmColor: INK_COLOR,
      success: (res) => { if (res.confirm) wx.openSetting(); }
    });
  }
});
