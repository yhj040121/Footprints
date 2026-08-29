// detail 足迹详情页（FR-11 全字段展示 + 照片预览；FR-12 删除二次确认）
// 读：db.getFootprint 直连（契约 §0.1）；照片 URL：ossSts.sign 运行时按需签发（§1.3，process 白名单 w_1600）
// 删：delFootprint 云函数（§1.4）；失败保留页面原样，1004 视为已删除直接返回（§0.3）
const db = require('../../utils/db');
const request = require('../../utils/request');
const constants = require('../../utils/constants');
const dateUtil = require('../../utils/date');

Page({
  data: {
    loading: true,
    notFound: false,
    networkError: false, // 断网/服务端异常 → 与「记录不存在」区分（S6-R3）
    fp: null,          // footprint 文档
    dateText: '',      // YYYY/MM/DD 大标题
    photoUrls: [],     // 与 fp.photos 同序的签名 URL
    photoFailed: false,
    deleting: false
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

  loadDetail() {
    this.setData({ loading: true, photoFailed: false, networkError: false });
    db.getFootprint(this.fpId)
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
        this.signPhotos(fp);
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
    this.loadDetail();
  },

  // 全部 key 一次批量 sign（契约 §1.3：items 1~100，process 白名单 PROCESS_FULL）
  signPhotos(fp) {
    const keys = (fp.photos || []).map((p) => p.key).filter(Boolean);
    if (!keys.length) {
      this.setData({ photoUrls: [] });
      return;
    }
    request.callFunction('ossSts', {
      action: 'sign',
      items: keys.map((key) => ({ key, process: constants.PROCESS_FULL }))
    }).then((data) => {
      // 按 fp.photos 原顺序取 url，保证预览左右滑动顺序与记录一致（FR-11 验收 2）
      const byKey = {};
      ((data && data.urls) || []).forEach((u) => { byKey[u.key] = u.url; });
      const urls = keys.map((k) => byKey[k] || '');
      this.setData({ photoUrls: urls, photoFailed: urls.some((u) => !u) });
    }).catch(() => {
      this.setData({ photoUrls: [], photoFailed: true });
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

  // §5.4（S6-R4 细化）删除传输异常终态：无应答重发同一 delFootprint 至明确终态（幂等安全）；
  // 1004 = 已删除成功按成功展示；3001/9000 可继续重试；重试耗尽（3 次，间隔 2s）仍无终态 → 回读记录：
  // 不存在 = 删除成功；存在或回读失败 = 提示「结果未确认」+「再试一次」，不得显示「删除失败」
  doDelete() {
    this.setData({ deleting: true });
    wx.showLoading({ title: '删除中', mask: true });
    const finish = () => { wx.hideLoading(); this.setData({ deleting: false }); };
    const success = () => {
      finish();
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    };
    const unconfirmed = () => {
      finish();
      wx.showModal({
        title: '结果未确认',
        content: '删除结果未确认，请再试一次',
        confirmText: '再试一次',
        cancelText: '取消',
        success: (r) => { if (r.confirm) this.doDelete(); }
      });
    };
    // 回读裁定：记录已不在 = 删除成功；仍在或回读也失败 = 结果未确认
    const reRead = () => {
      db.getFootprint(this.fpId)
        .then((fp) => (fp ? unconfirmed() : success()))
        .catch(() => unconfirmed());
    };
    const send = (retriesLeft) => {
      request.callFunction('delFootprint', { footprintId: this.fpId })
        .then(success)
        .catch((err) => {
          if (request.isNotFound(err)) return success(); // 1004：已删除成功（契约 §0.3 / §5.4）
          if (err && err.transport && retriesLeft > 0) { // 无应答：重发到终态（间隔 2s，最多 3 次）
            setTimeout(() => send(retriesLeft - 1), 2000);
            return;
          }
          if (err && err.transport) return reRead(); // 重试耗尽仍无终态 → 回读裁定
          // 服务端明确拒绝（3001/9000 可重试 / 1001/1003 拒绝）
          finish();
          let tip = (err && err.message) || '删除失败';
          if (!(err && err.transport) && request.isRetryable(err)) tip += '，可重试';
          wx.showToast({ title: tip, icon: 'none' });
        });
    };
    send(3); // 初始 1 次 + 至多 3 次重试（每次间隔 2s）
  },

  onBack() {
    wx.navigateBack();
  }
});
