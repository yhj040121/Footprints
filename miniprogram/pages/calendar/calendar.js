// FR-09 日历视图
// 加载纪律（FR-09 验收 4）：先渲染 42 格日期数字，再异步补记录标记与缩略图——
// db.listByMonth 拉当月记录按 date 归组 → 逐日取「最新一条有图记录」首图 key →
// 一次 ossSts.sign（process=PROCESS_THUMB）批量签发 → 回填格子与当日卡片封面。
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const constants = require('../../utils/constants');
const request = require('../../utils/request');
const contentCache = require('../../utils/content-cache');

const WEEK_DAYS = ['日', '一', '二', '三', '四', '五', '六'];
// 签名 URL 有效期 1h（契约 §6），临期 1 分钟内视为待重签
const SIGN_REFRESH_MARGIN_MS = 60 * 1000;
// ossSts.sign 单次上限 100 项（契约 §1.3）
const SIGN_BATCH_MAX = 100;

Page({
  data: {
    year: 0,
    month: 0,
    monthLabel: '',
    weekDays: WEEK_DAYS,
    cells: [],          // 42 格 { date, day, inMonth, isToday, isSelected, dot, thumb }
    selectedDate: '',
    dayTitle: '',
    dayRecords: []      // 当日记录 [{ _id, date, place, note, tags, coverUrl }]
  },

  onLoad() {
    this._cache = {};   // 'YYYY-MM' → { byDate: {date: [records]}, thumbKey: {date: key|null}, urls: {key: {url, expireAt}} }
    this._loadSeq = 0;  // 切月竞态令牌
    this._skipShowRefresh = true;
    const todayStr = dateUtil.today();
    this._showMonth(todayStr.slice(0, 7), todayStr);
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(1);
    if (this._skipShowRefresh) {
      this._skipShowRefresh = false;
      return;
    }
    // 其他入口（新增/详情删除/编辑）可能改动数据：清当月缓存重拉，保留当前选中日期
    const ym = this._ym();
    delete this._cache[ym];
    this._loadMonth(ym);
  },

  // ---------- 事件 ----------

  onPrevMonth() {
    this._shiftMonth(-1);
  },

  onNextMonth() {
    this._shiftMonth(1);
  },

  onTapCell(e) {
    const date = e.currentTarget.dataset.date;
    const inMonth = !!e.currentTarget.dataset.inmonth;
    if (!date) return;
    if (!inMonth) {
      // 点了相邻月灰格：切到该月并选中该日
      this._showMonth(date.slice(0, 7), date);
      return;
    }
    if (date === this.data.selectedDate) return;
    const cells = this.data.cells.map((c) => Object.assign({}, c, { isSelected: c.date === date }));
    this.setData({ cells, selectedDate: date });
    const entry = this._cache[this._ym()];
    if (entry) this._renderDayList(entry);
  },

  onTapCard(e) {
    // footprint-card triggerEvent('tap') 与原生 tap 冒泡都会到这里，无 id 的忽略
    const id = e.detail && e.detail.id;
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  // ---------- 内部 ----------

  _ym() {
    return this.data.year + '-' + dateUtil.pad2(this.data.month);
  },

  _shiftMonth(n) {
    const ym = dateUtil.addMonths(this._ym(), n);
    const todayStr = dateUtil.today();
    // 默认选中今天；今天不在目标月则选 1 号
    const sel = todayStr.slice(0, 7) === ym ? todayStr : ym + '-01';
    this._showMonth(ym, sel);
  },

  // 切月：立刻渲染纯日期格子（清空旧格图，无残留），再异步加载
  _showMonth(ym, selectedDate) {
    const year = +ym.slice(0, 4);
    const month = +ym.slice(5, 7);
    const todayStr = dateUtil.today();
    const cells = dateUtil.calendarGrid(year, month).map((c) => ({
      date: c.date,
      day: c.day,
      inMonth: c.inMonth,
      isToday: c.date === todayStr,
      isSelected: c.date === selectedDate,
      dot: false,
      thumb: '',
      loading: false      // 有首图但签名未完成 → 加载中占位
    }));
    this.setData({
      year,
      month,
      monthLabel: year + '年' + month + '月',
      cells,
      selectedDate,
      dayTitle: '',
      dayRecords: []
    });
    this._loadMonth(ym);
  },

  _loadMonth(ym) {
    const seq = ++this._loadSeq;
    const applyEntry = (entry) => {
      if (seq !== this._loadSeq || ym !== this._ym()) return;
      this._paint(entry, false);   // 先补圆点标记，图片待发签后回填
      this._renderDayList(entry);
      this._signAndPaint(entry, seq, ym);
    };
    const cached = this._cache[ym];
    if (cached) {
      applyEntry(cached);
      return;
    }
    db.listByMonth(ym)
      .then((list) => {
        const entry = this._buildEntry(list);
        this._cache[ym] = entry;
        applyEntry(entry);
      })
      .catch(() => {
        if (seq === this._loadSeq && ym === this._ym()) {
          wx.showToast({ title: '日历加载失败，请稍后再试', icon: 'none' });
        }
      });
  },

  // 按月归组；listByMonth 返回已按 date desc + createdAt desc，故每日首个有图记录即「最新一条有图记录」
  _buildEntry(list) {
    const byDate = {};
    (list || []).forEach((r) => {
      if (!r || !r.date) return;
      (byDate[r.date] = byDate[r.date] || []).push(r);
    });
    const thumbKey = {};
    Object.keys(byDate).forEach((d) => {
      const hit = byDate[d].filter((r) => (r.photos || []).length > 0)[0];
      thumbKey[d] = hit ? hit.photos[0].key : null;
    });
    return { byDate, thumbKey, urls: contentCache.getSignedMap(constants.PROCESS_THUMB) };
  },

  // 回填格子：dot（有记录但全部无图，或签名失败降级）/ loading（有首图但签名未完成）/ thumb（已签发则有值）
  _paint(entry, withThumbs) {
    const cells = this.data.cells.map((c) => {
      if (!c.inMonth) return Object.assign({}, c, { dot: false, thumb: '', loading: false });
      const key = entry.thumbKey[c.date];
      const signed = key && entry.urls[key];
      return Object.assign({}, c, {
        dot: !!entry.byDate[c.date] && (!key || (!!entry.signFailed && !signed)),
        thumb: withThumbs && signed ? signed.url : '',
        loading: !!key && !signed && !entry.signFailed
      });
    });
    this.setData({ cells });
  },

  // 当月全部首图 key（格图 + 当日卡片封面）一次批量签发
  _signAndPaint(entry, seq, ym) {
    const keys = [];
    Object.keys(entry.thumbKey).forEach((d) => {
      if (entry.thumbKey[d]) keys.push(entry.thumbKey[d]);
    });
    Object.keys(entry.byDate).forEach((d) => {
      entry.byDate[d].forEach((r) => {
        const p = (r.photos || [])[0];
        if (p && keys.indexOf(p.key) < 0) keys.push(p.key);
      });
    });
    const now = Date.now();
    const need = keys
      .filter((k) => !entry.urls[k] || entry.urls[k].expireAt - now < SIGN_REFRESH_MARGIN_MS)
      .slice(0, SIGN_BATCH_MAX);
    if (!need.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: need.map((k) => ({ key: k, process: constants.PROCESS_THUMB }))
    })
      .then((res) => {
        const urls = (res && res.urls) || [];
        urls.forEach((u) => { entry.urls[u.key] = u; });
        contentCache.setSignedMany(constants.PROCESS_THUMB, urls);
        if (seq !== this._loadSeq || ym !== this._ym()) return;
        this._paint(entry, true);
        this._renderDayList(entry);
      })
      .catch(() => {
        // 签发失败降级：清掉加载中占位、回退圆点，日期数字仍在，不阻塞日历
        entry.signFailed = true;
        if (seq !== this._loadSeq || ym !== this._ym()) return;
        this._paint(entry, true);
      });
  },

  _renderDayList(entry) {
    const date = this.data.selectedDate;
    const recs = (entry.byDate[date] || []).map((r) => {
      const p = (r.photos || [])[0];
      const signed = p && entry.urls[p.key];
      return {
        _id: r._id,
        date: r.date,
        place: r.place,
        note: r.note || '',
        tags: r.tags || [],
        coverUrl: signed ? signed.url : ''
      };
    });
    this.setData({
      dayTitle: dateUtil.displayDateCn(date) + ' · ' + recs.length + '条行旅记录',
      dayRecords: recs
    });
  }
});
