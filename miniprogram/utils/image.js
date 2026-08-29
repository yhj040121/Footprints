// 图片工具：选图校验（FR-05）+ 头像压缩转 base64 dataURL（契约 §2.1 S6 修正：≤64KB 写 user.avatarUrl）
// S6-R2 起保存链路不再压缩审核副本（审核直接作用于隔离区原图对象，§4.1 撤销项）
const constants = require('./constants');
const uuidUtil = require('./uuid');

const uuid = uuidUtil.uuid; // 标准 UUID v4（utils/uuid.js 单一来源，与云函数校验规则一致）

function extOf(filePath) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath || '');
  return m ? m[1].toLowerCase() : '';
}

// FR-05：相册多选或拍照；单张 ≤10MB，格式 jpg/png/webp/heic
// 返回 { items: [{ photoId, tempFilePath, size, ext }], rejectedCount }
// 契约 §4.2：每次选图/换图/删后重选都生成新 photoId
function chooseImages(maxCount) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: maxCount,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const items = [];
        let rejectedCount = 0;
        (res.tempFiles || []).forEach((f) => {
          const ext = extOf(f.tempFilePath);
          const okExt = constants.PHOTO_EXTS.indexOf(ext) >= 0;
          const okSize = f.size > 0 && f.size <= constants.MAX_PHOTO_BYTES;
          if (okExt && okSize) {
            items.push({ photoId: uuid(), tempFilePath: f.tempFilePath, size: f.size, ext });
          } else {
            rejectedCount++;
          }
        });
        resolve({ items, rejectedCount });
      },
      fail: (err) => {
        // 用户取消不算错误
        if (err && /cancel/.test(err.errMsg || '')) {
          resolve({ items: [], rejectedCount: 0, cancelled: true });
        } else {
          reject(err);
        }
      }
    });
  });
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject });
  });
}

function readBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: reject
    });
  });
}

function exportJpg(page, canvas, width, height, quality) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width,
      height,
      destWidth: width,
      destHeight: height,
      fileType: 'jpg',
      quality,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    }, page);
  });
}

// 头像压缩转 base64 dataURL（FR-14 验收 2 / 契约 §2.1 S6 修正）：
// chooseAvatar 返回的是临时路径，杀进程即失效 → 压缩后转 dataURL 写 user.avatarUrl，跨进程持久显示。
// page 上下文里需放 <canvas type="2d" id="...">（隐藏画布）；质量递减导出，仍超 64KB 则最长边打 8 折重试（最多再 3 次）
// 返回 'data:image/jpeg;base64,...' 字符串（总长 ≤64KB）
async function createAvatarDataUrl(page, canvasId, filePath) {
  const info = await getImageInfo(filePath);

  const query = page.createSelectorQuery();
  const canvas = await new Promise((resolve, reject) => {
    query.select('#' + canvasId)
      .fields({ node: true, size: true })
      .exec((res) => {
        if (res && res[0] && res[0].node) resolve(res[0].node);
        else reject(new Error('canvas not found'));
      });
  });
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = filePath;
  });

  // 质量到底仍超限 → 最长边打 8 折重绘重试，最多再 3 次
  let maxSide = constants.AVATAR_MAX_SIDE;
  for (let round = 0; round <= 3; round++) {
    const scale = Math.min(1, maxSide / Math.max(info.width, info.height));
    const width = Math.max(1, Math.round(info.width * scale));
    const height = Math.max(1, Math.round(info.height * scale));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    // 质量递减导出，每次都拼完整 dataURL 复检总长（base64 为 ASCII，字符数即字节数）
    let quality = 0.92;
    for (let i = 0; i < 6; i++) {
      const tempPath = await exportJpg(page, canvas, width, height, quality);
      const base64 = await readBase64(tempPath);
      const dataUrl = 'data:image/jpeg;base64,' + base64;
      if (dataUrl.length <= constants.AVATAR_MAX_BYTES) return dataUrl;
      quality = Math.max(0.2, quality - 0.15);
    }
    maxSide = Math.max(64, Math.round(maxSide * 0.8));
  }
  throw new Error('头像过大，压缩后仍超过限制，请更换图片');
}

module.exports = {
  extOf,
  chooseImages,
  createAvatarDataUrl
};
