// 溪山行旅 app 入口
// 职责：云环境初始化 + FR-01 静默登录（冷启动一次；断网重试 / code=1002 时重调）
const config = require('./utils/config');
const request = require('./utils/request');

App({
  globalData: {
    openid: '',
    profile: null,       // { avatarUrl, nickname }（标签体系待重写，customTags 已移除，见 S8）
    loginReady: null,    // Promise，页面可 await 登录完成
    loginFailed: false   // 断网等导致登录失败，页面展示重试入口
  },

  onLaunch() {
    if (config.USE_MOCK) {
      // 防误发布守卫：「模拟模式」启动大字告警（页面侧另有 mock-badge 角标）
      console.warn('%c ⚠ 模拟模式 ⚠ ', 'font-size:32px;font-weight:bold;color:#fff;background:#8C3B2E;padding:8px 16px;border-radius:8px;');
      console.warn('[Footprints] USE_MOCK=true：全部接口为本地模拟数据，禁止提审/发布！本状态只应来自不入库的 utils/config.local.js 本地覆盖；提审/发布前删除该覆盖文件回到默认 prod（USE_MOCK=false）。');
    } else {
      wx.cloud.init({ env: config.ENV_ID, traceUser: true });
    }
    this.globalData.loginReady = this.login();
  },

  // FR-01：wx.login 取 code → 云函数 login 换 openid 建档/复用；全程无授权弹窗
  login() {
    this.globalData.loginFailed = false;
    return request.login()
      .then((data) => {
        this.globalData.openid = data.openid;
        this.globalData.profile = data.profile;
        return data;
      })
      .catch((err) => {
        this.globalData.loginFailed = true;
        throw err;
      });
  },

  // 断网重试 / code=1002 重登录入口（契约 §1.1：仅此处与 onLaunch 可调 login）
  relogin() {
    this.globalData.loginReady = this.login();
    return this.globalData.loginReady;
  }
});
