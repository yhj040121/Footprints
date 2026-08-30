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
    allTags: [],           // 可选标签 = 本人 customTags ∪ 已选旧标签（编辑存量，S7-R4 预设已移除）
    customTags: [],        // 服务端返回的自定义标签；仅这些标签展示删除入口
    selectedTags: [],
    maxTags: constants.MAX_TAGS,
    maxTagLen: constants.MAX_TAG_LEN,
    photos: [],            // { uid, photoId, tempFilePath, ext, key, url, status, progress, isOld }
    maxPhotos: constants.MAX_PHOTOS,

    // 自定义标签弹窗
    tagModalVisible: false,
    tagInput: '',
    tagError: '',          // 弹窗内轻提示（S7-R4：审核失败不再 toast 打断）
    tagChecking: false,
    deletingTag: '',

    // 保存进度弹层
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
    this._customTags = [];      // 服务端 user.customTags（唯一可选标签来源，S7-R4 无预设）
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
    this.refreshTags();
  },

  onHide() {
    // 检测/上传中退出本页 → 终止本次保存：停止轮询、不调 commit、无残留（FR-06 验收 4）
    if (this.data.saving) {
      this.cancelSave();
      if (!this.data.isEdit) this._needReset = true;
    }
  },

  onUnload() {
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

  // ---------- 标签（FR-03 S7-R4：全部自定义，无预设；≤3 个、单个 ≤6 字） ----------

  refreshTags() {
    return db.getProfile().then((p) => {
      this._customTags = ((p && p.customTags) || []).slice();
      this.buildTagOptions();
    }).catch(() => {});
  },

  // 可选标签 = 本人 customTags ∪ 已选标签（编辑存量记录的旧标签如「徒步」未删时原样可选可保留，
  // 删除也允许——删除不走审核，S7-R4 编辑兼容）。去重防同一标签渲染两个 chip 导致连动勾选
  buildTagOptions() {
    const seen = {};
    const options = [];
    this._customTags.concat(this.data.selectedTags).forEach((t) => {
      if (t && !seen[t]) {
        seen[t] = true;
        options.push(t);
      }
    });
    this.setData({ allTags: options, customTags: this._customTags.slice() });
  },

  onTagToggle(e) {
    const tag = e.currentTarget.dataset.tag;
    const selected = this.data.selectedTags.slice();
    const idx = selected.indexOf(tag);
    if (idx >= 0) {
      selected.splice(idx, 1); // 删除不需审核（旧标签同样允许删）
    } else {
      if (selected.length >= constants.MAX_TAGS) {
        wx.showToast({ title: '最多选择 ' + constants.MAX_TAGS + ' 个标签', icon: 'none' });
        return;
      }
      selected.push(tag);
    }
    this.markDirty();
    this.setData({ selectedTags: selected });
  },

  // 全部现行标签均为自定义标签：角标进入删除，二次确认后由 login.updateProfile 服务端删除。
  // 编辑记录里仅为兼容而回填的旧标签不在 customTags 中，因此不会展示删除入口。
  onDeleteCustomTag(e) {
    const tag = e.currentTarget.dataset.tag;
    if (!tag || this.data.saving || this.data.deletingTag || this._customTags.indexOf(tag) < 0) return;
    wx.showModal({
      title: '删除标签',
      content: '确认删除「' + tag + '」？已选中的该标签也会移除。',
      confirmText: '删除',
      confirmColor: '#8C3B2E',
      success: (res) => {
        if (res.confirm) this.deleteCustomTag(tag);
      }
    });
  },

  deleteCustomTag(tag) {
    this.setData({ deletingTag: tag });
    request.callFunction('login', {
      action: 'updateProfile',
      removeCustomTags: [tag]
    }).then((data) => {
      const profile = (data && data.profile) || {};
      const customTags = Array.isArray(profile.customTags) ? profile.customTags.slice() : [];
      const previousCustomTags = this._customTags.slice();
      const selectedTags = this.data.selectedTags.filter((t) =>
        previousCustomTags.indexOf(t) < 0 || customTags.indexOf(t) >= 0
      );
      const app = getApp();
      if (app) app.globalData.profile = Object.assign({}, app.globalData.profile || {}, profile);
      this._customTags = customTags;
      if (selectedTags.length !== this.data.selectedTags.length) this.markDirty();
      this.setData({ deletingTag: '', selectedTags });
      this.buildTagOptions();
    }).catch((err) => {
      this.setData({ deletingTag: '' });
      wx.showToast({ title: (err && err.message) || '标签删除失败，请重试', icon: 'none' });
    });
  },

  onShowTagModal() {
    if (this.data.selectedTags.length >= constants.MAX_TAGS) {
      wx.showToast({ title: '最多选择 ' + constants.MAX_TAGS + ' 个标签', icon: 'none' });
      return;
    }
    this.setData({ tagModalVisible: true, tagInput: '', tagError: '' });
  },

  onTagInput(e) {
    // 超 6 字直接截断（S7-R4，不再 toast）
    this.setData({ tagInput: (e.detail.value || '').slice(0, constants.MAX_TAG_LEN), tagError: '' });
  },

  onTagModalCancel() {
    this.setData({ tagModalVisible: false, tagInput: '', tagError: '' });
  },

  // 自定义标签：先审后由服务端写入（S6-R3，契约 §1.2 text / FR-03）——
  // 客户端只调 secCheck.text（field=customTag），通过后服务端原子追加到 user.customTags 并返回完整数组。
  // S7-R4 无感知审核：过程无状态文案，失败只在弹窗内轻提示，无 toast/无跳转
  onTagConfirm() {
    const tag = (this.data.tagInput || '').trim();
    if (!tag) { this.onTagModalCancel(); return; }
    // 去重：已存在则直接选中，不产生重复（FR-03 验收 5）
    if (this.data.allTags.indexOf(tag) >= 0) {
      const selected = this.data.selectedTags.slice();
      if (selected.indexOf(tag) < 0 && selected.length < constants.MAX_TAGS) selected.push(tag);
      this.setData({ tagModalVisible: false, tagInput: '', tagError: '', selectedTags: selected });
      return;
    }
    if (this.data.tagChecking) return;
    this.setData({ tagChecking: true });
    request.callFunction('secCheck', {
      action: 'text',
      texts: [{ field: 'customTag', content: tag }]
    }).then((data) => {
      // 用服务端返回的完整 customTags 刷新；兜底并上本次标签，保证「输入 ABC → 可选与已选有且只有 ABC」
      const custom = ((data && data.customTags) || this._customTags.slice()).slice();
      if (custom.indexOf(tag) < 0) custom.push(tag);
      this._customTags = custom;
      const selected = this.data.selectedTags.slice();
      if (selected.indexOf(tag) < 0 && selected.length < constants.MAX_TAGS) selected.push(tag);
      this.markDirty();
      this.setData({
        tagChecking: false,
        tagModalVisible: false,
        tagInput: '',
        tagError: '',
        selectedTags: selected
      });
      this.buildTagOptions();
    }).catch((err) => {
      this.setData({
        tagChecking: false,
        tagError: (err && err.code === 2001)
          ? '该标签未通过安全检测，请换一个'
          : ((err && err.message) || '标签暂不可用，请稍后再试')
      });
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
      if (res.rejectedCount > 0) {
        wx.showToast({ title: res.rejectedCount + ' 张大小/格式不支持，已跳过', icon: 'none' });
      }
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
        selectedTags: (fp.tags || []).slice(),
        photos,
        saveError: null
      });
      wx.setNavigationBarTitle({ title: '编辑足迹' });
      this.buildTagOptions(); // 先同步并集渲染（含旧标签），customTags 随后由 refreshTags 刷新
      this.refreshTags();
      this.signEditThumbs(photos);
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    });
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
      selectedTags: [],
      photos: [],
      saveError: null
    });
    this._placeChecked = '';
    this._noteChecked = '';
    this.buildTagOptions();
  }
}, review, upload, save));
