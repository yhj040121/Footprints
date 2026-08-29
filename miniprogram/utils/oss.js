// OSS 直传（契约 §1.3 issueUpload → wx.uploadFile PostObject 逐 key 预签名表单）
// 前端只持有逐 key 表单（key/policy/OSSAccessKeyId/signature/securityToken），
// accessKeySecret 永不下发；前端不得自拼任何签名。
const config = require('./config');

// upload: issueUpload 返回的单项 { photoId, key, host, policy, signature, OSSAccessKeyId, securityToken }
// filePath: 原始照片临时路径（原图直传，不是审核副本）
// onProgress(percent 0~100)
// 失败 reject(Error)，由调用方按「单张失败可单独重试」处理（FR-05）
function uploadPhoto(upload, filePath, onProgress) {
  // mock 模式：不真正发网络请求；把选中照片持久化到本地并登记 key→路径，供 mock sign 展示
  if (config.USE_MOCK) {
    const mock = require('./mock/index');
    return new Promise((resolve, reject) => {
      let p = 0;
      const timer = setInterval(() => {
        p += 25;
        if (onProgress) onProgress(Math.min(p, 100));
        if (p >= 100) {
          clearInterval(timer);
          wx.getFileSystemManager().saveFile({
            tempFilePath: filePath,
            success: (res) => {
              mock.registerAsset(upload.key, res.savedFilePath);
              resolve({ key: upload.key });
            },
            fail: () => resolve({ key: upload.key }) // 持久化失败不阻塞 mock 流程
          });
        }
      }, 120);
    });
  }

  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: upload.host,
      filePath,
      name: 'file',
      formData: {
        key: upload.key,
        policy: upload.policy,
        OSSAccessKeyId: upload.OSSAccessKeyId,
        signature: upload.signature,
        'x-oss-security-token': upload.securityToken,
        success_action_status: '200'
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ key: upload.key });
        } else {
          reject(new Error('OSS upload failed: ' + res.statusCode));
        }
      },
      fail: (err) => reject(err)
    });
    if (onProgress && task && task.onProgressUpdate) {
      task.onProgressUpdate((res) => onProgress(res.progress));
    }
  });
}

module.exports = { uploadPhoto };
