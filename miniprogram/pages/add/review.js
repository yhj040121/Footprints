// 审核段（契约 §1.2 imageSubmit/imagePoll、§6 定值；S6-R2：原图已先传隔离区，对对象本体送审，不再压缩/传 base64 副本）
// imageSubmit 9 张真并行（Promise.all），每张记录自己的提交发起时间；
// 每次 imagePoll 返回先判「单张 40s（自该张提交起）/ 阶段 50s（自首张提交起）」截止再接受 pass，超期返回按 2003
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const constants = require('../../utils/constants');
const request = require('../../utils/request');

const CloudError = request.CloudError;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  // 全部待审照片真并行 imageSubmit（每张仅传 photoId，§1.2 S6-R2）；
  // 返回阶段起点时间戳（= 首张提交发起时间），供 pollReviews 判定阶段 50s 截止
  async submitReviews(toCheck, ctx) {
    this.throwIfCancelled(ctx);
    let failed = null;
    let stageStartAt = 0;
    await Promise.all(toCheck.map((p) => {
      p._submitAt = Date.now(); // 每张记录自己的提交发起时间：单张 40s 自该张提交起算（契约 §6）
      if (!stageStartAt || p._submitAt < stageStartAt) stageStartAt = p._submitAt;
      this.setPhoto(p.uid, { status: 'checking' });
      return request.callFunction('secCheck', {
        action: 'imageSubmit',
        photoId: p.photoId
      }).catch((err) => {
        this.setPhoto(p.uid, { status: 'uploaded' }); // 送审失败打回 uploaded：重试时同 photoId 重新送审
        if (!failed) failed = err;
      });
    }));
    this.throwIfCancelled(ctx);
    if (failed) throw failed;
    return stageStartAt;
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
            now - p._submitAt > constants.PHOTO_POLL_TIMEOUT_MS ||
            now - stageStartAt > constants.REVIEW_STAGE_TIMEOUT_MS;
          if (expired) {
            this.setPhoto(p.uid, { status: 'uploaded' }); // 已传未审：重试时同 photoId 重新送审
            timeoutCount++;
            delete pending[r.checkId];
          } else if (r.status === 'pass') {
            this.setPhoto(p.uid, { status: 'checked' });
            delete pending[r.checkId];
          } else if (r.status === 'reject') {
            this.setPhoto(p.uid, { status: 'review-failed' });
            rejectedCount++;
            delete pending[r.checkId];
          } else if (r.status === 'error') {
            this.setPhoto(p.uid, { status: 'uploaded' }); // 重试时同 photoId 重新送审
            errorCount++;
            delete pending[r.checkId];
          }
        });
        const left = Object.keys(pending).length;
        if (left) this.setData({ saveText: '图片检测中，剩 ' + left + ' 张…' });
      }
    } catch (err) {
      // 轮询中断（阶段超时/网络/取消）：仍 pending 的照片打回 uploaded，不留卡在 checking 的残留态
      Object.keys(pending).forEach((id) => this.setPhoto(pending[id].uid, { status: 'uploaded' }));
      throw err;
    }

    if (rejectedCount) throw new CloudError(2002, '有照片未通过安全检测，请更换后再试');
    if (timeoutCount) throw new CloudError(2003, '审核超时，暂无法保存，请稍后再试');
    if (errorCount) throw new CloudError(2004, '暂无法保存，请稍后再试');
  }
};
