Component({
  properties: {
    // 书法标题素材（如 titles/map-title.png）；不传则用文字标题
    titleImage: { type: String, value: '' },
    title: { type: String, value: '' }
  },

  data: {
    statusBarHeight: 20
  },

  lifetimes: {
    attached() {
      try {
        const win = wx.getWindowInfo();
        this.setData({ statusBarHeight: win.statusBarHeight || 20 });
      } catch (e) {
        // 旧基础库降级：保持默认高度
      }
    }
  }
});
