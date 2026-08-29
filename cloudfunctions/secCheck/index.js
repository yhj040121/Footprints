/**
 * secCheck —— 内容安全 + 入库把关（契约 §1.2，FR-03/06/07/13；写库唯一入口）
 *
 * 按 action 拆分的内部模块（同一云函数目录内多文件，云函数数量与对外契约不变）：
 *   index.js         入口路由 + 特权分支判定
 *   lib/errors       错误信封与业务异常（§0.2/§0.3）
 *   lib/constants    常量与确定性 _id 计算（§5.1 S6 修正）
 *   lib/oss          OSS 客户端（环境变量四元组，无 ROLE_ARN）
 *   lib/validate     入参校验/日期日历合法性/标签（§1.2）
 *   lib/security     内容安全封装（异常统一 2004）与照片终审三元组（§4.2）
 *   actions/text     action = "text"
 *   actions/image    action = "imageSubmit" / "imagePoll"
 *   actions/commit   action = "commitSave" / "commitEdit"
 *   actions/push     消息推送回投（mediaCheckAsync 异步结果）
 *
 * 安全要点（契约 §4.2/§5.1/§7）：
 *   - openid 一律取上下文；commitSave/commitEdit 在服务端重审文本、重校三元组
 *   - 内容安全云调用异常/异常返回 → 2004，绝不静默放行（S6 修正）
 *   - commitSave 幂等 = 确定性 _id = hash(openid+clientSaveId)（原子写，§5.1 S6 修正）
 *
 * 环境变量（仅环境变量描述，绝不写真实值进代码/仓库）：
 *   OSS_AK_ID / OSS_AK_SECRET / OSS_BUCKET / OSS_REGION —— 与 ossSts 同值（无 ROLE_ARN）
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail, BizError } = require('./lib/errors');
const { isPushEvent, handlePush } = require('./actions/push');
const { handleText } = require('./actions/text');
const { handleImageSubmit, handleImagePoll } = require('./actions/image');
const { handleCommitSave, handleCommitEdit } = require('./actions/commit');

exports.main = async (event, context) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    // S6 修正（特权分支收紧）：消息推送回投仅当「无 openid 上下文（推送非 callFunction）
    // 且事件字段与官方推送形状完全匹配」时进入；任何携带用户 OPENID 的 callFunction
    // （即使伪造推送形状）一律不得进入此分支，走下方 action 路由（无 action → 1001）。
    if (!openid && isPushEvent(event)) {
      await handlePush(event);
      return ok(null);
    }

    if (!openid) return fail(1002);

    const action = event && event.action;
    switch (action) {
      case 'text':
        return await handleText(event, openid);
      case 'imageSubmit':
        return await handleImageSubmit(event, openid);
      case 'imagePoll':
        return await handleImagePoll(event, openid);
      case 'commitSave':
        return await handleCommitSave(event, openid);
      case 'commitEdit':
        return await handleCommitEdit(event, openid);
      default:
        return fail(1001);
    }
  } catch (e) {
    if (e instanceof BizError) return fail(e.code, e.data);
    console.error('[secCheck] unexpected error:', e);
    return fail(9000);
  }
};
