/**
 * lib/oss —— OSS 客户端（契约 §1.2：OSS 四元组，无 ROLE_ARN）
 *
 * 密钥仅来自环境变量（OSS_AK_ID / OSS_AK_SECRET / OSS_BUCKET / OSS_REGION），
 * 代码与仓库绝不出现真实值（FR-16 验收 1）。
 */
const OSS = require('ali-oss');
const { BizError } = require('./errors');

const ENV = {
  OSS_AK_ID: process.env.OSS_AK_ID,
  OSS_AK_SECRET: process.env.OSS_AK_SECRET,
  OSS_BUCKET: process.env.OSS_BUCKET,
  OSS_REGION: process.env.OSS_REGION,
};

function ossClient() {
  if (!ENV.OSS_AK_ID || !ENV.OSS_AK_SECRET || !ENV.OSS_BUCKET || !ENV.OSS_REGION) {
    throw new BizError(3001);
  }
  return new OSS({
    region: ENV.OSS_REGION,
    accessKeyId: ENV.OSS_AK_ID,
    accessKeySecret: ENV.OSS_AK_SECRET,
    bucket: ENV.OSS_BUCKET,
    secure: true, // S7-R2：签名 URL 用 https（Node 云函数侧 https 客户端拒绝 http 协议）
  });
}

module.exports = { ENV, ossClient };
