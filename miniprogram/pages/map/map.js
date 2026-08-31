// 足迹地图 V1.3：真实地点独立标注、照片 Marker、时间顺序虚线、统计与底部详情卡片。
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const request = require('../../utils/request');
const constants = require('../../utils/constants');
const contentCache = require('../../utils/content-cache');

const DEFAULT_CENTER = { latitude: 30.75, longitude: 120.75 };
const DEFAULT_SCALE = 9;
const LOCATE_SCALE = 13;
const MARKER_TAP_GUARD_MS = 300;

function shortDate(date) {
  return (date || '').slice(5).replace('-', '.');
}

function cleanRegion(value) {
  return (value || '').replace(/(特别行政区|自治州|地区|盟|市)$/u, '');
}

function regionText(record) {
  return [record.city, record.district].filter(Boolean).join('') || record.address || '';
}

Page({
  data: {
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    scale: DEFAULT_SCALE,
    includePoints: [],
    markers: [],
    markerViews: [],
    polyline: [],
    footprintCount: 0,
    cityCount: 0,
    recentRegion: '—',
    empty: false,
    mapError: false,
    card: null,
    locating: false,
    statsTop: 72  // 统计信息带 top（px）：状态栏 + 导航行高度
  },

  onLoad() {
    this._records = [];
    this._thumbCache = {};
    this._lastMarkerTapAt = 0;
    this._view = null;
    this._skipShowRefresh = true;
    try {
      const win = wx.getWindowInfo();
      this.setData({ statsTop: (win.statusBarHeight || 20) + 56 });
    } catch (e) { /* 旧基础库保持默认 */ }
    this.loadRecords(false);
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(3);
    if (this._skipShowRefresh) {
      this._skipShowRefresh = false;
      return;
    }
    this.loadRecords(true);
  },

  loadRecords(keepView) {
    db.listWithLocation({ force: true }).then((list) => {
      this._records = list;
      // Marker：小墨点代表真实坐标（§27.3），地点信息由上方透明 callout 呈现（无白色胶囊）
      const markers = list.map((f, i) => ({
        id: i,
        latitude: f.lat,
        longitude: f.lng,
        iconPath: '/assets/map/marker-dot.png',
        width: 10,
        height: 10,
        anchor: { x: 0.5, y: 0.5 },
        customCallout: { display: 'ALWAYS', anchorY: 0 }
      }));
      const markerViews = list.map((f, i) => ({
        markerId: i,
        recordId: f._id,
        place: f.place,
        meta: shortDate(f.date) + ((f.photos || []).length ? ' · ' + f.photos.length + '张' : ''),
        photoUrl: '',
        hasPhoto: !!((f.photos || [])[0] && (f.photos || [])[0].key),
        side: i % 2 ? 'left' : 'right',
        selected: false
      }));
      const points = list.map((f) => ({ latitude: f.lat, longitude: f.lng }));
      const polyline = points.length >= 2 ? [{
        points,
        color: '#3F393266',   // 淡墨虚线（§28：视觉优先级低于 Marker 与地点名）
        width: 2,
        dottedLine: true,
        arrowLine: false
      }] : [];
      const citySet = {};
      list.forEach((f) => {
        const city = cleanRegion(f.cityLabel || f.city);
        if (city) citySet[city] = true;
      });
      const recent = list.slice().reverse().find((f) => f.cityLabel || f.city || f.province);
      const latest = list[list.length - 1];
      const includePoints = this.pointsForInitialView(points);
      const patch = {
        markers,
        markerViews,
        polyline,
        includePoints: keepView ? [] : includePoints,
        footprintCount: list.length,
        cityCount: Object.keys(citySet).length,
        recentRegion: recent ? cleanRegion(recent.cityLabel || recent.city || recent.province) : '—',
        empty: list.length === 0,
        mapError: false
      };
      if (keepView) {
        const view = this._view || {
          latitude: this.data.latitude,
          longitude: this.data.longitude,
          scale: this.data.scale
        };
        Object.assign(patch, view);
        if (this.data.card && !list.some((f) => f._id === this.data.card.id)) patch.card = null;
      } else {
        patch.latitude = latest ? latest.lat : DEFAULT_CENTER.latitude;
        patch.longitude = latest ? latest.lng : DEFAULT_CENTER.longitude;
        patch.scale = DEFAULT_SCALE;
      }
      this.setData(patch);
      this.loadMarkerThumbs(list);
    }).catch((err) => {
      this.setData({ mapError: true });
      wx.showToast({ title: (err && err.message) || '地图暂时没有加载出来', icon: 'none' });
    });
  },

  pointsForInitialView(points) {
    if (points.length <= 1) return points;
    const lats = points.map((p) => p.latitude);
    const lngs = points.map((p) => p.longitude);
    const span = Math.max(
      Math.max.apply(null, lats) - Math.min.apply(null, lats),
      Math.max.apply(null, lngs) - Math.min.apply(null, lngs)
    );
    return span > 5 ? points.slice(-5) : points;
  },

  loadMarkerThumbs(list) {
    const need = [];
    const byKey = {};
    list.forEach((f) => {
      const first = (f.photos || [])[0];
      if (!first || !first.key) return;
      const cached = this._thumbCache[first.key] || contentCache.getSigned(constants.PROCESS_THUMB, first.key);
      if (cached && cached.url && cached.expireAt > Date.now() + 60000) {
        byKey[first.key] = cached.url;
      } else if (!need.includes(first.key)) {
        need.push(first.key);
      }
    });
    this.applyMarkerThumbs(byKey);
    if (!need.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: need.map((key) => ({ key, process: constants.PROCESS_THUMB }))
    }).then((data) => {
      const items = (data && data.urls) || [];
      contentCache.setSignedMany(constants.PROCESS_THUMB, items);
      items.forEach((item) => {
        this._thumbCache[item.key] = item;
        byKey[item.key] = item.url;
      });
      this.applyMarkerThumbs(byKey);
    }).catch(() => {});
  },

  applyMarkerThumbs(byKey) {
    const next = this.data.markerViews.map((view, i) => {
      const record = this._records[i];
      const key = record && record.photos && record.photos[0] && record.photos[0].key;
      return Object.assign({}, view, { photoUrl: (key && byKey[key]) || view.photoUrl || '' });
    });
    this.setData({ markerViews: next });
  },

  onRegionChange(e) {
    if (!e || e.type !== 'end') return;
    const d = e.detail || {};
    const c = d.centerLocation;
    if (c && typeof c.latitude === 'number' && typeof c.longitude === 'number' && typeof d.scale === 'number') {
      this._view = { latitude: c.latitude, longitude: c.longitude, scale: d.scale };
    }
  },

  onMarkerTap(e) {
    this.selectMarker(Number(e.detail.markerId));
  },

  onCalloutTap(e) {
    this.selectMarker(Number(e.detail.markerId));
  },

  selectMarker(markerId) {
    const record = this._records[markerId];
    if (!record) return;
    this._lastMarkerTapAt = Date.now();
    const photoCount = (record.photos || []).length;
    this.setData({
      markerViews: this.data.markerViews.map((view, i) => Object.assign({}, view, { selected: i === markerId })),
      card: {
        id: record._id,
        place: record.place,
        regionText: regionText(record),
        dateText: dateUtil.displayDate(record.date),
        photoCount,
        thumb: '',
        previews: [],
        moreCount: 0
      }
    });
    this.loadCardPhotos(record);
  },

  loadCardPhotos(record) {
    const photos = (record.photos || []).filter((p) => p && p.key);
    if (!photos.length) return;
    const selected = photos.slice(0, 6);
    const byKey = {};
    const need = [];
    selected.forEach((p) => {
      const cached = contentCache.getSigned(constants.PROCESS_THUMB, p.key);
      if (cached && cached.url && cached.expireAt > Date.now() + 60000) byKey[p.key] = cached.url;
      else need.push(p.key);
    });
    const apply = () => {
      if (!this.data.card || this.data.card.id !== record._id) return;
      const urls = selected.map((p) => byKey[p.key]).filter(Boolean);
      const visibleCount = photos.length > 5 ? 5 : 6;
      this.setData({
        'card.thumb': urls[0] || '',
        'card.previews': urls.slice(0, visibleCount),
        'card.moreCount': Math.max(0, photos.length - visibleCount)
      });
    };
    apply();
    if (!need.length) return;
    request.callFunction('ossSts', {
      action: 'sign',
      items: need.map((key) => ({ key, process: constants.PROCESS_THUMB }))
    }).then((data) => {
      const items = (data && data.urls) || [];
      contentCache.setSignedMany(constants.PROCESS_THUMB, items);
      items.forEach((item) => { byKey[item.key] = item.url; });
      apply();
    }).catch(() => {});
  },

  onMapTap() {
    if (Date.now() - this._lastMarkerTapAt < MARKER_TAP_GUARD_MS) return;
    if (this.data.card) {
      this.setData({
        card: null,
        markerViews: this.data.markerViews.map((view) => Object.assign({}, view, { selected: false }))
      });
    }
  },

  onCardTap() {
    if (this.data.card) wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.card.id });
  },

  onRouteInfoTap() {
    wx.showModal({
      title: '足迹连线说明',
      content: '足迹连线仅表示记录的先后顺序，不代表真实行走路线。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#35322C'
    });
  },

  onLocate() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({ latitude: res.latitude, longitude: res.longitude, scale: LOCATE_SCALE, includePoints: [] });
      },
      fail: (err) => {
        const denied = /auth|deny|authorize/.test((err && err.errMsg) || '');
        if (denied) {
          wx.showModal({
            title: '未授权定位',
            content: '开启定位权限后可定位到当前位置，地图浏览不受影响',
            confirmText: '去设置',
            cancelText: '取消',
            success: (r) => { if (r.confirm) wx.openSetting(); }
          });
        } else {
          wx.showToast({ title: '暂时无法获取当前位置', icon: 'none' });
        }
      },
      complete: () => this.setData({ locating: false })
    });
  }
});
