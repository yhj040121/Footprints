// 审核段（契约 §1.2 imageSubmit/imagePoll、§6 定值；S6-R2：已先传隔离区，对对象本体送审）
// 每张照片上传成功即独立 imageSubmit；断点续跑时仅补交 uploaded，不重复提交 checking；
// 轮询固定 2s（§6）；阶段 50s 截止是数据保护——服务端权威终态（pass/reject）超期同样消费，
// 只把仍 pending/error 的任务按 2003/2004 清掉；单张 40s 定值保留在 constants（兼容旧语义）
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const constants = require('../../utils/constants');
const request = require('../../utils/request');

const CloudError = request.CloudError;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 阶段截止判定：自 stageStartAt 起 ≥50s 视为已到截止点（先于接受终态执行） */
function stageExpired(stageStartAt) {
  return Date.now() - stageStartAt > constants.REVIEW_STAGE_TIMEOUT_MS;
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
      if (ctx && ctx.cancelled) return Promise.reject(err); // 非终止性错误：状态已由流水线处理
      this.setPhoto(photo.uid, { status: 'uploaded' }); // 送审失败回退 uploaded，下次保存补交重送
      throw err;
    });
  },

  // 仅补交尚未 imageSubmit 的 uploaded 照片；checking 照片沿用上传流水线已记录的提交时间。
  // 单张失败不中断同批（收集失败的除外）；返回阶段起点时间戳 = 首张提交发起时间
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

  // 批量轮询（固定 2s，§6）：每次先判阶段 50s 截止再接受终态；超期时 pass/reject 权威终态
  // 照常消费，pending/error 按 2003/2004 处理；轮询中断 → 仍 pending 打回 uploaded
  async pollReviews(toCheck, ctx, stageStartAt) {
    const pending = {};
    toCheck.forEach((p) => { pending[p.photoId] = p; });
    let rejectedCount = 0;
    let timeoutCount = 0;
    let errorCount = 0;

    try {
      while (Object.keys(pending).length) {
        this.throwIfCancelled(ctx);
        if (stageExpired(stageStartAt)) {
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
          const expired = now - stageStartAt > constants.REVIEW_STAGE_TIMEOUT_MS;
          if (expired) {
            // 超期：pass/reject 为服务端权威终态，照常消费（防 9 图慢审在 50s 截断时功亏一篑）
            if (r.status === 'pass') {
              this.setPhoto(p.uid, { status: 'checked' });
              delete this._reviewSubmitAt[p.photoId];
              delete pending[r.checkId];
              return;
            }
            if (r.status === 'reject') {
              this.setPhoto(p.uid, { status: 'review-failed' });
              delete this._reviewSubmitAt[p.photoId];
              rejectedCount++;
              delete pending[r.checkId];
              return;
            }
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
  },

  // 公开入口：返回 { stageStartAt, promise }——阶段起点取「最早一张的提交发起时间」后立即启动轮询，
  // 与送审请求并行推进（轮询固定 2s 间隔，等服务端落结果，不等送审请求返回）
  startPollReviews(toCheck, ctx) {
    this.throwIfCancelled(ctx);
    const now = Date.now();
    toCheck.forEach((p) => {
      if (!this._reviewSubmitAt[p.photoId]) this._reviewSubmitAt[p.photoId] = now;
    });
    const submitTimes = toCheck.map((p) => this._reviewSubmitAt[p.photoId]).filter(Boolean);
    const stageStartAt = submitTimes.length ? Math.min.apply(null, submitTimes) : now;
    const promise = this.pollReviews(toCheck, ctx, stageStartAt);
    return { stageStartAt, promise };
  }
};