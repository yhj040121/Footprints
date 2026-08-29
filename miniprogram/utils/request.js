// 云函数统一调用封装（契约 §0.2 信封 + §0.3 错误码分流）
// - 成功（code=0）resolve(data)
// - 失败 reject(CloudError { code, message, data })，message 为可直接展示的中文文案
// - 分流约定（§0.3 前端约定）：
//     2003/2004/3001/9000 → isRetryable，页面展示「重试」
//     2001/2002             → isFieldError，回表单定位字段（data.results 指明字段/张序）
//     1002                  → 自动触发重新 login（name==='login' 自身除外：登录调用禁止自动 relogin，
//                             否则 login 失败会递归重登；登录失败由 app.js 置 loginFailed，
//                             页面展示失败态 + 人工重试，如 timeline.onRetryLogin），随后 reject 原错误
//     1004                  → 删除/编辑场景视为「已不存在」，停止重试
// - openid 一律由服务端取，前端不传（§0.2）
const config = require('./config');
const constants = require('./constants');

class CloudError extends Error {
  constructor(code, message, data) {
    super(message || '请求失败');
    this.code = code;
    this.data = data || null;
  }
}

function isRetryable(err) {
  return !!err && constants.RETRY_CODES.indexOf(err.code) >= 0;
}

function isFieldError(err) {
  return !!err && constants.FIELD_ERROR_CODES.indexOf(err.code) >= 0;
}

function isNotFound(err) {
  return !!err && err.code === constants.CODE_NOT_FOUND;
}

function isLoginExpired(err) {
  return !!err && err.code === constants.CODE_LOGIN_EXPIRED;
}

// §5.4：传输异常/云函数无应答标志（服务端可能已执行但应答丢失，前端不得直接断言失败）
function isTransport(err) {
  return !!(err && err.transport);
}

// 底层调用：mock / 真实云函数 二选一
function rawCall(name, data) {
  if (config.USE_MOCK) {
    const mock = require('./mock/index');
    return mock.call(name, data);
  }
  return wx.cloud.callFunction({ name, data }).then((res) => res.result);
}

// 统一信封解包 + 错误码分流
function callFunction(name, data) {
  return Promise.resolve()
    .then(() => rawCall(name, data || {}))
    .then((envelope) => {
      if (!envelope || typeof envelope.code !== 'number') {
        throw new CloudError(9000, '系统繁忙，请稍后再试');
      }
      if (envelope.code === 0) {
        return envelope.data;
      }
      const err = new CloudError(envelope.code, envelope.message, envelope.data);
      // name==='login' 禁止自动 relogin（防递归：login 失败 → relogin → login 失败 → …）；
      // 登录失败态 + 人工重试由页面侧处理（app.globalData.loginFailed）
      if (isLoginExpired(err) && name !== 'login') {
        const app = getApp();
        if (app && app.relogin) {
          return app.relogin().then(() => { throw err; }).catch(() => { throw err; });
        }
        throw err;
      }
      throw err;
    })
    .catch((err) => {
      // 传输异常/云函数无应答（非信封错误）：统一夹为可识别错误（§5.4）。
      // 信封内返回的 { code } 业务/系统错误已在此前抛为 CloudError，原样透传。
      if (err instanceof CloudError) throw err;
      const e = new CloudError(9000, '网络异常，请检查网络后重试');
      e.transport = true; // 无应答标志：服务端可能已执行，前端不得直接断言失败
      throw e;
    });
}

// FR-01 静默登录：wx.login 取 code → login 云函数（契约 §1.1，login 无 action）
function login() {
  if (config.USE_MOCK) {
    return callFunction('login', {});
  }
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: () => reject(new CloudError(9000, '网络不可用，请检查网络后重试'))
    });
  }).then((code) => callFunction('login', { code }));
}

module.exports = {
  CloudError,
  callFunction,
  login,
  isRetryable,
  isFieldError,
  isNotFound,
  isLoginExpired,
  isTransport
};
