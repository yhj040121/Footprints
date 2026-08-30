Component({
  data: {
    selected: 0,
    // 图标为 pic/ SVG 预渲染 PNG（active 态由样式 opacity 区分，不需要双份图）
    list: [
      { pagePath: '/pages/timeline/timeline', text: '时间轴', icon: '/assets/tabbar/timeline.png' },
      { pagePath: '/pages/calendar/calendar', text: '日历', icon: '/assets/tabbar/calendar.png' },
      { pagePath: '/pages/add/add', text: '记录', icon: '', isCenter: true },
      { pagePath: '/pages/map/map', text: '地图', icon: '/assets/tabbar/map.png' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: '/assets/tabbar/mine.png' }
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
