/**
 * error-text —— 云函数错误 → 用户可见文案（S7-R7 统一口径）
 * 三原则：①可重试成功必须让用户知道能重试 ②文案简洁 ③服务类问题「服务不可用，请反馈客服处理」。
 * 原始英文 errMsg（含 rid）只进 console 日志，绝不进用户可见文案。
 */
const DAILY_QUOTA_CODE = 45009; // 未上架小程序 msgSecCheck 100 次/天，超限返回 45009

function secErrorText(err) {
  if (!err) return '保存失败，请重试';
  if (err.transport) return '网络异常，请重试'; // 幂等 clientSaveId 兜底，重试安全
  const code = err.code;
  if (code === 2004) {
    if (err.data && err.data.reasonCode === DAILY_QUOTA_CODE) return '今日检测次数已用完，明天再试';
    return '安全检测服务不可用，请反馈客服处理';
  }
  if (code === 2003) return '审核超时，请重试';
  if (code === 2005) return '照片审核状态异常，请重试';
  if (code === 3001) return '照片服务不可用，请反馈客服处理';
  if (code === 9000) return '系统繁忙，请反馈客服处理';
  // 其余（1001/1002/1003/1004/2001/2002）信封 message 本就是中文业务文案，直出
  return err.message || '保存失败，请重试';
}

module.exports = { secErrorText };
