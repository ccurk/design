// 定时任务：撮合每 5 分钟；提醒 + 邀请到期每分钟。由 src/index.js 启动，测试里不启动。
import { processInviteDeadlines } from './services/invites.js';
import { runMatching } from './services/matching.js';
import { runReminders } from './services/reminders.js';

export const MATCH_INTERVAL = 5 * 60 * 1000;
export const MINUTE_INTERVAL = 60 * 1000;

/** 每分钟的任务：邀请到期处理 + 各类提醒 */
export function runMinuteJobs({ db, logger }) {
  const deadlines = processInviteDeadlines(db);
  const reminders = runReminders(db, logger);
  return { deadlines, reminders };
}

/** 每 5 分钟的任务：撮合 */
export function runMatchJob({ db }) {
  return runMatching(db);
}

function safely(name, fn, logger) {
  try {
    const result = fn();
    logger?.debug?.(`[jobs] ${name}`, JSON.stringify(result));
    return result;
  } catch (err) {
    logger?.error?.(`[jobs] ${name} 失败`, err);
    return null;
  }
}

export function startJobs(ctx, { matchEvery = MATCH_INTERVAL, minuteEvery = MINUTE_INTERVAL } = {}) {
  const { logger } = ctx;
  const timers = [
    setInterval(() => safely('match', () => runMatchJob(ctx), logger), matchEvery),
    setInterval(() => safely('minute', () => runMinuteJobs(ctx), logger), minuteEvery),
  ];
  timers.forEach((t) => t.unref?.());
  // 启动时先跑一遍
  safely('minute', () => runMinuteJobs(ctx), logger);
  safely('match', () => runMatchJob(ctx), logger);
  logger?.info?.('[jobs] 定时任务已启动：撮合每 5 分钟，提醒和邀请到期每分钟');
  return {
    stop() {
      timers.forEach(clearInterval);
    },
  };
}
