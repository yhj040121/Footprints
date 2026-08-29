// pages/mine/mine.js —— 「我的」Tab（FR-14 我的页 / FR-15 批量导出照片）
// 布局：头像+昵称（官方填写能力）→ 统计三项 → 功能列表（导出/设置）→ 底部私密文案
const db = require('../../utils/db');
const request = require('../../utils/request');
const constants = require('../../utils/constants');
const dateUtil = require('../../utils/date');
const imageUtil = require('../../utils/image');

const SIGN_BATCH = 100; // 契约 §1.3：sign 单次 items ≤100

Page({
  data: {
    profile: { avatarUrl: null, nickname: null },
    nickname: '', // input 绑定值；未设置时 placeholder 显示「旅人」
    stats: { days: 0, footprints: 0, photos: 0 },
    todayStr: '',
    // date range panel (FR-15 按日期范围)
    showRangePanel: false,
    rangeStart: '',
    rangeEnd: '',
    // export progress overlay
    exporting: false,
    exportDone: 0,
    exportTotal: 0,
    exportPercent: 0,
    // settings overlay
    showSettings: false
  },

  onLoad() {
    this.setData({ todayStr: dateUtil.today() });
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(4);
    this.refresh();
  },

  // 等静默登录就绪后拉资料与统计（FR-14）
  refresh() {
    const app = getApp();
    const ready = (app.globalData && app.globalData.loginReady) || Promise.resolve();
    ready.catch(() => {}).then(() => {
      db.getProfile()
        .then((p) => this.setData({ profile: p, nickname: p.nickname || '' }))
        .catch(() => {});
      db.stats()
        .then((s) => this.setData({ stats: s }))
        .catch(() => wx.showToast({ title: '统计加载失败，请稍后重试', icon: 'none' }));
    });
  },

  // ---------- profile (FR-14 ①) ----------

  // 官方头像填写能力：chooseAvatar 返回临时头像地址，无授权弹窗。
  // 临时路径杀进程即失效 → 压缩转 base64 dataURL（≤64KB，超限继续降质）再写 user.avatarUrl，
  // 保证杀进程后可持久显示（FR-14 验收 2 / 契约 §2.1 S6 修正）
  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;
    imageUtil.createAvatarDataUrl(this, 'avatarCanvas', tempPath)
      .then((dataUrl) => {
        this.setData({ 'profile.avatarUrl': dataUrl });
        return db.updateProfile({ avatarUrl: dataUrl });
      })
      .catch(() => {
        wx.showToast({ title: '头像保存失败，请重试', icon: 'none' });
      });
  },

  // 官方昵称填写能力：失焦/确认时保存（无变化或清空则不写库）
  onNicknameBlur(e) {
    const value = ((e.detail && e.detail.value) || '').trim();
    const current = this.data.profile.nickname || '';
    if (!value || value === current) {
      this.setData({ nickname: current });
      return;
    }
    db.updateProfile({ nickname: value })
      .then((p) => this.setData({ profile: p, nickname: p.nickname || '' }))
      .catch(() => {
        this.setData({ nickname: current });
        wx.showToast({ title: '昵称保存失败，请重试', icon: 'none' });
      });
  },

  // ---------- export photos (FR-15 ①) ----------

  // 入口：先选范围（用户主动点击触发）
  onExportTap() {
    if (this.data.exporting) return;
    wx.showActionSheet({
      itemList: ['全部照片', '按日期范围'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.collectAndConfirm(null, null);
        } else if (res.tapIndex === 1) {
          const t = dateUtil.today();
          this.setData({ showRangePanel: true, rangeStart: t, rangeEnd: t });
        }
      }
    });
  },

  onRangeStartChange(e) {
    this.setData({ rangeStart: e.detail.value });
  },

  onRangeEndChange(e) {
    this.setData({ rangeEnd: e.detail.value });
  },

  onRangeCancel() {
    this.setData({ showRangePanel: false });
  },

  // 校验：起 ≤ 止 且 止 ≤ 今天（picker 已用 end 属性挡住未来日期，此处兜底）
  onRangeConfirm() {
    const { rangeStart, rangeEnd } = this.data;
    if (rangeStart > rangeEnd) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    if (dateUtil.isFuture(rangeEnd)) {
      wx.showToast({ title: '结束日期不能晚于今天', icon: 'none' });
      return;
    }
    this.setData({ showRangePanel: false });
    this.collectAndConfirm(rangeStart, rangeEnd);
  },

  // 收集范围内全部照片 key → 二次确认（含将导出张数）
  collectAndConfirm(startDate, endDate) {
    wx.showLoading({ title: '正在统计', mask: true });
    this.collectKeys(startDate, endDate)
      .then((keys) => {
        wx.hideLoading();
        if (keys.length === 0) {
          wx.showToast({ title: '0 张可导出', icon: 'none' });
          return;
        }
        wx.showModal({
          title: '导出照片到相册',
          content: '共 ' + keys.length + ' 张照片，将逐张保存到系统相册',
          confirmText: '开始导出',
          success: (r) => {
            if (r.confirm) this.startExport(keys);
          }
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '读取失败，请重试', icon: 'none' });
      });
  },

  // 分页遍历全部足迹，按日期闭区间过滤（含起止两日），汇总 photos key；
  // 无照片记录自然跳过、不计入总数（FR-15 验收 6）
  collectKeys(startDate, endDate) {
    const keys = [];
    const step = (skip) => db.listFootprintsPage(skip, constants.PAGE_SIZE).then((res) => {
      res.list.forEach((f) => {
        if (startDate && (f.date < startDate || f.date > endDate)) return;
        (f.photos || []).forEach((p) => {
          if (p && p.key) keys.push(p.key);
        });
      });
      return res.hasMore ? step(skip + res.list.length) : keys;
    });
    return step(0);
  },

  // 分批 sign（每批 ≤100 个 key，process 用导出原图档白名单）
  startExport(keys) {
    wx.showLoading({ title: '准备中', mask: true });
    this.signAll(keys)
      .then((tasks) => {
        wx.hideLoading();
        // 整次导出累计上下文（S6-R3）：重试只翻转对应项状态，汇总始终按原总数计算
        this._exportAll = { total: tasks.length, ok: 0, fail: 0 };
        this._exportFailedTasks = [];
        this.runTasks(tasks, false);
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '签名失败，请重试', icon: 'none' });
      });
  },

  signAll(keys) {
    const tasks = [];
    let chain = Promise.resolve();
    for (let i = 0; i < keys.length; i += SIGN_BATCH) {
      const items = keys.slice(i, i + SIGN_BATCH).map((key) => ({ key, process: constants.PROCESS_FULL }));
      chain = chain.then(() => request.callFunction('ossSts', { action: 'sign', items })
        .then((data) => {
          (data.urls || []).forEach((u) => tasks.push({ key: u.key, url: u.url }));
        }));
    }
    return chain.then(() => tasks);
  },

  // 逐张循环保存；取消语义 = 立即停止发起新任务，在途单张允许完成并计入成功（FR-15）
  // S6-R3 累计化：重试（isRetry）只翻转对应项状态，汇总按原总数（_exportAll.total）计算
  runTasks(tasks, isRetry) {
    this.exportCancel = false;
    const all = this._exportAll;
    if (isRetry) all.fail = Math.max(0, all.fail - tasks.length); // 重试这批此前计失败，先回退再重判
    const failedTasks = [];
    this.setData({ exporting: true, exportTotal: all.total });
    let authDenied = false;
    let i = 0;
    const step = () => {
      if (this.exportCancel || authDenied || i >= tasks.length) return Promise.resolve();
      const task = tasks[i];
      i += 1;
      return this.saveOne(task)
        .then(() => { all.ok += 1; })
        .catch((err) => {
          all.fail += 1;
          failedTasks.push(task);
          // 相册写入授权被拒：后续必然同错，停止发起新任务（剩余计未处理）
          if (this.isAuthDeny(err)) authDenied = true;
        })
        .then(() => {
          const done = all.ok + all.fail;
          this.setData({
            exportDone: done,
            exportPercent: Math.round((done / all.total) * 100)
          });
          return step();
        });
    };
    return step().then(() => {
      const unprocessed = all.total - all.ok - all.fail;
      this._exportFailedTasks = failedTasks;
      this.setData({ exporting: false });
      const showSummary = () => this.showSummary(unprocessed);
      if (authDenied) {
        // 首次触发相册写入授权被拒：引导去设置开启，不崩溃（FR-15 验收 1）
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中开启「保存到相册」权限后再导出',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting({});
          },
          complete: showSummary
        });
      } else {
        showSummary();
      }
    });
  },

  // 单张保存：远程签名 URL 先 downloadFile 再写相册；本地路径直接写
  saveOne(task) {
    const url = task.url;
    // mock 降级：mock sign 返回小程序包内路径（'/assets/' 开头），无法真实写入相册，
    // 直接模拟进度并计为成功（联调切 USE_MOCK=false 后走下方真实下载+保存链路）
    if (url.indexOf('/assets/') === 0) {
      return new Promise((resolve) => setTimeout(resolve, 300));
    }
    // 本地文件路径（mock 已持久化的 wxfile:// 路径）跳过下载直接保存
    const isLocal = url.indexOf('wxfile://') === 0 || url.indexOf('http://tmp') === 0;
    const obtainPath = isLocal
      ? Promise.resolve(url)
      : new Promise((resolve, reject) => {
          wx.downloadFile({
            url,
            success: (res) => (res.statusCode === 200
              ? resolve(res.tempFilePath)
              : reject(new Error('download failed: ' + res.statusCode))),
            fail: reject
          });
        });
    return obtainPath.then((filePath) => new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject });
    }));
  },

  isAuthDeny(err) {
    const msg = (err && err.errMsg) || '';
    return msg.indexOf('auth') >= 0 || msg.indexOf('deny') >= 0 || msg.indexOf('authorize') >= 0;
  },

  // 汇总弹窗：成功 N / 失败 M / 未处理 K（N+M+K=原总数）；失败 >0 提供「重试失败张」
  // S6-R3：汇总始终按累计上下文（_exportAll）计算，重试只翻转对应项状态
  showSummary(unprocessed) {
    const all = this._exportAll;
    const content = '成功 ' + all.ok + ' / 失败 ' + all.fail + ' / 未处理 ' + Math.max(0, unprocessed);
    if (all.fail > 0) {
      wx.showModal({
        title: '导出完成',
        content,
        confirmText: '重试失败张',
        cancelText: '完成',
        success: (r) => {
          // 仅处理失败部分；签名 URL 有效期 1h（§6），重试复用原 URL（累计上下文保留）
          if (r.confirm) this.runTasks((this._exportFailedTasks || []).slice(), true);
        }
      });
    } else {
      wx.showModal({ title: '导出完成', content, showCancel: false, confirmText: '好的' });
    }
  },

  onExportCancel() {
    this.exportCancel = true;
  },

  // ---------- settings (FR-14 ④) ----------

  onSettingsTap() {
    this.setData({ showSettings: true });
  },

  onSettingsClose() {
    this.setData({ showSettings: false });
  },

  noop() {}
});
