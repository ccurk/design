// 内容审核：关键词 + 正则。checkText(text) → { ok, reasons[] }；checkContact(text) 只查联系方式
// 群聊 / 评论命中直接拒绝；动态 / 用户发起的局命中进后台审核；昵称 / 简介命中拒绝保存。

const AD_WORDS = [
  '代购', '刷单', '兼职', '加盟', '推广', '返利', '贷款', '投资理财', '理财产品', '微商',
  '招代理', '代理加盟', '日结', '引流', '网贷', '套现', '股票推荐', '带单', '拉人头', '优惠券',
];

const ILLEGAL_WORDS = [
  '约炮', '一夜情', '援交', '包养', '陪睡', '裸聊', '色情', '赌博', '博彩', '下注',
  '嫖', '卖淫', '上门服务', '黄片', '毒品', '大麻', '冰毒', '赌场', '六合彩', '私彩',
];

const CONTACT_KEYWORDS = '(?:微信|威信|薇信|徽信|weixin|wechat|vx|v信|wx|qq|扣扣|企鹅号?)';

const PATTERNS = [
  { re: /1[3-9]\d{9}/, reason: '包含手机号', normalize: true },
  {
    re: new RegExp(`${CONTACT_KEYWORDS}[\\s:：=＝号是为我加]{0,4}[a-z0-9][a-z0-9_-]{4,}`, 'i'),
    reason: '包含微信 / QQ 等联系方式',
  },
  { re: /(https?:\/\/|www\.)\S+/i, reason: '包含网址' },
  { re: /\b[a-z0-9-]{2,}\.(com|cn|net|org|top|xyz|vip|cc|io|me|shop|site|link)\b/i, reason: '包含网址' },
];

/** 去掉数字之间的空格、横线等分隔，防止「138 1234 5678」绕过 */
function squeezeDigits(text) {
  return text.replace(/(\d)[\s\-—－_.·]+(?=\d)/g, '$1');
}

/** 只查联系方式（手机号、微信 / QQ 号、网址） */
export function checkContact(text) {
  const reasons = [];
  if (typeof text !== 'string' || !text.trim()) return { ok: true, reasons };
  const lower = text.toLowerCase();
  const squeezed = squeezeDigits(lower);
  for (const p of PATTERNS) {
    const target = p.normalize ? squeezed : lower;
    if (p.re.test(target) && !reasons.includes(p.reason)) reasons.push(p.reason);
  }
  return { ok: reasons.length === 0, reasons };
}

export function checkText(text) {
  const { reasons } = checkContact(text);
  if (typeof text !== 'string' || !text.trim()) return { ok: true, reasons };
  const lower = text.toLowerCase();
  const ads = AD_WORDS.filter((w) => lower.includes(w));
  if (ads.length) reasons.push(`疑似广告：${ads.join('、')}`);
  const illegal = ILLEGAL_WORDS.filter((w) => lower.includes(w));
  if (illegal.length) reasons.push(`擦边或违法内容：${illegal.join('、')}`);

  return { ok: reasons.length === 0, reasons };
}

/** 多段文本一起检查 */
export function checkAll(...texts) {
  return checkText(texts.filter((t) => typeof t === 'string' && t).join('\n'));
}
