const RECENT_ACTIVITY_MONTHS = 6;
const QUALIFYING_ACTIVITY_TYPES = new Set(["post", "comment"]);

export function hasRecentVisiblePostOrComment(activities = [], now = new Date()) {
  const cutoff = subtractUtcMonths(now, RECENT_ACTIVITY_MONTHS);

  return activities.some((activity) => {
    const activityType = String(activity?.activityType ?? "").toLowerCase();
    if (!QUALIFYING_ACTIVITY_TYPES.has(activityType)) return false;

    const postedAt = new Date(activity?.postedAt);
    if (Number.isNaN(postedAt.getTime())) return false;

    return postedAt >= cutoff && postedAt <= now;
  });
}

export function isHighPotentialFit(fit = {}) {
  return Boolean(fit.founderSignal && fit.startupSignal && fit.recentActivitySignal);
}

function subtractUtcMonths(date, months) {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}
