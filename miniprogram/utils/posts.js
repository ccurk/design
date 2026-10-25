// 动态 / 评论的展示字段
const format = require('./format');

function mapPost(p) {
  const images = (p.images || []).map(format.imageUrl);
  let grid = 'many';
  if (images.length === 1) grid = 'one';
  else if (images.length === 2) grid = 'two';
  else if (images.length === 4) grid = 'four';
  return Object.assign({}, p, {
    images,
    grid,
    time: format.relative(p.createdAt),
    pending: p.status === 'pending',
    eventTitle: p.event ? format.shortTitle(p.event.title) : ''
  });
}

function mapComment(c) {
  return Object.assign({}, c, {
    time: format.relative(c.createdAt),
    display: c.replyTo ? '回复 ' + c.replyTo.nickname + '：' + c.text : c.text
  });
}

module.exports = { mapPost, mapComment };
