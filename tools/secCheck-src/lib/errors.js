/**
 * lib/errors —— 错误信封与业务异常（契约 §0.2/§0.3）
 */
const CODE_MSG = {
  1001: '提交内容有误，请重试',
  1002: '登录态失效，请重新进入小程序',
  1003: '无权操作该数据',
  1004: '记录不存在或已被删除',
  2001: '文字含违规内容，请修改',
  2002: '照片未通过安全检测，请更换',
  2003: '审核超时，请重试',
  2004: '安全检测服务不可用，请反馈客服处理',
  2005: '照片审核状态异常，请重试',
  3001: '照片服务不可用，请反馈客服处理',
  9000: '系统繁忙，请反馈客服处理',
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
