// 局的封面插画：按分类（和任务）选底色与线稿。
// variant: card（广场卡片）| match（撮合成功卡片）| hero（详情页顶部）| tile（小方块，配合 size）
const ART = {
  outdoor: { bg: '#193543', full: true },
  food: { bg: '#7CCAE3', art: '/assets/covers/bowl.svg', tile: '/assets/covers/bowl-tile.svg', wide: true },
  coffee: { bg: '#E3E8EC', art: '/assets/covers/cup.svg', tile: '/assets/covers/cup-tile.svg' },
  game: { bg: '#2E4A5C', art: '/assets/covers/dice.svg', tile: '/assets/covers/dice-tile.svg' },
  carpool: { bg: '#DDE4E9', art: '/assets/covers/car.svg', tile: '/assets/covers/car-tile.svg', wide: true },
  other: { bg: '#E1E7EC', art: '/assets/covers/sparkle-tile.svg', tile: '/assets/covers/sparkle-tile.svg', square: true },
  intent: { bg: '#193543', art: '/assets/covers/waves.svg', tile: '/assets/covers/waves.svg', square: true }
};
const FULL = {
  card: '/assets/covers/mountains-card.svg',
  match: '/assets/covers/mountains-match.svg',
  hero: '/assets/covers/mountains-wide.svg',
  tile: '/assets/covers/mountains-tile.svg'
};
const RIDE_TILE = '/assets/covers/waves.svg';
const HILL_TILE = '/assets/covers/hill-tile.svg';

// 没有分类时按标题猜一个（例如他人主页的「最近的局」）
function guess(text) {
  const s = String(text || '');
  if (/桌游|剧本|狼人|游戏/.test(s)) return 'game';
  if (/拼车|顺风|包车/.test(s)) return 'carpool';
  if (/咖啡|读书|书店|茶/.test(s)) return 'coffee';
  if (/吃|早餐|饭|夜市|火锅|烧烤|宵夜/.test(s)) return 'food';
  if (/日出|日落|爬山|徒步|骑行|苍山|洱海|走走|环线|露营|湖/.test(s)) return 'outdoor';
  return 'other';
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    category: { type: String, value: '' },
    task: { type: String, value: '' },
    title: { type: String, value: '' },
    kind: { type: String, value: 'event' },
    variant: { type: String, value: 'card' },
    size: { type: Number, value: 56 }
  },
  data: { boxStyle: '', full: false, src: '', imgStyle: '', innerStyle: '' },
  observers: {
    'category, task, title, kind, variant, size': function () {
      this.compute();
    }
  },
  lifetimes: {
    attached() {
      this.compute();
    }
  },
  methods: {
    compute() {
      const { category, task, title, kind, variant, size } = this.data;
      const key = kind === 'intent' ? 'intent' : ART[category] ? category : guess(title || task);
      const art = ART[key];
      let boxStyle = 'background:' + art.bg + ';';
      let full = !!art.full;
      let src = '';
      let imgStyle = '';
      let innerStyle = '';

      if (variant === 'tile') {
        const px = size * 2;
        boxStyle += 'width:' + px + 'rpx;height:' + px + 'rpx;border-radius:' + Math.round(size * 0.29) * 2 + 'rpx;';
        if (key === 'outdoor' && /骑行/.test(task + title)) {
          full = false;
          src = RIDE_TILE;
        } else if (key === 'outdoor' && /徒步|爬山|露营/.test(task + title)) {
          full = false;
          src = HILL_TILE;
        } else if (full) {
          src = FULL.tile;
          imgStyle = 'width:100%;height:' + Math.round((px * 38) / 56) + 'rpx;';
        } else {
          src = art.tile;
        }
        if (!full) {
          const w = art.wide ? Math.round(px * 0.56) : Math.round(px * 0.5);
          const h = art.wide ? Math.round(w / 1.5) : w;
          imgStyle = 'width:' + w + 'rpx;height:' + h + 'rpx;';
        }
      } else {
        const dims = {
          card: { h: 248, r: 36, w: 240 },
          match: { h: 224, r: 40, w: 220 },
          hero: { h: 360, r: 0, w: 260 }
        }[variant] || { h: 248, r: 36, w: 240 };
        boxStyle += 'width:100%;height:' + dims.h + 'rpx;border-radius:' + dims.r + 'rpx;';
        if (full) {
          src = FULL[variant] || FULL.card;
          imgStyle = variant === 'hero' ? 'width:100%;height:327rpx;' : 'width:100%;height:100%;';
        } else {
          src = art.art;
          const w = art.square ? Math.round(dims.w * 0.5) : dims.w;
          const h = art.square ? w : Math.round((dims.w * 2) / 3);
          imgStyle = 'width:' + w + 'rpx;height:' + h + 'rpx;';
          // 详情页底部被白色面板压住 28px，插画往上提一点
          if (variant === 'hero') innerStyle = 'padding-bottom:56rpx;';
        }
      }
      this.setData({ boxStyle, full, src, imgStyle, innerStyle });
    }
  }
});
