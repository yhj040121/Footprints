// 足迹地图页（FR-10）：含坐标记录打点 + 按记录先后顺序连线 + 底部记录卡片 + 定位我
// 视角保持（FR-10 验收 4）：onShow 重拉数据保证 marker 最新，但恢复用户离开前的中心点与缩放
// （regionchange 捕获视角；首进仍居中到最新一条记录）
const db = require('../../utils/db');
const dateUtil = require('../../utils/date');
const request = require('../../utils/request');
const constants = require('../../utils/constants');
const contentCache = require('../../utils/content-cache');

// 无任何含坐标记录时的默认中心（无锡附近）与缩放
const DEFAULT_CENTER = { latitude: 31.57, longitude: 120.30 };
const DEFAULT_SCALE = 8;
const LOCATE_SCALE = 12;
// marker 点击后 map 的 tap 可能连带触发，此窗口内的 map tap 视为打点而非点空白
const MARKER_TAP_GUARD_MS = 300;

Page({
  data: {
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    scale: DEFAULT_SCALE,
    markers: [],
    polyline: [],
    empty: false,      // 无任何含坐标记录
    card: null,        // 底部卡片 { id, dateText, place, note, thumb }
    locating: false
  },

  onLoad() {
    this._records = [];       // 与 markers 同序的原始记录（id = 数组下标）
    this._thumbCache = {};    // recordId -> { url, expireAt }，签名 URL 1h 内复用
    this._lastMarkerTapAt = 0;
    this._view = null;        // 用户离开前的视角 { latitude, longitude, scale }（regionchange 捕获）
    this._skipShowRefresh = true;
    this.loadRecords(false);
  },

  onShow() {
    const tb = this.getTabBar && this.getTabBar();
    if (tb) tb.setSelected(3);
    if (this._skipShowRefresh) {
      this._skipShowRefresh = false;
      return;
    }
    // 重拉数据（新增/编辑/删除后 marker 刷新），但保持离开前的视角
    this.loadRecords(true);
  },

  // 全部含坐标记录（工具层已过滤成对 number 坐标，并按 date asc + createdAt asc 排序，同日按创建先后连线）
  // keepView=true 时不重置中心点与缩放
  loadRecords(keepView) {
    db.listWithLocation().then((list) => {
      this._records = list;
      const markers = list.map((f, i) => ({
        id: i,
        latitude: f.lat,
        longitude: f.lng,
        iconPath: '/assets/icons/marker.png',
        width: 32,
        height: 32,
        anchor: { x: 0.5, y: 0.5 }
      }));
      const points = list.map((f) => ({ latitude: f.lat, longitude: f.lng }));
      const polyline = points.length >= 2 ? [{
        points: points,
        color: '#35322C',
        width: 2,
        arrowLine: false
      }] : [];
      const patch = {
        markers: markers,
        polyline: polyline,
        empty: list.length === 0
      };
      if (keepView) {
        // 恢复离开前视角；用户未拖动过地图则维持当前中心
        const view = this._view || {
          latitude: this.data.latitude,
          longitude: this.data.longitude,
          scale: this.data.scale
        };
        patch.latitude = view.latitude;
        patch.longitude = view.longitude;
        patch.scale = view.scale;
        // 打开中的卡片对应记录已不在 → 收起
        if (this.data.card && !list.some((f) => f._id === this.data.card.id)) patch.card = null;
      } else {
        const latest = list[list.length - 1];
        patch.latitude = latest ? latest.lat : DEFAULT_CENTER.latitude;
        patch.longitude = latest ? latest.lng : DEFAULT_CENTER.longitude;
        patch.scale = DEFAULT_SCALE;
      }
      this.setData(patch);
    }).catch((err) => {
      wx.showToast({ title: (err && err.message) || '加载失败，请稍后再试', icon: 'none' });
    });
  },

  // 手势/程序化视野变化结束时捕获中心点与缩放（视角保持的数据源）
  onRegionChange(e) {
    if (!e || e.type !== 'end') return;
    const d = e.detail || {};
    const c = d.centerLocation;
    if (c && typeof c.latitude === 'number' && typeof c.longitude === 'number' && typeof d.scale === 'number') {
      this._view = { latitude: c.latitude, longitude: c.longitude, scale: d.scale };
    }
  },

  onMarkerTap(e) {
    const record = this._records[e.detail.markerId];
    if (!record) return;
    this._lastMarkerTapAt = Date.now();
    this.setData({
      card: {
        id: record._id,
        dateText: dateUtil.displayDate(record.date),
        place: record.place,
        note: record.note || '',
        thumb: ''
      }
    });
    this.loadThumb(record);
  },

  // 首图缩略图（w_300）按需签发；签发失败仅缺图，不影响卡片其余字段
  loadThumb(record) {
    const first = (record.photos || [])[0];
    if (!first || !first.key) return;
    const cached = this._thumbCache[record._id] || contentCache.getSigned(constants.PROCESS_THUMB, first.key);
    if (cached && cached.expireAt > Date.now()) {
      this._thumbCache[record._id] = cached;
      this.setData({ 'card.thumb': cached.url });
      return;
    }
    request.callFunction('ossSts', {
      action: 'sign',
      items: [{ key: first.key, process: constants.PROCESS_THUMB }]
    }).then((data) => {
      const item = (data.urls || [])[0];
      if (!item) return;
      this._thumbCache[record._id] = { url: item.url, expireAt: item.expireAt };
      contentCache.setSignedMany(constants.PROCESS_THUMB, [item]);
      if (this.data.card && this.data.card.id === record._id) {
        this.setData({ 'card.thumb': item.url });
      }
    }).catch(() => {});
  },

  // 点地图空白收起卡片（打点后的连带 tap 在守卫窗口内忽略）
  onMapTap() {
    if (Date.now() - this._lastMarkerTapAt < MARKER_TAP_GUARD_MS) return;
    if (this.data.card) this.setData({ card: null });
  },

  onCardClose() {
    this.setData({ card: null });
  },

  onCardTap() {
    const card = this.data.card;
    if (!card) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + card.id });
  },

  // 「定位我」：wgs84 取当前位置并移中心；拒绝授权则引导去设置，其余功能不受影响
  onLocate() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    wx.getLocation({
      type: 'wgs84',
      success: (res) => {
        this.setData({
          latitude: res.latitude,
          longitude: res.longitude,
          scale: LOCATE_SCALE
        });
      },
      fail: (err) => {
        const denied = err && err.errMsg && err.errMsg.indexOf('auth') >= 0;
        if (denied) {
          wx.showModal({
            title: '未授权定位',
            content: '开启定位权限后可定位到当前位置，地图浏览不受影响',
            confirmText: '去设置',
            cancelText: '取消',
            success: (r) => {
              if (r.confirm) wx.openSetting();
            }
          });
        } else {
          wx.showToast({ title: '定位失败，请稍后再试', icon: 'none' });
        }
      },
      complete: () => {
        this.setData({ locating: false });
      }
    });
  }
});
