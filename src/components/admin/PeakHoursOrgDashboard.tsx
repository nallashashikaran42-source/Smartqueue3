import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Leaf,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import {
  api,
  type ApiFacility,
  type CrowdLevel,
  type OrganisationAnalyticsDashboardResponse,
} from '../../services/api';

interface PeakHoursOrgDashboardProps {
  facilities: ApiFacility[];
  refreshKey: number;
  onMutated: () => Promise<void> | void;
  onToast: (msg: string) => void;
}

const CROWD_STYLE: Record<CrowdLevel, { text: string; bg: string; label: string }> = {
  Low: {
    text: 'text-teal-800',
    bg: 'bg-teal-50 border-teal-200',
    label: 'Low',
  },
  Medium: {
    text: 'text-amber-800',
    bg: 'bg-amber-50 border-amber-200',
    label: 'Medium',
  },
  High: {
    text: 'text-red-800',
    bg: 'bg-red-50 border-red-200',
    label: 'High',
  },
};

const COUNTER_STATUS_STYLE: Record<string, string> = {
  Serving: 'text-teal-800 bg-teal-50 border-teal-200',
  Busy: 'text-amber-800 bg-amber-50 border-amber-200',
  Paused: 'text-slate-700 bg-slate-100 border-slate-200',
  Closed: 'text-red-800 bg-red-50 border-red-200',
};

export const PeakHoursOrgDashboard: React.FC<PeakHoursOrgDashboardProps> = ({
  facilities,
  refreshKey,
  onMutated,
  onToast,
}) => {
  const [selectedFacilityId, setSelectedFacilityId] = useState<string>(
    () => facilities[0]?.id || 'vja-hospital'
  );
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [threshold, setThreshold] = useState<number>(5);
  const [dashboard, setDashboard] = useState<OrganisationAnalyticsDashboardResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Reallocation Modal / Drawer state
  const [reallocOpen, setReallocOpen] = useState(false);
  const [reallocCounterId, setReallocCounterId] = useState<string>('');
  const [reallocQueueId, setReallocQueueId] = useState<string>('');
  const [reallocOperatorId, setReallocOperatorId] = useState<string>('');
  const [reallocStaffName, setReallocStaffName] = useState<string>('');
  const [reallocStatus, setReallocStatus] = useState<'Serving' | 'Busy' | 'Closed'>('Serving');

  const loadDashboard = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getOrganisationAnalyticsDashboard({
        facilityId: selectedFacilityId,
        period,
        threshold,
      });
      setDashboard(data);
      setSelectedHour((prev) => {
        if (prev && data.hourlyFootfall.some((h) => h.hour === prev)) return prev;
        return data.visitorStats.busiestHour || data.hourlyFootfall[0]?.hour || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load peak hours analytics.');
    } finally {
      setLoading(false);
    }
  }, [selectedFacilityId, period, threshold]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard, refreshKey]);

  const maxFootfall = useMemo(() => {
    if (!dashboard || dashboard.hourlyFootfall.length === 0) return 100;
    return Math.max(10, ...dashboard.hourlyFootfall.map((h) => h.footfall));
  }, [dashboard]);

  const inspectedHour = useMemo(() => {
    if (!dashboard) return null;
    return (
      dashboard.hourlyFootfall.find((h) => h.hour === selectedHour) ||
      dashboard.hourlyFootfall[0] ||
      null
    );
  }, [dashboard, selectedHour]);

  const openReallocationModal = (params?: {
    counterId?: string | null;
    queueId?: string;
    facilityId?: string;
  }) => {
    if (!dashboard) return;
    const facCounters = params?.facilityId
      ? dashboard.counters.filter((c) => c.facilityId === params.facilityId)
      : dashboard.counters;

    const chosenCounter =
      (params?.counterId && dashboard.counters.find((c) => c.id === params.counterId)) ||
      facCounters.find((c) => c.status === 'Closed' || c.status === 'Paused') ||
      facCounters[0] ||
      dashboard.counters[0];

    const targetQueueId =
      params?.queueId ||
      dashboard.surgeAlerts[0]?.queueId ||
      chosenCounter?.queueId ||
      dashboard.availableQueues[0]?.id ||
      '';

    if (chosenCounter) {
      setReallocCounterId(chosenCounter.id);
      setReallocOperatorId(chosenCounter.assignedOperatorId || '');
      setReallocStaffName(chosenCounter.staffName);
      setReallocStatus(chosenCounter.status === 'Closed' ? 'Serving' : (chosenCounter.status === 'Paused' ? 'Serving' : chosenCounter.status));
    }
    setReallocQueueId(targetQueueId);
    setReallocOpen(true);
  };

  const handleConfirmReallocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reallocCounterId) return;
    setBusyId('reallocate');
    try {
      await api.adminReallocateCounter({
        counterId: reallocCounterId,
        targetQueueId: reallocQueueId || undefined,
        operatorId: reallocOperatorId || undefined,
        staffName: !reallocOperatorId ? reallocStaffName.trim() : undefined,
        status: reallocStatus,
      });
      setReallocOpen(false);
      await Promise.all([loadDashboard(), Promise.resolve(onMutated())]);
      onToast('Counter & staff allocation updated across live queues.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to reallocate staff.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCounterStatusUpdate = async (
    counterId: string,
    nextStatus: 'Serving' | 'Busy' | 'Closed'
  ) => {
    setBusyId(`status:${counterId}`);
    try {
      await api.adminUpdateCounter(counterId, { status: nextStatus });
      await Promise.all([loadDashboard(), Promise.resolve(onMutated())]);
      onToast(`Counter status set to ${nextStatus}.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to update counter status.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCounterQueueReassign = async (counterId: string, targetQueueId: string) => {
    setBusyId(`queue:${counterId}`);
    try {
      await api.adminReallocateCounter({
        counterId,
        targetQueueId,
        status: 'Serving',
      });
      await Promise.all([loadDashboard(), Promise.resolve(onMutated())]);
      onToast('Counter reassigned to updated service queue.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to reassign counter.');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenExtraCounter = async (counterId: string, queueId: string, queueName: string) => {
    setBusyId(`open-extra:${queueId}`);
    try {
      await api.adminReallocateCounter({
        counterId,
        targetQueueId: queueId,
        status: 'Serving',
      });
      await Promise.all([loadDashboard(), Promise.resolve(onMutated())]);
      onToast(`Opened additional counter for ${queueName}.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Unable to open additional counter.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !dashboard) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-64 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (error && !dashboard) {
    return (
      <div className="p-6 bg-white border border-red-200 rounded-xl text-sm text-red-700 flex items-center justify-between gap-4">
        <span>{error}</span>
        <button
          type="button"
          onClick={loadDashboard}
          className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!dashboard) return null;

  const { overviewCards, visitorStats, hourlyFootfall, upcomingBusyHours, surgeAlerts, counters, queuePredictions, sustainabilityImpact } =
    dashboard;

  return (
    <div className="space-y-6">
      {/* Top Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 mb-1">
            Peak Hours Analytics &amp; Smart Organisation
          </p>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            {dashboard.facilityName}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Live queue telemetry, AI surge detection, counter orchestration, and sustainability metrics.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Filter organisation dashboard by center"
            value={selectedFacilityId}
            onChange={(e) => setSelectedFacilityId(e.target.value)}
            className="px-3 py-2 text-xs font-semibold bg-white border border-slate-300 rounded-lg text-slate-800 focus:outline-none focus:border-teal-600"
          >
            <option value="all">All Service Centers</option>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.city})
              </option>
            ))}
          </select>

          <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200">
            {(['daily', 'weekly', 'monthly'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs font-semibold capitalize rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  period === p
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-700">
            <span className="font-medium text-slate-500">Surge Alert:</span>
            <select
              aria-label="Surge threshold"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="font-mono font-semibold text-slate-900 bg-transparent focus:outline-none"
            >
              <option value={4}>&ge; 4 waiting</option>
              <option value={5}>&ge; 5 waiting</option>
              <option value={6}>&ge; 6 waiting</option>
              <option value={8}>&ge; 8 waiting</option>
            </select>
          </label>

          <button
            type="button"
            onClick={loadDashboard}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5 text-teal-700" />
            <span>Sync</span>
          </button>
        </div>
      </div>

      {/* 1. ORGANISATION OVERVIEW CARDS (5 Required Metrics) */}
      <section aria-label="Organisation overview metrics" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <div className="p-4 bg-white border border-slate-200 rounded-xl">
          <div className="text-xs font-medium text-slate-500">People Currently in Queue</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1.5">
            {overviewCards.peopleInQueue}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Across active service lines
          </div>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl">
          <div className="text-xs font-medium text-slate-500">Average Service Time</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1.5">
            {overviewCards.avgServiceTimeMins} min
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
            ~{overviewCards.avgWaitTimeMins} min avg queue wait
          </div>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl">
          <div className="text-xs font-medium text-slate-500">Active Counters</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-teal-700 mt-1.5">
            {overviewCards.activeCounters} / {overviewCards.totalCounters}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {overviewCards.totalCounters - overviewCards.activeCounters} standby / closed
          </div>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl">
          <div className="text-xs font-medium text-slate-500">On-Time Service Rate</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-teal-700 mt-1.5">
            {overviewCards.onTimeServiceRate}%
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Within target SLA window
          </div>
        </div>

        <div className="p-4 bg-white border border-slate-200 rounded-xl col-span-2 md:col-span-1">
          <div className="text-xs font-medium text-slate-500">Total Visitors Served Today</div>
          <div className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1.5">
            {overviewCards.visitorsServedToday}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Real-time queue completions
          </div>
        </div>
      </section>

      {/* 2. AI SURGE ALERT */}
      <section aria-label="AI Surge Alerts" className="space-y-3">
        {surgeAlerts.length > 0 ? (
          surgeAlerts.map((alert) => (
            <div
              key={alert.id}
              className="p-5 bg-amber-50/90 border border-amber-200 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="flex items-start gap-3.5">
                <div className="p-2 rounded-lg bg-amber-100 text-amber-800 shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-bold text-amber-950 text-sm">{alert.title}</span>
                    <span className="text-amber-700">·</span>
                    <span className="font-medium text-amber-900">{alert.facilityName}</span>
                    <span className="text-amber-700">·</span>
                    <span className="font-mono tabular-nums font-semibold text-amber-900">
                      {alert.waitingCount} waiting (threshold {alert.threshold}) · ~{alert.predictedWaitMins}m wait
                    </span>
                  </div>
                  <p className="text-xs text-amber-900 leading-relaxed">
                    {alert.recommendation}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  openReallocationModal({
                    counterId: alert.standbyCounterId,
                    queueId: alert.queueId,
                    facilityId: alert.facilityId,
                  })
                }
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>Reallocate Staff</span>
              </button>
            </div>
          ))
        ) : (
          <div className="p-4 bg-white border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-teal-700 shrink-0" />
              <div className="text-xs">
                <span className="font-bold text-slate-900">No Active Crowd Surges</span>
                <span className="text-slate-500 ml-2">
                  All active service queues are operating below the {dashboard.surgeThreshold}-visitor alert threshold.
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => openReallocationModal()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
            >
              <ArrowRightLeft className="w-3.5 h-3.5 text-teal-700" />
              <span>Reallocate Staff</span>
            </button>
          </div>
        )}
      </section>

      {/* 3. PEAK HOURS ANALYTICS + SMART QUEUE PREDICTION */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-6 items-start">
        {/* Peak Hours Analytics Card */}
        <section className="p-6 bg-white border border-slate-200 rounded-xl space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200">
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-teal-700" />
                <span>Interactive Hourly Footfall</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Click or hover any time slot to inspect wait times, live token arrivals, and peak classification.
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600 shrink-0">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-teal-600 inline-block" />
                <span className="font-medium text-slate-800">Peak Hours</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-slate-900 inline-block" />
                <span className="font-medium text-slate-800">Normal Hours</span>
              </span>
            </div>
          </div>

          {/* Interactive Bar Chart */}
          <div className="pt-2">
            <div className="flex items-end gap-2 sm:gap-3 h-52 px-2 pt-6 pb-2 border-b border-slate-200 bg-slate-50/60 rounded-lg">
              {hourlyFootfall.map((slot) => {
                const heightPct = Math.max(12, Math.round((slot.footfall / maxFootfall) * 100));
                const isSelected = inspectedHour?.hour === slot.hour;
                return (
                  <button
                    key={slot.hour}
                    type="button"
                    onClick={() => setSelectedHour(slot.hour)}
                    onMouseEnter={() => setSelectedHour(slot.hour)}
                    className="flex-1 h-full flex flex-col items-center justify-end gap-1.5 group cursor-pointer focus:outline-none"
                    aria-label={`${slot.hour}: ${slot.footfall} visitors, ${slot.isPeak ? 'Peak hour' : 'Normal hour'}, average wait ${slot.avgWaitMins} minutes`}
                  >
                    <span className="font-mono tabular-nums text-[11px] font-semibold text-slate-600 group-hover:text-slate-900">
                      {slot.footfall}
                    </span>
                    <div
                      className={`w-full max-w-[44px] rounded-t-md transition-transform duration-150 ${
                        slot.isPeak
                          ? 'bg-teal-600 hover:bg-teal-700'
                          : 'bg-slate-900 hover:bg-blue-950'
                      } ${isSelected ? 'ring-2 ring-offset-2 ring-blue-600' : ''}`}
                      style={{ height: `${heightPct}%` }}
                    />
                    <span
                      className={`text-[11px] whitespace-nowrap ${
                        isSelected ? 'font-bold text-slate-900' : 'text-slate-500'
                      }`}
                    >
                      {slot.hour.replace(' ', '')}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Selected Hour Detail Strip */}
            {inspectedHour && (
              <div className="mt-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-900">{inspectedHour.hour} Window</span>
                  <span className="text-slate-400">·</span>
                  <span
                    className={`font-semibold ${
                      inspectedHour.isPeak ? 'text-teal-700' : 'text-slate-800'
                    }`}
                  >
                    {inspectedHour.isPeak
                      ? 'Peak Hour Detected'
                      : inspectedHour.isRecommended
                        ? 'Recommended Off-Peak Window'
                        : 'Normal Traffic Window'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4 font-mono tabular-nums text-slate-700">
                  <span>
                    <strong className="text-slate-900">{inspectedHour.footfall}</strong> visitors ({period})
                  </span>
                  <span>
                    <strong className="text-slate-900">{inspectedHour.avgWaitMins}m</strong> avg wait
                  </span>
                  <span>
                    Crowd: <strong className="text-slate-900">{inspectedHour.crowdLevel}</strong>
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Visitor Statistics & Peak vs Non-Peak Wait */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
            <div className="p-3.5 border border-slate-200 rounded-lg">
              <div className="text-[11px] font-medium text-slate-500">Busiest Time of Day</div>
              <div className="font-mono tabular-nums text-lg font-bold text-teal-700 mt-0.5">
                {visitorStats.busiestHour}
              </div>
              <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                {visitorStats.busiestHourVisitors} visitors ({period})
              </div>
            </div>

            <div className="p-3.5 border border-slate-200 rounded-lg">
              <div className="text-[11px] font-medium text-slate-500">Peak vs Non-Peak Wait</div>
              <div className="font-mono tabular-nums text-lg font-bold text-slate-900 mt-0.5">
                {visitorStats.peakAvgWaitMins}m / {visitorStats.nonPeakAvgWaitMins}m
              </div>
              <div className="text-[11px] text-slate-500">
                Peak avg vs off-peak avg
              </div>
            </div>

            <div className="p-3.5 border border-slate-200 rounded-lg col-span-2 sm:col-span-1">
              <div className="text-[11px] font-medium text-slate-500">
                Daily / Weekly / Monthly
              </div>
              <div className="font-mono tabular-nums text-sm font-bold text-slate-900 mt-1">
                {visitorStats.dailyVisitors.toLocaleString()} ·{' '}
                {visitorStats.weeklyVisitors.toLocaleString()} ·{' '}
                {visitorStats.monthlyVisitors.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Total visitor volume
              </div>
            </div>
          </div>
        </section>

        {/* Smart Queue Prediction Card */}
        <section className="p-6 bg-white border border-slate-200 rounded-xl space-y-5">
          <div className="flex items-center justify-between pb-4 border-b border-slate-200">
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Clock className="w-4 h-4 text-slate-900" />
                <span>Smart Queue Prediction</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Upcoming busy windows, wait predictions, and counter scaling guidance.
              </p>
            </div>
          </div>

          {/* Upcoming Busy Hours Forecast */}
          <div className="space-y-2.5">
            <div className="text-xs font-semibold text-slate-700">
              Predicted Upcoming Busy Hours
            </div>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
              {upcomingBusyHours.map((slot) => {
                const style = CROWD_STYLE[slot.crowdLevel];
                return (
                  <div
                    key={slot.hour}
                    className="px-3.5 py-2.5 bg-white flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-900">{slot.hour}</span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono tabular-nums text-slate-600">
                          ~{slot.expectedVisitors} visitors
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {slot.suggestedAction}
                      </div>
                    </div>
                    <div className="text-right shrink-0 space-y-1">
                      <span
                        className={`inline-block px-2 py-0.5 text-[11px] font-semibold border rounded ${style.bg} ${style.text}`}
                      >
                        {style.label} Crowd
                      </span>
                      <div className="font-mono tabular-nums text-[11px] text-slate-500">
                        ~{slot.predictedWaitMins}m wait
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-Queue Smart Predictions */}
          <div className="space-y-2.5">
            <div className="text-xs font-semibold text-slate-700">
              Live Queue Load &amp; Pre-Surge Warnings
            </div>
            <div className="space-y-2.5 max-h-[320px] overflow-y-auto pr-0.5">
              {queuePredictions.map((qp) => {
                const cStyle = CROWD_STYLE[qp.crowdLevel];
                return (
                  <div
                    key={`${qp.facilityId}-${qp.queueId}`}
                    className="p-3.5 border border-slate-200 rounded-lg space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-slate-900">{qp.queueName}</div>
                        <div className="text-[11px] text-slate-500">
                          {qp.facilityName} · {qp.departmentName}
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 text-[11px] font-semibold border rounded shrink-0 ${cStyle.bg} ${cStyle.text}`}
                      >
                        {cStyle.label}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-600 pt-1 border-t border-slate-100">
                      <span>{qp.waitingCount} waiting</span>
                      <span>{qp.activeCounters} active desk(s)</span>
                      <span className="font-bold text-slate-900">ETA ~{qp.predictedWaitMins}m</span>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span
                        className={
                          qp.overThreshold || qp.approachingThreshold
                            ? 'text-amber-800 font-medium'
                            : 'text-slate-500'
                        }
                      >
                        {qp.suggestedAction}
                      </span>
                      {qp.suggestedCounterId && (
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() =>
                            handleOpenExtraCounter(qp.suggestedCounterId!, qp.queueId, qp.queueName)
                          }
                          className="px-2.5 py-1 bg-teal-700 hover:bg-teal-800 text-white rounded text-[11px] font-semibold whitespace-nowrap cursor-pointer shrink-0"
                        >
                          Open Extra Counter
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {/* 4. COUNTER MANAGEMENT DASHBOARD */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-teal-700" />
              <span>Counter Management Dashboard</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Open, close, or reassign service counters and staff allocation in real time.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openReallocationModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Reallocate Staff</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="py-3 px-5">Counter &amp; Staff</th>
                <th className="py-3 px-4">Department / Service</th>
                <th className="py-3 px-4 text-right">Queue Length</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Est. Wait</th>
                <th className="py-3 px-5 text-right">Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {counters.map((cnt) => {
                const facQueues = dashboard.availableQueues.filter(
                  (q) => q.facilityId === cnt.facilityId
                );
                const statusClass =
                  COUNTER_STATUS_STYLE[cnt.status] || COUNTER_STATUS_STYLE.Serving;
                return (
                  <tr key={cnt.id} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-5">
                      <div className="font-bold text-slate-900">
                        {cnt.label} · {cnt.staffName}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {cnt.facilityName} · Token{' '}
                        <span className="font-mono font-semibold text-slate-700">
                          {cnt.currentToken}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-slate-700 font-medium mb-1">{cnt.departmentName}</div>
                      <select
                        aria-label={`Reassign service queue for ${cnt.label}`}
                        disabled={busyId !== null}
                        value={cnt.queueId}
                        onChange={(e) => handleCounterQueueReassign(cnt.id, e.target.value)}
                        className="px-2.5 py-1 text-xs bg-white border border-slate-200 rounded-md text-slate-800 max-w-[200px]"
                      >
                        {facQueues.map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold text-slate-900">
                      {cnt.queueLength}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-block px-2.5 py-1 text-[11px] font-semibold border rounded ${statusClass}`}
                      >
                        {cnt.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-800 font-semibold">
                      ~{cnt.estimatedWaitMins} min
                    </td>
                    <td className="py-3.5 px-5 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <select
                          aria-label={`Set status for ${cnt.label}`}
                          disabled={busyId !== null}
                          value={cnt.status === 'Paused' ? 'Closed' : cnt.status}
                          onChange={(e) =>
                            handleCounterStatusUpdate(
                              cnt.id,
                              e.target.value as 'Serving' | 'Busy' | 'Closed'
                            )
                          }
                          className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 rounded-md text-slate-800 cursor-pointer"
                        >
                          <option value="Serving">Serving</option>
                          <option value="Busy">Busy</option>
                          <option value="Closed">Closed</option>
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            openReallocationModal({
                              counterId: cnt.id,
                              queueId: cnt.queueId,
                              facilityId: cnt.facilityId,
                            })
                          }
                          className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap"
                        >
                          Reassign
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 5. SUSTAINABILITY & SOCIAL IMPACT */}
      <section className="p-6 bg-white border border-slate-200 rounded-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Leaf className="w-4 h-4 text-teal-700" />
            <h2 className="text-base font-bold text-slate-900">
              Sustainability &amp; Social Impact
            </h2>
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-700" />
            <span>UN SDG 9 · SDG 11 · SDG 12 Live Telemetry</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div className="text-xs font-medium text-slate-600">
              Estimated Time Saved by Citizens
            </div>
            <div className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1.5">
              {sustainabilityImpact.estimatedTimeSavedHours} hrs
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              {sustainabilityImpact.estimatedTimeSavedMinutes.toLocaleString()} mins reclaimed via virtual waiting
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div className="text-xs font-medium text-slate-600">
              Reduction in Physical Queue Waiting
            </div>
            <div className="font-mono tabular-nums text-2xl font-bold text-teal-700 mt-1.5">
              -{sustainabilityImpact.physicalWaitReductionPct}%
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Remote check-ins &amp; grace-window pacing
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div className="text-xs font-medium text-slate-600">
              Digital Tokens Served
            </div>
            <div className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1.5">
              {sustainabilityImpact.digitalTokensServed.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Paper queue slips eliminated (SDG 12)
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div className="text-xs font-medium text-slate-600">
              Estimated Crowd Reduction
            </div>
            <div className="font-mono tabular-nums text-2xl font-bold text-teal-700 mt-1.5">
              -{sustainabilityImpact.estimatedCrowdReductionPct}%
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              ~{sustainabilityImpact.corridorVisitorsAvoided} fewer waiting-hall occupants
            </div>
          </div>
        </div>
      </section>

      {/* REALLOCATE STAFF MODAL */}
      {reallocOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="realloc-modal-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 id="realloc-modal-title" className="text-base font-bold text-slate-900">
                  Reallocate Staff &amp; Counter
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Open standby counters or reassign staff to relieve overloaded queues.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReallocOpen(false)}
                aria-label="Close staff reallocation modal"
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmReallocation} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Counter to Open / Reassign
                </label>
                <select
                  value={reallocCounterId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setReallocCounterId(nextId);
                    const found = dashboard.counters.find((c) => c.id === nextId);
                    if (found) {
                      setReallocOperatorId(found.assignedOperatorId || '');
                      setReallocStaffName(found.staffName);
                    }
                  }}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {dashboard.counters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} · {c.staffName} ({c.status}) — {c.facilityName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Target Service Queue
                </label>
                <select
                  value={reallocQueueId}
                  onChange={(e) => setReallocQueueId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {dashboard.availableQueues
                    .filter((q) => {
                      const activeCnt = dashboard.counters.find((c) => c.id === reallocCounterId);
                      return !activeCnt || q.facilityId === activeCnt.facilityId;
                    })
                    .map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name} ({q.facilityName})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Assign Operator Account (Optional)
                </label>
                <select
                  value={reallocOperatorId}
                  onChange={(e) => {
                    setReallocOperatorId(e.target.value);
                    const op = dashboard.operators.find((o) => o.id === e.target.value);
                    if (op) setReallocStaffName(op.name);
                  }}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Keep / Enter Custom Staff Name</option>
                  {dashboard.operators.map((op) => (
                    <option key={op.id} value={op.id}>
                      {op.name}
                    </option>
                  ))}
                </select>
              </div>

              {!reallocOperatorId && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Staff Name
                  </label>
                  <input
                    type="text"
                    value={reallocStaffName}
                    onChange={(e) => setReallocStaffName(e.target.value)}
                    placeholder="e.g. Dr. Anita Rao"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Counter Status
                </label>
                <select
                  value={reallocStatus}
                  onChange={(e) =>
                    setReallocStatus(e.target.value as 'Serving' | 'Busy' | 'Closed')
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Serving">Serving (Active)</option>
                  <option value="Busy">Busy</option>
                  <option value="Closed">Closed</option>
                </select>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setReallocOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyId === 'reallocate'}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-teal-700 rounded-lg cursor-pointer"
                >
                  {busyId === 'reallocate' ? 'Applying...' : 'Confirm Reallocation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
