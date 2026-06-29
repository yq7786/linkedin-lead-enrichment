export function isActivityWithinMonths(postedAt, now = new Date(), months = 6) {
  if (!postedAt) return false;
  const posted = new Date(postedAt);
  const threshold = new Date(now);
  threshold.setMonth(threshold.getMonth() - months);
  return posted >= threshold;
}
