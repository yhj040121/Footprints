// pages/mine/mine.js —— 「我的」Tab（FR-14 我的页）
// 布局：头像+昵称（官方填写能力）→ 统计三项 → 功能列表（导出照片/关于我们）
const db = require('../../utils/db');
const request = require('../../utils/request');
const imageUtil = require('../../utils/image');

Page({
  data: {
    profile: { avatarUrl: null, nickname: null },
    nickname: '',
    stats: { days: 0, footprints: 0, photos: 0 },
    showSettings: false
  },

  onLoad() {},

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(4);
    this.refresh();
  },

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

  // ---------- profile ----------

  saveProfile(patch) {
    return request.callFunction('login', Object.assign({ action: 'updateProfile' }, patch))
      .then((data) => {
        const profile = (data && data.profile) || {};
        const app = getApp();
        if (app) app.globalData.profile = Object.assign({}, app.globalData.profile || {}, profile);
        return profile;
      });
  },

  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;
    imageUtil.createAvatarDataUrl(this, 'avatarCanvas', tempPath)
      .then((dataUrl) => this.saveProfile({ avatarUrl: dataUrl }))
      .then((profile) => this.setData({ profile: Object.assign({}, this.data.profile, profile) }))
      .catch(() => {
        wx.showToast({ title: '头像保存失败，请重试', icon: 'none' });
      });
  },

  onNicknameBlur(e) {
    const value = ((e.detail && e.detail.value) || '').trim();
    const current = this.data.profile.nickname || '';
    if (!value || value === current) {
      this.setData({ nickname: current });
      return;
    }
    this.saveProfile({ nickname: value })
      .then((profile) => this.setData({
        profile: Object.assign({}, this.data.profile, profile),
        nickname: (profile && profile.nickname) || ''
      }))
      .catch((err) => {
        this.setData({ nickname: current });
        wx.showToast({ title: ((err && err.message) || '昵称保存失败') + '，请重试', icon: 'none' });
      });
  },

  // ---------- 导出照片：跳到独立页 ----------
  onExportTap() {
    wx.navigateTo({ url: '/pages/export/export' });
  },

  // ---------- 关于我们 ----------
  onSettingsTap() {
    this.setData({ showSettings: true });
  },

  onSettingsClose() {
    this.setData({ showSettings: false });
  },

  // 弹层内容区拦截冒泡（catchtap 空实现）
  noop() {}
});
