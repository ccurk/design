// 开发辅助接口（NODE_ENV != production 才挂载）：时间穿越、手动跑定时任务。
import { Router } from 'express';
import { clock, MINUTE } from '../clock.js';
import { invalid } from '../errors.js';
import { runMatchJob, runMinuteJobs } from '../jobs.js';
import { body } from './util.js';

export function devRoutes(ctx) {
  const r = Router();

  r.get('/clock', (req, res) => res.json({ now: clock.iso(), altered: clock.isAltered() }));

  /** { now?: ISO 时间（之后以真实速度继续走）, advanceMinutes?: number, reset?: true } */
  r.post('/clock', (req, res) => {
    const { now, advanceMinutes, reset } = body(req);
    if (reset) clock.reset();
    if (now !== undefined) {
      const d = new Date(now);
      if (Number.isNaN(d.getTime())) throw invalid('now 格式不正确');
      clock.travelTo(d);
    }
    if (advanceMinutes !== undefined) {
      if (typeof advanceMinutes !== 'number' || !Number.isFinite(advanceMinutes)) throw invalid('advanceMinutes 需要是数字');
      clock.advance(advanceMinutes * MINUTE);
    }
    res.json({ now: clock.iso(), altered: clock.isAltered() });
  });

  /** 立刻跑一遍定时任务：{ match?: true } 时连撮合一起跑 */
  r.post('/tick', (req, res) => {
    const minute = runMinuteJobs(ctx);
    const match = body(req).match ? runMatchJob(ctx) : null;
    res.json({ now: clock.iso(), ...minute, match });
  });

  return r;
}
