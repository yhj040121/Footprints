/**
 * secCheck 源入口。部署入口 index.js 由本文件打包生成，把 actions/lib 内联进单文件，
 * 避免部分部署方式遗漏子目录后出现 Cannot find module './lib/errors'。
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

    // 消息推送回投仅允许无 openid 的官方事件；普通 callFunction 始终走 action 路由。
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
