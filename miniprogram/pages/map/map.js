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
const SIGN_BATCH = 100;

function shortDate(date) {
  return (date || '').slice(5).replace('-', '.');
}

function cleanRegion(value) {
  return (value || '').replace(/(特别行政区|自治州|地区|盟|市)$/u, '');
}

function regionText(record) {
  return [record.city, record.district].filter(Boolean).join('') || record.address || '';
}

function cityIdentity(record) {
  const city = cleanRegion(record && (record.cityLabel || record.city));
  if (city) return 'name:' + city;
  const adcode = String((record && record.adcode) || '');
  return /^\d{6}$/.test(adcode) ? 'adcode:' + adcode.slice(0, 4) : '';
}

function fallbackRegion(record) {
  const named = cleanRegion(record && (record.cityLabel || record.city || record.district || record.province));
  if (named) return named;
  const place = String((record && record.place) || '').trim();
  if (!place) return '—';
  const prefix = place.split(/[·•]/)[0].trim();
  return (prefix || place).replace(/(火车站|高铁站|汽车站|客运站|景区|公园|车站|站)$/u, '') || prefix || place;
}

function coordDistance(a, b) {
  const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dy = a.lat - b.lat;
  const dx = (a.lng - b.lng) * Math.cos(lat);
  return Math.sqrt(dx * dx + dy * dy);
}

// 详情页通过 tab 切换进入地图时无法携带 query，用一次性全局字段交接待聚焦的足迹 id。
function takeFocusMapFootprintId() {
  try {
    const app = getApp();
    const id = app && app.globalData && app.globalData.focusMapFootprintId;
    if (id) app.globalData.focusMapFootprintId = '';
    return id || '';
  } catch (e) {
    return '';
  }
}

Page({
  data: {
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    scale: DEFAULT_SCALE,
    mapSetting: {
      enableZoom: true,
      enableScroll: true,
      enableRotate: false,
      enableOverlooking: false,
      enableSatellite: false,
      enableTraffic: false,
      enablePoi: false,
      enableBuilding: false,
      showCompass: false,
      showScale: false
    },
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
    this._regionCache = {};
    this._regionFailed = {};
    this._lastMarkerTapAt = 0;
    this._view = null;
    this._loadVersion = 0;
    this._skipShowRefresh = true;
    this._pendingFocusId = takeFocusMapFootprintId();
    try {
      const win = wx.getWindowInfo();
      this.setData({ statsTop: (win.statusBarHeight || 20) + 56 });
    } catch (e) { /* 旧基础库保持默认 */ }
    this.loadRecords(false);
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(3);
    const focusId = takeFocusMapFootprintId();
    if (focusId) this._pendingFocusId = focusId;
    if (this._skipShowRefresh) {
      this._skipShowRefresh = false;
      return;
    }
    this.loadRecords(true);
  },

  loadRecords(keepView) {
    const version = ++this._loadVersion;
    db.listWithLocation({ force: true }).then((list) => {
      if (version !== this._loadVersion) return;
      this._records = list;
      const requestedId = this._pendingFocusId || '';
      const selectedId = requestedId || (keepView && this.data.card ? this.data.card.id : '');
      const selectedIndex = selectedId ? list.findIndex((f) => f._id === selectedId) : -1;
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
        // 近期写入缓存中的新照片先用本地临时路径；正式记录可见后再自然切到 OSS 缩略图。
        markerId: i,
        recordId: f._id,
        place: f.place,
        meta: shortDate(f.date) + ((f.photos || []).length ? ' · ' + f.photos.length + '张' : ''),
        photoUrl: ((f.photos || [])[0] && (f.photos || [])[0].url) || '',
        hasPhoto: !!((f.photos || [])[0] && ((f.photos || [])[0].key || (f.photos || [])[0].url)),
        side: i % 2 ? 'left' : 'right',
        selected: i === selectedIndex
      }));
      const points = list.map((f) => ({ latitude: f.lat, longitude: f.lng }));
      const polyline = points.length >= 2 ? [{
        points,
        color: '#3F393266',   // 淡墨虚线（§28：视觉优先级低于 Marker 与地点名）
        width: 2,
        dottedLine: true,
        arrowLine: false
      }] : [];
      const regionStats = this.buildRegionStats(list);
      const latest = list[list.length - 1];
      const includePoints = this.pointsForInitialView(points);
      const patch = {
        markers,
        markerViews,
        polyline,
        includePoints: keepView ? [] : includePoints,
        footprintCount: list.length,
        cityCount: regionStats.cityCount,
        recentRegion: regionStats.recentRegion,
        empty: list.length === 0,
        mapError: false
      };
      if (requestedId && selectedIndex >= 0) {
        patch.includePoints = [];
        patch.latitude = list[selectedIndex].lat;
        patch.longitude = list[selectedIndex].lng;
        patch.scale = LOCATE_SCALE;
      } else if (keepView) {
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
      if (requestedId) this._pendingFocusId = '';
      const focusIndex = selectedIndex >= 0 ? selectedIndex : (!keepView && list.length ? list.length - 1 : -1);
      this.setData(patch, () => {
        if (version !== this._loadVersion) return;
        this.loadMarkerThumbs(list, version);
        this.resolveMissingRegions(list, version);
        // 初次进入默认选中最近一条，参考稿中的照片墨钉与底部详情卡立即形成联动。
        if (focusIndex >= 0) this.selectMarker(focusIndex);
      });
    }).catch((err) => {
      if (version !== this._loadVersion) return;
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

  // 统计优先使用真实城市字段/adcode；旧记录缺行政区时按约 50km 经纬度近邻聚类，避免长期显示 0。
  buildRegionStats(list) {
    const citySet = {};
    const knownCoords = [];
    const unknown = [];
    (list || []).forEach((record) => {
      const identity = cityIdentity(record);
      const point = { lat: record.lat, lng: record.lng };
      if (identity) {
        citySet[identity] = true;
        knownCoords.push(point);
      } else {
        unknown.push(point);
      }
    });
    const clusters = [];
    unknown.forEach((point) => {
      if (knownCoords.some((known) => coordDistance(point, known) <= 0.45)) return;
      const hit = clusters.find((cluster) => coordDistance(point, cluster) <= 0.45);
      if (hit) {
        hit.lat = (hit.lat * hit.count + point.lat) / (hit.count + 1);
        hit.lng = (hit.lng * hit.count + point.lng) / (hit.count + 1);
        hit.count += 1;
      } else {
        clusters.push({ lat: point.lat, lng: point.lng, count: 1 });
      }
    });
    const recent = (list || []).length ? list[list.length - 1] : null;
    return {
      cityCount: Object.keys(citySet).length + clusters.length,
      recentRegion: recent ? fallbackRegion(recent) : '—'
    };
  },

  // 旧记录仅有坐标时后台补行政区；解析失败保留上面的坐标聚类结果，不阻塞地图交互。
  resolveMissingRegions(list, version) {
    const queue = [];
    let usedCache = false;
    (list || []).forEach((record) => {
      if (cityIdentity(record)) return;
      const key = record.lat.toFixed(5) + ',' + record.lng.toFixed(5);
      if (this._regionCache[key]) {
        Object.assign(record, this._regionCache[key]);
        usedCache = true;
      } else if (!this._regionFailed[key]) {
        queue.push({ key, record });
      }
    });
    if (usedCache) this.updateRegionStats(version);
    if (!queue.length) return;
    let cursor = 0;
    const worker = () => {
      if (cursor >= queue.length) return Promise.resolve();
      const task = queue[cursor++];
      return request.callFunction('geoResolve', {
        lat: task.record.lat,
        lng: task.record.lng,
        fallbackPlace: task.record.place
      }).then((region) => {
        this._regionCache[task.key] = region;
        if (version === this._loadVersion) Object.assign(task.record, region);
      }).catch(() => {
        this._regionFailed[task.key] = true;
      }).then(worker);
    };
    const workers = [];
    for (let i = 0; i < Math.min(3, queue.length); i++) workers.push(worker());
    Promise.all(workers).then(() => this.updateRegionStats(version));
  },

  updateRegionStats(version) {
    if (version !== this._loadVersion) return;
    const stats = this.buildRegionStats(this._records);
    const patch = {
      cityCount: stats.cityCount,
      recentRegion: stats.recentRegion
    };
    if (this.data.card) {
      const selected = this._records.find((record) => record._id === this.data.card.id);
      if (selected) patch['card.regionText'] = regionText(selected);
    }
    this.setData(patch);
  },

  loadMarkerThumbs(list, version) {
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
    this.applyMarkerThumbs(byKey, list, version);
    if (!need.length) return;
    const tasks = [];
    for (let i = 0; i < need.length; i += SIGN_BATCH) {
      tasks.push(request.callFunction('ossSts', {
        action: 'sign',
        items: need.slice(i, i + SIGN_BATCH).map((key) => ({ key, process: constants.PROCESS_THUMB }))
      }));
    }
    Promise.all(tasks).then((results) => {
      if (version !== this._loadVersion) return;
      const items = [];
      results.forEach((data) => items.push.apply(items, (data && data.urls) || []));
      contentCache.setSignedMany(constants.PROCESS_THUMB, items);
      items.forEach((item) => {
        this._thumbCache[item.key] = item;
        byKey[item.key] = item.url;
      });
      this.applyMarkerThumbs(byKey, list, version);
    }).catch(() => {});
  },

  applyMarkerThumbs(byKey, list, version) {
    if (version !== this._loadVersion) return;
    const next = this.data.markerViews.map((view, i) => {
      const record = list[i];
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
    const photos = (record.photos || []).filter((p) => p && (p.key || p.url));
    if (!photos.length) return;
    const selected = photos.slice(0, 6);
    const byKey = {};
    const need = [];
    selected.forEach((p) => {
      if (p.url) return;
      const cached = contentCache.getSigned(constants.PROCESS_THUMB, p.key);
      if (cached && cached.url && cached.expireAt > Date.now() + 60000) byKey[p.key] = cached.url;
      else need.push(p.key);
    });
    const apply = () => {
      if (!this.data.card || this.data.card.id !== record._id) return;
      const urls = selected.map((p) => p.url || byKey[p.key]).filter(Boolean);
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
