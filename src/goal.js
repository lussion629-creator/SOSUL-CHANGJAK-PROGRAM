// 장 목표 분량 막대 (원고 목록에 표시)
import { fmt } from './stats.js';
export function chapterGoalHtml(c, n) {
  if (!c.goal) return '';
  const pct = Math.min(100, Math.round((n / c.goal) * 100));
  return `<span class="ch-goal${pct >= 100 ? ' full' : ''}" title="목표 ${fmt(c.goal)}자 중 ${pct}%"><i style="width:${pct}%"></i></span>`;
}
