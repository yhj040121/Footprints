// 提交段（契约 §4.1 保存时序、§5.1 clientSaveId 幂等、§0.3 错误码分流、FR-13 编辑保存、§5.4 传输异常终态）
// S8 乐观保存：新增走「草稿链」、编辑走「编辑链」——点保存立即 toast + 跳页，审核/上传/入库在后台推进。
// 编辑链失败不弹层：失败原因落在本条记录上（时间线/详情徽标，点击恢复表单重试）。
// 两条链共享 review.js/upload.js（均按传入照片数组工作，快照对象与页面 data 对象均兼容；
// setPhoto 按 uid 找不到页面照片时 no-op，草稿/编辑链因此天然不影响已重置的表单）。
// 本模块方法经 Object.assign 挂到 add 页 Page 上，this 即页面实例
const request = require('../../utils/request');
const uuidUtil = require('../../utils/uuid');
const db = require('../../utils/db');
const drafts = require('../../utils/drafts');
const errorText = require('../../utils/error-text');

/** 后台草稿链落定（成功转正式/失败标记）后刷新时间线（若其在页面栈中） */
function refreshTimeline() {
  try {
    const pages = getCurrentPages() || [];
    pages.forEach((p) => {
      if (p && p.route === 'pages/timeline/timeline' && typeof p.loadFirst === 'function') {
        p.loadFirst({ force: true });
      }
    });
  } catch (e) { /* 栈不可用时由 timeline onShow 兜底刷新 */ }
}

/** 新增草稿详情已经打开时，原地刷新审核状态；成功后无缝切到正式记录 ID。 */
function refreshDraftDetail(draftId, footprintId) {
  try {
    const pages = getCurrentPages() || [];
    pages.forEach((page) => {
      if (!page || page.route !== 'pages/detail/detail' || page.draftId !== draftId) return;
      if (footprintId && typeof page.onDraftPublished === 'function') {
        page.onDraftPublished(footprintId);
      } else if (typeof page.loadDraftDetail === 'function') {
        page.loadDraftDetail();
      }
    });
  } catch (e) { /* 详情页不在栈中时由草稿落盘状态兜底 */ }
}

/** 新增/编辑正式落定后，主动刷新当前页面栈中的日历、地图、导出与我的统计。 */
function refreshOtherDataPages(footprintId) {
  try {
    const pages = getCurrentPages() || [];
    pages.forEach((page) => {
      if (!page) return;
      if (page.route === 'pages/calendar/calendar' && typeof page._loadMonth === 'function') {
        const ym = page._ym();
        if (page._cache) delete page._cache[ym];
        page._loadMonth(ym);
      } else if (page.route === 'pages/map/map' && typeof page.loadRecords === 'function') {
        if (footprintId) page._pendingFocusId = footprintId;
        page.loadRecords(true);
      } else if (page.route === 'pages/export/export' && typeof page.load === 'function') {
        page.load({ force: true });
      } else if (page.route === 'pages/mine/mine' && typeof page.refresh === 'function') {
        page.refresh();
      }
    });
  } catch (e) { /* 不在页面栈中的 tab 由下次 onShow 强制刷新 */ }
}

function optimisticFootprint(footprintId, snap, createdAt) {
  return {
    _id: footprintId,
    date: snap.date,
    place: snap.place,
    lat: typeof snap.lat === 'number' ? snap.lat : null,
    lng: typeof snap.lng === 'number' ? snap.lng : null,
    address: snap.address || '',
    province: snap.province || '',
    city: snap.city || '',
    district: snap.district || '',
    adcode: snap.adcode || '',
    cityLabel: snap.cityLabel || '',
    locationSource: snap.locationSource || '',
    note: snap.note || '',
    tags: (snap.tags || []).slice(),
    photos: (snap.photos || []).map((photo) => (photo.isOld ? {
      key: photo.key
    } : {
      url: photo.tempFilePath || '',
      width: photo.width,
      height: photo.height
    })),
    createdAt: createdAt || (snap.origin && snap.origin.createdAt) || Date.now()
  };
}

/** 后台编辑链落定后刷新详情页（若其在页面栈中且正是本条记录） */
function refreshDetail(footprintId) {
  try {
    const pages = getCurrentPages() || [];
    pages.forEach((p) => {
      if (p && p.route === 'pages/detail/detail' && p.fpId === footprintId && typeof p.loadDetail === 'function') {
        p.loadDetail({ force: true });
      }
    });
  } catch (e) { /* 详情页不在栈中即无需刷新 */ }
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

  // ---------- 编辑：乐观链（与草稿链同构，失败落在记录上） ----------

  // 立即：快照 + 编辑草稿落盘 + toast + 表单重置 + 回时间线；后台：runEditSave 推进全链。
  // 注意：编辑入口经 switchTab 进入 add（tab 页无法 navigateTo），原详情页已被销毁；
  // 保存后若 navigateTo 新详情页，系统返回键必然落回 add 空表单（微信 tab 页硬限制）。
  // 因此与新增保存一致，保存后切回时间线——后台链落定后时间线即显示最新记录。
  startEditSave() {
    if (!this._clientSaveId || this._formDirty) {
      this._clientSaveId = uuidUtil.uuid();
      this._formDirty = false;
    }
    const editId = this.data.editId;
    const clientSaveId = this._clientSaveId;
    const snap = this.buildEditSnapshot();
    // 同一记录只保留最新一份编辑草稿：新编辑接管后旧后台链静默终止
    this._editChains = this._editChains || {};
    const prev = this._editChains[editId];
    if (prev) prev.cancelled = true;
    drafts.listAll().filter((d) => d.editId === editId).forEach((d) => drafts.remove(d.id));

    const draftId = 'edit_' + Date.now() + '_' + ((Math.random() * 1e6) | 0);
    drafts.upsert(Object.assign({
      id: draftId,
      editId,
      clientSaveId,
      status: 'syncing',
      createdAt: Date.now()
    }, snap));

    // 立即反馈：用户马上看到「已保存」并回到时间线（编辑在后台推进，失败标注在记录上）
    wx.showToast({ title: '已保存', icon: 'success' });
    this.resetForm();
    wx.setNavigationBarTitle({ title: '溪山行旅' });
    setTimeout(() => wx.switchTab({ url: '/pages/timeline/timeline' }), 600);

    const ctx = {
      cancelled: false,
      round: ++this._saveSeq,
      draftId,
      editId,
      clientSaveId,
      date: snap.date,
      photoIds: snap.photos.filter((p) => !p.isOld).map((p) => p.photoId)
    };
    this._editChains[editId] = ctx;
    this.runEditSave(ctx, snap).then(
      () => this.finishEdit(ctx),
      (err) => this.failEdit(ctx, snap, err)
    );
  },

  // 失败弹层上的「取消/关闭」：终止在途编辑链并退回表单（内容保留）。乐观化后 saving 恒为
  // false，此入口仅作 add 页 onHide/onUnload 兜底保留
  onSaveCancel() {
    this.cancelSave();
  },

  cancelSave() {
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
      date: snap.date,
      photoIds: snap.photos.map((p) => p.photoId)
    };
    this.runDraftSave(ctx, snap).then(
      (result) => this.finishDraft(ctx, result),
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
      // V1.3：地点与地区字段随快照保存（commitSave 时一起提交）
      address: this.data.address || '',
      province: this.data.province || '',
      city: this.data.city || '',
      district: this.data.district || '',
      adcode: this.data.adcode || '',
      cityLabel: this.data.cityLabel || '',
      locationSource: this.data.locationSource || (this._lat !== null ? 'legacy' : ''),
      photos: this.data.photos
        .filter((p) => !p.isOld)
        .map((p) => ({
          uid: p.uid,
          photoId: p.photoId,
          tempFilePath: p.tempFilePath,
          ext: p.ext,
          width: p.width,
          height: p.height,
          status: p.status,
          progress: p.progress
        }))
    };
  },

  // 草稿链主体：文本预检 -> 上传隔离区 -> 送审/轮询 -> commitSave；与编辑链同序但全程持快照
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
    // V1.3 地点与地区字段（修改地区文本不动坐标，重新选择才更新；缺省为旧记录兼容）
    if (snap.address) payload.address = snap.address;
    if (snap.province) payload.province = snap.province;
    if (snap.city) payload.city = snap.city;
    if (snap.district) payload.district = snap.district;
    if (snap.adcode) payload.adcode = snap.adcode;
    if (snap.cityLabel) payload.cityLabel = snap.cityLabel;
    if (snap.locationSource) payload.locationSource = snap.locationSource;
    const result = await request.callFunction('secCheck', Object.assign({
      action: 'commitSave',
      clientSaveId: ctx.clientSaveId
    }, payload));
    this.throwIfCancelled(ctx);
    if (result && result.footprintId) {
      db.rememberFootprint(optimisticFootprint(result.footprintId, snap, result.createdAt));
    }
    return result;
  },

  // 草稿链成功：保留短期 draftId -> footprintId 映射，刷新时间线并让已打开的草稿详情
  // 原地切到正式记录。映射由 drafts 在十分钟后自动清理，覆盖「点卡片与刷新交错」的竞态窗口。
  finishDraft(ctx, result) {
    const footprintId = result && result.footprintId;
    if (!drafts.markPublished(ctx.draftId, footprintId)) drafts.remove(ctx.draftId);
    db.invalidateFootprintsCache();
    draftCleanup.forEachPhotoCleanup(this, ctx); // 清本链轮询时间记录（见底部工具函数）
    refreshTimeline();
    refreshOtherDataPages(footprintId);
    refreshDraftDetail(ctx.draftId, footprintId);
  },

  // 草稿链失败：草稿标 failed + 原因落盘，时间线显示「未同步」，轻提示一次（不弹层打断）
  // 2005（审核与照片对不上）：服务端已冻结 pass 的 photoId，重试必须换新 photoId，此处一并重置
  failDraft(ctx, snap, err) {
    if (err && err.cancelled) return;
    const draft = drafts.get(ctx.draftId) || Object.assign({ id: ctx.draftId, clientSaveId: ctx.clientSaveId, createdAt: Date.now() }, snap);
    draft.status = 'failed';
    draft.failedAt = Date.now();
    draft.error = errorText.secErrorText(err);
    if (err && err.code === 2005) {
      // 换新 photoId 整链重走（恢复草稿后重试即生效）
      draft.photos = draft.photos.map((p) => Object.assign({}, p, { photoId: uuidUtil.uuid(), status: 'ready', progress: 0 }));
      draft.clientSaveId = null; // 旧 clientSaveId 已可能半途写库，重试换新防幂等回读旧结果
    }
    drafts.upsert(draft);
    draftCleanup.forEachPhotoCleanup(this, ctx);
    console.error('[Footprints] draft publish failed:', err && err.code, draft.error, err && err.data);
    wx.showToast({ title: draft.error, icon: 'none', duration: 4000 });
    refreshTimeline();
    refreshDraftDetail(ctx.draftId);
  },

  // ---------- 编辑链（乐观后台，全程持快照；语义与同步版一致） ----------

  // 保存瞬间的表单快照（编辑链全程只用快照）：旧照片只留 key，新照片带 tempFilePath/状态可断点续跑；
  // origin 记原始文本（重试恢复后仍按「仅被修改的文本」预检，FR-13）
  buildEditSnapshot() {
    return {
      date: this.data.date,
      place: (this.data.place || '').trim(),
      lat: typeof this._lat === 'number' ? this._lat : null,
      lng: typeof this._lng === 'number' ? this._lng : null,
      note: this.data.note || '',
      address: this.data.address || '',
      province: this.data.province || '',
      city: this.data.city || '',
      district: this.data.district || '',
      adcode: this.data.adcode || '',
      cityLabel: this.data.cityLabel || '',
      locationSource: this.data.locationSource || '',
      // 标签体系下架（S8）：编辑保留原记录标签（原样回传，服务端豁免存量）
      tags: (this._origin && this._origin.tags) || [],
      origin: this._origin ? {
        place: this._origin.place,
        note: this._origin.note || '',
        tags: (this._origin.tags || []).slice(),
        address: this._origin.address || '',
        province: this._origin.province || '',
        city: this._origin.city || '',
        district: this._origin.district || '',
        adcode: this._origin.adcode || '',
        cityLabel: this._origin.cityLabel || '',
        locationSource: this._origin.locationSource || '',
        createdAt: this._origin.createdAt
      } : null,
      removedKeys: this._removedKeys.slice(),
      photos: this.data.photos.map((p) => (p.isOld ? {
        uid: p.uid,
        key: p.key,
        status: 'done',
        progress: 100,
        isOld: true
      } : {
        uid: p.uid,
        photoId: p.photoId,
        tempFilePath: p.tempFilePath,
        ext: p.ext,
        width: p.width,
        height: p.height,
        status: p.status,
        progress: p.progress,
        isOld: false
      }))
    };
  },

  // 编辑链主体：文本预检 -> 上传隔离区 -> 送审/轮询 -> commitEdit（+回读确认）；
  // 与草稿链同序，但提交走 commitEdit（带 footprintId/removedKeys，旧照片传 key）
  async runEditSave(ctx, snap) {
    // 1) 文本预检：仅被修改的文本（FR-13：预设标签/日期不重审）；服务端 commit 会终审
    const origin = snap.origin || {};
    const texts = [];
    if (snap.place && snap.place !== origin.place) texts.push({ field: 'place', content: snap.place });
    if (snap.note && snap.note !== (origin.note || '')) texts.push({ field: 'note', content: snap.note });
    if (texts.length) {
      await request.callFunction('secCheck', { action: 'text', texts });
      this.throwIfCancelled(ctx);
    }

    // 2) 签发隔离区上传凭证 + 原图直传（单张失败标 upload-failed，重试恢复后续跑）
    const toUpload = snap.photos.filter((p) =>
      !p.isOld && (p.status === 'ready' || p.status === 'upload-failed')
    );
    if (toUpload.length) {
      await this.issueAndUpload(toUpload, ctx);
      this.throwIfCancelled(ctx);
    }

    // 3) 图片审核（已传隔离区才送审；阶段 50s 自首张提交起算，§6 定值）
    const toCheck = snap.photos.filter((p) =>
      !p.isOld && (p.status === 'uploaded' || p.status === 'checking')
    );
    if (toCheck.length) {
      const n = this.submitReviews(toCheck, ctx);
      const r = await this.startPollReviews(toCheck, ctx);
      await n;
      await r.promise;
    }

    // 4) 提交写库（幂等；服务端 CopyObject 转正 travel/ 后落库）+ 回读确认
    const payload = {
      date: snap.date,
      place: snap.place,
      lat: snap.lat,
      lng: snap.lng,
      address: snap.address || '',
      province: snap.province || '',
      city: snap.city || '',
      district: snap.district || '',
      adcode: snap.adcode || '',
      cityLabel: snap.cityLabel || '',
      locationSource: snap.locationSource || '',
      note: snap.note,
      tags: snap.tags,
      photos: snap.photos.map((p) => (p.isOld ? { key: p.key } : { photoId: p.photoId }))
    };
    await this.commitEditSnap(payload, snap, ctx);
  },

  // 编辑提交：无应答重发同一请求至终态（同值覆盖幂等）；提交后回读比对，一致才算确认。
  // 返回 true=确认成功；false=结果未确认（重发耗尽/回读遇网络异常）——不断言失败，按成功收尾
  // 并失效缓存，记录实际状态以回读数据为准（§5.4）
  commitEditSnap(payload, snap, ctx) {
    const editId = ctx.editId;
    const toSend = Object.assign({
      action: 'commitEdit',
      footprintId: editId,
      removedKeys: snap.removedKeys
    }, payload);
    const attempt = (remaining) => request.callFunction('secCheck', toSend)
      .then((data) => {
        db.invalidateFootprintsCache();
        const footprintId = (data && data.footprintId) ? data.footprintId : editId;
        db.rememberFootprint(optimisticFootprint(footprintId, snap));
        return db.getFootprint(footprintId, { force: true }).then((fp) => {
          this.throwIfCancelled(ctx);
          return this.editMatches(fp, payload, editId);
        });
      })
      .catch((err) => {
        if (err && err.transport && remaining > 1) {
          return new Promise((resolve) => setTimeout(() => resolve(attempt(remaining - 1)), 2000));
        }
        if (err && (err.transport || err.network)) return false; // 结果未确认，不落失败徽标
        throw err; // 1004 等由 failEdit 分流
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
    const locationFields = ['address', 'province', 'city', 'district', 'adcode', 'cityLabel', 'locationSource'];
    if (locationFields.some((field) => (fp[field] || '') !== (payload[field] || ''))) return false;
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

  // 编辑链成功：删编辑草稿、失效缓存、刷新时间线与详情（徽标消失，记录展示新内容）
  finishEdit(ctx) {
    if (this._editChains && this._editChains[ctx.editId] === ctx) delete this._editChains[ctx.editId];
    drafts.remove(ctx.draftId);
    db.invalidateFootprintsCache();
    draftCleanup.forEachPhotoCleanup(this, ctx);
    refreshTimeline();
    refreshOtherDataPages(ctx.editId);
    refreshDetail(ctx.editId);
  },

  // 编辑链失败：不弹层，失败原因落在记录上——编辑草稿标 failed，时间线/详情显示徽标，
  // 点击恢复编辑表单可改可重试；轻提示一次（不打断，无弹层）
  // 2005（审核与照片对不上）：服务端已冻结 pass 的 photoId，重试必须换新 photoId，此处一并重置
  failEdit(ctx, snap, err) {
    if (err && err.cancelled) return;
    if (this._editChains && this._editChains[ctx.editId] === ctx) delete this._editChains[ctx.editId];
    draftCleanup.forEachPhotoCleanup(this, ctx);
    if (request.isNotFound(err)) { // 1004：记录已被删除，编辑无从落地，直接丢弃编辑草稿
      drafts.remove(ctx.draftId);
      refreshTimeline();
      return;
    }
    const draft = drafts.get(ctx.draftId) || Object.assign({
      id: ctx.draftId,
      editId: ctx.editId,
      clientSaveId: ctx.clientSaveId,
      createdAt: Date.now()
    }, snap);
    draft.status = 'failed';
    draft.failedAt = Date.now();
    draft.error = errorText.secErrorText(err);
    if (err && err.code === 2005) {
      draft.photos = draft.photos.map((p) => (p.isOld ? p : Object.assign({}, p, {
        photoId: uuidUtil.uuid(),
        status: 'ready',
        progress: 0
      })));
      draft.clientSaveId = null; // 旧 clientSaveId 已可能半途写库，重试换新防幂等回读旧结果
    }
    drafts.upsert(draft);
    console.error('[Footprints] edit publish failed:', err && err.code, draft.error, err && err.data);
    wx.showToast({ title: '修改未保存成功，' + draft.error, icon: 'none', duration: 4000 });
    refreshTimeline();
    refreshDetail(ctx.editId);
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
