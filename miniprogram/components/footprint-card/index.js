Component({
  properties: {
    // { _id, date, place, note, tags: [] }
    record: { type: Object, value: {} },
    // 首图签名 URL（缩略图 process 由调用方签发），无图传 ''
    coverUrl: { type: String, value: '' }
  },

  methods: {
    onTap() {
      this.triggerEvent('tap', {
        id: this.data.record._id,
        isDraft: !!this.data.record.isDraft
      });
    }
  }
});
