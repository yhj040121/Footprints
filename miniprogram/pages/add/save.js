// 提交段（契约 §4.1 保存时序、§5.1 clientSaveId 幂等、§0.3 错误码分流、FR-13 编辑保存、§5.4 传输异常终态）
// S8 乐观保存：新增走「草稿链」--点保存立即落本地草稿 + toast + 跳时间线，审核/上传/入库在后台推进；
// 编辑走「同步链」（runSave，页面等待弹层）--详情页数据一致性依赖提交完成，不适合乐观化。
// 两条链共享 review.js/upload.js（均按传入照片数组工作，快照对象与页面 data 对象均兼容；
// setPhoto 按 uid 找不到页面照片时 no-op，草稿链因此天然不影响已重置的表单）。
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const request = require('../../utils/request');
const uuidUtil = require('../../utils/uuid');
const db = require('../../utils/db');
const drafts = require('../../utils/drafts');

/** 后台草稿链落定（成功删除/失败标记）后刷新时间线（若其在页面栈中） */
function refreshTimeline() {
  try {
    const pages = getCurrentPages() || [];
    pages.forEach((p) => {
      if (p && p.route === 'pages/timeline/timeline' && typeof p.loadFirst === 'function') {
        p.loadFirst();
      }
    });
  } catch (e) { /* 栈不可用时由 timeline onShow 兜底刷新 */ }
}

module.exports = {
  onSave() {
    if (this.data.saving) return;
    const place = (this.data.place || '').trim();
    if (!place) {
      this.setData({ placeError: '请填写地点' });
      return;
    }
    if (this.data.photos.some((p) => p.status === 'review-failed')) {
      wx.showToast({ title: '有照片未通过检测，请更换后再保存', icon: 'none' });
      return;
    }
    // 单张「失败 · 重试」补传在途时不进入保存链路，等其落定
    // （checking 不挡：中断/取消残留的 checking 会随 toCheck 断点续跑重新送审）
    if (this.data.photos.some((p) => p.status === 'uploading')) {
      wx.showToast({ title: '照片上传中，请稍候', icon: 'none' });
      return;
    }
    // §5.1：同一次保存的所有重试复用 clientSaveId；换了内容再点保存才生成新的（标准 UUID v4）
    if (!this._clientSaveId || this._formDirty) {
      this._clientSaveId = uuidUtil.uuid();
      this._formDirty = false;
    }
    if (this.data.isEdit) return this.startEditSave();
    return this.startDraftSave();
  },

  // ---------- 编辑：同步等待链（原保存链，弹层等待 + 失败弹层重试） ----------

  startEditSave() {
    const ctx = { cancelled: false, round: ++this._saveSeq, isEdit: true };
    this._saveCtx = ctx;
    this.setData({ saving: true, saveError: null });
    this.runSave(ctx).catch((err) => this.handleSaveError(err, ctx));
  },

  onSaveRetry() {
    if (this.data.saving) return;
    if (this.data.isEdit) return this.startEditSave();
    return this.startDraftSave(); // 草稿链失败后表单保留：再点保存按草稿链重试（同 clientSaveId 幂等）
  },

  // 失败弹层上的「取消/关闭」：终止在途编辑链并退回表单（内容保留）
  onSaveCancel() {
    this.cancelSave();
  },

  cancelSave() {
    // 只取消编辑链（草稿链在用户离开后仍需后台推进，不受影响）
    if (this._saveCtx && this._saveCtx.isEdit) this._saveCtx.cancelled = true;
    this._saveCtx = null;
    this.setData({ saving: false, saveError: null });
  },

  // 取消判定：显式 cancelled 才终止；identity 校验仅约束编辑链
  // （草稿链不注册 _saveCtx，多条草稿可并行后台推进，互不误杀）
  throwIfCancelled(ctx) {
    if (ctx && ctx.cancelled) {
      const e = new Error('cancelled');
      e.cancelled = true;
      throw e;
    }
    if (ctx && ctx.isEdit && ctx !== this._saveCtx) {
      const e = new Error('cancelled');
      e.cancelled = true;
      throw e;
    }
  },

  // ---------- 新增：乐观草稿链 ----------

  // 立即：快照 + 草稿落盘 + toast + 表单重置 + 跳时间线；后台：runDraftSave 推进全链
  startDraftSave() {
    // §5.1：同一次编辑重试沿用 clientSaveId（幂等）；内容变更或 2005 后已置空时重新生成
    if (!this._clientSaveId || this._formDirty) {
      this._clientSaveId = uuidUtil.uuid();
      this._formDirty = false;
    }
    const draftId = 'draft_' + Date.now() + '_' + ((Math.random() * 1e6) | 0);
    const clientSaveId = this._clientSaveId;
    const snap = this.buildSnapshot();
    drafts.upsert(Object.assign({
      id: draftId,
      clientSaveId,
      status: 'syncing',
      createdAt: Date.now()
    }, snap));

    // 立即反馈：用户马上看到「已保存」并回到时间线（草稿已可见，带「同步中」徽标）
    wx.showToast({ title: '已保存', icon: 'success' });
    this.resetForm();
    setTimeout(() => wx.switchTab({ url: '/pages/timeline/timeline' }), 600);

    // 后台链：页面已重置/用户已离开均不影响（链路持有快照；tab 页不销毁，定时器与请求继续）
    const ctx = {
      cancelled: false,
      round: ++this._saveSeq,
      draftId,
      clientSaveId,
      photoIds: snap.photos.map((p) => p.photoId)
    };
    this.runDraftSave(ctx, snap).then(
      () => this.finishDraft(ctx),
      (err) => this.failDraft(ctx, snap, err)
    );
  },

  // 保存瞬间的表单快照（草稿链全程只用快照，不读页面 data）
  buildSnapshot() {
    return {
      date: this.data.date,
      place: (this.data.place || '').trim(),
      lat: typeof this._lat === 'number' ? this._lat : null,
      lng: typeof this._lng === 'number' ? this._lng : null,
      note: this.data.note || '',
      tags: [], // S8：标签体系下架，重写后再接入
      photos: this.data.photos
        .filter((p) => !p.isOld)
        .map((p) => ({
          photoId: p.photoId,
          tempFilePath: p.tempFilePath,
          ext: p.ext,
          status: p.status,
          progress: p.progress
        }))
    };
  },

  // 草稿链主体：文本预检 -> 上传隔离区 -> 送审/轮询 -> commitSave；与 runSave 同序但全程持快照
  async runDraftSave(ctx, snap) {
    const texts = [];
    if (snap.place) texts.push({ field: 'place', content: snap.place });
    if (snap.note) texts.push({ field: 'note', content: snap.note });
    if (texts.length) {
      await request.callFunction('secCheck', { action: 'text', texts });
      this.throwIfCancelled(ctx);
    }

    const toUpload = snap.photos.filter((p) => p.status === 'ready' || p.status === 'upload-failed');
    if (toUpload.length) {
      await this.issueAndUpload(toUpload, ctx);
      this.throwIfCancelled(ctx);
    }

    const toCheck = snap.photos.filter((p) => p.status === 'uploaded' || p.status === 'checking');
    if (toCheck.length) {
      const n = this.submitReviews(toCheck, ctx);
      const r = await this.startPollReviews(toCheck, ctx); // 阶段起点 = 首张提交发起时间
      await n;
      await r.promise;
    }

    const payload = {
      date: snap.date,
      place: snap.place,
      note: snap.note,
      tags: snap.tags,
      photos: snap.photos.map((p) => ({ photoId: p.photoId }))
    };
    if (typeof snap.lat === 'number' && typeof snap.lng === 'number') {
      payload.lat = snap.lat;
      payload.lng = snap.lng;
    }
    await request.callFunction('secCheck', Object.assign({
      action: 'commitSave',
      clientSaveId: ctx.clientSaveId
    }, payload));
    this.throwIfCancelled(ctx);
  },

  // 草稿链成功：删草稿、刷新时间线（正式记录出现）；无弹层（保存瞬间的 toast 已给过反馈）
  finishDraft(ctx) {
    drafts.remove(ctx.draftId);
    db.invalidateFootprintsCache();
    draftCleanup.forEachPhotoCleanup(this, ctx); // 清本链轮询时间记录（见底部工具函数）
    refreshTimeline();
  },

  // 草稿链失败：草稿标 failed + 原因落盘，时间线显示「未同步」，轻提示一次（不弹层打断）
  // 2005（审核与照片对不上）：服务端已冻结 pass 的 photoId，重试必须换新 photoId，此处一并重置
  failDraft(ctx, snap, err) {
    if (err && err.cancelled) return;
    const draft = drafts.get(ctx.draftId) || Object.assign({ id: ctx.draftId, clientSaveId: ctx.clientSaveId, createdAt: Date.now() }, snap);
    draft.status = 'failed';
    draft.error = (err && err.message) || '保存失败，请重试';
    if (err && err.code === 2001) draft.error = '内容未通过安全检测，请修改';
    if (err && err.code === 2002) draft.error = '有照片未通过安全检测，请更换';
    if (err && err.code === 2005) {
      // 换新 photoId 整链重走（恢复草稿后重试即生效）
      draft.photos = draft.photos.map((p) => Object.assign({}, p, { photoId: uuidUtil.uuid(), status: 'ready', progress: 0 }));
      draft.clientSaveId = null; // 旧 clientSaveId 已可能半途写库，重试换新防幂等回读旧结果
    }
    drafts.upsert(draft);
    draftCleanup.forEachPhotoCleanup(this, ctx);
    wx.showToast({ title: '有 1 条足迹未保存成功，可稍后在时间线处理', icon: 'none' });
    refreshTimeline();
  },

  // ---------- 编辑链（同步等待，基于页面 data；语义与 S7 版一致） ----------

  // S6-R2 隔离区转正时序（契约 §4.1）：text 预检 -> issueUpload（审核前签发隔离区表单）->
  // 每张 wx.uploadFile 成功即 imageSubmit(photoId)（百分比仅显示在照片格内，对隔离区对象本体送审）
  // -> imagePoll -> commitSave（photos 只带 photoId，不传 key，travel key 由服务端从绑定对象解析）
  async runSave(ctx) {
    // 1) 文本预检（FR-06：服务端 commit 会终审，不信任前端结果；S7-R4 过程无状态文案）
    const texts = this.textsToCheck();
    if (texts.length) {
      await request.callFunction('secCheck', { action: 'text', texts });
      this.throwIfCancelled(ctx);
    }

    // 2) 签发隔离区上传凭证 + 原图直传隔离区（审核之前；单张失败标 upload-failed 可单独重试）
    const toUpload = this.data.photos.filter((p) =>
      !p.isOld && (p.status === 'ready' || p.status === 'upload-failed')
    );
    if (toUpload.length) {
      await this.issueAndUpload(toUpload, ctx);
      this.throwIfCancelled(ctx);
    }

    // 3) 图片审核（已传隔离区才送审：imageSubmit 真并行，批量 imagePoll；
    //    阶段 50s 自首张提交起算，§6 定值）
    const toCheck = this.data.photos.filter((p) =>
      !p.isOld && (p.status === 'uploaded' || p.status === 'checking')
    );
    if (toCheck.length) {
      const n = this.submitReviews(toCheck, ctx);
      const r = await this.startPollReviews(toCheck, ctx); // 阶段起点 = 首张提交发起时间
      await n; // 全部送审请求落定（失败由 submitReviews 抛出）
      await r.promise;
    }

    // 4) 提交写库（幂等；服务端 CopyObject 转正 travel/ 后落库）
    await this.doCommit(ctx);
  },

  // add：note/place 全量预检；edit：仅被修改的文本（FR-13：预设标签/日期不重审）
  textsToCheck() {
    const texts = [];
    const place = (this.data.place || '').trim();
    const note = this.data.note || '';
    if (!this.data.isEdit || !this._origin) {
      if (place) texts.push({ field: 'place', content: place });
      if (note) texts.push({ field: 'note', content: note });
      return texts;
    }
    if (place !== this._origin.place) texts.push({ field: 'place', content: place });
    if (note !== (this._origin.note || '')) texts.push({ field: 'note', content: note });
    return texts;
  },

  doCommit(ctx) {
    // S6-R2：新照片只传 { photoId }（travel key 由服务端从 sec-check/key 绑定对象解析，前端不传 key）；
    // 编辑场景旧照片项传 { key }（契约 §1.2 commitSave/commitEdit）
    const photos = this.data.photos.map((p) =>
      p.isOld ? { key: p.key } : { photoId: p.photoId }
    );
    const payload = {
      date: this.data.date,
      place: (this.data.place || '').trim(),
      note: this.data.note || '',
      // 标签体系下架（S8）：编辑保留原记录标签（原样回传，服务端豁免存量），新增为空
      tags: (this._origin && this._origin.tags) || [],
      photos
    };
    // 坐标同有同无（契约 §0.4）
    if (typeof this._lat === 'number' && typeof this._lng === 'number') {
      payload.lat = this._lat;
      payload.lng = this._lng;
    }
    if (this.data.isEdit) return this.commitEdit(payload, ctx);
    return this.commitSave(payload, ctx);
  },

  // 编辑提交（同步链专用；草稿链不走此处）
  commitEdit(payload, ctx) {
    const editId = this.data.editId;
    const toSend = Object.assign({
      action: 'commitEdit',
      footprintId: editId,
      removedKeys: this._removedKeys
    }, payload);
    const confirm = (fp) => {
      this.throwIfCancelled(ctx);
      if (this.editMatches(fp, payload, editId)) return this.onSaveSuccess(ctx);
      return this.onSaveUnconfirmed();
    };
    const attempt = (remaining) => request.callFunction('secCheck', toSend)
      .then((data) => {
        db.invalidateFootprintsCache();
        const footprintId = (data && data.footprintId) ? data.footprintId : editId;
        return db.getFootprint(footprintId, { force: true }).then((fp) => confirm(fp));
      })
      .catch((err) => {
        // 无应答：重发同一请求直到终态（同值覆盖幂等）
        if (err && err.transport && remaining > 1) {
          return new Promise((resolve) => setTimeout(() => resolve(attempt(remaining - 1)), 2000));
        }
        // §5.4：edit 重发耗尽 或 回读遇网络异常（err.network）-> 一律「结果未确认」，不得落入「保存失败」
        if (err && (err.transport || err.network)) return this.onSaveUnconfirmed();
        throw err; // 1004 等由 handleSaveError 分流
      });
    return attempt(4);
  },

  // 回读确认（§5.4 S6-R4）：提交内容与落库记录一致才展示成功--
  // date/place/note/lat/lng/tags（含顺序与内容）+ 照片 key 序列（旧保留 key 的相对顺序与数量）
  editMatches(fp, payload, editId) {
    if (!fp || fp._id !== editId) return false;
    if (fp.date !== payload.date) return false;
    if (fp.place !== payload.place) return false;
    if ((fp.note || '') !== (payload.note || '')) return false;
    // lat/lng 同有同无且数值一致（契约 §0.4）
    const hasCoord = typeof payload.lat === 'number' && typeof payload.lng === 'number';
    if (hasCoord) {
      if (fp.lat !== payload.lat || fp.lng !== payload.lng) return false;
    } else if (typeof fp.lat === 'number' || typeof fp.lng === 'number') {
      return false;
    }
    // tags 顺序与内容一致
    if (JSON.stringify(fp.tags || []) !== JSON.stringify(payload.tags || [])) return false;
    // 照片序列：总数一致 + 旧保留 key 的相对顺序与数量一致（新照片 key 由服务端解析无法预知，只较数量）
    const dbKeys = (fp.photos || []).map((p) => p.key);
    const oldKeys = (payload.photos || []).filter((p) => p.key).map((p) => p.key);
    if (dbKeys.length !== payload.photos.length) return false;
    if (oldKeys.length) {
      const oldSet = {};
      oldKeys.forEach((k) => { oldSet[k] = true; });
      const dbOldSeq = dbKeys.filter((k) => oldSet[k]);
      if (dbOldSeq.length !== oldKeys.length) return false;
      for (let i = 0; i < oldKeys.length; i++) {
        if (dbOldSeq[i] !== oldKeys[i]) return false;
      }
    }
    return true;
  },

  // 保存成功（编辑同步链）：轻提示后重开详情页（编辑并刷新其 onLoad）；表单已重置
  onSaveSuccess(ctx) {
    this.throwIfCancelled(ctx);
    const editId = this.data.editId;
    this._clientSaveId = null;
    this._reviewSubmitAt = {};
    this.setData({ saving: false, saveError: null });
    wx.showToast({ title: '保存成功', icon: 'success' });
    this.resetForm();
    wx.setNavigationBarTitle({ title: '溪山行旅' });
    // 编辑模式：回详情页并刷新。编辑入口的 detail 已被 switchTab 销毁（tab 页无返回栈可退），
    // 重开详情页，其 onLoad 重新拉取记录与签名 URL 即最新值（FR-13）
    setTimeout(() => wx.navigateTo({ url: '/pages/detail/detail?id=' + editId }), 800);
  },

  // §5.4：编辑结果未确认（重发仍无应答/回读不一致）-> 不断言失败，回详情页按回读数据展示实际状态
  onSaveUnconfirmed() {
    db.invalidateFootprintsCache();
    this._clientSaveId = null;
    this.setData({ saving: false, saveError: null });
    wx.showToast({ title: '结果未确认，请到详情查看', icon: 'none' });
    wx.setNavigationBarTitle({ title: '溪山行旅' });
    setTimeout(() => wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.editId }), 800);
  },

  // 编辑链错误分流（同步链专属；草稿链失败走 failDraft）
  handleSaveError(err, ctx) {
    if (err && err.cancelled) return; // 取消/退出：静默
    if (ctx && ctx.isEdit && ctx !== this._saveCtx) return; // 旧轮次编辑链回调：丢弃
    this.setData({ saving: false });
    if (request.isFieldError(err)) {
      // 2001：定位字段；2002：定位到具体照片（状态已在轮询时标注）
      if (err.code === 2001) this.locateTextField(err);
      this.setData({ saveError: { message: err.message, retryable: false } });
      return;
    }
    if (err && err.code === 2005) { // REVIEW_MISMATCH：审核与照片对不上，需重新走审核
      this.resetReviewState();
      this.setData({ saveError: { message: err.message, retryable: false } });
      return;
    }
    if (request.isNotFound(err)) { // 1004：编辑对象已被删
      this.setData({ saveError: { message: err.message, retryable: false } });
      return;
    }
    // 2003/2004/3001/9000/网络：给重试入口（沿用同一 clientSaveId，幂等）
    this.setData({ saveError: { message: (err && err.message) || '保存失败，请重试', retryable: true } });
  },

  locateTextField(err) {
    const results = (err.data && err.data.results) || [];
    const patch = {};
    results.forEach((r) => {
      if (r.pass) return;
      if (r.field === 'place') patch.placeError = '地点' + '包含不适宜内容，请修改';
      if (r.field === 'note') patch.noteError = '备注包含不适宜内容，请修改';
    });
    if (!Object.keys(patch).length) patch.noteError = err.message;
    this.setData(patch);
  },

  resetReviewState() {
    // 2005：三元组对不上 -> 整链重走。已过审的 photoId 被服务端冻结（task=pass 拒绝再签发，§4.2），
    // 必须为全部新照片换新 photoId 从签发开始重来；clientSaveId 作废
    this._clientSaveId = null;
    this._reviewSubmitAt = {};
    const photos = this.data.photos.map((p) =>
      p.isOld ? p : Object.assign({}, p, { photoId: uuidUtil.uuid(), status: 'ready', progress: 0 })
    );
    this.setData({ photos });
  }
};

// 工具：链路落定后清理 _reviewSubmitAt 中本链照片的轮询时间记录（防多条草稿并行时互相污染截止基准）
const draftCleanup = {
  forEachPhotoCleanup(page, ctx) {
    const at = page._reviewSubmitAt;
    if (!at || !Array.isArray(ctx.photoIds)) return;
    ctx.photoIds.forEach((id) => { delete at[id]; });
  }
};
