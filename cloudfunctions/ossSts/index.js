/**
 * ossSts —— OSS 凭证与签名 URL（契约 §1.3，FR-05/07/08/09/10/11/15/16）
 *
 * action = "issueUpload"（S6-R2：隔离区签发，先于审核）
 *   1. 为每项生成隔离 key `sec-check/img/<openid>/<photoId>.<ext>` 与预生成正式 key
 *      `travel/YYYY/MM/DD/<16hex>.<ext>`（此刻即绑定，前端不可见）
 *   2. 冻结规则：该 photoId 的 task 已 status=pass → 拒绝再签发（2005，对象冻结防换字节）；
 *      未过审/未送审重试 → 复用同隔离 key 重签（覆盖重传同一 key，不产生第二份）
 *   3. AssumeRole：session policy 精确收敛到**隔离 key**、仅 oss:PutObject、900 秒
 *      —— travel/ 的任何写凭证永不下发前端（转正只由 secCheck 服务端 CopyObject 完成）
 *   4. 逐隔离 key 生成 PostObject 表单签名（conditions：$key 精确匹配 + content-length-range 1~10MB）
 *   5. 落绑定对象 sec-check/key/<photoId>.json（photoId↔imgKey↔travelKey↔openid）
 *
 * action = "sign"
 *   所有 key 必须存在于当前 openid 名下任一 footprint 的 photos[].key（DB 批量核验归属，
 *   S6-R2：一次查出本人全部 key 集合再比对，31 张 <500ms）；任一不属 → 整体 1003 拒签；
 *   归属查询数据库异常 → 9000。通过后逐 key GET 签名 URL，有效期 3600 秒
 *   （定值 §6；process 仅白名单 image/resize,w_300 | image/resize,w_1600，参与签名、前端不得自拼）
 *
 * 环境变量（仅环境变量描述，绝不写真实值进代码/仓库）：
 *   OSS_AK_ID / OSS_AK_SECRET（阿里云长期 AccessKey，仅此与 delFootprint 持有）
 *   OSS_BUCKET / OSS_REGION / OSS_STS_ROLE_ARN（RAM 角色，S5 部署期建）
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const OSS = require('ali-oss');
const { RPCClient } = require('@alicloud/pop-core');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ENV = {
  OSS_AK_ID: process.env.OSS_AK_ID,
  OSS_AK_SECRET: process.env.OSS_AK_SECRET,
  OSS_BUCKET: process.env.OSS_BUCKET,
  OSS_REGION: process.env.OSS_REGION,
  OSS_STS_ROLE_ARN: process.env.OSS_STS_ROLE_ARN,
};

/* ---------- 契约 §0.3 错误码 ---------- */
const CODE_MSG = {
  1001: '提交内容有误，请重试',
  1002: '登录态失效，请重新进入小程序',
  1003: '无权操作该数据',
  1004: '记录不存在或已被删除',
  2005: '照片审核状态异常，请重试',
  3001: '照片服务不可用，请反馈客服处理',
  9000: '系统繁忙，请反馈客服处理',
};

/* ---------- 常量（契约 §3.1/§3.2/§3.3/§6） ---------- */
const UPLOAD_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic']; // 原图上传扩展名白名单
const PROCESS_WHITELIST = { 'image/resize,w_300': true, 'image/resize,w_1600': true }; // 签名缩略图白名单
const STS_DURATION = 900; // STS/上传凭证有效期（秒，AssumeRole 最小值）
const POST_POLICY_MS = 15 * 60 * 1000; // PostObject policy 有效期 15 分钟（契约 §1.3）
const SIGN_EXPIRES = 3600; // 签名 URL 有效期（秒，定值 §6）
const MAX_OBJ_SIZE = 10485760; // 10MB（FR-05 单张上限）
const DB_PAGE = 100; // sign 批量归属核验分页大小
// S6-R2：真 UUID v4（版本位 4、variant 8/9/a/b）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^travel\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{16}\.(jpg|jpeg|png|webp|heic)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 真实日历合法性（S6 修正）：YYYY-MM-DD 且为合法日期（如 02-30 拒绝） */
function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

class BizError extends Error {
  constructor(code) {
    super(CODE_MSG[code] || CODE_MSG[9000]);
    this.code = code;
  }
}

function ok(data) {
  return { code: 0, message: 'OK', data: data || null };
}

function fail(code) {
  return { code, message: CODE_MSG[code] || CODE_MSG[9000], data: null };
}

function ossClient() {
  if (!ENV.OSS_AK_ID || !ENV.OSS_AK_SECRET || !ENV.OSS_BUCKET || !ENV.OSS_REGION) {
    throw new BizError(3001);
  }
  return new OSS({
    region: ENV.OSS_REGION,
    accessKeyId: ENV.OSS_AK_ID,
    accessKeySecret: ENV.OSS_AK_SECRET,
    bucket: ENV.OSS_BUCKET,
    secure: true, // S7：签名 URL 用 https（与 secCheck/lib/oss.js 同口径）
  });
}

/* ==================================================================
 * action = "issueUpload"（S6-R2：隔离区签发，先于审核）
 * ================================================================== */
async function handleIssueUpload(event, openid) {
  const items = event.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 9) throw new BizError(1001);

  const normalized = items.map((item) => {
    const photoId = item && item.photoId;
    const ext = item && item.ext;
    const date = item && item.date;
    if (typeof photoId !== 'string' || !UUID_RE.test(photoId)) throw new BizError(1001);
    if (!UPLOAD_EXT.includes(ext)) throw new BizError(1001);
    // S6 修正：date 须为真实日历合法日期（如 2026-02-30 → 1001）
    if (!isValidDateString(date)) throw new BizError(1001);
    return { photoId, ext, date };
  });

  // S6-R4：入参去重——items 内 photoId 重复 → 1001
  const pidSeen = new Set();
  for (const { photoId } of normalized) {
    if (pidSeen.has(photoId)) throw new BizError(1001);
    pidSeen.add(photoId);
  }

  const client = ossClient();

  // 1. 逐项解析/生成隔离 key + 预生成 travel key
  //    冻结规则（S6-R2）：task 已 pass → 2005（对象冻结防换字节）；未过审/未送审 → 复用同隔离 key
  const records = []; // { photoId, imgKey, travelKey }
  for (const { photoId, ext, date } of normalized) {
    // 冻结检查：该 photoId 已审核通过 → 拒绝再签发
    try {
      const tobj = await client.get(`sec-check/task/${photoId}.json`);
      const task = JSON.parse(tobj.content.toString('utf8'));
      if (task && task.openid === openid && task.status === 'pass') {
        throw new BizError(2005); // 对象冻结：pass 后想换图只能新 photoId 重走全流程（FR-06.5）
      }
    } catch (e) {
      if (e instanceof BizError) throw e;
      // 无 task 对象 → 未送审，允许签发
    }

    let bind = null;
    try {
      const obj = await client.get(`sec-check/key/${photoId}.json`);
      bind = JSON.parse(obj.content.toString('utf8'));
    } catch (e) {
      bind = null;
    }
    if (bind) {
      if (bind.openid !== openid || typeof bind.imgKey !== 'string' || typeof bind.travelKey !== 'string') {
        throw new BizError(1001); // 绑定对象归属不符/字段缺失 → photoId 非本会话
      }
      records.push({ photoId, imgKey: bind.imgKey, travelKey: bind.travelKey }); // 复用同隔离 key/travel key
    } else {
      const imgKey = `sec-check/img/${openid}/${photoId}.${ext}`; // 隔离区原图 key
      const travelKey = `travel/${date.replace(/-/g, '/')}/${crypto.randomBytes(8).toString('hex')}.${ext}`; // 预生成正式 key
      records.push({ photoId, imgKey, travelKey });
    }
  }

  // 2. AssumeRole：session policy 精确收敛到隔离 key、仅 oss:PutObject、900 秒
  //    —— travel/ 写凭证永不下发前端（S6-R2），转正只由服务端 CopyObject 完成
  let stsCred;
  try {
    if (!ENV.OSS_STS_ROLE_ARN) throw new Error('OSS_STS_ROLE_ARN env not configured');
    const sessionPolicy = {
      Version: '1',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['oss:PutObject'],
          Resource: records.map((r) => `acs:oss:*:*:${ENV.OSS_BUCKET}/${r.imgKey}`),
        },
      ],
    };
    const stsClient = new RPCClient({
      accessKeyId: ENV.OSS_AK_ID,
      accessKeySecret: ENV.OSS_AK_SECRET,
      endpoint: 'https://sts.aliyuncs.com',
      apiVersion: '2015-04-01',
    });
    const res = await stsClient.request(
      'AssumeRole',
      {
        RoleArn: ENV.OSS_STS_ROLE_ARN,
        RoleSessionName: `fp_${(openid || 'u').replace(/[^0-9a-zA-Z._-]/g, '').slice(0, 24) || 'u'}`,
        DurationSeconds: STS_DURATION,
        Policy: JSON.stringify(sessionPolicy),
      },
      { method: 'POST' }
    );
    if (!res || !res.Credentials || !res.Credentials.AccessKeyId) throw new Error('AssumeRole invalid response');
    stsCred = res.Credentials;
  } catch (e) {
    console.error('[ossSts.issueUpload] AssumeRole failed:', e);
    throw new BizError(3001);
  }

  // 3. 逐隔离 key PostObject 表单签名（policy 15 分钟；签名 = HMAC-SHA1(stsSecret, base64(policy))）
  const expireAt = Date.now() + STS_DURATION * 1000;
  const uploads = records.map(({ photoId, imgKey }) => {
    const policy = {
      expiration: new Date(Date.now() + POST_POLICY_MS).toISOString(),
      conditions: [['eq', '$key', imgKey], ['content-length-range', 1, MAX_OBJ_SIZE]],
    };
    const policyBase64 = Buffer.from(JSON.stringify(policy)).toString('base64');
    const signature = crypto
      .createHmac('sha1', stsCred.AccessKeySecret)
      .update(policyBase64)
      .digest('base64');
    return {
      photoId,
      key: imgKey, // 下发的是隔离 key；travel key 永不下发
      host: `https://${ENV.OSS_BUCKET}.${ENV.OSS_REGION}.aliyuncs.com`,
      policy: policyBase64,
      signature,
      OSSAccessKeyId: stsCred.AccessKeyId,
      securityToken: stsCred.SecurityToken,
      expireAt,
    };
  });

  // 4. 落绑定对象（photoId↔imgKey↔travelKey↔openid）；失败 → 整体失败可重试（同 photoId 复用）
  try {
    await Promise.all(
      records.map(({ photoId, imgKey, travelKey }) =>
        client.put(
          `sec-check/key/${photoId}.json`,
          Buffer.from(JSON.stringify({ photoId, imgKey, travelKey, openid }), 'utf8'),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
  } catch (e) {
    console.error('[ossSts.issueUpload] write binding failed:', e);
    throw new BizError(3001);
  }

  return ok({ uploads, expireAt });
}

/* ==================================================================
 * action = "sign"
 * ================================================================== */
async function handleSign(event, openid) {
  const items = event.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new BizError(1001);

  const normalized = items.map((item) => {
    const key = item && item.key;
    const process = item && item.process;
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new BizError(1001);
    let proc;
    if (process !== undefined && process !== null && process !== '') {
      if (!PROCESS_WHITELIST[process]) throw new BizError(1001); // process 仅白名单
      proc = process;
    }
    return { key, process: proc };
  });

  // 归属核验（S6-R3 批量 key 查询）：`where photos.key in 请求 keys` 一次查出命中记录（分块 in，
  // 每块 ≤50，避免 in 超限；禁止全量分页扫描）。命中记录的 photos[].key 中属于请求集合的记为已归属。
  // 任一请求 key 不属本人 → 整体 1003 拒签（FR-02 验收 4）；数据库异常 → 9000（S6 修正，非 1003）
  const reqKeys = normalized.map(({ key }) => key);
  const ownedKeys = new Set();
  const IN_CHUNK = 50;
  for (let i = 0; i < reqKeys.length; i += IN_CHUNK) {
    const chunk = reqKeys.slice(i, i + IN_CHUNK);
    let skip = 0;
    let page;
    do {
      let res;
      try {
        res = await db
          .collection('footprint')
          .where({ _openid: openid, 'photos.key': db.command.in(chunk) })
          .field({ photos: true })
          .skip(skip)
          .limit(DB_PAGE)
          .get();
      } catch (e) {
        console.error('[ossSts.sign] ownership query failed:', e);
        throw new BizError(9000);
      }
      page = res.data;
      for (const d of page) {
        for (const p of d.photos || []) {
          if (p && typeof p.key === 'string' && chunk.includes(p.key)) ownedKeys.add(p.key);
        }
      }
      skip += page.length;
    } while (page.length === DB_PAGE);
  }

  if (reqKeys.some((key) => !ownedKeys.has(key))) throw new BizError(1003);

  // 逐 key GET 签名 URL（process 参与签名），有效期 3600 秒，不落库不缓存
  const client = ossClient();
  const expireAt = Date.now() + SIGN_EXPIRES * 1000;
  let urls;
  try {
    urls = normalized.map(({ key, process }) => ({
      key,
      url: client.signatureUrl(key, { expires: SIGN_EXPIRES, process }),
      expireAt,
    }));
  } catch (e) {
    console.error('[ossSts.sign] signatureUrl failed:', e);
    throw new BizError(3001);
  }

  return ok({ urls });
}

/* ==================================================================
 * 入口
 * ================================================================== */
exports.main = async (event) => {
  try {
    const openid = cloud.getWXContext().OPENID;
    if (!openid) return fail(1002);

    const action = event && event.action;
    switch (action) {
      case 'issueUpload':
        return await handleIssueUpload(event, openid);
      case 'sign':
        return await handleSign(event, openid);
      default:
        return fail(1001);
    }
  } catch (e) {
    if (e instanceof BizError) return fail(e.code);
    console.error('[ossSts] unexpected error:', e);
    return fail(9000);
  }
};
