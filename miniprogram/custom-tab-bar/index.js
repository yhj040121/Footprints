Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/timeline/timeline', text: '时间线', icon: '☰' },
      { pagePath: '/pages/calendar/calendar', text: '日历', icon: '▦' },
      { pagePath: '/pages/add/add', text: '记录', icon: '', isCenter: true },
      { pagePath: '/pages/map/map', text: '地图', icon: '◎' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: '◡' }
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
