// 定时任务：撮合每 5 分钟；提醒 + 邀请到期 + 最晚退出时间每分钟。由 src/index.js 启动，测试里不启动。
import { processExitDeadlines } from './services/events.js';
import { processInviteDeadlines } from './services/invites.js';
import { runMatching } from './services/matching.js';
import { publishDailyEvents } from './services/platformEvents.js';
import { runReminders } from './services/reminders.js';

export const MATCH_INTERVAL = 5 * 60 * 1000;
export const MINUTE_INTERVAL = 60 * 1000;
export const DAILY_INTERVAL = 60 * 60 * 1000; // 每小时查一次，publishDailyEvents 内部按天幂等

/** 每分钟的任务：邀请到期处理 + 最晚退出时间（成群或取消）+ 各类提醒 */
export function runMinuteJobs({ db, logger }) {
  const deadlines = processInviteDeadlines(db);
  const exitDeadlines = processExitDeadlines(db);
  const reminders = runReminders(db, logger);
  return { deadlines, exitDeadlines, reminders };
}

/** 每 5 分钟的任务：撮合 */
export function runMatchJob({ db }) {
  return runMatching(db);
}

/** 每天的任务：自动发布运营带队的平台局（内部按天幂等，多调无害） */
export function runDailyJobs({ db }) {
  return publishDailyEvents(db);
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

export function startJobs(ctx, { matchEvery = MATCH_INTERVAL, minuteEvery = MINUTE_INTERVAL, dailyEvery = DAILY_INTERVAL } = {}) {
  const { logger } = ctx;
  const timers = [
    setInterval(() => safely('match', () => runMatchJob(ctx), logger), matchEvery),
    setInterval(() => safely('minute', () => runMinuteJobs(ctx), logger), minuteEvery),
    setInterval(() => safely('daily', () => runDailyJobs(ctx), logger), dailyEvery),
  ];
  timers.forEach((t) => t.unref?.());
  // 启动时先跑一遍
  safely('minute', () => runMinuteJobs(ctx), logger);
  safely('match', () => runMatchJob(ctx), logger);
  safely('daily', () => runDailyJobs(ctx), logger);
  logger?.info?.('[jobs] 定时任务已启动：撮合每 5 分钟，提醒 / 邀请到期 / 最晚退出时间每分钟，运营局每天自动发布');
  return {
    stop() {
      timers.forEach(clearInterval);
    },
  };
}
