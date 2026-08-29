// 提交段（契约 §4.1 保存时序、§5.1 clientSaveId 幂等、§0.3 错误码分流、FR-13 编辑保存、§5.4 传输异常终态）
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const request = require('../../utils/request');
const uuidUtil = require('../../utils/uuid');
const db = require('../../utils/db');

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
    // 保存轮次 token：每轮生成全新 ctx 并取 round；旧轮次的回调按「ctx===this._saveCtx 且未取消」双校验丢弃
    const ctx = { cancelled: false, round: ++this._saveSeq };
    this._saveCtx = ctx;
    this.setData({ saving: true, saveError: null, saveText: '准备中…' });
    this.runSave(ctx).catch((err) => this.handleSaveError(err, ctx));
  },

  onSaveRetry() {
    if (this.data.saving) return;
    const ctx = { cancelled: false, round: ++this._saveSeq };
    this._saveCtx = ctx;
    this.setData({ saving: true, saveError: null, saveText: '准备中…' });
    this.runSave(ctx).catch((err) => this.handleSaveError(err, ctx));
  },

  onSaveCancel() {
    this.cancelSave();
  },

  cancelSave() {
    if (this._saveCtx) this._saveCtx.cancelled = true;
    this._saveCtx = null; // 使旧轮次异步回调因 identity 不匹配而全部失效（杜绝被新保存复活）
    this.setData({ saving: false, saveError: null });
  },

  // 双校验：ctx 未取消 且 ctx 仍是当前这一轮（防止旧异步链干扰/复活新保存）
  throwIfCancelled(ctx) {
    if (!ctx || ctx.cancelled || ctx !== this._saveCtx) {
      const e = new Error('cancelled');
      e.cancelled = true;
      throw e;
    }
  },

  // S6-R2 隔离区转正时序（契约 §4.1）：text 预检 → issueUpload（审核前签发隔离区表单）→
  // wx.uploadFile 原图直传隔离区（进度 n/9）→ imageSubmit(photoId)（对隔离区对象本体送审，不再压缩/传 base64）
  // → imagePoll → commitSave（photos 只带 photoId，不传 key，travel key 由服务端从绑定对象解析）
  async runSave(ctx) {
    // 1) 文本预检（FR-06：尽早反馈；服务端 commit 会终审，不信任前端结果）
    const texts = this.textsToCheck();
    if (texts.length) {
      this.setData({ saveText: '文本检测中…' });
      await request.callFunction('secCheck', { action: 'text', texts });
      this.throwIfCancelled(ctx);
    }

    // 2) 签发隔离区上传凭证 + 原图直传隔离区（审核之前；单张失败标 upload-failed 可单独重试）
    const toUpload = this.data.photos.filter((p) =>
      !p.isOld && (p.status === 'ready' || p.status === 'upload-failed')
    );
    if (toUpload.length) {
      await this.issueAndUpload(toUpload);
      this.throwIfCancelled(ctx);
    }

    // 3) 图片审核（已传隔离区才送审：imageSubmit 真并行，批量 imagePoll；
    //    单张 40s 自该张提交起算、阶段 50s 自首张提交起算，§6 定值）
    const toCheck = this.data.photos.filter((p) =>
      !p.isOld && (p.status === 'uploaded' || p.status === 'checking')
    );
    if (toCheck.length) {
      this.setData({ saveText: '图片检测中…' });
      const stageStartAt = await this.submitReviews(toCheck, ctx);
      await this.pollReviews(toCheck, ctx, stageStartAt);
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
    this.setData({ saveText: '提交中…' });
    // S6-R2：新照片只传 { photoId }（travel key 由服务端从 sec-check/key 绑定对象解析，前端不传 key）；
    // 编辑场景旧照片项传 { key }（契约 §1.2 commitSave/commitEdit）
    const photos = this.data.photos.map((p) =>
      p.isOld ? { key: p.key } : { photoId: p.photoId }
    );
    const payload = {
      date: this.data.date,
      place: (this.data.place || '').trim(),
      note: this.data.note || '',
      tags: this.data.selectedTags,
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

  // 新增：commitSave（幂等，同 clientSaveId 重发即命中）
  commitSave(payload, ctx) {
    return request.callFunction('secCheck', Object.assign({
      action: 'commitSave',
      clientSaveId: this._clientSaveId
    }, payload))
      .then(() => { this.throwIfCancelled(ctx); return this.onSaveSuccess(ctx); });
  },

  // 编辑：commitEdit —— §5.4 传输异常终态：无应答则重发同一请求（同值覆盖幂等）至 code=0，
  // 随后回读该记录确认展示内容与提交一致再展示；重发仍失败 → 提示「结果未确认」，详情以回读数据为准
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
        const footprintId = (data && data.footprintId) ? data.footprintId : editId;
        return db.getFootprint(footprintId).then((fp) => confirm(fp));
      })
      .catch((err) => {
        // 无应答：重发同一请求直到终态（同值覆盖幂等）
        if (err && err.transport && remaining > 1) {
          return new Promise((resolve) => setTimeout(() => resolve(attempt(remaining - 1)), 2000));
        }
        // §5.4：edit 重发耗尽 或 回读遇网络异常（err.network）→ 一律「结果未确认」，不得落入「保存失败」
        if (err && (err.transport || err.network)) return this.onSaveUnconfirmed();
        throw err; // 1004 等由 handleSaveError 分流
      });
    return attempt(4);
  },

  // 回读确认（§5.4 S6-R4）：提交内容与落库记录一致才展示成功——
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

  onSaveSuccess(ctx) {
    this.throwIfCancelled(ctx);
    const wasEdit = this.data.isEdit;
    const editId = this.data.editId;
    this._clientSaveId = null;
    this.setData({ saving: false, saveError: null });
    wx.showToast({ title: '保存成功', icon: 'success' });
    this.resetForm();
    if (wasEdit) {
      wx.setNavigationBarTitle({ title: '溪山行旅' });
      // 编辑模式：回详情页并刷新。编辑入口的 detail 已被 switchTab 销毁（tab 页无返回栈可退），
      // 重开详情页，其 onLoad 重新拉取记录与签名 URL 即最新值（FR-13）
      setTimeout(() => wx.navigateTo({ url: '/pages/detail/detail?id=' + editId }), 800);
      return;
    }
    // 新增模式：回时间线（onShow 自动刷新，记录按 date 归组，不置顶）
    setTimeout(() => wx.switchTab({ url: '/pages/timeline/timeline' }), 800);
  },

  // §5.4：编辑结果未确认（重发仍无应答/回读不一致）→ 不断言失败，回详情页按回读数据展示实际状态
  onSaveUnconfirmed() {
    this._clientSaveId = null;
    this.setData({ saving: false, saveError: null });
    wx.showToast({ title: '结果未确认，请到详情查看', icon: 'none' });
    wx.setNavigationBarTitle({ title: '溪山行旅' });
    if (this.data.isEdit) {
      setTimeout(() => wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.editId }), 800);
    } else {
      setTimeout(() => wx.switchTab({ url: '/pages/timeline/timeline' }), 800);
    }
  },

  handleSaveError(err, ctx) {
    if (err && err.cancelled) return; // 用户主动取消/退出：静默
    if (ctx && ctx !== this._saveCtx) return; // 旧轮次的回调：直接丢弃，杜绝复活新保存
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
    // 2005：三元组对不上 → 整链重走。已过审的 photoId 被服务端冻结（task=pass 拒绝再签发，§4.2），
    // 必须为全部新照片换新 photoId 从签发开始重来；clientSaveId 作废
    this._clientSaveId = null;
    const photos = this.data.photos.map((p) =>
      p.isOld ? p : Object.assign({}, p, { photoId: uuidUtil.uuid(), status: 'ready', progress: 0 })
    );
    this.setData({ photos });
  }
};
