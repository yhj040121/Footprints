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
 * 5. S6-R4：action=updateProfile 头像/昵称更新（user 集合客户端 write:false 后的服务端写入口）。
 * 6. S7：未知 action（非空且 ≠ updateProfile）直接 1001，不落入普通登录；
 *    updateProfile 的 avatarUrl MIME 收紧为 image/jpeg|png|webp；update 须恰好更新 1 条、
 *    回读失败一律 9000（绝不返回空 profile）。
 *
 * 错误码：1001（updateProfile 格式/超限/未知 action）、1002（code 无效/上下文无 openid）、9000（未预期异常）。
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
  1001: '提交内容不完整或格式不正确',
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
    // S7：未知 action（非空且 ≠ updateProfile）直接 1001，不落入普通登录
    if (
      event &&
      event.action !== undefined &&
      event.action !== null &&
      event.action !== '' &&
      event.action !== 'updateProfile'
    ) {
      console.warn('[login] unknown action:', event.action);
      return fail(1001, CODE_MSG[1001]);
    }

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

    // S6-R4：action=updateProfile 头像/昵称更新（user 集合客户端 write:false 后的服务端写入口）
    if (event && event.action === 'updateProfile') {
      return await handleUpdateProfile(event, openid);
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

/**
 * action = "updateProfile"（S6-R4，契约 §1.1）：头像/昵称更新（FR-14）。
 * 入参：avatarUrl（base64 dataURL，S7 收紧仅 image/jpeg|png|webp，解码后 ≤64KB，超限 1001）、
 *       nickname（1~32 字，去首尾空白）。
 * 未传/传 null 的字段不动；openid 取自上下文；出参返回更新后的完整 profile。
 * S7：update 须恰好命中 1 条文档、回读失败 → 9000（绝不返回空 profile）。
 * 错误码：1001（格式/MIME/超限）、9000（DB 异常）。
 */
async function handleUpdateProfile(event, openid) {
  const update = {};

  // avatarUrl：base64 dataURL（S7 收紧：仅 image/jpeg|png|webp），解码后 ≤64KB
  if (event.avatarUrl !== undefined && event.avatarUrl !== null) {
    if (typeof event.avatarUrl !== 'string') return fail(1001, CODE_MSG[1001]);
    const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(event.avatarUrl);
    if (!m) return fail(1001, CODE_MSG[1001]);
    let buf;
    try {
      buf = Buffer.from(m[1], 'base64');
    } catch (e) {
      return fail(1001, CODE_MSG[1001]);
    }
    if (!buf.length || buf.length > 64 * 1024) return fail(1001, CODE_MSG[1001]); // ≤64KB
    update.avatarUrl = event.avatarUrl;
  }

  // nickname：1~32 字，去首尾空白
  if (event.nickname !== undefined && event.nickname !== null) {
    if (typeof event.nickname !== 'string') return fail(1001, CODE_MSG[1001]);
    const nick = event.nickname.trim();
    if (nick.length < 1 || nick.length > 32) return fail(1001, CODE_MSG[1001]);
    update.nickname = nick;
  }

  if (!Object.keys(update).length) return fail(1001, CODE_MSG[1001]); // 无字段可更新

  try {
    const updRes = await db.collection('user').doc(openid).update({ data: update });
    // S7：必须恰好更新 1 条文档，否则视为异常（含文档不存在的 updated=0）
    const updated = updRes && updRes.stats && typeof updRes.stats.updated === 'number'
      ? updRes.stats.updated
      : null;
    if (updated !== 1) {
      console.error('[login.updateProfile] unexpected update stats:', JSON.stringify(updRes));
      return fail(9000, CODE_MSG[9000]);
    }
  } catch (e) {
    console.error('[login.updateProfile] update failed:', e);
    return fail(9000, CODE_MSG[9000]);
  }

  // 回读返回完整 profile（S7：回读失败 → 9000，绝不返回空 profile）
  let got;
  try {
    got = await db.collection('user').doc(openid).get();
  } catch (e) {
    console.error('[login.updateProfile] readback failed:', e && e.message);
    return fail(9000, CODE_MSG[9000]);
  }
  const u = (got && got.data) || {};
  if (!u || !u._id) {
    console.error('[login.updateProfile] readback empty, openid=', openid);
    return fail(9000, CODE_MSG[9000]);
  }
  return ok({
    profile: {
      avatarUrl: u.avatarUrl || null,
      nickname: u.nickname || null,
      customTags: Array.isArray(u.customTags) ? u.customTags : [],
    },
  });
}
