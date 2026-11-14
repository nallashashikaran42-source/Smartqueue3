import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Clock, TrendingDown, Users } from 'lucide-react';
import type { AnalyticsSummaryResponse, CrowdLevel } from '../../services/api';

interface CitizenPeakHoursPanelProps {
  facilityId: string;
  facilityName: string;
  facilities?: Array<{ id: string; name: string; city: string }>;
  onSelectFacility?: (facilityId: string) => void;
  summary: AnalyticsSummaryResponse | null;
  loading?: boolean;
  compact?: boolean;
  onBookAtFacility?: () => void;
}

function deriveCrowdLevel(
  footfall: number,
  maxFootfall: number,
  isPeak: boolean,
  isRecommended: boolean
): CrowdLevel {
  if (isPeak || footfall >= maxFootfall * 0.78) return 'High';
  if (isRecommended || footfall <= maxFootfall * 0.48) return 'Low';
  return 'Medium';
}

export const CitizenPeakHoursPanel: React.FC<CitizenPeakHoursPanelProps> = ({
  facilityId,
  facilityName,
  facilities,
  onSelectFacility,
  summary,
  loading = false,
  compact = false,
  onBookAtFacility,
}) => {
  const [selectedHour, setSelectedHour] = useState<string | null>(null);

  const hourlyData = useMemo(() => {
    const rich = summary?.organisationDashboard?.hourlyFootfall;
    if (rich && rich.length > 0) {
      return rich.map((pt) => ({
        hour: pt.hour,
        footfall: pt.footfall,
        avgWaitMins: pt.avgWaitMins,
        isPeak: pt.isPeak,
        isRecommended: pt.isRecommended,
        crowdLevel: pt.crowdLevel,
      }));
    }
    const base = summary?.hourlyTraffic ?? [];
    const maxVal = Math.max(1, ...base.map((p) => p.footfall));
    return base.map((pt) => ({
      hour: pt.hour,
      footfall: pt.footfall,
      avgWaitMins: pt.avgWaitMins,
      isPeak: Boolean(pt.isPeak),
      isRecommended: Boolean(pt.isRecommended),
      crowdLevel: deriveCrowdLevel(pt.footfall, maxVal, Boolean(pt.isPeak), Boolean(pt.isRecommended)),
    }));
  }, [summary]);

  const metrics = useMemo(() => {
    const stats = summary?.organisationDashboard?.visitorStats;
    const maxFootfall = Math.max(1, ...hourlyData.map((h) => h.footfall));
    const busiest =
      stats?.busiestHour ||
      [...hourlyData].sort((a, b) => b.footfall - a.footfall)[0]?.hour ||
      '10 AM';

    const peakItems = hourlyData.filter((h) => h.isPeak);
    const quietItems = hourlyData.filter((h) => h.isRecommended);
    const nonPeakItems = hourlyData.filter((h) => !h.isPeak);

    const peakAvgWait =
      stats?.peakAvgWaitMins ??
      (peakItems.length > 0
        ? Math.round(peakItems.reduce((s, p) => s + p.avgWaitMins, 0) / peakItems.length)
        : 0);

    const bestAvgWait =
      quietItems.length > 0
        ? Math.round(quietItems.reduce((s, p) => s + p.avgWaitMins, 0) / quietItems.length)
        : stats?.nonPeakAvgWaitMins ??
          (nonPeakItems.length > 0
            ? Math.round(nonPeakItems.reduce((s, p) => s + p.avgWaitMins, 0) / nonPeakItems.length)
            : 0);

    const bestWindowHours =
      stats?.recommendedHours && stats.recommendedHours.length > 0
        ? stats.recommendedHours
        : quietItems.map((q) => q.hour);

    const peakHoursList =
      stats?.peakHours && stats.peakHours.length > 0
        ? stats.peakHours
        : peakItems.map((p) => p.hour);

    const bestSlot = [...hourlyData].sort((a, b) => a.avgWaitMins - b.avgWaitMins)[0] || null;
    const waitSavingsMins = Math.max(0, peakAvgWait - bestAvgWait);

    return {
      maxFootfall,
      busiest,
      peakAvgWait,
      bestAvgWait,
      bestWindowHours,
      peakHoursList,
      bestSlot,
      waitSavingsMins,
    };
  }, [hourlyData, summary]);

  useEffect(() => {
    if (hourlyData.length === 0) {
      setSelectedHour(null);
      return;
    }
    setSelectedHour((prev) => {
      if (prev && hourlyData.some((h) => h.hour === prev)) return prev;
      return metrics.bestSlot?.hour || hourlyData[0].hour;
    });
  }, [facilityId, hourlyData, metrics.bestSlot]);

  const activeSlot = useMemo(() => {
    return (
      hourlyData.find((h) => h.hour === selectedHour) ||
      metrics.bestSlot ||
      hourlyData[0] ||
      null
    );
  }, [hourlyData, selectedHour, metrics.bestSlot]);

  if (loading && hourlyData.length === 0) {
    return <div className="h-56 bg-white border border-slate-200 rounded-xl animate-pulse" />;
  }

  if (hourlyData.length === 0) {
    return null;
  }

  const timeSavedText =
    metrics.waitSavingsMins > 0
      ? `Visiting during recommended hours saves ~${metrics.waitSavingsMins} min`
      : 'Balanced crowd levels across operating hours';

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
      {/* Header Row */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
        <div>
          <p className="text-xs font-semibold text-teal-700">
            Visit Timing Advisor · {facilityName}
          </p>
          <h2 className={`${compact ? 'text-base' : 'text-lg'} font-bold text-slate-900 mt-0.5`}>
            Peak Hours &amp; Best Time to Visit
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {summary?.recommendationText || timeSavedText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {facilities && facilities.length > 1 && onSelectFacility && (
            <select
              aria-label="Select service center for peak hours"
              value={facilityId}
              onChange={(e) => onSelectFacility(e.target.value)}
              className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-800 focus:outline-none focus:border-blue-600"
            >
              {facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          {onBookAtFacility && (
            <button
              type="button"
              onClick={onBookAtFacility}
              className="px-3.5 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              Book During Best Hours
            </button>
          )}
        </div>
      </div>

      {/* Key Visit Guidance Strip */}
      <div className={`grid grid-cols-1 ${compact ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4'} gap-4`}>
        <div className="p-3.5 bg-teal-50/70 border border-teal-200/80 rounded-lg">
          <div className="flex items-center justify-between text-xs font-medium text-teal-800">
            <span>Best Time to Visit</span>
            <CalendarClock className="w-3.5 h-3.5 text-teal-700" />
          </div>
          <div className="font-mono tabular-nums text-base font-bold text-slate-900 mt-1">
            {metrics.bestWindowHours.slice(0, 3).join(', ') || metrics.bestSlot?.hour || '—'}
          </div>
          <div className="text-[11px] text-teal-800 mt-0.5 font-mono tabular-nums">
            ~{metrics.bestAvgWait} min avg wait
          </div>
        </div>

        <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg">
          <div className="flex items-center justify-between text-xs font-medium text-slate-600">
            <span>Peak Crowd Hours</span>
            <Users className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <div className="font-mono tabular-nums text-base font-bold text-slate-900 mt-1">
            {metrics.peakHoursList.join(' – ') || metrics.busiest}
          </div>
          <div className="text-[11px] text-amber-700 mt-0.5 font-mono tabular-nums">
            ~{metrics.peakAvgWait} min avg wait
          </div>
        </div>

        <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-lg">
          <div className="flex items-center justify-between text-xs font-medium text-slate-600">
            <span>Wait Time Saved</span>
            <TrendingDown className="w-3.5 h-3.5 text-teal-600" />
          </div>
          <div className="font-mono tabular-nums text-base font-bold text-teal-700 mt-1">
            {metrics.waitSavingsMins > 0 ? `${metrics.waitSavingsMins} min shorter` : 'Balanced'}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Compared to busiest hour ({metrics.busiest})
          </div>
        </div>

        {!compact && activeSlot && (
          <div className="p-3.5 bg-slate-900 text-white rounded-lg">
            <div className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span>Selected Slot · {activeSlot.hour}</span>
              <Clock className="w-3.5 h-3.5 text-teal-400" />
            </div>
            <div className="font-mono tabular-nums text-base font-bold mt-1">
              ~{activeSlot.avgWaitMins} min wait
            </div>
            <div className="text-[11px] text-slate-300 mt-0.5">
              {activeSlot.isRecommended
                ? 'Recommended · Low crowd'
                : activeSlot.isPeak
                  ? 'Peak hour · High crowd'
                  : 'Moderate traffic'}
            </div>
          </div>
        )}
      </div>

      {/* Interactive Hourly Chart */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-semibold text-slate-700">
            Click any hour to inspect expected wait time &amp; crowd level
          </span>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-teal-600 inline-block" />
              Best Time (Low Wait)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-slate-900 inline-block" />
              Normal Hours
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" />
              Peak Crowd
            </span>
          </div>
        </div>

        <div
          className={`flex items-end gap-1.5 sm:gap-2.5 ${
            compact ? 'h-32 pt-4' : 'h-44 pt-5'
          } pb-1 border-b border-slate-100`}
        >
          {hourlyData.map((pt) => {
            const heightPct = Math.max(16, Math.round((pt.footfall / metrics.maxFootfall) * 100));
            const isSelected = activeSlot?.hour === pt.hour;
            const barColor = pt.isRecommended
              ? 'bg-teal-600 hover:bg-teal-700'
              : pt.isPeak
                ? 'bg-amber-500 hover:bg-amber-600'
                : 'bg-slate-900 hover:bg-slate-700';

            return (
              <button
                key={pt.hour}
                type="button"
                onClick={() => setSelectedHour(pt.hour)}
                aria-label={`${pt.hour}: ${pt.avgWaitMins} min average wait, ${pt.crowdLevel} crowd`}
                className="flex-1 h-full flex flex-col items-center justify-end gap-1 group cursor-pointer focus:outline-none"
              >
                <span
                  className={`font-mono tabular-nums text-[10px] leading-none transition-colors ${
                    isSelected
                      ? 'font-bold text-slate-900'
                      : 'text-slate-500 group-hover:text-slate-900'
                  }`}
                >
                  {pt.avgWaitMins}m
                </span>
                <div className="w-full flex-1 flex items-end">
                  <div
                    className={`w-full rounded-t transition-all ${barColor} ${
                      isSelected ? 'ring-2 ring-blue-600 ring-offset-1' : ''
                    }`}
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
                <span
                  className={`text-[10px] sm:text-[11px] whitespace-nowrap font-mono ${
                    isSelected ? 'font-bold text-blue-700' : 'text-slate-500'
                  }`}
                >
                  {pt.hour.replace(' ', '')}
                </span>
              </button>
            );
          })}
        </div>

        {/* Selected Hour Breakdown Line */}
        {activeSlot && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 pt-1">
            <div>
              <strong className="text-slate-900">{activeSlot.hour} Window:</strong>{' '}
              <span className="font-mono tabular-nums">~{activeSlot.avgWaitMins} min</span>{' '}
              estimated wait ·{' '}
              <span className="font-mono tabular-nums">{activeSlot.footfall}</span> typical hourly
              visitors · Crowd:{' '}
              <strong
                className={
                  activeSlot.crowdLevel === 'Low'
                    ? 'text-teal-700'
                    : activeSlot.crowdLevel === 'High'
                      ? 'text-amber-700'
                      : 'text-slate-900'
                }
              >
                {activeSlot.crowdLevel}
              </strong>
            </div>
            <div className="text-[11px] text-slate-500">
              {activeSlot.isRecommended
                ? 'Ideal slot for shortest counter wait'
                : activeSlot.isPeak
                  ? 'High queue volume — book a digital token remotely first'
                  : 'Steady counter turnaround'}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
