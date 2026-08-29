/**
 * lib/errors —— 错误信封与业务异常（契约 §0.2/§0.3）
 */
const CODE_MSG = {
  1001: '提交内容不完整或格式不正确',
  1002: '登录态失效，请重新进入小程序',
  1003: '无权操作该数据',
  1004: '记录不存在或已被删除',
  2001: '文本包含不适宜内容，请修改后再试',
  2002: '有照片未通过安全检测，请更换后再试',
  2003: '审核超时，暂无法保存，请稍后再试',
  2004: '暂无法保存，请稍后再试',
  2005: '照片与审核结果不一致，请重新保存',
  3001: '照片服务异常，请稍后再试',
  9000: '系统繁忙，请稍后再试',
};

class BizError extends Error {
  constructor(code, data) {
    super(CODE_MSG[code] || CODE_MSG[9000]);
    this.code = code;
    this.data = data || null;
  }
}

function ok(data) {
  return { code: 0, message: 'OK', data: data || null };
}

function fail(code, data) {
  return { code, message: CODE_MSG[code] || CODE_MSG[9000], data: data || null };
}

module.exports = { CODE_MSG, BizError, ok, fail };
