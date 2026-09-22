import type { StatsPeriod } from '../services/api';

// The gateway buckets messages on the stored UTC timestamp and returns the bucket as zone-less text:
// '2026-06-24 14:00:00' for an hour, '2026-06-24' for a day.
//
// An hour bucket is shown in the browser's zone ('21:00' in UTC+7). A day bucket keeps its 'MM-DD'
// text: a UTC day spans two local days, so it cannot be moved on the client, and the chart says the
// days are UTC instead.
export function formatTick(ts: string, period: StatsPeriod): string {
  if (period !== '24h') return ts.slice(5);
  const at = new Date(`${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(at.getTime())) return ts.slice(11, 16);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
