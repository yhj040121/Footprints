// 新增足迹 tab 页（index 2，中央「＋」直达）+ 编辑模式（FR-13 复用本表单）
// 依据：需求 FR-03（表单）/FR-04（定位联动）/FR-05（选图与直传）/FR-06（先审后传）/FR-07（保存全链路）/FR-13（编辑）
// 契约：§1.2 secCheck（text/imageSubmit/imagePoll/commitSave/commitEdit）、§1.3 ossSts.issueUpload、
//       §4.1 保存时序、§4.2 photoId 规则、§5.1 clientSaveId 幂等、§6 轮询 2s/40s/50s 定值
// 拆分（单文件 ≤600 行规范）：审核段 review.js / 上传段 upload.js / 提交段 save.js，
// 三个模块的方法经 Object.assign 合并进 Page，this 即本页实例；本文件保留表单/标签/照片选择/编辑模式。
// 注意：add 是 tab 页，navigateTo 无法进入，编辑入口 = detail 页写 globalData.editFootprintId 后 switchTab，
//       本页 onShow 读取并进入编辑模式（见交付说明）。
const constants = require('../../utils/constants');
const request = require('../../utils/request');
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const imageUtil = require('../../utils/image');
const review = require('./review');
const upload = require('./upload');
const save = require('./save');
const drafts = require('../../utils/drafts');

Page(Object.assign({
  data: {
    isEdit: false,
    editId: '',

    // 表单
    today: '',
    date: '',
    dateText: '',
    place: '',
    placeError: '',
    placeHint: '',         // 失焦预审未通过的浅色轻提示（不阻断，S7-R4 无感知审核）
    hasCoord: false,       // 当前是否持有坐标（lat/lng 存 this，不入渲染层）
    note: '',
    noteLen: 0,
    noteError: '',
    noteHint: '',          // 同上（备注失焦预审）
    maxNoteLen: constants.MAX_NOTE_LEN,
    photos: [],            // { uid, photoId, tempFilePath, ext, key, url, status, progress, isOld }
    maxPhotos: constants.MAX_PHOTOS,

    // 保存状态
    saving: false,
    saveError: null        // { message, retryable }
  },

  onLoad(options) {
    this._seq = 0;
    this._lat = null;
    this._lng = null;
    this._locatedPlace = null;  // 选点回填的地点文字（手动改写即清坐标，FR-04）
    this._origin = null;        // 编辑模式原始记录（变更文本比对，FR-13）
    this._removedKeys = [];
    this._clientSaveId = null;
    this._formDirty = false;
    this._saveCtx = null;
    this._saveSeq = 0; // 保存轮次 token（save.js：旧轮次回调按 identity 丢弃）
    this._needReset = false;
    this._uploadTaskCount = 0;
    this._placeCheckSeq = 0;    // 失焦预审竞态 token
    this._noteCheckSeq = 0;
    this._placeChecked = '';    // 上次预审通过的内容（未变化不重审）
    this._noteChecked = '';
    this._reviewSubmitAt = {}; // photoId → imageSubmit 发起时间（逐张上传即送审）

    const today = dateUtil.today();
    this.setData({ today, date: today, dateText: dateUtil.displayDate(today) });

    // 直接带 id 进入（保险路径；正常编辑入口在 onShow 的 globalData 交接）
    if (options && options.id) {
      getApp().globalData.editFootprintId = options.id;
    }
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(2);

    const app = getApp();
    // 草稿恢复交接：时间线点「未同步」草稿 → switchTab 过来，恢复表单供修改/重试（S8 乐观保存）
    const restoreId = app.globalData.restoreDraftId;
    if (restoreId) {
      app.globalData.restoreDraftId = null;
      this.restoreDraft(restoreId);
      return;
    }

    // 失败编辑恢复交接：时间线/详情点「修改未保存」徽标 → 恢复编辑表单重试（乐观编辑链）
    const restoreEditId = app.globalData.restoreEditDraftId;
    if (restoreEditId) {
      app.globalData.restoreEditDraftId = null;
      this.restoreEdit(restoreEditId);
      return;
    }

    // 编辑交接：detail 页 switchTab 过来（tab 页无法 navigateTo，见文件头注释）
    const editId = app.globalData.editFootprintId;
    if (editId) {
      app.globalData.editFootprintId = null;
      if (this.data.saving) this.cancelSave(); // 进编辑前先终止在途保存
      this.enterEdit(editId);
      return;
    }

    // tab 重进：检测中被退出的保存已终止 → 表单清空（FR-06 验收 4）
    if (this._needReset) {
      this._needReset = false;
      this.resetForm();
    }
  },

  onHide() {
    // 仅保存中退出才终止在途保存并作废旧轮次（防在隐藏页残留 setData 复活旧链）；
    // 选点（wx.chooseLocation）等系统级跳转也会先 onHide 再回 onShow，不得重置表单
    if (this.data.saving) {
      this.cancelSave();
      // 检测/上传中退出本页 → 本次保存被终止：新增模式置位，下次 onShow 重置表单（FR-06 验收 4）
      if (!this.data.isEdit) this._needReset = true;
    }
  },

  onUnload() {
    // 仅保存中退出才中止在途链（tab 页可能不触发 onHide 直接被销毁）
    if (this.data.saving) this.cancelSave();
  },

  // ---------- 表单 ----------

  markDirty() {
    this._formDirty = true;
  },

  noop() {}, // 遮罩层拦截滚动的空处理器

  onDateChange(e) {
    const date = e.detail.value;
    if (dateUtil.isFuture(date)) return; // picker end 已挡，双保险
    this.markDirty();
    this.setData({ date, dateText: dateUtil.displayDate(date) });
  },

  onPlaceInput(e) {
    const place = e.detail.value;
    this._placeCheckSeq += 1; // 输入即使在途预审失效，防旧响应覆盖新值
    this.markDirty();
    const patch = { place, placeError: '', placeHint: '' };
    // FR-04：选点回填后手动改写地点文字 → 视为手动输入，清空经纬度
    if (this._lat !== null && place !== this._locatedPlace) {
      this._lat = null;
      this._lng = null;
      this._locatedPlace = null;
      patch.hasCoord = false;
    }
    this.setData(patch);
  },

  // 地点失焦静默预审（S7-R4 无感知审核）：通过无任何表现，未通过仅输入框下浅色小字；
  // 不阻断填写，最终保存仍由服务端终审（契约 2001 语义不变）
  onPlaceBlur(e) {
    const place = (e.detail.value || '').trim();
    if (!place || place === this._placeChecked) {
      if (!place) this.setData({ placeHint: '' });
      return;
    }
    const seq = ++this._placeCheckSeq;
    request.callFunction('secCheck', {
      action: 'text',
      texts: [{ field: 'place', content: place }]
    }).then(() => {
      if (seq !== this._placeCheckSeq || (this.data.place || '').trim() !== place) return;
      this._placeChecked = place;
      this.setData({ placeHint: '' });
    }).catch((err) => {
      // 仅预审明确「未通过」（2001）才轻提示；接口异常等保持无感知（保存时服务端会拦截并给出原因）
      if (seq !== this._placeCheckSeq || (this.data.place || '').trim() !== place) return;
      if (err && err.code === 2001) {
        this.setData({ placeHint: '该地点可能未通过安全检测，保存时可能被拦截' });
      }
    });
  },
  // FR-04：wx.chooseLocation 选点回填；取消/拒授权原样保留
  onGetLocation() {
    wx.chooseLocation({
      success: (res) => {
        const place = (res.name || res.address || '').slice(0, constants.MAX_PLACE_LEN);
        if (!place) return;
        this.markDirty();
        this._lat = res.latitude;
        this._lng = res.longitude;
        this._locatedPlace = place;
        this._placeCheckSeq += 1;
        this.setData({ place, placeError: '', placeHint: '', hasCoord: true });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (/cancel/.test(msg)) return; // 取消选点：表单原样（FR-04 验收 4）
        if (/auth|deny|authorize/.test(msg)) {
          wx.showModal({
            title: '需要定位权限',
            content: '获取位置被拒绝，可去设置开启；手动输入地点不受影响',
            confirmText: '去设置',
            cancelText: '手动输入',
            confirmColor: '#35322C',
            success: (r) => { if (r.confirm) wx.openSetting(); }
          });
          return;
        }
        wx.showToast({ title: '获取位置失败，可手动输入', icon: 'none' });
      }
    });
  },

  onNoteInput(e) {
    this._noteCheckSeq += 1; // 输入即使在途预审失效，防旧响应覆盖新值
    this.markDirty();
    this.setData({ note: e.detail.value, noteLen: e.detail.value.length, noteError: '', noteHint: '' });
  },

  // 备注失焦静默预审（S7-R4）：同地点口径，通过无表现，未通过浅色小字，不弹窗不打断
  onNoteBlur(e) {
    const note = e.detail.value || '';
    if (!note.trim() || note === this._noteChecked) {
      if (!note.trim()) this.setData({ noteHint: '' });
      return;
    }
    const seq = ++this._noteCheckSeq;
    request.callFunction('secCheck', {
      action: 'text',
      texts: [{ field: 'note', content: note }]
    }).then(() => {
      if (seq !== this._noteCheckSeq || this.data.note !== note) return;
      this._noteChecked = note;
      this.setData({ noteHint: '' });
    }).catch((err) => {
      if (seq !== this._noteCheckSeq || this.data.note !== note) return;
      if (err && err.code === 2001) {
        this.setData({ noteHint: '该备注可能未通过安全检测，保存时可能被拦截' });
      }
    });
  },

  // ---------- 照片（FR-05） ----------

  onAddPhotos() {
    const remain = constants.MAX_PHOTOS - this.data.photos.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 ' + constants.MAX_PHOTOS + ' 张照片', icon: 'none' });
      return;
    }
    imageUtil.chooseImages(remain).then((res) => {
      if (res.cancelled) return;
      const added = (res.items || []).map((it) => ({
        uid: ++this._seq,
        photoId: it.photoId, // 契约 §4.2：每次选图生成新 photoId
        tempFilePath: it.tempFilePath,
        ext: it.ext === 'jpeg' ? 'jpg' : it.ext,
        key: '',
        url: it.tempFilePath,
        status: 'ready',     // ready→uploading→uploaded→checking→checked；upload-failed/review-failed（§4.1 S6-R2）
        progress: 0,
        isOld: false
      }));
      if (added.length) {
        this.markDirty();
        this.setData({ photos: this.data.photos.concat(added) });
      }
      // 超限/不支持格式静默跳过（S8-R2 用户拍板：无感知，不提示）
    }).catch(() => {
      wx.showToast({ title: '选图失败，请重试', icon: 'none' });
    });
  },

  onRemovePhoto(e) {
    const uid = e.currentTarget.dataset.uid;
    const target = this.data.photos.find((p) => p.uid === uid);
    if (!target) return;
    if (target.isOld && target.key) this._removedKeys.push(target.key); // commitEdit removedKeys
    if (target.photoId) delete this._reviewSubmitAt[target.photoId];
    this.markDirty();
    this.setData({ photos: this.data.photos.filter((p) => p.uid !== uid) });
  },

  setPhoto(uid, patch) {
    const idx = this.data.photos.findIndex((p) => p.uid === uid);
    if (idx < 0) return;
    const data = {};
    Object.keys(patch).forEach((k) => { data['photos[' + idx + '].' + k] = patch[k]; });
    this.setData(data);
  },

  // 同时更新照片对象本身与页面渲染数据：编辑链中的 photo 来自 this.data.photos，
  // 乐观保存链中的 photo 来自独立快照。后台链离开页面后仍必须推进快照状态，
  // 否则上传/送审虽成功，commitSave 仍会把照片误判为未审核。
  updatePhoto(photo, patch) {
    if (!photo) return;
    Object.assign(photo, patch);
    if (photo.uid !== undefined && photo.uid !== null) this.setPhoto(photo.uid, patch);
  },

  // ---------- 保存/上传/审核/提交：已拆至同目录 save.js / upload.js / review.js（Object.assign 合并） ----------

  // ---------- 编辑模式（FR-13） ----------

  enterEdit(id) {
    this._placeCheckSeq += 1;
    this._noteCheckSeq += 1;
    this._placeChecked = '';
    this._noteChecked = '';
    this._reviewSubmitAt = {};
    wx.showLoading({ title: '加载中', mask: true });
    db.getFootprint(id).then((fp) => {
      wx.hideLoading();
      if (!fp) {
        wx.showToast({ title: '记录不存在或已被删除', icon: 'none' });
        return;
      }
      this._origin = fp;
      this._removedKeys = [];
      this._clientSaveId = null;
      this._lat = typeof fp.lat === 'number' ? fp.lat : null;
      this._lng = typeof fp.lng === 'number' ? fp.lng : null;
      this._locatedPlace = this._lat !== null ? fp.place : null;
      const photos = (fp.photos || []).map((p) => ({
        uid: ++this._seq,
        photoId: '',
        tempFilePath: '',
        ext: '',
        key: p.key,
        url: '',
        status: 'done',
        progress: 100,
        isOld: true
      }));
      this.setData({
        isEdit: true,
        editId: id,
        date: fp.date,
        dateText: dateUtil.displayDate(fp.date),
        place: fp.place,
        placeError: '',
        placeHint: '',
        hasCoord: this._lat !== null,
        note: fp.note || '',
        noteLen: (fp.note || '').length,
        noteError: '',
        noteHint: '',
        photos,
        saveError: null
      });
      wx.setNavigationBarTitle({ title: '编辑足迹' });
      this.signEditThumbs(photos);
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    });
  },

  // 恢复草稿（S8 乐观保存）：时间线点「未同步」草稿 → 回填表单。照片沿用 photoId/状态可断点续跑；
  // tempFilePath 跨会话失效时仍回填路径（显示裂图），用户可删后重选。恢复即接管草稿（删旧，重存时新建）
  restoreDraft(id) {
    const d = drafts.get(id);
    if (!d) {
      wx.showToast({ title: '草稿不存在或已处理', icon: 'none' });
      return;
    }
    drafts.remove(id); // 接管该草稿（下次保存按新草稿落盘；避免「恢复-保存」后旧草稿残留）
    this._origin = null;
    this._removedKeys = [];
    this._clientSaveId = d.clientSaveId || null; // 沿用幂等 id（成功半途时可回读原结果）
    this._formDirty = true; // 用户改动后再保存会换新 clientSaveId
    this._lat = typeof d.lat === 'number' ? d.lat : null;
    this._lng = typeof d.lng === 'number' ? d.lng : null;
    this._locatedPlace = this._lat !== null ? d.place : null;
    this._placeCheckSeq += 1;
    this._noteCheckSeq += 1;
    this._placeChecked = '';
    this._noteChecked = '';
    const photos = (d.photos || []).map((p) => ({
      uid: ++this._seq,
      photoId: p.photoId,
      tempFilePath: p.tempFilePath,
      ext: p.ext,
      key: '',
      url: p.tempFilePath,
      status: (p.status === 'checking' || p.status === 'uploaded' || p.status === 'upload-failed')
        ? p.status
        : 'ready',
      progress: p.progress || 0,
      isOld: false
    }));
    this.setData({
      isEdit: false,
      editId: '',
      date: d.date,
      dateText: dateUtil.displayDate(d.date),
      place: d.place,
      placeError: '',
      placeHint: '',
      hasCoord: this._lat !== null,
      note: d.note || '',
      noteLen: (d.note || '').length,
      noteError: '',
      noteHint: '',
      photos,
      saveError: null
    });
    wx.setNavigationBarTitle({ title: '记录足迹' });
  },

  // 恢复失败的编辑（乐观编辑链）：时间线/详情点「修改未保存」徽标 → 回填编辑表单重试。
  // 照片沿用 photoId/状态可断点续跑；恢复即接管草稿（删旧，重存时新建）
  restoreEdit(id) {
    const d = drafts.get(id);
    if (!d || !d.editId) {
      wx.showToast({ title: '没有待处理的修改', icon: 'none' });
      return;
    }
    drafts.remove(id); // 接管该编辑草稿（下次保存按新草稿落盘；避免「恢复-保存」后旧草稿残留）
    const origin = d.origin || {};
    this._origin = {
      _id: d.editId,
      place: origin.place,
      note: origin.note || '',
      tags: origin.tags || []
    };
    this._removedKeys = d.removedKeys || [];
    this._clientSaveId = d.clientSaveId || null; // 沿用幂等 id（成功半途时可回读原结果）
    this._formDirty = true; // 用户改动后再保存会换新 clientSaveId
    this._lat = typeof d.lat === 'number' ? d.lat : null;
    this._lng = typeof d.lng === 'number' ? d.lng : null;
    this._locatedPlace = this._lat !== null ? d.place : null;
    this._placeCheckSeq += 1;
    this._noteCheckSeq += 1;
    this._placeChecked = '';
    this._noteChecked = '';
    const photos = (d.photos || []).map((p) => (p.isOld ? {
      uid: ++this._seq,
      photoId: '',
      tempFilePath: '',
      ext: '',
      key: p.key,
      url: '',
      status: 'done',
      progress: 100,
      isOld: true
    } : {
      uid: ++this._seq,
      photoId: p.photoId,
      tempFilePath: p.tempFilePath,
      ext: p.ext,
      key: '',
      url: p.tempFilePath,
      status: (p.status === 'checking' || p.status === 'uploaded' || p.status === 'upload-failed')
        ? p.status
        : 'ready',
      progress: p.progress || 0,
      isOld: false
    }));
    this.setData({
      isEdit: true,
      editId: d.editId,
      date: d.date,
      dateText: dateUtil.displayDate(d.date),
      place: d.place,
      placeError: '',
      placeHint: '',
      hasCoord: this._lat !== null,
      note: d.note || '',
      noteLen: (d.note || '').length,
      noteError: '',
      noteHint: '',
      photos,
      saveError: null
    });
    wx.setNavigationBarTitle({ title: '编辑足迹' });
    this.signEditThumbs(photos);
  },

  // 编辑回填照片：运行时按需签名（§1.3，process 白名单缩略图）
  signEditThumbs(photos) {
    const keys = photos.map((p) => p.key).filter(Boolean);
    if (!keys.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: keys.map((key) => ({ key, process: constants.PROCESS_THUMB }))
    }).then((data) => {
      const byKey = {};
      ((data && data.urls) || []).forEach((u) => { byKey[u.key] = u.url; });
      this.data.photos.forEach((p) => {
        if (p.isOld && byKey[p.key]) this.setPhoto(p.uid, { url: byKey[p.key] });
      });
    }).catch(() => {});
  },

  onCancelEdit() {
    wx.setNavigationBarTitle({ title: '溪山行旅' });
    this.setData({ isEdit: false, editId: '' });
    this._origin = null;
    this.resetForm();
  },

  resetForm() {
    const today = dateUtil.today();
    this._lat = null;
    this._lng = null;
    this._locatedPlace = null;
    this._origin = this.data.isEdit ? this._origin : null;
    this._removedKeys = [];
    this._clientSaveId = null;
    this._formDirty = false;
    this._placeCheckSeq += 1;
    this._noteCheckSeq += 1;
    this._reviewSubmitAt = {};
    this.setData({
      isEdit: false,
      editId: '',
      date: today,
      dateText: dateUtil.displayDate(today),
      place: '',
      placeError: '',
      placeHint: '',
      hasCoord: false,
      note: '',
      noteLen: 0,
      noteError: '',
      noteHint: '',
      photos: [],
      saveError: null
    });
    this._placeChecked = '';
    this._noteChecked = '';
  }
}, review, upload, save));
