/**
 * lib/constants —— 常量与确定性 _id 计算（契约 §2.2/§3.1/§5.1 S6 修正/§6）
 * S7-R4：预设标签清单已移除（commitSave/commitEdit 的 tags 全部须命中本人 user.customTags，
 *         上限 ≤3 个、单个 ≤6 字，见 lib/validate.js）。
 */
const crypto = require('crypto');

const FIELD_WHITELIST = ['note', 'place', 'customTag'];
const MAX_TEXT_CHARS = 500;
const MAX_TEXT_BYTES = 2500; // msgSecCheck 单次上限
const MAX_CUSTOM_TAG_CHARS = 6; // S7-R4：自定义标签新建单个 1~6 字（删除历史 7~10 字存量标签不受限）
// S6-R2：真 UUID v4（版本位 4、variant 8/9/a/b）；photoId/clientSaveId 一律此格式
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^travel\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{16}\.(jpg|jpeg|png|webp|heic)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 确定性 footprint 文档 _id = hash(openid + clientSaveId)（十六进制，契约 §5.1 S6 修正）。
 * 同一次保存（同 clientSaveId）的重复 commitSave → 同一 _id：add 指定 _id 主键冲突即幂等命中，
 * 消除「检查-写库-写标记」三步间的并发/中断窗口。
 */
function deterministicFootprintId(openid, clientSaveId) {
  return crypto.createHash('sha256').update(`${openid}:${clientSaveId}`).digest('hex').slice(0, 32);
}

module.exports = {
  FIELD_WHITELIST,
  MAX_TEXT_CHARS,
  MAX_TEXT_BYTES,
  MAX_CUSTOM_TAG_CHARS,
  UUID_RE,
  KEY_RE,
  DATE_RE,
  deterministicFootprintId,
};
