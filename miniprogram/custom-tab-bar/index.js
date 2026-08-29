Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/timeline/timeline', text: '时间线', icon: '/assets/icons/timeline.png', iconActive: '/assets/icons/timeline-active.png' },
      { pagePath: '/pages/calendar/calendar', text: '日历', icon: '/assets/icons/calendar.png', iconActive: '/assets/icons/calendar-active.png' },
      { pagePath: '/pages/add/add', text: '记录', icon: '', iconActive: '', isCenter: true },
      { pagePath: '/pages/map/map', text: '地图', icon: '/assets/icons/map.png', iconActive: '/assets/icons/map-active.png' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: '/assets/icons/mine.png', iconActive: '/assets/icons/mine-active.png' }
    ]
  },

  methods: {
    onTap(e) {
      const index = e.currentTarget.dataset.index;
      const item = this.data.list[index];
      // 中央「＋」与其余页签均 switchTab 直达（add 为 tab 页，任意页签可直达，FR-03 验收 1）
      wx.switchTab({ url: item.pagePath });
    },

    // 各 tab 页 onShow 时调用：this.getTabBar().setSelected(index)
    setSelected(index) {
      this.setData({ selected: index });
    }
  }
});
