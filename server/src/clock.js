// 全局时钟：业务代码一律用 clock.now()，测试和开发环境可以“穿越时间”。
let fixed = null; // 固定的时间点（ms）
let offset = 0; // 相对真实时间的偏移（ms）

export const clock = {
  /** 当前时间（Date） */
  now() {
    return new Date(fixed ?? Date.now() + offset);
  },
  /** 当前时间的 ISO 字符串 */
  iso() {
    return clock.now().toISOString();
  },
  /** 把时间固定在某一刻（之后不再走动，直到 advance / reset） */
  set(date) {
    fixed = new Date(date).getTime();
    offset = 0;
  },
  /** 往后拨 ms 毫秒；固定模式下移动固定点，否则累加偏移 */
  advance(ms) {
    if (fixed !== null) fixed += ms;
    else offset += ms;
  },
  /** 让时钟以真实速度走，但从 date 开始 */
  travelTo(date) {
    fixed = null;
    offset = new Date(date).getTime() - Date.now();
  },
  reset() {
    fixed = null;
    offset = 0;
  },
  isAltered() {
    return fixed !== null || offset !== 0;
  },
};

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
