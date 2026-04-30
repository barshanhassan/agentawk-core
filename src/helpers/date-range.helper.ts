/**
 * Mirrors gateway's ContactHelper::dateQueryBuilder semantic ranges.
 * Resolves named ranges (today, yesterday, this_week, etc.) into
 * { gte, lte } DateTimes that can be plugged into a Prisma where clause.
 *
 * `firstDayOfWeek`: 0 = Sunday, 1 = Monday (matches workspaces.first_day_week).
 */
export type DateRange =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'last_7_days'
  | 'last_30_days'
  | 'custom';

export interface CustomRange {
  from?: string | Date;
  to?: string | Date;
}

export interface DateRangeBounds {
  gte?: Date;
  lte?: Date;
}

export function resolveDateRange(
  range: DateRange | string | undefined,
  customRange?: CustomRange,
  firstDayOfWeek: number = 0,
): DateRangeBounds {
  if (!range) return {};

  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (range) {
    case 'today':
      return { gte: startOfDay(now), lte: endOfDay(now) };

    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { gte: startOfDay(y), lte: endOfDay(y) };
    }

    case 'this_week': {
      const offset = (now.getDay() - firstDayOfWeek + 7) % 7;
      const start = new Date(now);
      start.setDate(start.getDate() - offset);
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }

    case 'last_week': {
      const offset = (now.getDay() - firstDayOfWeek + 7) % 7;
      const startThisWeek = new Date(now);
      startThisWeek.setDate(startThisWeek.getDate() - offset);
      const startLast = new Date(startThisWeek);
      startLast.setDate(startLast.getDate() - 7);
      const endLast = new Date(startThisWeek);
      endLast.setDate(endLast.getDate() - 1);
      return { gte: startOfDay(startLast), lte: endOfDay(endLast) };
    }

    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }

    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { gte: startOfDay(start), lte: endOfDay(end) };
    }

    case 'last_7_days': {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }

    case 'last_30_days': {
      const start = new Date(now);
      start.setDate(start.getDate() - 29);
      return { gte: startOfDay(start), lte: endOfDay(now) };
    }

    case 'custom': {
      const out: DateRangeBounds = {};
      if (customRange?.from) out.gte = new Date(customRange.from);
      if (customRange?.to) out.lte = new Date(customRange.to);
      return out;
    }

    default:
      return {};
  }
}
