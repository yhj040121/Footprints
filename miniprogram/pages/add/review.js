// 审核段（契约 §1.2 imageSubmit/imagePoll、§6 定值；S6-R2：原图已先传隔离区，对对象本体送审，不再压缩/传 base64 副本）
// 每张照片上传成功即独立 imageSubmit；断点续跑时仅补交 uploaded，不重复提交 checking；
// 每次 imagePoll 返回先判「单张 40s（自该张提交起）/ 阶段 50s（自首张提交起）」截止再接受 pass，超期返回按 2003
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const constants = require('../../utils/constants');
const request = require('../../utils/request');

const CloudError = request.CloudError;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  // 单张送审：由上传成功回调立即触发，也供断点续跑补交 uploaded 照片。
  submitReview(photo, ctx) {
    if (ctx) this.throwIfCancelled(ctx);
    const submitAt = Date.now();
    this._reviewSubmitAt[photo.photoId] = submitAt;
    this.setPhoto(photo.uid, { status: 'checking' });
    return request.callFunction('secCheck', {
      action: 'imageSubmit',
      photoId: photo.photoId
    }).then((data) => {
      if (ctx) this.throwIfCancelled(ctx);
      return data;
    }).catch((err) => {
      delete this._reviewSubmitAt[photo.photoId];
      this.setPhoto(photo.uid, { status: 'uploaded' });
      throw err;
    });
  },

  // 仅补交尚未 imageSubmit 的 uploaded 照片；checking 照片沿用上传流水线已记录的提交时间。
  // 返回阶段起点时间戳（= 首张提交发起时间），供 pollReviews 判定阶段 50s 截止
  async submitReviews(toCheck, ctx) {
    this.throwIfCancelled(ctx);
    let failed = null;
    const now = Date.now();
    toCheck.forEach((p) => {
      if (p.status === 'checking' && !this._reviewSubmitAt[p.photoId]) {
        this._reviewSubmitAt[p.photoId] = now;
      }
    });
    await Promise.all(toCheck.filter((p) => p.status === 'uploaded').map((p) =>
      this.submitReview(p, ctx).catch((err) => {
        if (!failed) failed = err;
      })
    ));
    this.throwIfCancelled(ctx);
    if (failed) throw failed;
    const submitTimes = toCheck.map((p) => this._reviewSubmitAt[p.photoId]).filter(Boolean);
    return submitTimes.length ? Math.min.apply(null, submitTimes) : Date.now();
  },

  // 批量轮询（固定 2s，§6）：每次返回先判截止（单张 40s / 阶段 50s 自首张提交起算），
  // 再接受 pass/reject/error；超期才返回的结果一律按 2003 处理
  async pollReviews(toCheck, ctx, stageStartAt) {
    const pending = {};
    toCheck.forEach((p) => { pending[p.photoId] = p; });
    let rejectedCount = 0;
    let timeoutCount = 0;
    let errorCount = 0;

    try {
      while (Object.keys(pending).length) {
        this.throwIfCancelled(ctx);
        if (Date.now() - stageStartAt >= constants.REVIEW_STAGE_TIMEOUT_MS) {
          throw new CloudError(2003, '审核超时，暂无法保存，请稍后再试');
        }
        await wait(constants.POLL_INTERVAL_MS);
        this.throwIfCancelled(ctx);

        const res = await request.callFunction('secCheck', {
          action: 'imagePoll',
          checkIds: Object.keys(pending)
        });
        const now = Date.now();
        ((res && res.results) || []).forEach((r) => {
          const p = pending[r.checkId];
          if (!p) return;
          // 截止判定先于接受任何终态：单张 40s（自该张提交起）/ 阶段 50s（自首张提交起）
          const expired =
            now - (this._reviewSubmitAt[p.photoId] || stageStartAt) > constants.PHOTO_POLL_TIMEOUT_MS ||
            now - stageStartAt > constants.REVIEW_STAGE_TIMEOUT_MS;
          if (expired) {
            this.setPhoto(p.uid, { status: 'uploaded' }); // 已传未审：重试时同 photoId 重新送审
            delete this._reviewSubmitAt[p.photoId];
            timeoutCount++;
            delete pending[r.checkId];
          } else if (r.status === 'pass') {
            this.setPhoto(p.uid, { status: 'checked' });
            delete this._reviewSubmitAt[p.photoId];
            delete pending[r.checkId];
          } else if (r.status === 'reject') {
            this.setPhoto(p.uid, { status: 'review-failed' });
            delete this._reviewSubmitAt[p.photoId];
            rejectedCount++;
            delete pending[r.checkId];
          } else if (r.status === 'error') {
            this.setPhoto(p.uid, { status: 'uploaded' }); // 重试时同 photoId 重新送审
            delete this._reviewSubmitAt[p.photoId];
            errorCount++;
            delete pending[r.checkId];
          }
        });
        // S7-R4：审核过程无感知，不再更新「检测中剩 N 张」等阶段性文案
      }
    } catch (err) {
      // 轮询中断（阶段超时/网络/取消）：仍 pending 的照片打回 uploaded，不留卡在 checking 的残留态
      Object.keys(pending).forEach((id) => {
        this.setPhoto(pending[id].uid, { status: 'uploaded' });
        delete this._reviewSubmitAt[id];
      });
      throw err;
    }

    if (rejectedCount) throw new CloudError(2002, '有照片未通过安全检测，请更换后再试');
    if (timeoutCount) throw new CloudError(2003, '审核超时，暂无法保存，请稍后再试');
    if (errorCount) throw new CloudError(2004, '暂无法保存，请稍后再试');
  }
};
