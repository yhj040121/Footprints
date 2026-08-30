// 图片工具：选图校验（FR-05）+ 头像压缩转 base64 dataURL（契约 §2.1 S6 修正：≤64KB 写 user.avatarUrl）
// S6-R2 起保存链路不再压缩审核副本（审核直接作用于隔离区原图对象，§4.1 撤销项）
const constants = require('./constants');
const uuidUtil = require('./uuid');

const uuid = uuidUtil.uuid; // 标准 UUID v4（utils/uuid.js 单一来源，与云函数校验规则一致）

function extOf(filePath) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath || '');
  return m ? m[1].toLowerCase() : '';
}

function statSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => resolve(res.size || 0),
      fail: () => resolve(0)
    });
  });
}

function compressOnce(src, options) {
  return new Promise((resolve, reject) => {
    wx.compressImage(Object.assign({ src }, options, {
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    }));
  });
}

// 超 30MB 大图（ProRAW/高像素直出/长截图）自动压到限内再收（S8-R2，用户无感知）：
// 先只压质量不动尺寸（85→70），仍超再逐步缩边长（0.6/0.4/0.25，quality 80）；
// 压缩失败或压不到位返回 null，由调用方静默跳过
async function shrinkToLimit(filePath) {
  let srcW = 0;
  try {
    const info = await getImageInfo(filePath);
    srcW = Math.max(1, info.width || 1);
  } catch (e) { /* 读不出尺寸时只走压质量步 */ }
  const steps = [{ quality: 85 }, { quality: 70 }];
  if (srcW) {
    [0.6, 0.4, 0.25].forEach((r) => {
      steps.push({ quality: 80, compressedWidth: Math.max(1, Math.round(srcW * r)) });
    });
  }
  for (let i = 0; i < steps.length; i++) {
    let out = '';
    try {
      out = await compressOnce(filePath, steps[i]);
    } catch (e) { continue; } // 该步不支持（如部分平台 png 压质量）：试下一步
    const size = await statSize(out);
    if (size > 0 && size <= constants.MAX_PHOTO_BYTES) {
      return { tempFilePath: out, size };
    }
  }
  return null;
}

// FR-05：相册多选或拍照；单张 ≤30MB（S8-R2 放宽，存原图），格式 jpg/png/webp/heic；
// 超 30MB 自动压缩到限内再收（用户无感知），压不到或格式不符则静默跳过
// 返回 { items: [{ photoId, tempFilePath, size, ext }], rejectedCount }
// 契约 §4.2：每次选图/换图/删后重选都生成新 photoId
function chooseImages(maxCount) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: maxCount,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const items = [];
        let rejectedCount = 0;
        for (const f of (res.tempFiles || [])) {
          const ext = extOf(f.tempFilePath);
          const okExt = constants.PHOTO_EXTS.indexOf(ext) >= 0;
          if (okExt && f.size > 0 && f.size <= constants.MAX_PHOTO_BYTES) {
            items.push({ photoId: uuid(), tempFilePath: f.tempFilePath, size: f.size, ext });
            continue;
          }
          if (!okExt) { rejectedCount++; continue; } // 格式不符：静默跳过
          const shrunk = await shrinkToLimit(f.tempFilePath);
          if (shrunk) {
            // 压缩产物可能是转码后的 jpg（如 heic/png 入参），ext 以产物为准
            items.push({
              photoId: uuid(),
              tempFilePath: shrunk.tempFilePath,
              size: shrunk.size,
              ext: extOf(shrunk.tempFilePath) || ext
            });
          } else {
            rejectedCount++;
          }
        }
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

function avatarMime(info, filePath) {
  const type = String((info && info.type) || extOf(filePath) || '').toLowerCase();
  if (type === 'jpg' || type === 'jpeg') return 'image/jpeg';
  if (type === 'png') return 'image/png';
  if (type === 'webp') return 'image/webp';
  return '';
}

function toDataUrl(mime, base64) {
  return mime + ';base64,' + base64;
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
// page 上下文里需放 <canvas type="2d" id="...">（隐藏画布）；头像统一输出为方形画布，
// 原图按 contain 完整居中，不使用 cover 裁切，避免微信头像等来源被局部放大。
// 质量递减导出，仍超 64KB 则边长打 8 折重试（最多再 3 次）
// 返回 'data:image/jpeg;base64,...' 字符串（总长 ≤64KB）
async function createAvatarDataUrl(page, canvasId, filePath) {
  const info = await getImageInfo(filePath);

  // 微信头像通常已是体积很小的标准方图。满足限制时直接保存原文件，完全绕过画布，
  // 可避免不同基础库对离屏 canvas 导出坐标解释不一致而产生的局部裁切/放大。
  const mime = avatarMime(info, filePath);
  if (mime) {
    const originalBase64 = await readBase64(filePath);
    const originalDataUrl = toDataUrl('data:' + mime, originalBase64);
    if (originalDataUrl.length <= constants.AVATAR_MAX_BYTES) return originalDataUrl;
  }

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

  // 使用图片节点的实际尺寸优先，getImageInfo 作为兜底；完整缩放到固定方形画布内。
  const sourceWidth = Math.max(1, img.width || info.width || 1);
  const sourceHeight = Math.max(1, img.height || info.height || 1);

  // CSS 尺寸、canvas backing store 和导出区域统一为 256×256，避免客户端按 CSS 坐标
  // 截取 backing store 时只导出局部区域。
  const side = constants.AVATAR_MAX_SIDE;
  const scale = Math.min(side / sourceWidth, side / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  const x = Math.round((side - drawWidth) / 2);
  const y = Math.round((side - drawHeight) / 2);
  canvas.width = side;
  canvas.height = side;
  ctx.clearRect(0, 0, side, side);
  ctx.fillStyle = '#EFE9DC';
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(img, x, y, drawWidth, drawHeight);

  // 固定尺寸下逐级降低 JPEG 质量；256×256 在最低质量时可稳定压到 64KB 内。
  const qualities = [0.92, 0.78, 0.64, 0.50, 0.36, 0.24, 0.14];
  for (let i = 0; i < qualities.length; i++) {
    const tempPath = await exportJpg(page, canvas, side, side, qualities[i]);
    const base64 = await readBase64(tempPath);
    const dataUrl = 'data:image/jpeg;base64,' + base64;
    if (dataUrl.length <= constants.AVATAR_MAX_BYTES) return dataUrl;
  }
  throw new Error('头像过大，压缩后仍超过限制，请更换图片');
}

module.exports = {
  extOf,
  chooseImages,
  createAvatarDataUrl
};
