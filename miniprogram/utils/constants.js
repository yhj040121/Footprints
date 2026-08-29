// 业务常量（唯一来源：需求文档 + 接口契约 §6 数值定值表）
module.exports = {
  // 预设标签（前端常量，需求文档 FR-03）
  PRESET_TAGS: ['山水', '古镇', '徒步', '晴天', '人文', '初秋'],

  // 表单上限（FR-03）
  MAX_PLACE_LEN: 50,
  MAX_NOTE_LEN: 500,
  MAX_TAGS: 10,
  MAX_TAG_LEN: 10,

  // 照片（FR-05）
  MAX_PHOTOS: 9,
  MAX_PHOTO_BYTES: 10 * 1024 * 1024,   // 单张 ≤10MB
  PHOTO_EXTS: ['jpg', 'jpeg', 'png', 'webp', 'heic'],

  // 头像（契约 §2.1 S6 修正：压缩后 base64 dataURL ≤64KB 写 user.avatarUrl）
  AVATAR_MAX_SIDE: 256,                // 最长边 ≤256px（仍超限再递减）
  AVATAR_MAX_BYTES: 64 * 1024,         // dataURL 总长 ≤64KB

  // 审核轮询纪律（契约 §1.2 / §6 定值）
  POLL_INTERVAL_MS: 2000,              // 固定 2 秒
  PHOTO_POLL_TIMEOUT_MS: 40000,        // 单张自提交起 40 秒
  REVIEW_STAGE_TIMEOUT_MS: 50000,      // 审核阶段总超时 50 秒

  // 时间线分页（FR-08 / §6）
  PAGE_SIZE: 20,

  // 签名 URL 有效期（§6：3600 秒；前端仅用于判断是否重签，不自拼 URL）
  SIGN_URL_TTL_MS: 3600 * 1000,

  // 错误码分流（契约 §0.3）
  RETRY_CODES: [2003, 2004, 3001, 9000],   // 展示「重试」入口
  FIELD_ERROR_CODES: [2001, 2002],         // 回到表单定位对应内容
  CODE_LOGIN_EXPIRED: 1002,                // 触发重新 login
  CODE_NOT_FOUND: 1004,                    // 删除/编辑场景视为「已不存在」

  // OSS 缩略图白名单 process（契约 §1.3 sign）
  PROCESS_THUMB: 'image/resize,w_300',
  PROCESS_FULL: 'image/resize,w_1600'
};
