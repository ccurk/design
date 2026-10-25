// 极简日志：测试时静音（LOG_LEVEL=silent 或 NODE_ENV=test）。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = (lvl, fn) => (...args) => {
    if (LEVELS[lvl] >= min) fn(`[${new Date().toISOString()}] ${lvl.toUpperCase()}`, ...args);
  };
  return {
    debug: out('debug', console.log),
    info: out('info', console.log),
    warn: out('warn', console.warn),
    error: out('error', console.error),
  };
}

export const silentLogger = createLogger('silent');
