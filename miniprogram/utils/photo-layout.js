// 足迹详情照片排版：只决定版式与瀑布流分列，不改变任何照片的原始比例。
const MAX_DETAIL_PHOTOS = 9;
const PORTRAIT_MAX_RATIO = 0.85;
const FALLBACK_RATIO = 4 / 3;

function safeRatio(item) {
  const width = Number(item && item.width);
  const height = Number(item && item.height);
  const stored = Number(item && item.ratio);
  if (width > 0 && height > 0) return width / height;
  return stored > 0 ? stored : FALLBACK_RATIO;
}

function normalizeItem(item) {
  return Object.assign({}, item, { ratio: safeRatio(item) });
}

// 等宽双列中，显示高度与 1 / ratio 成正比；每次放入当前累计高度更短的一列。
function splitMasonry(items) {
  const left = [];
  const right = [];
  let leftHeight = 0;
  let rightHeight = 0;
  (items || []).forEach((item) => {
    const heightScore = 1 / safeRatio(item);
    if (leftHeight <= rightHeight) {
      left.push(item);
      leftHeight += heightScore;
    } else {
      right.push(item);
      rightHeight += heightScore;
    }
  });
  return { left, right };
}

function buildPhotoLayout(items) {
  const list = (items || []).slice(0, MAX_DETAIL_PHOTOS).map(normalizeItem);
  const result = {
    items: list,
    mainPhoto: null,
    stackPhotos: [],
    photoLeft: [],
    photoRight: []
  };

  if (!list.length) return result;
  if (list.length === 1) {
    result.mainPhoto = list[0];
    return result;
  }

  if (list.length === 2) {
    const bothPortrait = list.every((item) => item.ratio < PORTRAIT_MAX_RATIO);
    if (bothPortrait) {
      result.photoLeft = [list[0]];
      result.photoRight = [list[1]];
    } else {
      result.stackPhotos = list;
    }
    return result;
  }

  result.mainPhoto = list[0];
  if (list.length === 3) {
    result.photoLeft = [list[1]];
    result.photoRight = [list[2]];
    return result;
  }

  const columns = splitMasonry(list.slice(1));
  result.photoLeft = columns.left;
  result.photoRight = columns.right;
  return result;
}

module.exports = {
  MAX_DETAIL_PHOTOS,
  PORTRAIT_MAX_RATIO,
  buildPhotoLayout,
  splitMasonry
};
