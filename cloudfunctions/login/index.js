/**
 * login —— 静默登录建档（契约 §1.1，FR-01）
 *
 * 实现要点（契约 §1.1 + §0.2）：
 * 1. openid 一律取自云调用上下文（cloud.getWXContext().OPENID），前端传 openid 一律忽略；
 *    上下文无 openid 且带 code 时，走 code2Session 兜底（需配置 WX_APPID / WX_APPSECRET 环境变量）。
 * 2. 建档/复用：以 openid 作为 _id 建档（_id 唯一约束天然保证「重复调用不重复建档」，
 *    并发下也不会产生两条，等价于契约「按 openid 查 → 无则建档」的对外行为）。
 * 3. user 文档显式写 _openid + openid：云函数管理端写入不会自动带 _openid，
 *    而前端后续读写本人 user 文档依赖「仅创建者可读写」（按 _openid 判定）。
 * 4. createdAt 由服务端 serverDate 写入，前端传了也忽略。
 *
 * 错误码：1002（code 无效/上下文无 openid）、9000（未预期异常）。
 *
 * 环境变量（仅环境变量描述，绝不写真实值进代码/仓库）：
 *   WX_APPID    微信小程序 AppID（=wx195015715a8e389d，已定可入文档）
 *   WX_APPSECRET 微信小程序 AppSecret（仅环境变量，主路径不依赖，code2Session 兜底才用）
 */
const cloud = require('wx-server-sdk');
const https = require('https');
const querystring = require('querystring');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ENV = {
  WX_APPID: process.env.WX_APPID,
  WX_APPSECRET: process.env.WX_APPSECRET,
};

const CODE_MSG = {
  1002: '登录态失效，请重新进入小程序',
  9000: '系统繁忙，请稍后再试',
};

function ok(data) {
  return { code: 0, message: 'OK', data };
}

function fail(code, message) {
  return { code, message, data: null };
}

/** code2Session 兜底：仅上下文无 openid 且调用方提供了 code 时使用 */
function code2Session(code) {
  return new Promise((resolve, reject) => {
    if (!ENV.WX_APPID || !ENV.WX_APPSECRET) {
      reject(new Error('WX_APPID/WX_APPSECRET env not configured'));
      return;
    }
    const qs = querystring.stringify({
      appid: ENV.WX_APPID,
      secret: ENV.WX_APPSECRET,
      js_code: code,
      grant_type: 'authorization_code',
    });
    https
      .get(`https://api.weixin.qq.com/sns/jscode2session?${qs}`, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json && json.openid) resolve(json.openid);
            else reject(new Error(`code2Session failed: ${body.slice(0, 200)}`));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    let openid = wxContext.OPENID;

    // 兜底分支：上下文无 openid 且提供了 code（登录态失效重调场景）
    if (!openid && event && typeof event.code === 'string' && event.code) {
      try {
        openid = await code2Session(event.code);
      } catch (e) {
        console.warn('[login] code2Session fallback failed:', e && e.message);
      }
    }

    if (!openid) {
      return fail(1002, CODE_MSG[1002]);
    }

    const userCol = db.collection('user');
    try {
      // 建档：_id = openid，重复调用/并发下唯一约束保证不重复建档
      await userCol.add({
        data: {
          _id: openid,
          _openid: openid,
          openid,
          createdAt: db.serverDate(),
        },
      });
      console.log('[login] new user created, openid=', openid);
      return ok({
        openid,
        isNewUser: true,
        profile: { avatarUrl: null, nickname: null, customTags: [] },
      });
    } catch (e) {
      // _id 已存在 → 复用已有文档（不重复建档）
      const got = await userCol.doc(openid).get();
      const u = (got && got.data) || {};
      console.log('[login] existing user, openid=', openid);
      return ok({
        openid,
        isNewUser: false,
        profile: {
          avatarUrl: u.avatarUrl || null,
          nickname: u.nickname || null,
          customTags: Array.isArray(u.customTags) ? u.customTags : [],
        },
      });
    }
  } catch (e) {
    console.error('[login] unexpected error:', e);
    return fail(9000, CODE_MSG[9000]);
  }
};
