// 局的封面：有照片用第一张照片，没有就用标签对应的插画（docs/changes-v0.3.md C / H）。
// variant: card（广场卡片）| wide（横滑小卡）| match（撮合成功）| hero（详情页顶部）| tile（小方块，配合 size）
const format = require('../../utils/format');


// 没有分类时按文字猜一个分类（例如他人主页的「最近的局」）
function guessCategory(text) {
  const s = String(text || '');
  if (/桌游|剧本|狼人|游戏/.test(s)) return 'game';
  if (/拼车|顺风|包车/.test(s)) return 'carpool';
  if (/咖啡|读书|书店|茶/.test(s)) return 'coffee';
  if (/吃|早餐|饭|夜市|火锅|烧烤|宵夜/.test(s)) return 'food';
  if (/日出|日落|爬山|徒步|骑行|苍山|洱海|走走|环线|露营|湖/.test(s)) return 'outdoor';
  return 'other';
}

function guessKey(text) {
  const s = String(text || '');
  if (/日出/.test(s)) return 'sunrise';
  if (/骑行|单车/.test(s)) return 'cycling';
  if (/读书|书/.test(s)) return 'reading';
  if (/洱海|湖|码头/.test(s)) return 'lake';
  if (/古城|走走|古镇/.test(s)) return 'oldtown';
  return '';
}

const BOX = {
  card: { h: 360, r: 36 },
  wide: { h: 232, r: 28 },
  match: { h: 300, r: 40 },
  hero: { h: 440, r: 0 }
};

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    image: { type: String, value: '' },
    coverKey: { type: String, value: '' },
    category: { type: String, value: '' },
    task: { type: String, value: '' },
    title: { type: String, value: '' },
    variant: { type: String, value: 'card' },
    size: { type: Number, value: 56 }
  },
  data: { boxStyle: '', src: '', isPhoto: false, failed: false },
  observers: {
    'image, coverKey, category, task, title, variant, size': function () {
      this.compute(false);
    }
  },
  lifetimes: {
    attached() {
      this.compute(false);
    }
  },
  methods: {
    illustration() {
      const { coverKey, category, task, title } = this.data;
      let key = format.COVER_KEYS.indexOf(coverKey) >= 0 ? coverKey : '';
      if (!key) key = guessKey(task) || (category ? '' : guessKey(title));
      if (!key) key = format.coverKey('', category || guessCategory(task + ' ' + title));
      return format.coverSrc(key);
    },
    compute(failed) {
      const { image, variant, size } = this.data;
      const photo = format.imageUrl(image);
      const isPhoto = !!photo && !failed;
      let boxStyle;
      if (variant === 'tile') {
        const px = size * 2;
        boxStyle = 'width:' + px + 'rpx;height:' + px + 'rpx;border-radius:' + Math.round(size * 0.29) * 2 + 'rpx;';
      } else {
        const b = BOX[variant] || BOX.card;
        boxStyle = 'width:100%;height:' + b.h + 'rpx;border-radius:' + b.r + 'rpx;';
      }
      this.setData({ boxStyle, isPhoto, failed, src: isPhoto ? photo : this.illustration() });
    },
    onError() {
      if (this.data.isPhoto) this.compute(true);
    }
  }
});
