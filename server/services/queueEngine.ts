import crypto from 'node:crypto';
import { dbStore } from '../db/store.ts';
import type {
  AuditLogRecord,
  CounterRecord,
  DepartmentRecord,
  EntryChannel,
  NotificationCategory,
  NotificationRecord,
  QueueLifecycleState,
  QueuePriority,
  ServiceQueueRecord,
  SwapRequestRecord,
  TokenRecord,
  UserRole,
} from '../models/types.ts';
import { wsHub } from '../socket/wsHub.ts';
import {
  diffCalendarDaysIso,
  formatAppointmentCountdown,
  formatIstDateShort,
  getIstDateIso,
  getIstHourMinute,
  getIstTimeFormatted,
  parseSlotToMinutesOfDay,
} from './istTime.ts';

export interface ActorInfo {
  id: string;
  name: string;
  role: UserRole;
}

const PRIORITY_RANK: Record<QueuePriority, number> = {
  emergency: 0,
  senior: 1,
  appointment: 2,
  standard: 3,
};

const ACTIVE_TOKEN_STATUSES = new Set(['Waiting', 'Called', 'Serving', 'Grace']);

export function recordAuditLog(params: {
  actor: ActorInfo;
  action: string;
  targetType: AuditLogRecord['targetType'];
  targetId: string;
  facilityId?: string;
  details: string;
}): AuditLogRecord {
  const db = dbStore.getState();
  const entry: AuditLogRecord = {
    id: `audit-${crypto.randomUUID().slice(0, 8)}`,
    actorId: params.actor.id,
    actorName: params.actor.name,
    actorRole: params.actor.role,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    facilityId: params.facilityId,
    details: params.details,
    timestamp: new Date().toISOString(),
  };
  db.auditLogs.unshift(entry);
  if (db.auditLogs.length > 250) {
    db.auditLogs = db.auditLogs.slice(0, 250);
  }
  return entry;
}

export function pushNotification(params: {
  facilityId: string;
  userId?: string;
  tokenId?: string;
  title: string;
  message: string;
  category: NotificationCategory;
  dedupePrefix?: string;
}): NotificationRecord | null {
  const db = dbStore.getState();
  if (params.dedupePrefix && params.tokenId) {
    const exists = db.notifications.some(
      (n) =>
        n.tokenId === params.tokenId &&
        (!params.userId || n.userId === params.userId) &&
        n.title.startsWith(params.dedupePrefix!)
    );
    if (exists) return null;
  }

  const notif: NotificationRecord = {
    id: `notif-${crypto.randomUUID().slice(0, 8)}`,
    facilityId: params.facilityId,
    userId: params.userId,
    tokenId: params.tokenId,
    title: params.title,
    message: params.message,
    category: params.category,
    channel: 'in-app',
    isRead: false,
    createdAt: new Date().toISOString(),
  };
  db.notifications.unshift(notif);
  if (db.notifications.length > 150) {
    db.notifications = db.notifications.slice(0, 150);
  }
  wsHub.broadcast(params.facilityId, 'notification:new', { notification: notif });
  wsHub.broadcast('all', 'notification:new', { notification: notif });
  return notif;
}

export interface HydratedQueue extends ServiceQueueRecord {
  departmentName: string;
  waitingCount: number;
  activeCounters: number;
  predictedWaitMins: number;
}

export interface HydratedCounter extends CounterRecord {
  queueName: string;
  departmentName: string;
}

export interface HydratedToken extends TokenRecord {
  departmentName: string;
  facilityName?: string;
  counterLabel?: string;
  queueLifecycleState: QueueLifecycleState;
  bookingStatusLabel: string;
  queueStatusLabel: string;
  checkInEligible: boolean;
  checkInStatusText: string;
  countdownText: string;
  currentServingToken: string | null;
  aheadCount: number | null;
  etaMinutes: number | null;
  waitStatusMessage: string;
}

export interface FacilitySnapshot {
  facilityId: string;
  todayIst: string;
  departments: DepartmentRecord[];
  queues: HydratedQueue[];
  counters: HydratedCounter[];
  roster: HydratedToken[];
  openSwaps: SwapRequestRecord[];
  surgeAlert: {
    active: boolean;
    queueId: string;
    queueName: string;
    waitingCount: number;
    standbyCounterId: string;
    standbyStaffName: string;
  } | null;
  summary: {
    totalWaiting: number;
    activeCountersCount: number;
    totalCountersCount: number;
    avgWaitMins: number;
    onTimeReturnRate: number;
  };
}

/**
 * Exact waiting-time formula:
 * Estimated Waiting Time = (People Ahead × Average Service Time) / Number of Active Counters
 * Returns null if the queue is paused or zero active counters are available.
 */
export function computeQueueWaitMins(
  queue: ServiceQueueRecord,
  aheadCount: number,
  activeCounters: number
): number | null {
  if (queue.isPaused || activeCounters <= 0) return null;
  if (aheadCount <= 0) return 0;
  return Math.max(1, Math.round((aheadCount * queue.avgServiceMinutes) / activeCounters));
}

function computeQueueOverviewWaitMins(
  queue: ServiceQueueRecord,
  waitingCount: number,
  activeCounters: number
): number {
  if (waitingCount <= 0) return 0;
  const divisor = Math.max(1, activeCounters);
  return Math.max(1, Math.round((waitingCount * queue.avgServiceMinutes) / divisor));
}

function formatMinutesAsTime12(totalMins: number): string {
  const clamped = ((totalMins % 1440) + 1440) % 1440;
  const hr24 = Math.floor(clamped / 60);
  const min = clamped % 60;
  const meridiem = hr24 >= 12 ? 'PM' : 'AM';
  const hr12 = hr24 % 12 === 0 ? 12 : hr24 % 12;
  return `${hr12}:${String(min).padStart(2, '0')} ${meridiem}`;
}

function compareActiveTokens(a: TokenRecord, b: TokenRecord): number {
  const activeScore = (t: TokenRecord) => {
    if (t.status === 'Serving') return 0;
    if (t.status === 'Called') return 1;
    if (t.status === 'Grace') return 2;
    return 3;
  };
  const stageDiff = activeScore(a) - activeScore(b);
  if (stageDiff !== 0) return stageDiff;

  const prioDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (prioDiff !== 0) return prioDiff;

  const aTime = a.checkedInAtMs ?? a.createdAtMs ?? 0;
  const bTime = b.checkedInAtMs ?? b.createdAtMs ?? 0;
  if (aTime !== bTime) return aTime - bTime;

  return a.numberValue - b.numberValue;
}

function resolveCurrentServingToken(
  queue: ServiceQueueRecord,
  todayTokensInQueue: TokenRecord[],
  queueCounters: CounterRecord[]
): string | null {
  const activeOnDesk = todayTokensInQueue.find(
    (t) => t.status === 'Serving' || t.status === 'Called'
  );
  if (activeOnDesk) return activeOnDesk.tokenId;

  const counterServing = queueCounters.find(
    (c) => (c.status === 'Serving' || c.status === 'Busy') && c.currentToken && c.currentToken !== '—'
  );
  if (counterServing) return counterServing.currentToken;

  if (queue.servingNumber > 0) {
    return `${queue.prefix}-${queue.servingNumber}`;
  }
  return null;
}

function ensureUniqueTokenId(tokens: TokenRecord[], candidate: string): string {
  const existing = new Set(tokens.map((t) => t.tokenId));
  if (!existing.has(candidate)) return candidate;
  let suffix = 2;
  while (existing.has(`${candidate}-${suffix}`)) {
    suffix += 1;
  }
  return `${candidate}-${suffix}`;
}

function hydrateTokenWithContext(
  token: TokenRecord,
  ctx: {
    facilityName?: string;
    departmentName: string;
    counterLabel?: string;
    queue?: ServiceQueueRecord;
    queueCounters: CounterRecord[];
    orderedActiveTokensForQueue: TokenRecord[];
    todayIst: string;
    now: Date;
    checkInWindowBeforeMins: number;
  }
): HydratedToken {
  const apptDate = token.appointmentDate || getIstDateIso(new Date(token.createdAtMs || ctx.now.getTime()));
  const apptSlot = token.appointmentSlot || token.joinedAt || '08:00 AM';
  const checkedIn = typeof token.checkedIn === 'boolean' ? token.checkedIn : true;
  const qrCodePayload =
    token.qrCodePayload || `SQ:${token.facilityId}:${token.queueId}:${token.tokenId}:${apptDate}`;

  if (token.status === 'Completed') {
    const minsText = token.actualServiceMinutes
      ? `Completed in ${token.actualServiceMinutes} min`
      : 'Service Completed';
    return {
      ...token,
      appointmentDate: apptDate,
      appointmentSlot: apptSlot,
      checkedIn,
      qrCodePayload,
      facilityName: ctx.facilityName,
      departmentName: ctx.departmentName,
      counterLabel: ctx.counterLabel,
      queueLifecycleState: 'Completed',
      bookingStatusLabel: 'Completed',
      queueStatusLabel: 'Service Completed',
      checkInEligible: false,
      checkInStatusText: token.completedAt ? `Completed at ${token.completedAt} IST` : 'Completed',
      countdownText: 'Completed',
      currentServingToken: null,
      aheadCount: 0,
      etaMinutes: 0,
      waitStatusMessage: minsText,
    };
  }

  if (['Cancelled', 'Skipped', 'NoShow'].includes(token.status)) {
    return {
      ...token,
      appointmentDate: apptDate,
      appointmentSlot: apptSlot,
      checkedIn,
      qrCodePayload,
      facilityName: ctx.facilityName,
      departmentName: ctx.departmentName,
      counterLabel: ctx.counterLabel,
      queueLifecycleState: 'Cancelled',
      bookingStatusLabel: token.status,
      queueStatusLabel: token.status,
      checkInEligible: false,
      checkInStatusText: 'Closed',
      countdownText: token.status,
      currentServingToken: null,
      aheadCount: null,
      etaMinutes: null,
      waitStatusMessage: `Token ${token.status.toLowerCase()}`,
    };
  }

  const dayDiff = diffCalendarDaysIso(apptDate, ctx.todayIst);

  // State 1: Upcoming Appointment (future IST date)
  if (dayDiff > 0) {
    return {
      ...token,
      appointmentDate: apptDate,
      appointmentSlot: apptSlot,
      checkedIn: false,
      qrCodePayload,
      facilityName: ctx.facilityName,
      departmentName: ctx.departmentName,
      counterLabel: ctx.counterLabel,
      queueLifecycleState: 'Upcoming Appointment',
      bookingStatusLabel: 'Upcoming Appointment',
      queueStatusLabel: 'Not Started',
      checkInEligible: false,
      checkInStatusText: 'Available on appointment day',
      countdownText: formatAppointmentCountdown(apptDate, ctx.todayIst),
      currentServingToken: null,
      aheadCount: null,
      etaMinutes: null,
      waitStatusMessage: 'Available after check-in',
    };
  }

  // State 2: Same-day (or past un-checked-in) appointment awaiting QR Check-In
  if (!checkedIn) {
    const slotMins = parseSlotToMinutesOfDay(apptSlot);
    const { hour, minute } = getIstHourMinute(ctx.now);
    const nowMins = hour * 60 + minute;
    const isExpiredDate = dayDiff < 0;
    const withinWindow =
      !isExpiredDate &&
      (slotMins === null || slotMins - nowMins <= ctx.checkInWindowBeforeMins);
    const queuePaused = Boolean(ctx.queue?.isPaused);

    let checkInStatusText = 'QR check-in available now';
    if (isExpiredDate) {
      checkInStatusText = 'Appointment date has passed';
    } else if (queuePaused) {
      checkInStatusText = 'Queue temporarily paused by counter staff';
    } else if (!withinWindow && slotMins !== null) {
      checkInStatusText = `Check-in opens at ${formatMinutesAsTime12(
        slotMins - ctx.checkInWindowBeforeMins
      )} IST`;
    }

    return {
      ...token,
      appointmentDate: apptDate,
      appointmentSlot: apptSlot,
      checkedIn: false,
      qrCodePayload,
      facilityName: ctx.facilityName,
      departmentName: ctx.departmentName,
      counterLabel: ctx.counterLabel,
      queueLifecycleState: 'Check-In Required',
      bookingStatusLabel: isExpiredDate ? 'Expired' : 'Check-In Required',
      queueStatusLabel: isExpiredDate ? 'Missed Appointment' : 'Awaiting Check-In',
      checkInEligible: withinWindow && !queuePaused,
      checkInStatusText,
      countdownText: formatAppointmentCountdown(apptDate, ctx.todayIst),
      currentServingToken: null,
      aheadCount: null,
      etaMinutes: null,
      waitStatusMessage: 'Waiting time will be available after check-in.',
    };
  }

  // State 3: Active Queue (Today IST + Checked-in)
  const activeCounters = ctx.queueCounters.filter(
    (c) => c.status === 'Serving' || c.status === 'Busy'
  ).length;
  const currentServingToken = ctx.queue
    ? resolveCurrentServingToken(ctx.queue, ctx.orderedActiveTokensForQueue, ctx.queueCounters)
    : null;

  const idxInQueue = ctx.orderedActiveTokensForQueue.findIndex(
    (t) => t.tokenId === token.tokenId
  );
  const aheadCount =
    token.status === 'Serving' || token.status === 'Called'
      ? 0
      : idxInQueue >= 0
        ? idxInQueue
        : 0;

  let etaMinutes: number | null = null;
  let waitStatusMessage = 'Calculating...';

  if (token.status === 'Serving' || token.status === 'Called') {
    etaMinutes = 0;
    waitStatusMessage = token.status === 'Serving' ? 'Now Serving' : 'Called to counter';
  } else if (!ctx.queue) {
    etaMinutes = null;
    waitStatusMessage = 'Queue metadata unavailable';
  } else if (ctx.queue.isPaused) {
    etaMinutes = null;
    waitStatusMessage = 'Queue paused by counter staff';
  } else if (activeCounters <= 0) {
    etaMinutes = null;
    waitStatusMessage = 'Waiting for active counter staff';
  } else {
    etaMinutes = computeQueueWaitMins(ctx.queue, aheadCount, activeCounters);
    waitStatusMessage =
      etaMinutes === 0 ? 'Next in line' : `${etaMinutes} minute${etaMinutes === 1 ? '' : 's'}`;
  }

  return {
    ...token,
    appointmentDate: apptDate,
    appointmentSlot: apptSlot,
    checkedIn: true,
    qrCodePayload,
    facilityName: ctx.facilityName,
    departmentName: ctx.departmentName,
    counterLabel: ctx.counterLabel,
    queueLifecycleState: 'Active Queue',
    bookingStatusLabel: token.status,
    queueStatusLabel: token.status,
    checkInEligible: false,
    checkInStatusText: token.checkedInAt ? `Checked in at ${token.checkedInAt} IST` : 'Checked in',
    countdownText: 'Today',
    currentServingToken,
    aheadCount,
    etaMinutes,
    waitStatusMessage,
  };
}

export function hydrateTokenForCitizen(
  token: TokenRecord,
  now: Date = new Date()
): HydratedToken {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(now);
  const facility = db.facilities.find((f) => f.id === token.facilityId);
  const dept = db.departments.find((d) => d.id === token.departmentId);
  const queue = db.queues.find((q) => q.id === token.queueId && q.facilityId === token.facilityId);
  const queueCounters = db.counters.filter(
    (c) => c.facilityId === token.facilityId && c.queueId === token.queueId
  );
  const counter =
    queueCounters.find((c) => c.id === token.counterId) ||
    queueCounters.find((c) => c.status !== 'Closed') ||
    queueCounters[0];

  const orderedActiveTokensForQueue = db.tokens
    .filter(
      (t) =>
        t.facilityId === token.facilityId &&
        t.queueId === token.queueId &&
        (t.appointmentDate || todayIst) === todayIst &&
        (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
        ACTIVE_TOKEN_STATUSES.has(t.status)
    )
    .slice()
    .sort(compareActiveTokens);

  return hydrateTokenWithContext(token, {
    facilityName: facility?.name,
    departmentName: dept?.name || 'General Services',
    counterLabel: counter?.label,
    queue,
    queueCounters,
    orderedActiveTokensForQueue,
    todayIst,
    now,
    checkInWindowBeforeMins: db.settings.checkInWindowBeforeMins ?? 120,
  });
}

export function getFacilitySnapshot(
  facilityId: string,
  now: Date = new Date()
): FacilitySnapshot | null {
  const db = dbStore.getState();
  const facility = db.facilities.find((f) => f.id === facilityId);
  if (!facility) return null;

  const todayIst = getIstDateIso(now);
  const facilityDepartments = db.departments.filter((d) => d.facilityId === facilityId);
  const facilityQueues = db.queues.filter((q) => q.facilityId === facilityId);
  const facilityCounters = db.counters.filter((c) => c.facilityId === facilityId);

  // Strictly isolate active queue to tokens scheduled for TODAY (IST) AND checked in
  const activeTodayCheckedIn = db.tokens.filter(
    (t) =>
      t.facilityId === facilityId &&
      (t.appointmentDate || todayIst) === todayIst &&
      (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
      ACTIVE_TOKEN_STATUSES.has(t.status)
  );

  const orderedByQueue = new Map<string, TokenRecord[]>();
  for (const q of facilityQueues) {
    const queueTokens = activeTodayCheckedIn
      .filter((t) => t.queueId === q.id)
      .slice()
      .sort(compareActiveTokens);
    orderedByQueue.set(q.id, queueTokens);
  }

  const hydratedQueues: HydratedQueue[] = facilityQueues.map((q) => {
    const dept = facilityDepartments.find((d) => d.id === q.departmentId);
    const activeCounters = facilityCounters.filter(
      (c) => c.queueId === q.id && (c.status === 'Serving' || c.status === 'Busy')
    ).length;
    const queueActive = orderedByQueue.get(q.id) || [];
    const waitingCount = queueActive.filter((t) =>
      ['Waiting', 'Called', 'Grace'].includes(t.status)
    ).length;
    const predictedWaitMins = computeQueueOverviewWaitMins(q, waitingCount, activeCounters);

    return {
      ...q,
      departmentName: dept?.name || 'General Services',
      waitingCount,
      activeCounters,
      predictedWaitMins,
    };
  });

  const hydratedCounters: HydratedCounter[] = facilityCounters.map((c) => {
    const q = facilityQueues.find((fq) => fq.id === c.queueId);
    const dept = facilityDepartments.find((d) => d.id === (c.departmentId || q?.departmentId));
    return {
      ...c,
      queueName: q?.name || 'General Queue',
      departmentName: dept?.name || 'General Services',
    };
  });

  const checkInWindowBeforeMins = db.settings.checkInWindowBeforeMins ?? 120;
  const hydratedRoster: HydratedToken[] = activeTodayCheckedIn
    .slice()
    .sort(compareActiveTokens)
    .map((t) => {
      const q = hydratedQueues.find((hq) => hq.id === t.queueId);
      const dept = facilityDepartments.find((d) => d.id === (t.departmentId || q?.departmentId));
      const queueCounters = facilityCounters.filter((c) => c.queueId === t.queueId);
      const cnt =
        queueCounters.find((c) => c.id === t.counterId) ||
        queueCounters.find((c) => c.status !== 'Closed') ||
        queueCounters[0];

      return hydrateTokenWithContext(t, {
        facilityName: facility.name,
        departmentName: dept?.name || 'General Services',
        counterLabel: cnt?.label,
        queue: q,
        queueCounters,
        orderedActiveTokensForQueue: orderedByQueue.get(t.queueId) || [],
        todayIst,
        now,
        checkInWindowBeforeMins,
      });
    });

  const openSwaps = db.swaps.filter(
    (s) => s.facilityId === facilityId && s.status === 'open'
  );

  const standbyCounter = facilityCounters.find((c) => c.status === 'Closed');
  const overloadedQueue = hydratedQueues.find((q) => q.waitingCount >= 6);
  const surgeAlert =
    standbyCounter && overloadedQueue
      ? {
          active: true,
          queueId: overloadedQueue.id,
          queueName: overloadedQueue.name,
          waitingCount: overloadedQueue.waitingCount,
          standbyCounterId: standbyCounter.id,
          standbyStaffName: standbyCounter.staffName,
        }
      : null;

  const totalWaiting = hydratedQueues.reduce((sum, q) => sum + q.waitingCount, 0);
  const activeCountersCount = facilityCounters.filter(
    (c) => c.status === 'Serving' || c.status === 'Busy'
  ).length;
  const avgWaitMins =
    hydratedQueues.length > 0
      ? Math.round(
          hydratedQueues.reduce((sum, q) => sum + q.predictedWaitMins, 0) /
            hydratedQueues.length
        )
      : 0;

  return {
    facilityId,
    todayIst,
    departments: facilityDepartments,
    queues: hydratedQueues,
    counters: hydratedCounters,
    roster: hydratedRoster,
    openSwaps,
    surgeAlert,
    summary: {
      totalWaiting,
      activeCountersCount,
      totalCountersCount: facilityCounters.length,
      avgWaitMins,
      onTimeReturnRate: 94,
    },
  };
}

export function broadcastFacilitySnapshot(
  facilityId: string,
  event: string,
  extra?: Record<string, unknown>
) {
  const snapshot = getFacilitySnapshot(facilityId);
  if (!snapshot) return;
  wsHub.broadcast(facilityId, event, { ...extra, snapshot });
  wsHub.broadcast('all', event, { facilityId, ...extra, snapshot });
}

export function syncCitizenAppointmentNotifications(
  userId: string,
  now: Date = new Date()
): void {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(now);
  let mutated = false;

  for (const token of db.tokens) {
    if (token.userId !== userId) continue;
    if (!['Waiting', 'Grace'].includes(token.status)) continue;
    const apptDate = token.appointmentDate || todayIst;
    const diff = diffCalendarDaysIso(apptDate, todayIst);

    if (diff === 1) {
      const created = pushNotification({
        facilityId: token.facilityId,
        userId,
        tokenId: token.tokenId,
        dedupePrefix: 'Appointment Reminder',
        title: `Appointment Reminder · ${token.tokenId}`,
        message: `Your appointment in ${token.queueName} is tomorrow (${formatIstDateShort(
          apptDate
        )}${token.appointmentSlot ? ` at ${token.appointmentSlot}` : ''} IST).`,
        category: 'token',
      });
      if (created) mutated = true;
    } else if (diff === 0 && !token.checkedIn) {
      const created = pushNotification({
        facilityId: token.facilityId,
        userId,
        tokenId: token.tokenId,
        dedupePrefix: 'Check-In Available',
        title: `Check-In Available · ${token.tokenId}`,
        message: `Your appointment today (${token.appointmentSlot || 'Scheduled'}) is ready for QR check-in at ${token.queueName}.`,
        category: 'token',
      });
      if (created) mutated = true;
    }
  }

  if (mutated) {
    dbStore.save();
  }
}

export function notifyQueueDisruption(params: {
  facilityId: string;
  queueId: string;
  title: string;
  message: string;
  category?: NotificationCategory;
}): void {
  const db = dbStore.getState();
  const todayIst = getIstDateIso();
  const affected = db.tokens.filter(
    (t) =>
      t.facilityId === params.facilityId &&
      t.queueId === params.queueId &&
      (t.appointmentDate || todayIst) === todayIst &&
      (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
      ['Waiting', 'Called', 'Grace'].includes(t.status)
  );
  if (affected.length === 0) {
    pushNotification({
      facilityId: params.facilityId,
      title: params.title,
      message: params.message,
      category: params.category || 'system',
    });
    return;
  }
  for (const tok of affected) {
    pushNotification({
      facilityId: params.facilityId,
      userId: tok.userId,
      tokenId: tok.tokenId,
      title: `${params.title} · ${tok.tokenId}`,
      message: params.message,
      category: params.category || 'system',
    });
  }
}

const PREBOOK_SLOT_TEMPLATES = [
  { slot: '08:00 AM', hourLabel: '8 AM' },
  { slot: '08:30 AM', hourLabel: '8 AM' },
  { slot: '09:00 AM', hourLabel: '9 AM' },
  { slot: '09:30 AM', hourLabel: '9 AM' },
  { slot: '10:00 AM', hourLabel: '10 AM' },
  { slot: '10:30 AM', hourLabel: '10 AM' },
  { slot: '11:00 AM', hourLabel: '11 AM' },
  { slot: '11:30 AM', hourLabel: '11 AM' },
  { slot: '12:00 PM', hourLabel: '12 PM' },
  { slot: '01:00 PM', hourLabel: '1 PM' },
  { slot: '01:30 PM', hourLabel: '1 PM' },
  { slot: '02:00 PM', hourLabel: '2 PM' },
  { slot: '02:30 PM', hourLabel: '2 PM' },
  { slot: '03:00 PM', hourLabel: '3 PM' },
  { slot: '03:30 PM', hourLabel: '3 PM' },
  { slot: '04:00 PM', hourLabel: '4 PM' },
  { slot: '04:30 PM', hourLabel: '4 PM' },
];

export interface AppointmentSlotItem {
  slot: string;
  hourLabel: string;
  bookedCount: number;
  maxCapacity: number;
  remainingSpots: number;
  isAvailable: boolean;
  crowdLevel: CrowdLevel;
  isBestTime: boolean;
  isPeak: boolean;
  estimatedWaitMins: number;
}

export interface AppointmentSlotsResult {
  facilityId: string;
  queueId: string;
  queueName: string;
  date: string;
  slots: AppointmentSlotItem[];
}

export function normalizeAppointmentDate(date?: string, now: Date = new Date()): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
    return date.trim();
  }
  return getIstDateIso(now);
}

export function getAppointmentSlots(
  params: {
    facilityId: string;
    queueId: string;
    date?: string;
  },
  now: Date = new Date()
): AppointmentSlotsResult | null {
  const db = dbStore.getState();
  const facility = db.facilities.find((f) => f.id === params.facilityId);
  const queue = db.queues.find(
    (q) => q.id === params.queueId && q.facilityId === params.facilityId
  );
  if (!facility || !queue) return null;

  const targetDate = normalizeAppointmentDate(params.date, now);
  const activeCountersForQueue = Math.max(
    1,
    db.counters.filter(
      (c) => c.facilityId === params.facilityId && c.queueId === queue.id && c.status !== 'Closed'
    ).length
  );
  const maxCapacity = Math.min(
    12,
    Math.max(4, Math.floor(30 / Math.max(2, queue.avgServiceMinutes)) * activeCountersForQueue)
  );

  const orgDash = getOrganisationAnalyticsDashboard({
    facilityId: params.facilityId,
    period: 'daily',
  });
  const hourlyMap = new Map(
    (orgDash?.hourlyFootfall || []).map((h) => [h.hour, h])
  );

  const slots: AppointmentSlotItem[] = PREBOOK_SLOT_TEMPLATES.map((tpl) => {
    const bookedCount = db.tokens.filter(
      (t) =>
        t.facilityId === params.facilityId &&
        t.queueId === queue.id &&
        t.appointmentSlot === tpl.slot &&
        (t.appointmentDate || targetDate) === targetDate &&
        !['Cancelled', 'Skipped', 'NoShow', 'Completed'].includes(t.status)
    ).length;

    const remainingSpots = Math.max(0, maxCapacity - bookedCount);
    const hrMeta = hourlyMap.get(tpl.hourLabel);
    const isPeak = hrMeta ? hrMeta.isPeak : tpl.hourLabel === '10 AM' || tpl.hourLabel === '11 AM';
    const isBestTime = hrMeta
      ? hrMeta.isRecommended
      : !isPeak &&
        (tpl.hourLabel === '8 AM' ||
          tpl.hourLabel === '1 PM' ||
          tpl.hourLabel === '2 PM' ||
          tpl.hourLabel === '3 PM');
    const crowdLevel: CrowdLevel = hrMeta
      ? hrMeta.crowdLevel
      : isPeak
        ? 'High'
        : isBestTime
          ? 'Low'
          : 'Medium';
    const baseHourWait = hrMeta ? hrMeta.avgWaitMins : isPeak ? 22 : isBestTime ? 8 : 13;
    const estimatedWaitMins = Math.max(
      2,
      Math.round(baseHourWait * 0.65 + bookedCount * Math.max(1.5, queue.avgServiceMinutes * 0.5))
    );

    return {
      slot: tpl.slot,
      hourLabel: tpl.hourLabel,
      bookedCount,
      maxCapacity,
      remainingSpots,
      isAvailable: remainingSpots > 0,
      crowdLevel,
      isBestTime,
      isPeak,
      estimatedWaitMins,
    };
  });

  return {
    facilityId: facility.id,
    queueId: queue.id,
    queueName: queue.name,
    date: targetDate,
    slots,
  };
}

export function issueToken(
  params: {
    facilityId: string;
    queueId: string;
    channel: EntryChannel;
    citizenName?: string;
    userId?: string;
    appointmentDate?: string;
    appointmentSlot?: string;
    isPreBooked?: boolean;
  },
  now: Date = new Date()
): { token: HydratedToken; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(now);

  const facility = db.facilities.find((f) => f.id === params.facilityId);
  if (!facility || !facility.isActive) {
    throw new Error('Selected service center is currently unavailable.');
  }

  const queue = db.queues.find(
    (q) => q.id === params.queueId && q.facilityId === params.facilityId
  );
  if (!queue || !queue.isActive) {
    throw new Error(`Service queue '${params.queueId}' not found or inactive.`);
  }
  if (queue.isPaused) {
    throw new Error(`Service '${queue.name}' is temporarily paused by counter staff.`);
  }

  // Prevent duplicate active tokens beyond configured maximum
  if (params.userId) {
    const activeForUser = db.tokens.filter(
      (t) =>
        t.userId === params.userId &&
        ACTIVE_TOKEN_STATUSES.has(t.status)
    );
    const maxAllowed = Math.max(1, db.settings.maxActiveTokensPerCitizen || 1);
    if (activeForUser.length >= maxAllowed) {
      throw new Error(
        `You already have an active token (${activeForUser[0].tokenId}). Cancel or complete it before booking another.`
      );
    }
  }

  const targetDate = normalizeAppointmentDate(params.appointmentDate, now);
  if (diffCalendarDaysIso(targetDate, todayIst) < 0) {
    throw new Error('Cannot book an appointment for a past date.');
  }

  let normalizedSlot = params.appointmentSlot?.trim() || undefined;
  if (normalizedSlot) {
    const slotInfo = getAppointmentSlots(
      {
        facilityId: params.facilityId,
        queueId: queue.id,
        date: targetDate,
      },
      now
    );
    const matched = slotInfo?.slots.find((s) => s.slot === normalizedSlot);
    if (!matched) {
      throw new Error(
        `Selected appointment time '${normalizedSlot}' is not valid for this service center.`
      );
    }
    if (!matched.isAvailable) {
      throw new Error(
        `Time slot ${normalizedSlot} on ${targetDate} is already full. Please select another slot.`
      );
    }
  }

  const isFutureDate = diffCalendarDaysIso(targetDate, todayIst) > 0;
  const isPreBooked =
    typeof params.isPreBooked === 'boolean'
      ? params.isPreBooked
      : Boolean(normalizedSlot || isFutureDate || queue.priority === 'appointment');

  if (isPreBooked && !normalizedSlot) {
    normalizedSlot = '08:00 AM';
  }

  // Walk-ins on today's IST date enter the active queue immediately; pre-booked tokens require QR check-in
  const checkedIn = !isPreBooked && !isFutureDate;
  const joinedAt = getIstTimeFormatted(now);

  // Per-(facility, queue, date) isolated token numbering so future dates never pollute today's queue sequence
  const sameDateQueueTokens = db.tokens.filter(
    (t) =>
      t.facilityId === params.facilityId &&
      t.queueId === queue.id &&
      (t.appointmentDate || todayIst) === targetDate
  );

  let numberValue: number;
  let rawTokenId: string;
  if (targetDate === todayIst) {
    const maxTodayNumber = sameDateQueueTokens.reduce(
      (max, t) => Math.max(max, t.numberValue),
      queue.servingNumber
    );
    numberValue = Math.max(queue.nextIssueNumber, maxTodayNumber + 1);
    queue.nextIssueNumber = numberValue + 1;
    rawTokenId = `${queue.prefix}-${numberValue}`;
  } else {
    const maxFutureNumber = sameDateQueueTokens.reduce(
      (max, t) => Math.max(max, t.numberValue),
      0
    );
    numberValue = maxFutureNumber + 1;
    const mmdd = `${targetDate.slice(5, 7)}${targetDate.slice(8, 10)}`;
    rawTokenId = `${queue.prefix}-${mmdd}-${numberValue}`;
  }

  const tokenId = ensureUniqueTokenId(db.tokens, rawTokenId);
  const qrCodePayload = `SQ:${facility.id}:${queue.id}:${tokenId}:${targetDate}`;

  const assignedCounter =
    db.counters.find(
      (c) => c.facilityId === params.facilityId && c.queueId === queue.id && c.status !== 'Closed'
    ) || db.counters.find((c) => c.facilityId === params.facilityId && c.queueId === queue.id);

  const token: TokenRecord = {
    tokenId,
    facilityId: params.facilityId,
    departmentId: queue.departmentId,
    queueId: queue.id,
    queueName: queue.name,
    counterId: assignedCounter?.id,
    assignedOperatorId: assignedCounter?.assignedOperatorId,
    numberValue,
    citizenName: params.citizenName?.trim() || 'Citizen Guest',
    userId: params.userId,
    channel: params.channel,
    priority: queue.priority,
    status: 'Waiting',
    joinedAt,
    appointmentDate: targetDate,
    appointmentSlot: normalizedSlot || joinedAt,
    isPreBooked,
    checkedIn,
    checkedInAt: checkedIn ? joinedAt : undefined,
    checkedInAtMs: checkedIn ? now.getTime() : undefined,
    qrCodePayload,
    createdAtMs: now.getTime(),
  };

  db.tokens.push(token);
  if (checkedIn) {
    db.metrics.processedDelta += 1;
  }

  pushNotification({
    facilityId: params.facilityId,
    userId: params.userId,
    tokenId: token.tokenId,
    title: isPreBooked
      ? `Appointment Confirmed · ${token.tokenId}`
      : `Token ${token.tokenId} Confirmed`,
    message: isPreBooked
      ? `Reserved in ${queue.name} for ${formatIstDateShort(targetDate)}${
          normalizedSlot ? ` at ${normalizedSlot} IST` : ''
        } (${queue.location}) at ${facility.name}. Scan QR on appointment day to check in.`
      : `Checked in to ${queue.name} (${queue.location}) at ${facility.name} via ${params.channel}.`,
    category: 'token',
  });

  if (params.userId) {
    const diff = diffCalendarDaysIso(targetDate, todayIst);
    if (diff === 1) {
      pushNotification({
        facilityId: params.facilityId,
        userId: params.userId,
        tokenId: token.tokenId,
        dedupePrefix: 'Appointment Reminder',
        title: `Appointment Reminder · ${token.tokenId}`,
        message: `Reminder: Your appointment at ${facility.name} is tomorrow (${formatIstDateShort(
          targetDate
        )} at ${normalizedSlot || joinedAt} IST).`,
        category: 'token',
      });
    } else if (diff === 0 && !checkedIn) {
      pushNotification({
        facilityId: params.facilityId,
        userId: params.userId,
        tokenId: token.tokenId,
        dedupePrefix: 'Check-In Available',
        title: `Check-In Available · ${token.tokenId}`,
        message: `Your appointment today (${normalizedSlot || joinedAt}) can be checked in via QR to enter the live queue.`,
        category: 'token',
      });
    }
  }

  dbStore.save();

  const snapshot = getFacilitySnapshot(params.facilityId, now)!;
  const hydrated = hydrateTokenForCitizen(token, now);
  return { token: hydrated, snapshot };
}

export function verifyAndCheckInQr(
  params: {
    facilityId?: string;
    qrPayload?: string;
    tokenId?: string;
    departmentId?: string;
    queueId?: string;
    actor?: ActorInfo;
  },
  now: Date = new Date()
): { token: HydratedToken; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(now);

  let targetFacilityId = params.facilityId?.trim();
  let targetQueueId = params.queueId?.trim();
  let targetTokenId = params.tokenId?.trim();

  if (params.qrPayload && params.qrPayload.trim()) {
    const raw = params.qrPayload.trim();
    if (raw.startsWith('SQ:')) {
      const parts = raw.split(':');
      if (parts.length < 4) {
        throw new Error('Invalid QR code format.');
      }
      targetFacilityId = targetFacilityId || parts[1];
      targetQueueId = targetQueueId || parts[2];
      targetTokenId = targetTokenId || parts[3];
    } else if (raw.includes(':')) {
      const parts = raw.split(':');
      targetFacilityId = targetFacilityId || parts[0];
      targetTokenId = targetTokenId || parts[1];
    } else {
      targetTokenId = targetTokenId || raw;
    }
  }

  if (!targetTokenId) {
    throw new Error('Token ID or QR payload is required to check in.');
  }

  const token = db.tokens.find(
    (t) =>
      t.tokenId.toLowerCase() === targetTokenId!.toLowerCase() &&
      (!targetFacilityId || t.facilityId === targetFacilityId)
  );
  if (!token) {
    throw new Error(`Token '${targetTokenId}' was not found for this service center.`);
  }

  if (params.actor?.role === 'citizen' && token.userId && token.userId !== params.actor.id) {
    throw new Error('You can only check in your own appointment token.');
  }
  if (params.departmentId && token.departmentId !== params.departmentId) {
    throw new Error('QR token belongs to a different department.');
  }
  if (targetQueueId && token.queueId !== targetQueueId) {
    throw new Error('QR token belongs to a different service queue.');
  }
  if (['Completed', 'Cancelled', 'Skipped', 'NoShow'].includes(token.status)) {
    throw new Error(`Cannot check in token '${token.tokenId}' because it is ${token.status}.`);
  }

  const queue = db.queues.find(
    (q) => q.id === token.queueId && q.facilityId === token.facilityId
  );
  if (!queue || !queue.isActive) {
    throw new Error('Assigned service queue is inactive.');
  }
  if (queue.isPaused) {
    throw new Error(`Queue '${queue.name}' is currently paused. Check-in will resume shortly.`);
  }

  const apptDate = token.appointmentDate || todayIst;
  const dayDiff = diffCalendarDaysIso(apptDate, todayIst);

  if (dayDiff > 0) {
    throw new Error(
      `Check-in is only available on your appointment date (${formatIstDateShort(
        apptDate
      )} IST). Early check-in is not allowed.`
    );
  }
  if (dayDiff < 0) {
    throw new Error(
      `Appointment date (${formatIstDateShort(apptDate)}) has already passed.`
    );
  }

  if (token.checkedIn) {
    const snapshot = getFacilitySnapshot(token.facilityId, now)!;
    return { token: hydrateTokenForCitizen(token, now), snapshot };
  }

  const windowBeforeMins = db.settings.checkInWindowBeforeMins ?? 120;
  const slotMins = token.appointmentSlot ? parseSlotToMinutesOfDay(token.appointmentSlot) : null;
  if (slotMins !== null) {
    const { hour, minute } = getIstHourMinute(now);
    const nowMins = hour * 60 + minute;
    if (slotMins - nowMins > windowBeforeMins) {
      throw new Error(
        `Check-in window for ${token.appointmentSlot} opens at ${formatMinutesAsTime12(
          slotMins - windowBeforeMins
        )} IST.`
      );
    }
  }

  const nowTime = getIstTimeFormatted(now);
  token.checkedIn = true;
  token.checkedInAt = nowTime;
  token.checkedInAtMs = now.getTime();

  const assignedCounter =
    db.counters.find(
      (c) => c.facilityId === token.facilityId && c.queueId === queue.id && c.status !== 'Closed'
    ) || db.counters.find((c) => c.facilityId === token.facilityId && c.queueId === queue.id);
  if (assignedCounter && !token.counterId) {
    token.counterId = assignedCounter.id;
    token.assignedOperatorId = assignedCounter.assignedOperatorId;
  }

  db.metrics.processedDelta += 1;

  pushNotification({
    facilityId: token.facilityId,
    userId: token.userId,
    tokenId: token.tokenId,
    title: `Check-In Successful · ${token.tokenId}`,
    message: `You are now checked in to ${queue.name} (${queue.location}). Live waiting time is active.`,
    category: 'token',
  });

  if (params.actor) {
    recordAuditLog({
      actor: params.actor,
      action: 'TOKEN_QR_CHECKED_IN',
      targetType: 'token',
      targetId: token.tokenId,
      facilityId: token.facilityId,
      details: `Verified QR check-in for ${token.tokenId} in ${queue.name} (${apptDate}).`,
    });
  }

  dbStore.save();
  const snapshot = getFacilitySnapshot(token.facilityId, now)!;
  return { token: hydrateTokenForCitizen(token, now), snapshot };
}

export function cancelToken(
  facilityId: string,
  tokenId: string,
  actor?: { id: string; role: UserRole; name: string },
  now: Date = new Date()
): FacilitySnapshot {
  const db = dbStore.getState();
  const token = db.tokens.find(
    (t) => t.facilityId === facilityId && t.tokenId === tokenId
  );
  if (!token) {
    throw new Error(`Token '${tokenId}' not found.`);
  }
  if (actor && actor.role === 'citizen' && token.userId && token.userId !== actor.id) {
    throw new Error('You can only cancel your own queue token.');
  }
  if (!['Waiting', 'Called', 'Grace'].includes(token.status)) {
    throw new Error(`Cannot cancel token '${tokenId}' in status '${token.status}'.`);
  }

  token.status = 'Cancelled';
  token.cancelledAt = getIstTimeFormatted(now);

  for (const cnt of db.counters) {
    if (cnt.facilityId === facilityId && cnt.currentToken === token.tokenId) {
      cnt.currentToken = '—';
    }
  }

  pushNotification({
    facilityId,
    userId: token.userId,
    tokenId: token.tokenId,
    title: `Token ${token.tokenId} Cancelled`,
    message: `Your appointment in ${token.queueName} was cancelled and queue capacity has been released.`,
    category: 'token',
  });

  if (actor && actor.role !== 'citizen') {
    recordAuditLog({
      actor,
      action: 'TOKEN_CANCELLED',
      targetType: 'token',
      targetId: tokenId,
      facilityId,
      details: `Cancelled token ${tokenId} in ${token.queueName}.`,
    });
  }

  dbStore.save();
  return getFacilitySnapshot(facilityId, now)!;
}

function promoteNextCheckedInToken(params: {
  facilityId: string;
  queue: ServiceQueueRecord;
  counter: CounterRecord;
  actor?: ActorInfo;
  now: Date;
}): TokenRecord | null {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(params.now);
  const nowTime = getIstTimeFormatted(params.now);

  const candidates = db.tokens
    .filter(
      (t) =>
        t.facilityId === params.facilityId &&
        t.queueId === params.queue.id &&
        (t.appointmentDate || todayIst) === todayIst &&
        (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
        t.status === 'Waiting'
    )
    .slice()
    .sort(compareActiveTokens);

  if (candidates.length === 0) {
    params.counter.currentToken = '—';
    return null;
  }

  const nextToken = candidates[0];
  params.queue.servingNumber = nextToken.numberValue;
  nextToken.status = 'Called';
  nextToken.calledAt = nowTime;
  nextToken.counterId = params.counter.id;
  nextToken.assignedOperatorId = params.actor?.id || params.counter.assignedOperatorId;
  params.counter.currentToken = nextToken.tokenId;

  pushNotification({
    facilityId: params.facilityId,
    userId: nextToken.userId,
    tokenId: nextToken.tokenId,
    title: `Token ${nextToken.tokenId} Called`,
    message: `${params.counter.label} (${params.counter.staffName}) is calling token ${nextToken.tokenId} at ${params.queue.location}.`,
    category: 'turn',
  });

  // Notify approaching checked-in tokens (1-2 positions behind)
  const approaching = candidates.slice(1, 3);
  for (let i = 0; i < approaching.length; i += 1) {
    const appTok = approaching[i];
    const ahead = i + 1;
    pushNotification({
      facilityId: params.facilityId,
      userId: appTok.userId,
      tokenId: appTok.tokenId,
      title: `Turn Approaching · ${appTok.tokenId}`,
      message: `${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you at ${
        params.queue.location
      }. Please walk toward ${params.counter.label}.`,
      category: 'turn',
    });
  }

  return nextToken;
}

export function callNextAtCounter(
  facilityId: string,
  counterId: string,
  actor?: ActorInfo,
  now: Date = new Date()
): {
  calledTokenId: string;
  queueId: string;
  snapshot: FacilitySnapshot;
} {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(now);
  const counter = db.counters.find(
    (c) => c.facilityId === facilityId && c.id === counterId
  );
  if (!counter) {
    throw new Error(`Counter '${counterId}' not found.`);
  }
  if (counter.status === 'Closed') {
    throw new Error(`Counter '${counter.label}' is closed.`);
  }
  if (counter.status === 'Paused') {
    throw new Error(`Counter '${counter.label}' is paused. Resume counter before calling next.`);
  }

  const queue = db.queues.find(
    (q) => q.facilityId === facilityId && q.id === counter.queueId
  );
  if (!queue) {
    throw new Error(`Assigned queue '${counter.queueId}' not found.`);
  }
  if (queue.isPaused) {
    throw new Error(`Queue '${queue.name}' is currently paused.`);
  }

  const nowTime = getIstTimeFormatted(now);

  // Complete any currently Serving/Called token assigned to this counter on today's IST date
  for (const t of db.tokens) {
    if (
      t.facilityId === facilityId &&
      t.queueId === queue.id &&
      (t.appointmentDate || todayIst) === todayIst &&
      (t.status === 'Serving' || t.status === 'Called') &&
      (!t.counterId || t.counterId === counter.id)
    ) {
      t.status = 'Completed';
      t.completedAt = nowTime;
      t.completedAtMs = now.getTime();
      t.actualServiceMinutes = Math.max(
        1,
        Math.round(
          (now.getTime() - (t.servingStartedAtMs || t.checkedInAtMs || t.createdAtMs)) / 60000
        )
      );
    }
  }

  const promoted = promoteNextCheckedInToken({
    facilityId,
    queue,
    counter,
    actor,
    now,
  });

  if (!promoted) {
    throw new Error(`No checked-in waiting patients left in ${queue.name} for today (${todayIst}).`);
  }

  counter.status = 'Serving';
  db.metrics.processedDelta += 1;

  if (actor) {
    recordAuditLog({
      actor,
      action: 'TOKEN_CALLED',
      targetType: 'token',
      targetId: promoted.tokenId,
      facilityId,
      details: `Called ${promoted.tokenId} at ${counter.label} (${queue.name}).`,
    });
  }

  dbStore.save();

  return {
    calledTokenId: promoted.tokenId,
    queueId: queue.id,
    snapshot: getFacilitySnapshot(facilityId, now)!,
  };
}

export function transitionTokenAtCounter(
  params: {
    facilityId: string;
    counterId: string;
    tokenId: string;
    action: 'recall' | 'serve' | 'complete' | 'skip' | 'no-show';
    actor: ActorInfo;
  },
  now: Date = new Date()
): { token: TokenRecord; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const todayIst = getIstDateIso(now);
  const counter = db.counters.find(
    (c) => c.facilityId === params.facilityId && c.id === params.counterId
  );
  if (!counter) {
    throw new Error('Counter not found in this facility.');
  }

  const token = db.tokens.find(
    (t) => t.facilityId === params.facilityId && t.tokenId === params.tokenId
  );
  if (!token) {
    throw new Error(`Token '${params.tokenId}' not found.`);
  }

  const queue = db.queues.find(
    (q) => q.facilityId === params.facilityId && q.id === token.queueId
  );
  const nowTime = getIstTimeFormatted(now);

  switch (params.action) {
    case 'recall': {
      if (!['Called', 'Grace', 'Serving'].includes(token.status)) {
        throw new Error(`Cannot recall token in status '${token.status}'.`);
      }
      token.recallCount = (token.recallCount || 0) + 1;
      token.calledAt = nowTime;
      pushNotification({
        facilityId: params.facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Recall Alert · ${token.tokenId}`,
        message: `Please proceed immediately to ${counter.label} (${token.queueName}).`,
        category: 'turn',
      });
      recordAuditLog({
        actor: params.actor,
        action: 'TOKEN_RECALLED',
        targetType: 'token',
        targetId: token.tokenId,
        facilityId: params.facilityId,
        details: `Recalled ${token.tokenId} at ${counter.label} (attempt #${token.recallCount}).`,
      });
      break;
    }

    case 'serve': {
      if ((token.appointmentDate || todayIst) !== todayIst || !token.checkedIn) {
        throw new Error('Only checked-in patients scheduled for today can be served.');
      }
      if (!['Waiting', 'Called', 'Grace'].includes(token.status)) {
        throw new Error(`Cannot start serving token in status '${token.status}'.`);
      }
      // Complete any other token currently Serving on this counter
      for (const other of db.tokens) {
        if (
          other.facilityId === params.facilityId &&
          other.counterId === counter.id &&
          other.tokenId !== token.tokenId &&
          other.status === 'Serving'
        ) {
          other.status = 'Completed';
          other.completedAt = nowTime;
          other.completedAtMs = now.getTime();
          other.actualServiceMinutes = Math.max(
            1,
            Math.round(
              (now.getTime() - (other.servingStartedAtMs || other.checkedInAtMs || other.createdAtMs)) /
                60000
            )
          );
        }
      }
      token.status = 'Serving';
      token.servingStartedAt = nowTime;
      token.servingStartedAtMs = now.getTime();
      token.counterId = counter.id;
      token.assignedOperatorId = params.actor.id;
      counter.currentToken = token.tokenId;
      counter.status = 'Serving';

      if (queue && token.numberValue > queue.servingNumber) {
        queue.servingNumber = token.numberValue;
      }

      pushNotification({
        facilityId: params.facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Service Started · ${token.tokenId}`,
        message: `Counter ${counter.label} is now serving your token ${token.tokenId}.`,
        category: 'turn',
      });
      recordAuditLog({
        actor: params.actor,
        action: 'TOKEN_SERVING_STARTED',
        targetType: 'token',
        targetId: token.tokenId,
        facilityId: params.facilityId,
        details: `Started serving ${token.tokenId} at ${counter.label}.`,
      });
      break;
    }

    case 'complete': {
      if (!['Called', 'Serving', 'Grace'].includes(token.status)) {
        throw new Error(`Cannot complete token in status '${token.status}'.`);
      }
      token.status = 'Completed';
      token.completedAt = nowTime;
      token.completedAtMs = now.getTime();
      token.actualServiceMinutes = Math.max(
        1,
        Math.round(
          (now.getTime() - (token.servingStartedAtMs || token.checkedInAtMs || token.createdAtMs)) /
            60000
        )
      );
      token.counterId = counter.id;
      token.assignedOperatorId = params.actor.id;
      db.metrics.processedDelta += 1;

      pushNotification({
        facilityId: params.facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Service Completed · ${token.tokenId}`,
        message: `Your visit for ${token.queueName} at ${counter.label} completed in ${token.actualServiceMinutes} min.`,
        category: 'token',
      });
      recordAuditLog({
        actor: params.actor,
        action: 'TOKEN_COMPLETED',
        targetType: 'token',
        targetId: token.tokenId,
        facilityId: params.facilityId,
        details: `Completed service for ${token.tokenId} at ${counter.label} (${token.actualServiceMinutes}m).`,
      });

      if (
        db.settings.autoAdvanceOnComplete !== false &&
        queue &&
        !queue.isPaused &&
        (counter.status === 'Serving' || counter.status === 'Busy')
      ) {
        promoteNextCheckedInToken({
          facilityId: params.facilityId,
          queue,
          counter,
          actor: params.actor,
          now,
        });
      } else if (counter.currentToken === token.tokenId) {
        counter.currentToken = '—';
      }
      break;
    }

    case 'skip': {
      if (!['Waiting', 'Called', 'Grace'].includes(token.status)) {
        throw new Error(`Cannot skip token in status '${token.status}'.`);
      }
      token.status = 'Skipped';
      token.completedAt = nowTime;
      token.completedAtMs = now.getTime();
      pushNotification({
        facilityId: params.facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Token ${token.tokenId} Skipped`,
        message: `Your token was skipped at ${counter.label}. Contact desk if you need assistance.`,
        category: 'grace',
      });
      recordAuditLog({
        actor: params.actor,
        action: 'TOKEN_SKIPPED',
        targetType: 'token',
        targetId: token.tokenId,
        facilityId: params.facilityId,
        details: `Skipped ${token.tokenId} at ${counter.label}.`,
      });
      if (
        db.settings.autoAdvanceOnComplete !== false &&
        queue &&
        !queue.isPaused &&
        counter.currentToken === token.tokenId &&
        (counter.status === 'Serving' || counter.status === 'Busy')
      ) {
        promoteNextCheckedInToken({
          facilityId: params.facilityId,
          queue,
          counter,
          actor: params.actor,
          now,
        });
      } else if (counter.currentToken === token.tokenId) {
        counter.currentToken = '—';
      }
      break;
    }

    case 'no-show': {
      if (!['Waiting', 'Called', 'Grace'].includes(token.status)) {
        throw new Error(`Cannot mark no-show for token in status '${token.status}'.`);
      }
      token.status = 'NoShow';
      token.completedAt = nowTime;
      token.completedAtMs = now.getTime();
      pushNotification({
        facilityId: params.facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Missed Turn · ${token.tokenId}`,
        message: `Token ${token.tokenId} was marked as No Show at ${counter.label}.`,
        category: 'grace',
      });
      recordAuditLog({
        actor: params.actor,
        action: 'TOKEN_NO_SHOW',
        targetType: 'token',
        targetId: token.tokenId,
        facilityId: params.facilityId,
        details: `Marked ${token.tokenId} as No Show at ${counter.label}.`,
      });
      if (
        db.settings.autoAdvanceOnComplete !== false &&
        queue &&
        !queue.isPaused &&
        counter.currentToken === token.tokenId &&
        (counter.status === 'Serving' || counter.status === 'Busy')
      ) {
        promoteNextCheckedInToken({
          facilityId: params.facilityId,
          queue,
          counter,
          actor: params.actor,
          now,
        });
      } else if (counter.currentToken === token.tokenId) {
        counter.currentToken = '—';
      }
      break;
    }
  }

  dbStore.save();
  return {
    token,
    snapshot: getFacilitySnapshot(params.facilityId, now)!,
  };
}

export function createSwapRequest(params: {
  facilityId: string;
  tokenId: string;
  reason?: string;
}): { swap: SwapRequestRecord; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  if (!db.settings.allowPeerSwaps) {
    throw new Error('Peer token swaps are currently disabled by system settings.');
  }
  const todayIst = getIstDateIso();
  const token = db.tokens.find(
    (t) =>
      t.facilityId === params.facilityId &&
      t.tokenId === params.tokenId &&
      (t.appointmentDate || todayIst) === todayIst &&
      (typeof t.checkedIn === 'boolean' ? t.checkedIn : true)
  );
  if (!token) {
    throw new Error(`Checked-in active token '${params.tokenId}' for today not found.`);
  }

  const existingOpen = db.swaps.find(
    (s) =>
      s.facilityId === params.facilityId &&
      s.fromTokenId === token.tokenId &&
      s.status === 'open'
  );
  if (existingOpen) {
    return { swap: existingOpen, snapshot: getFacilitySnapshot(params.facilityId)! };
  }

  const swap: SwapRequestRecord = {
    id: `swap-${crypto.randomUUID().slice(0, 6)}`,
    facilityId: params.facilityId,
    queueId: token.queueId,
    fromTokenId: token.tokenId,
    fromCitizenName: token.citizenName,
    fromNumber: token.numberValue,
    reason: params.reason?.trim() || 'Willing to trade turns fairly',
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  db.swaps.push(swap);
  dbStore.save();
  return { swap, snapshot: getFacilitySnapshot(params.facilityId)! };
}

export function acceptSwapRequest(params: {
  facilityId: string;
  swapId: string;
  targetTokenId: string;
  userId?: string;
}): {
  updatedTokenId: string;
  updatedNumber: number;
  trustScore: number;
  snapshot: FacilitySnapshot;
} {
  const db = dbStore.getState();
  const swap = db.swaps.find(
    (s) => s.facilityId === params.facilityId && s.id === params.swapId && s.status === 'open'
  );
  if (!swap) {
    throw new Error('Swap request is no longer available.');
  }

  const callerToken = db.tokens.find(
    (t) =>
      t.facilityId === params.facilityId &&
      t.tokenId === params.targetTokenId &&
      t.queueId === swap.queueId &&
      (typeof t.checkedIn === 'boolean' ? t.checkedIn : true)
  );
  if (!callerToken) {
    throw new Error('Your checked-in active token is not eligible for this queue swap.');
  }

  const peerToken = db.tokens.find(
    (t) => t.facilityId === params.facilityId && t.tokenId === swap.fromTokenId
  );

  const oldCallerNumber = callerToken.numberValue;
  const oldCallerId = callerToken.tokenId;
  const newCallerNumber = swap.fromNumber;
  const newCallerId = swap.fromTokenId;

  callerToken.numberValue = newCallerNumber;
  callerToken.tokenId = newCallerId;

  if (peerToken) {
    peerToken.numberValue = oldCallerNumber;
    peerToken.tokenId = oldCallerId;
  }

  swap.status = 'accepted';
  swap.acceptedByTokenId = oldCallerId;

  let trustScore = 118;
  if (params.userId) {
    const user = db.users.find((u) => u.id === params.userId);
    if (user) {
      user.trustScore += 20;
      trustScore = user.trustScore;
    }
  }

  pushNotification({
    facilityId: params.facilityId,
    userId: params.userId,
    tokenId: newCallerId,
    title: `Swap Confirmed · ${newCallerId}`,
    message: `Traded ${oldCallerId} for ${newCallerId}. +20 Civic Trust points credited.`,
    category: 'swap',
  });

  dbStore.save();
  return {
    updatedTokenId: newCallerId,
    updatedNumber: newCallerNumber,
    trustScore,
    snapshot: getFacilitySnapshot(params.facilityId)!,
  };
}

export function activateGraceSlot(
  facilityId: string,
  tokenId: string
): { graceExpiresAt: string; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const token = db.tokens.find(
    (t) => t.facilityId === facilityId && t.tokenId === tokenId
  );
  if (!token) {
    throw new Error(`Token '${tokenId}' not found.`);
  }
  const graceMinutes = Math.max(1, db.settings.gracePeriodMinutes || 5);
  const graceExpiresAt = new Date(Date.now() + graceMinutes * 60 * 1000).toISOString();
  token.status = 'Grace';
  token.graceExpiresAt = graceExpiresAt;
  pushNotification({
    facilityId,
    userId: token.userId,
    tokenId,
    title: `${graceMinutes}-Minute Grace Window Active`,
    message: `Token ${tokenId} was called. Check in within ${graceMinutes} minutes to keep your slot.`,
    category: 'grace',
  });
  dbStore.save();

  return {
    graceExpiresAt,
    snapshot: getFacilitySnapshot(facilityId)!,
  };
}

export function checkInGraceSlot(
  facilityId: string,
  tokenId: string,
  userId?: string,
  now: Date = new Date()
): { trustScore: number; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const token = db.tokens.find(
    (t) => t.facilityId === facilityId && t.tokenId === tokenId
  );
  if (!token) {
    throw new Error(`Token '${tokenId}' not found.`);
  }
  const nowTime = getIstTimeFormatted(now);
  token.status = 'Serving';
  token.checkedIn = true;
  token.checkedInAt = token.checkedInAt || nowTime;
  token.checkedInAtMs = token.checkedInAtMs || now.getTime();
  token.servingStartedAt = nowTime;
  token.servingStartedAtMs = now.getTime();
  token.graceExpiresAt = undefined;

  let trustScore = 103;
  if (userId) {
    const user = db.users.find((u) => u.id === userId);
    if (user) {
      user.trustScore += 5;
      trustScore = user.trustScore;
    }
  }

  dbStore.save();
  return {
    trustScore,
    snapshot: getFacilitySnapshot(facilityId, now)!,
  };
}

function parseHourLabelTo24(label: string): number {
  const m = label.trim().match(/^(\d{1,2})\s*(AM|PM)$/i);
  if (!m) return 10;
  let hr = Number(m[1]);
  const meridiem = m[2].toUpperCase();
  if (meridiem === 'PM' && hr < 12) hr += 12;
  if (meridiem === 'AM' && hr === 12) hr = 0;
  return hr;
}

function getTokenHour24(token: TokenRecord): number {
  if (token.joinedAt) {
    const m = token.joinedAt.trim().match(/^(\d{1,2})(?::\d{2})?\s*(AM|PM)$/i);
    if (m) {
      let hr = Number(m[1]);
      const mer = m[2].toUpperCase();
      if (mer === 'PM' && hr < 12) hr += 12;
      if (mer === 'AM' && hr === 12) hr = 0;
      return hr;
    }
  }
  return getIstHourMinute(new Date(token.createdAtMs || Date.now())).hour;
}

export type CrowdLevel = 'Low' | 'Medium' | 'High';

export function classifyCrowdLevel(waitingCount: number, predictedWaitMins: number, threshold = 5): CrowdLevel {
  if (waitingCount >= threshold || predictedWaitMins >= 15) return 'High';
  if (waitingCount >= Math.max(2, Math.ceil(threshold * 0.6)) || predictedWaitMins >= 8) return 'Medium';
  return 'Low';
}

export interface OrganisationAnalyticsDashboard {
  facilityId: string;
  facilityName: string;
  period: 'daily' | 'weekly' | 'monthly';
  surgeThreshold: number;
  overviewCards: {
    peopleInQueue: number;
    avgServiceTimeMins: number;
    avgWaitTimeMins: number;
    activeCounters: number;
    totalCounters: number;
    onTimeServiceRate: number;
    visitorsServedToday: number;
  };
  visitorStats: {
    dailyVisitors: number;
    weeklyVisitors: number;
    monthlyVisitors: number;
    busiestHour: string;
    busiestHourVisitors: number;
    peakAvgWaitMins: number;
    nonPeakAvgWaitMins: number;
    peakHours: string[];
    recommendedHours: string[];
  };
  hourlyFootfall: Array<{
    hour: string;
    hour24: number;
    footfall: number;
    liveTokensCount: number;
    avgWaitMins: number;
    isPeak: boolean;
    isRecommended: boolean;
    crowdLevel: CrowdLevel;
  }>;
  upcomingBusyHours: Array<{
    hour: string;
    expectedVisitors: number;
    predictedWaitMins: number;
    crowdLevel: CrowdLevel;
    confidence: number;
    suggestedAction: string;
  }>;
  surgeAlerts: Array<{
    id: string;
    facilityId: string;
    facilityName: string;
    queueId: string;
    queueName: string;
    departmentName: string;
    title: string;
    waitingCount: number;
    threshold: number;
    predictedWaitMins: number;
    recommendation: string;
    standbyCounterId: string | null;
    standbyCounterLabel: string | null;
    standbyStaffName: string | null;
  }>;
  counters: Array<{
    id: string;
    facilityId: string;
    facilityName: string;
    departmentId: string;
    departmentName: string;
    queueId: string;
    queueName: string;
    label: string;
    staffName: string;
    assignedOperatorId?: string;
    status: CounterRecord['status'];
    currentToken: string;
    queueLength: number;
    estimatedWaitMins: number;
    avgCycleMins: number;
  }>;
  queuePredictions: Array<{
    queueId: string;
    queueName: string;
    facilityId: string;
    facilityName: string;
    departmentName: string;
    waitingCount: number;
    activeCounters: number;
    avgServiceMinutes: number;
    predictedWaitMins: number;
    crowdLevel: CrowdLevel;
    approachingThreshold: boolean;
    overThreshold: boolean;
    confidence: number;
    suggestedAction: string;
    suggestedCounterId: string | null;
  }>;
  sustainabilityImpact: {
    estimatedTimeSavedMinutes: number;
    estimatedTimeSavedHours: number;
    physicalWaitReductionPct: number;
    digitalTokensServed: number;
    estimatedCrowdReductionPct: number;
    corridorVisitorsAvoided: number;
    sdg9InfraCalls: number;
    sdg12PaperSlipsSaved: number;
  };
  operators: Array<{
    id: string;
    name: string;
    assignedFacilityId?: string;
    assignedCounterId?: string;
  }>;
  availableQueues: Array<{
    id: string;
    facilityId: string;
    facilityName: string;
    departmentId: string;
    name: string;
  }>;
}

export function getOrganisationAnalyticsDashboard(params: {
  facilityId?: string;
  period?: 'daily' | 'weekly' | 'monthly';
  surgeThreshold?: number;
} = {}): OrganisationAnalyticsDashboard | null {
  const db = dbStore.getState();
  const scopeId = params.facilityId && params.facilityId !== 'all' ? params.facilityId : 'all';
  const period: 'daily' | 'weekly' | 'monthly' =
    params.period === 'weekly' || params.period === 'monthly' ? params.period : 'daily';
  const surgeThreshold = Math.max(3, Math.min(30, Number(params.surgeThreshold) || 5));

  const targetFacilities =
    scopeId === 'all'
      ? db.facilities
      : db.facilities.filter((f) => f.id === scopeId);
  if (targetFacilities.length === 0) return null;

  const facilityIds = new Set(targetFacilities.map((f) => f.id));
  const scopedQueues = db.queues.filter((q) => facilityIds.has(q.facilityId) && q.isActive);
  const scopedCounters = db.counters.filter((c) => facilityIds.has(c.facilityId));
  const scopedTokens = db.tokens.filter((t) => facilityIds.has(t.facilityId));

  // Build hydrated snapshots per facility
  const facilitySnapshots = targetFacilities
    .map((f) => ({ facility: f, snapshot: getFacilitySnapshot(f.id) }))
    .filter((item): item is { facility: typeof targetFacilities[number]; snapshot: FacilitySnapshot } =>
      Boolean(item.snapshot)
    );

  const allHydratedQueues = facilitySnapshots.flatMap(({ facility, snapshot }) =>
    snapshot.queues.map((q) => ({ ...q, facilityName: facility.name }))
  );

  const peopleInQueue = allHydratedQueues.reduce((sum, q) => sum + q.waitingCount, 0);
  const activeCounters = scopedCounters.filter(
    (c) => c.status === 'Serving' || c.status === 'Busy'
  ).length;
  const totalCounters = scopedCounters.length;

  const avgServiceTimeMins =
    allHydratedQueues.length > 0
      ? Number(
          (
            allHydratedQueues.reduce((sum, q) => sum + q.avgServiceMinutes, 0) /
            allHydratedQueues.length
          ).toFixed(1)
        )
      : 4;

  const avgWaitTimeMins =
    allHydratedQueues.length > 0
      ? Math.round(
          allHydratedQueues.reduce((sum, q) => sum + q.predictedWaitMins, 0) /
            allHydratedQueues.length
        )
      : 0;

  // Baseline served today from servingNumber counters + live completed tokens + processedDelta
  const servedFromQueueSequence = scopedQueues.reduce(
    (sum, q) => sum + Math.max(0, q.servingNumber - 1),
    0
  );
  const completedTokensInStore = scopedTokens.filter((t) => t.status === 'Completed').length;
  const cancelledOrNoShow = scopedTokens.filter(
    (t) => t.status === 'NoShow' || t.status === 'Skipped'
  ).length;
  const visitorsServedToday = Math.max(
    completedTokensInStore,
    servedFromQueueSequence + completedTokensInStore + Math.floor(db.metrics.processedDelta / 2)
  );

  // Dynamic hourly footfall combining historical baseline + live tokens in store
  const hourBuckets = new Map<
    string,
    { hour: string; hour24: number; baseFootfall: number; baseWaitSum: number; count: number }
  >();

  for (const fac of targetFacilities) {
    const series = db.hourlyTraffic[fac.id] || [];
    for (const pt of series) {
      const hr24 = parseHourLabelTo24(pt.hour);
      const existing = hourBuckets.get(pt.hour);
      if (existing) {
        existing.baseFootfall += pt.footfall;
        existing.baseWaitSum += pt.avgWaitMins;
        existing.count += 1;
      } else {
        hourBuckets.set(pt.hour, {
          hour: pt.hour,
          hour24: hr24,
          baseFootfall: pt.footfall,
          baseWaitSum: pt.avgWaitMins,
          count: 1,
        });
      }
    }
  }

  // Fold live token creation counts per hour bucket & active waiting pressure into current/peak slots
  const liveTokensByHour = new Map<number, number>();
  for (const tok of scopedTokens) {
    const hr24 = getTokenHour24(tok);
    liveTokensByHour.set(hr24, (liveTokensByHour.get(hr24) || 0) + 1);
  }

  // Capacity relief when standby counters are opened
  const capacityRatio =
    totalCounters > 0 ? activeCounters / Math.max(1, totalCounters) : 1;
  const waitCapacityFactor = Math.max(0.65, Math.min(1.25, 1.15 - (capacityRatio - 0.65) * 0.65));

  const periodScale = period === 'monthly' ? 26 : period === 'weekly' ? 7 : 1;
  const sortedBuckets = Array.from(hourBuckets.values()).sort((a, b) => a.hour24 - b.hour24);

  const rawDailyHourly = sortedBuckets.map((b) => {
    const liveInHour = liveTokensByHour.get(b.hour24) || 0;
    const dailyFootfall = b.baseFootfall + liveInHour;
    const baseWait = b.count > 0 ? b.baseWaitSum / b.count : 10;
    const adjustedWait = Math.max(
      2,
      Math.round(baseWait * waitCapacityFactor + Math.min(6, liveInHour * 0.4))
    );
    return {
      hour: b.hour,
      hour24: b.hour24,
      dailyFootfall,
      liveTokensCount: liveInHour,
      avgWaitMins: adjustedWait,
    };
  });

  const maxDailyFootfall = Math.max(1, ...rawDailyHourly.map((h) => h.dailyFootfall));
  const peakCutoff = Math.max(55 * targetFacilities.length, Math.round(maxDailyFootfall * 0.72));
  const recCutoff = Math.round(maxDailyFootfall * 0.48);

  const hourlyFootfall = rawDailyHourly.map((h, idx) => {
    const isPeak = h.dailyFootfall >= peakCutoff;
    const isRecommended = !isPeak && h.dailyFootfall <= recCutoff;
    // Slight deterministic weekly/monthly day-pattern adjustment so charts stay informative
    const periodVariance =
      period === 'daily' ? 1 : period === 'weekly' ? 0.94 + ((idx % 3) * 0.05) : 0.96 + ((idx % 4) * 0.03);
    const scaledFootfall = Math.round(h.dailyFootfall * periodScale * periodVariance);
    const crowdLevel: CrowdLevel = isPeak
      ? 'High'
      : h.dailyFootfall >= Math.round(peakCutoff * 0.68)
        ? 'Medium'
        : 'Low';
    return {
      hour: h.hour,
      hour24: h.hour24,
      footfall: scaledFootfall,
      liveTokensCount: h.liveTokensCount,
      avgWaitMins: h.avgWaitMins,
      isPeak,
      isRecommended,
      crowdLevel,
    };
  });

  const dailyVisitors =
    rawDailyHourly.reduce((sum, h) => sum + h.dailyFootfall, 0) +
    Math.max(0, peopleInQueue - 5);
  const weeklyVisitors = Math.round(dailyVisitors * 6.85);
  const monthlyVisitors = Math.round(dailyVisitors * 26.2);

  const busiestSlot = hourlyFootfall.reduce(
    (best, cur) => (cur.footfall > best.footfall ? cur : best),
    hourlyFootfall[0] || { hour: '11 AM', footfall: 0, avgWaitMins: 0 }
  );

  const peakSlots = hourlyFootfall.filter((h) => h.isPeak);
  const nonPeakSlots = hourlyFootfall.filter((h) => !h.isPeak);
  const peakAvgWaitMins =
    peakSlots.length > 0
      ? Math.round(peakSlots.reduce((s, p) => s + p.avgWaitMins, 0) / peakSlots.length)
      : avgWaitTimeMins;
  const nonPeakAvgWaitMins =
    nonPeakSlots.length > 0
      ? Math.round(nonPeakSlots.reduce((s, p) => s + p.avgWaitMins, 0) / nonPeakSlots.length)
      : Math.max(4, Math.round(avgWaitTimeMins * 0.55));

  // Surge alerts across scoped queues
  const surgeAlerts = allHydratedQueues
    .filter((q) => q.waitingCount >= surgeThreshold || q.predictedWaitMins >= 15)
    .map((q) => {
      const facCounters = scopedCounters.filter((c) => c.facilityId === q.facilityId);
      const standby =
        facCounters.find((c) => c.status === 'Closed' && c.queueId === q.id) ||
        facCounters.find((c) => c.status === 'Closed' || c.status === 'Paused');
      const lowLoadCounter = facCounters.find(
        (c) =>
          c.id !== standby?.id &&
          c.queueId !== q.id &&
          (c.status === 'Serving' || c.status === 'Busy')
      );

      const recommendation = standby
        ? `Shift standby desk ${standby.label} (${standby.staffName}) to ${q.name} to cut wait time by ~45%.`
        : lowLoadCounter
          ? `Reassign ${lowLoadCounter.label} (${lowLoadCounter.staffName}) from low-load desk to assist ${q.name}.`
          : `All facility counters active. Open a temporary overflow counter for ${q.name}.`;

      return {
        id: `surge-${q.facilityId}-${q.id}`,
        facilityId: q.facilityId,
        facilityName: q.facilityName,
        queueId: q.id,
        queueName: q.name,
        departmentName: q.departmentName,
        title: `High Crowd Detected – ${q.name}`,
        waitingCount: q.waitingCount,
        threshold: surgeThreshold,
        predictedWaitMins: q.predictedWaitMins,
        recommendation,
        standbyCounterId: standby?.id || null,
        standbyCounterLabel: standby?.label || null,
        standbyStaffName: standby?.staffName || null,
      };
    });

  // Counter Management hydrated list
  const counters = scopedCounters.map((c) => {
    const fac = targetFacilities.find((f) => f.id === c.facilityId);
    const dept = db.departments.find((d) => d.id === c.departmentId);
    const hq = allHydratedQueues.find((q) => q.id === c.queueId && q.facilityId === c.facilityId);
    return {
      id: c.id,
      facilityId: c.facilityId,
      facilityName: fac?.name || c.facilityId,
      departmentId: c.departmentId,
      departmentName: dept?.name || hq?.departmentName || 'General Services',
      queueId: c.queueId,
      queueName: hq?.name || 'General Queue',
      label: c.label,
      staffName: c.staffName,
      assignedOperatorId: c.assignedOperatorId,
      status: c.status,
      currentToken: c.currentToken,
      queueLength: hq?.waitingCount || 0,
      estimatedWaitMins: hq?.isPaused ? 0 : hq?.predictedWaitMins || 0,
      avgCycleMins: c.avgCycleMins,
    };
  });

  // Smart Queue Predictions per queue
  const queuePredictions = allHydratedQueues.map((q) => {
    const crowdLevel = classifyCrowdLevel(q.waitingCount, q.predictedWaitMins, surgeThreshold);
    const overThreshold = q.waitingCount >= surgeThreshold || q.predictedWaitMins >= 15;
    const approachingThreshold =
      !overThreshold &&
      (q.waitingCount >= Math.max(2, surgeThreshold - 2) || q.predictedWaitMins >= 10);

    const standby = scopedCounters.find(
      (c) => c.facilityId === q.facilityId && (c.status === 'Closed' || c.status === 'Paused')
    );
    const nextWaitEstimate =
      q.activeCounters > 0
        ? computeQueueWaitMins(q, q.waitingCount, q.activeCounters + 1) ?? q.predictedWaitMins
        : q.predictedWaitMins;

    let suggestedAction = 'Optimal counter allocation';
    if (overThreshold && standby) {
      suggestedAction = `Open ${standby.label} (${standby.staffName}) to cut wait from ${q.predictedWaitMins}m to ~${nextWaitEstimate}m`;
    } else if (overThreshold) {
      suggestedAction = `High load: add overflow counter or reassign staff to ${q.name}`;
    } else if (approachingThreshold) {
      suggestedAction = `Approaching surge threshold (${q.waitingCount}/${surgeThreshold}); keep standby desk ready`;
    }

    return {
      queueId: q.id,
      queueName: q.name,
      facilityId: q.facilityId,
      facilityName: q.facilityName,
      departmentName: q.departmentName,
      waitingCount: q.waitingCount,
      activeCounters: q.activeCounters,
      avgServiceMinutes: q.avgServiceMinutes,
      predictedWaitMins: q.predictedWaitMins,
      crowdLevel,
      approachingThreshold,
      overThreshold,
      confidence: q.predictionConfidence,
      suggestedAction,
      suggestedCounterId: (overThreshold || approachingThreshold) && standby ? standby.id : null,
    };
  });

  // Upcoming Busy Hours predictions (historical pattern + current queue momentum)
  const currentHour24 = getIstHourMinute(new Date()).hour;
  const upcomingCandidates = hourlyFootfall
    .filter((h) => h.hour24 >= Math.min(14, currentHour24) || h.isPeak)
    .sort((a, b) => b.footfall - a.footfall)
    .slice(0, 4)
    .sort((a, b) => a.hour24 - b.hour24);

  const upcomingBusyHours = upcomingCandidates.map((slot) => {
    const queuePressureBoost = Math.round(peopleInQueue * 0.35);
    const expectedVisitors = slot.footfall + (period === 'daily' ? queuePressureBoost : 0);
    const predictedWaitMins = slot.avgWaitMins + (surgeAlerts.length > 0 ? 3 : 0);
    const crowdLevel: CrowdLevel = slot.isPeak
      ? 'High'
      : predictedWaitMins >= 12
        ? 'Medium'
        : 'Low';
    const suggestedAction =
      crowdLevel === 'High'
        ? 'Open additional standby counter 15 mins prior'
        : crowdLevel === 'Medium'
          ? 'Monitor counter cycle times & enable pre-alerts'
          : 'Normal staffing sufficient · ideal for follow-ups';

    return {
      hour: slot.hour,
      expectedVisitors,
      predictedWaitMins,
      crowdLevel,
      confidence: slot.isPeak ? 94 : 89,
      suggestedAction,
    };
  });

  // On-time SLA calculation
  const baseOnTime = 96;
  const overloadPenalty = surgeAlerts.length * 2;
  const skipPenalty = Math.min(6, cancelledOrNoShow);
  const counterBonus = activeCounters >= totalCounters && totalCounters > 0 ? 2 : 0;
  const onTimeServiceRate = Math.max(
    78,
    Math.min(99, baseOnTime - overloadPenalty - skipPenalty + counterBonus)
  );

  // Sustainability & Social Impact
  const digitalTokensServed =
    db.metrics.basePaperSlipsSaved + db.metrics.processedDelta + completedTokensInStore;
  const avgMinsSavedPerVisitor = Math.max(12, Math.round(peakAvgWaitMins * 0.72));
  const estimatedTimeSavedMinutes =
    (visitorsServedToday + peopleInQueue) * avgMinsSavedPerVisitor +
    Math.round(db.metrics.processedDelta * 14);
  const estimatedTimeSavedHours = Math.round(estimatedTimeSavedMinutes / 60);
  const standbyOpenedCount = scopedCounters.filter(
    (c) => c.id === 'c3' && (c.status === 'Serving' || c.status === 'Busy')
  ).length;
  const physicalWaitReductionPct = Math.min(
    62,
    41 + standbyOpenedCount * 5 + Math.min(8, Math.floor(db.metrics.processedDelta / 2))
  );
  const estimatedCrowdReductionPct = Math.min(58, 36 + standbyOpenedCount * 6 + activeCounters);
  const corridorVisitorsAvoided = Math.round(
    (visitorsServedToday + peopleInQueue) * (estimatedCrowdReductionPct / 100) +
      db.metrics.processedDelta
  );

  return {
    facilityId: scopeId,
    facilityName:
      scopeId === 'all'
        ? 'All Organisation Service Centers'
        : targetFacilities[0].name,
    period,
    surgeThreshold,
    overviewCards: {
      peopleInQueue,
      avgServiceTimeMins,
      avgWaitTimeMins,
      activeCounters,
      totalCounters,
      onTimeServiceRate,
      visitorsServedToday,
    },
    visitorStats: {
      dailyVisitors,
      weeklyVisitors,
      monthlyVisitors,
      busiestHour: busiestSlot.hour,
      busiestHourVisitors: busiestSlot.footfall,
      peakAvgWaitMins,
      nonPeakAvgWaitMins,
      peakHours: peakSlots.map((p) => p.hour),
      recommendedHours: hourlyFootfall.filter((h) => h.isRecommended).map((h) => h.hour),
    },
    hourlyFootfall,
    upcomingBusyHours,
    surgeAlerts,
    counters,
    queuePredictions,
    sustainabilityImpact: {
      estimatedTimeSavedMinutes,
      estimatedTimeSavedHours,
      physicalWaitReductionPct,
      digitalTokensServed,
      estimatedCrowdReductionPct,
      corridorVisitorsAvoided,
      sdg9InfraCalls: db.metrics.baseInfraCalls + db.metrics.processedDelta,
      sdg12PaperSlipsSaved: digitalTokensServed,
    },
    operators: db.users
      .filter((u) => u.role === 'operator' && u.accountStatus === 'active')
      .map((u) => ({
        id: u.id,
        name: u.name,
        assignedFacilityId: u.assignedFacilityId,
        assignedCounterId: u.assignedCounterId,
      })),
    availableQueues: scopedQueues.map((q) => ({
      id: q.id,
      facilityId: q.facilityId,
      facilityName: targetFacilities.find((f) => f.id === q.facilityId)?.name || q.facilityId,
      departmentId: q.departmentId,
      name: q.name,
    })),
  };
}

export function reallocateCounterStaff(params: {
  counterId: string;
  targetQueueId?: string;
  operatorId?: string;
  staffName?: string;
  status?: CounterRecord['status'];
  actor: ActorInfo;
}): { counter: CounterRecord; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const counter = db.counters.find((c) => c.id === params.counterId);
  if (!counter) {
    throw new Error(`Counter '${params.counterId}' not found.`);
  }

  if (params.targetQueueId) {
    const q = db.queues.find(
      (fq) => fq.id === params.targetQueueId && fq.facilityId === counter.facilityId
    );
    if (!q) {
      throw new Error('Target service queue not found in the same facility.');
    }
    counter.queueId = q.id;
    counter.departmentId = q.departmentId;
    counter.avgCycleMins = q.avgServiceMinutes;
    counter.currentToken = `${q.prefix}-${q.servingNumber}`;
  }

  if (params.operatorId !== undefined) {
    const op = params.operatorId
      ? db.users.find((u) => u.id === params.operatorId && u.role === 'operator')
      : undefined;
    if (op) {
      counter.assignedOperatorId = op.id;
      counter.staffName = op.name;
      op.assignedFacilityId = counter.facilityId;
      op.assignedDepartmentId = counter.departmentId;
      op.assignedCounterId = counter.id;
    } else if (params.staffName?.trim()) {
      counter.assignedOperatorId = undefined;
      counter.staffName = params.staffName.trim();
    }
  } else if (params.staffName?.trim()) {
    counter.staffName = params.staffName.trim();
  }

  counter.status = params.status || 'Serving';

  const queueObj = db.queues.find((q) => q.id === counter.queueId);
  recordAuditLog({
    actor: params.actor,
    action: 'STAFF_REALLOCATED',
    targetType: 'counter',
    targetId: counter.id,
    facilityId: counter.facilityId,
    details: `Reallocated ${counter.label} (${counter.staffName}) to ${queueObj?.name || counter.queueId} as ${counter.status}.`,
  });

  pushNotification({
    facilityId: counter.facilityId,
    title: `Staff Reallocated · ${counter.label}`,
    message: `${counter.staffName} assigned to ${queueObj?.name || 'service queue'} (${counter.status}).`,
    category: 'system',
  });

  dbStore.save();
  broadcastFacilitySnapshot(counter.facilityId, 'counter:updated', { counter });

  return {
    counter,
    snapshot: getFacilitySnapshot(counter.facilityId)!,
  };
}

export function getAnalyticsSummary(facilityId: string) {
  const db = dbStore.getState();
  const snapshot = getFacilitySnapshot(facilityId);
  if (!snapshot) return null;

  const orgDash = getOrganisationAnalyticsDashboard({ facilityId, period: 'daily' });
  const hourlyTraffic = orgDash
    ? orgDash.hourlyFootfall.map((h) => ({
        hour: h.hour,
        footfall: h.footfall,
        avgWaitMins: h.avgWaitMins,
        isPeak: h.isPeak,
        isRecommended: h.isRecommended,
      }))
    : db.hourlyTraffic[facilityId] || [];

  const peakHours = hourlyTraffic.filter((h) => h.isPeak).map((h) => h.hour);
  const recommendedHours = hourlyTraffic
    .filter((h) => h.isRecommended)
    .map((h) => h.hour);

  const standbyOpened = snapshot.counters.some(
    (c) => c.id === 'c3' && c.status !== 'Closed' && c.status !== 'Paused'
  );

  return {
    facilityId,
    hourlyTraffic,
    peakHours,
    recommendedHours,
    recommendationText:
      recommendedHours.length > 0
        ? `Shift non-urgent follow-ups from ${peakHours.join('–') || 'peak hours'} to ${recommendedHours[0]}.`
        : 'Queue flow balanced across current hours.',
    queues: snapshot.queues,
    sdgImpact: {
      sdg9InfraCalls: db.metrics.baseInfraCalls + db.metrics.processedDelta,
      sdg11CorridorDensityReduction: standbyOpened ? '-46%' : '-41%',
      sdg12PaperSlipsSaved: db.metrics.basePaperSlipsSaved + db.metrics.processedDelta,
    },
    organisationDashboard: orgDash,
  };
}
