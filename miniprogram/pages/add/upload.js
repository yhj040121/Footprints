// 上传段（契约 §1.3 issueUpload S6-R2：签发隔离区上传表单 → 每张原图上传成功后立即送审）
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
    this.issueAndUpload([photo]).catch(() => {
      // 保存（可将其并入重试中的单张）与普通重试并发：竞态弱——photo 状态可能已被保存链改写，
      // 仅当仍停留在 uploading 才回滚为 upload-failed；若已转为 checking/checked 则保持不动
      const current = this.data.photos.find((p) => p.uid === uid);
      if (current && current.status === 'uploading') this.setPhoto(uid, { status: 'upload-failed' });
    });
    // 补传成功会立即 imageSubmit；下一次「保存/重试」从 checking/uploaded 状态继续轮询或送审
  },

  // issueUpload → wx.uploadFile 原图并行直传隔离区（§1.3 / §4.1）；
  // 单张成功即立刻 imageSubmit，不等待同批慢图，形成 upload → submit 的逐张流水线。
  // 同 photoId 重试服务端复用同一隔离 key 重签（覆盖重传同一 key，不产生第二份）
  async issueAndUpload(toUpload, ctx) {
    const data = await request.callFunction('ossSts', {
      action: 'issueUpload',
      items: toUpload.map((p) => ({
        photoId: p.photoId,
        ext: p.ext,
        date: (ctx && ctx.date) || this.data.date
      }))
    });
    if (ctx) this.throwIfCancelled(ctx);
    const byPhotoId = {};
    ((data && data.uploads) || []).forEach((u) => { byPhotoId[u.photoId] = u; });

    let failed = 0;
    let reviewFailed = null;
    await Promise.all(toUpload.map((p) => {
      const upload = byPhotoId[p.photoId];
      if (!upload) {
        failed++;
        this.updatePhoto(p, { status: 'upload-failed' });
        return Promise.resolve();
      }
      this.updatePhoto(p, { status: 'uploading', progress: 0 });
      return oss.uploadPhoto(upload, p.tempFilePath, (percent) => {
        this.updatePhoto(p, { progress: percent });
      }).then(() => {
        this.updatePhoto(p, { status: 'uploaded', progress: 100 });
        return this.submitReview(p, ctx).catch((err) => {
          if (!reviewFailed) reviewFailed = err;
        });
      }, () => {
        failed++;
        this.updatePhoto(p, { status: 'upload-failed' });
      });
    }));

    if (ctx) this.throwIfCancelled(ctx);

    if (failed) {
      const e = new CloudError(3001, failed + ' 张照片上传失败，可重试');
      e.uploadFailed = true;
      throw e;
    }
    if (reviewFailed) throw reviewFailed;
  }
};
