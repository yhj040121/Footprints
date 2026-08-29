// 上传段（契约 §1.3 issueUpload S6-R2：审核之前签发隔离区上传表单 → wx.uploadFile 原图直传隔离区，进度 n/9）
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const request = require('../../utils/request');
const oss = require('../../utils/oss');

const CloudError = request.CloudError;

module.exports = {
  // 单张上传失败重试（FR-05 验收 3 / §4.3）：同 photoId 重新 issueUpload（复用同隔离 key 重新签名）再传
  onPhotoRetry(e) {
    const uid = e.currentTarget.dataset.uid;
    const photo = this.data.photos.find((p) => p.uid === uid);
    if (!photo || photo.status !== 'upload-failed') return;
    this.setPhoto(uid, { status: 'uploading', progress: 0 }); // 同步占位，防连点重入
    this.issueAndUpload([photo])
      .catch(() => this.setPhoto(uid, { status: 'upload-failed' }));
    // 补传成功后照片处于 uploaded，由下一次「保存/重试」继续送审与提交（runSave 按状态断点续跑）
  },

  // issueUpload → wx.uploadFile 原图逐张直传隔离区（§1.3 / §4.1）；
  // 同 photoId 重试服务端复用同一隔离 key 重签（覆盖重传同一 key，不产生第二份）
  async issueAndUpload(toUpload) {
    this.refreshUploadProgress();
    const data = await request.callFunction('ossSts', {
      action: 'issueUpload',
      items: toUpload.map((p) => ({ photoId: p.photoId, ext: p.ext, date: this.data.date }))
    });
    const byPhotoId = {};
    ((data && data.uploads) || []).forEach((u) => { byPhotoId[u.photoId] = u; });

    let failed = 0;
    await Promise.all(toUpload.map((p) => {
      const upload = byPhotoId[p.photoId];
      if (!upload) {
        failed++;
        this.setPhoto(p.uid, { status: 'upload-failed' });
        return Promise.resolve();
      }
      this.setPhoto(p.uid, { status: 'uploading', progress: 0 });
      return oss.uploadPhoto(upload, p.tempFilePath, (percent) => {
        this.setPhoto(p.uid, { progress: percent });
        this.refreshUploadProgress();
      }).then(() => {
        this.setPhoto(p.uid, { status: 'uploaded', progress: 100 });
        this.refreshUploadProgress();
      }).catch(() => {
        failed++;
        this.setPhoto(p.uid, { status: 'upload-failed' });
        this.refreshUploadProgress();
      });
    }));

    // 全部落定后刷一次最终 n/n，并用 setData 回调确认渲染完成，随后才进入送审/提交态（进度收尾口径）
    await this.refreshUploadProgress();

    if (failed) {
      const e = new CloudError(3001, failed + ' 张照片上传失败，可重试');
      e.uploadFailed = true;
      throw e;
    }
  },

  // 上传进度 n/N：N = 本次表单内全部新照片，n = 已传完隔离区（含已过审）的新照片；
  // 返回 Promise 在 setData 渲染回调后 resolve（供 runSave 等确认渲染完再切「检测中」）
  refreshUploadProgress() {
    const news = this.data.photos.filter((p) => !p.isOld);
    const text = news.length
      ? '照片上传中 ' + news.filter((p) =>
          p.status === 'uploaded' || p.status === 'checking' || p.status === 'checked'
        ).length + '/' + news.length
      : '';
    return new Promise((resolve) => {
      if (!text) { resolve(); return; }
      this.setData({ saveText: text }, () => resolve());
    });
  }
};
