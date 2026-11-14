import crypto from 'node:crypto';
import { dbStore } from '../db/store.ts';
import type {
  AuditLogRecord,
  CounterRecord,
  DepartmentRecord,
  EntryChannel,
  NotificationCategory,
  NotificationRecord,
  ServiceQueueRecord,
  SwapRequestRecord,
  TokenRecord,
  UserRole,
} from '../models/types.ts';
import { wsHub } from '../socket/wsHub.ts';

export interface ActorInfo {
  id: string;
  name: string;
  role: UserRole;
}

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
}): NotificationRecord {
  const db = dbStore.getState();
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
  counterLabel?: string;
  aheadCount: number;
  etaMinutes: number;
}

export interface FacilitySnapshot {
  facilityId: string;
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

export function computeQueueWaitMins(
  queue: ServiceQueueRecord,
  aheadOrWaiting: number,
  activeCounters: number
): number {
  if (aheadOrWaiting <= 0) return 0;
  const divisor = Math.max(1, activeCounters);
  return Math.max(2, Math.round((aheadOrWaiting * queue.avgServiceMinutes) / divisor));
}

function formatNowTime(): string {
  return new Date().toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function getFacilitySnapshot(facilityId: string): FacilitySnapshot | null {
  const db = dbStore.getState();
  const facility = db.facilities.find((f) => f.id === facilityId);
  if (!facility) return null;

  const facilityDepartments = db.departments.filter((d) => d.facilityId === facilityId);
  const facilityQueues = db.queues.filter((q) => q.facilityId === facilityId);
  const facilityCounters = db.counters.filter((c) => c.facilityId === facilityId);
  const facilityTokens = db.tokens.filter(
    (t) =>
      t.facilityId === facilityId &&
      ['Waiting', 'Called', 'Serving', 'Grace'].includes(t.status)
  );

  const hydratedQueues: HydratedQueue[] = facilityQueues.map((q) => {
    const dept = facilityDepartments.find((d) => d.id === q.departmentId);
    const activeCounters = facilityCounters.filter(
      (c) => c.queueId === q.id && (c.status === 'Serving' || c.status === 'Busy')
    ).length;
    const waitingTokens = facilityTokens.filter(
      (t) =>
        t.queueId === q.id &&
        (t.status === 'Waiting' || t.status === 'Called' || t.status === 'Grace')
    );
    const spreadCount = Math.max(0, q.nextIssueNumber - q.servingNumber - 1);
    const waitingCount = Math.max(waitingTokens.length, spreadCount);
    const predictedWaitMins = computeQueueWaitMins(q, waitingCount, activeCounters);

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

  const hydratedRoster: HydratedToken[] = facilityTokens
    .slice()
    .sort((a, b) => a.numberValue - b.numberValue)
    .map((t) => {
      const q = hydratedQueues.find((hq) => hq.id === t.queueId);
      const dept = facilityDepartments.find((d) => d.id === (t.departmentId || q?.departmentId));
      const cnt = facilityCounters.find(
        (c) => c.id === t.counterId || (c.queueId === t.queueId && c.status !== 'Closed')
      );
      const aheadCount = q ? Math.max(0, t.numberValue - q.servingNumber) : 0;
      const etaMinutes =
        t.status === 'Serving' || t.status === 'Called' || !q
          ? 0
          : computeQueueWaitMins(q, aheadCount, q.activeCounters);
      return {
        ...t,
        departmentName: dept?.name || 'General Services',
        counterLabel: cnt?.label,
        aheadCount,
        etaMinutes,
      };
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

export function broadcastFacilitySnapshot(facilityId: string, event: string, extra?: Record<string, unknown>) {
  const snapshot = getFacilitySnapshot(facilityId);
  if (!snapshot) return;
  wsHub.broadcast(facilityId, event, { ...extra, snapshot });
  wsHub.broadcast('all', event, { facilityId, ...extra, snapshot });
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

export function normalizeAppointmentDate(date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
    return date.trim();
  }
  return new Date().toISOString().slice(0, 10);
}

export function getAppointmentSlots(params: {
  facilityId: string;
  queueId: string;
  date?: string;
}): AppointmentSlotsResult | null {
  const db = dbStore.getState();
  const facility = db.facilities.find((f) => f.id === params.facilityId);
  const queue = db.queues.find(
    (q) => q.id === params.queueId && q.facilityId === params.facilityId
  );
  if (!facility || !queue) return null;

  const targetDate = normalizeAppointmentDate(params.date);
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
    const isBestTime = hrMeta ? hrMeta.isRecommended : !isPeak && (tpl.hourLabel === '8 AM' || tpl.hourLabel === '1 PM' || tpl.hourLabel === '2 PM' || tpl.hourLabel === '3 PM');
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

export function issueToken(params: {
  facilityId: string;
  queueId: string;
  channel: EntryChannel;
  citizenName?: string;
  userId?: string;
  appointmentDate?: string;
  appointmentSlot?: string;
}): { token: HydratedToken; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
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
        ['Waiting', 'Called', 'Serving', 'Grace'].includes(t.status)
    );
    const maxAllowed = Math.max(1, db.settings.maxActiveTokensPerCitizen || 1);
    if (activeForUser.length >= maxAllowed) {
      throw new Error(
        `You already have an active token (${activeForUser[0].tokenId}). Cancel or complete it before booking another.`
      );
    }
  }

  let normalizedDate: string | undefined;
  let normalizedSlot: string | undefined;
  if (params.appointmentSlot && params.appointmentSlot.trim()) {
    normalizedSlot = params.appointmentSlot.trim();
    normalizedDate = normalizeAppointmentDate(params.appointmentDate);
    const slotInfo = getAppointmentSlots({
      facilityId: params.facilityId,
      queueId: queue.id,
      date: normalizedDate,
    });
    const matched = slotInfo?.slots.find((s) => s.slot === normalizedSlot);
    if (!matched) {
      throw new Error(`Selected appointment time '${normalizedSlot}' is not valid for this service center.`);
    }
    if (!matched.isAvailable) {
      throw new Error(`Time slot ${normalizedSlot} on ${normalizedDate} is already full. Please select another slot.`);
    }
  } else if (queue.priority === 'appointment' && params.appointmentDate) {
    normalizedDate = normalizeAppointmentDate(params.appointmentDate);
  }

  const numberValue = queue.nextIssueNumber;
  queue.nextIssueNumber += 1;

  const assignedCounter =
    db.counters.find(
      (c) => c.facilityId === params.facilityId && c.queueId === queue.id && c.status !== 'Closed'
    ) || db.counters.find((c) => c.facilityId === params.facilityId && c.queueId === queue.id);

  const tokenId = `${queue.prefix}-${numberValue}`;
  const joinedAt = formatNowTime();

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
    appointmentDate: normalizedDate,
    appointmentSlot: normalizedSlot,
    createdAtMs: Date.now(),
  };

  db.tokens.push(token);
  db.metrics.processedDelta += 1;
  pushNotification({
    facilityId: params.facilityId,
    userId: params.userId,
    tokenId: token.tokenId,
    title: normalizedSlot
      ? `Pre-Booked ${token.tokenId} · ${normalizedSlot}`
      : `Token ${token.tokenId} Confirmed`,
    message: normalizedSlot
      ? `Reserved in ${queue.name} for ${normalizedDate} at ${normalizedSlot} (${queue.location}) at ${facility.name} via ${params.channel}.`
      : `Reserved in ${queue.name} (${queue.location}) at ${facility.name} via ${params.channel}.`,
    category: 'token',
  });
  dbStore.save();

  const snapshot = getFacilitySnapshot(params.facilityId)!;
  const hydrated = snapshot.roster.find((r) => r.tokenId === token.tokenId)!;
  return { token: hydrated, snapshot };
}

export function cancelToken(
  facilityId: string,
  tokenId: string,
  actor?: { id: string; role: UserRole; name: string }
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
  token.cancelledAt = formatNowTime();

  pushNotification({
    facilityId,
    userId: token.userId,
    tokenId: token.tokenId,
    title: `Token ${token.tokenId} Cancelled`,
    message: `Your slot in ${token.queueName} was cancelled and queue capacity has been released.`,
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
  return getFacilitySnapshot(facilityId)!;
}

export function callNextAtCounter(
  facilityId: string,
  counterId: string,
  actor?: ActorInfo
): {
  calledTokenId: string;
  queueId: string;
  snapshot: FacilitySnapshot;
} {
  const db = dbStore.getState();
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

  const nowTime = formatNowTime();

  // Complete any currently Serving/Called token assigned to this counter/queue so the counter stays clean
  for (const t of db.tokens) {
    if (
      t.facilityId === facilityId &&
      t.queueId === queue.id &&
      (t.status === 'Serving' || t.status === 'Called')
    ) {
      t.status = 'Completed';
      t.completedAt = nowTime;
    }
  }

  // Pick next waiting token in roster order if available, otherwise advance queue.servingNumber
  const waitingCandidates = db.tokens
    .filter(
      (t) =>
        t.facilityId === facilityId &&
        t.queueId === queue.id &&
        t.status === 'Waiting'
    )
    .sort((a, b) => a.numberValue - b.numberValue);

  let calledTokenId: string;
  let targetToken: TokenRecord | undefined;

  if (waitingCandidates.length > 0) {
    targetToken = waitingCandidates[0];
    queue.servingNumber = targetToken.numberValue;
    calledTokenId = targetToken.tokenId;
    targetToken.status = 'Called';
    targetToken.calledAt = nowTime;
    targetToken.counterId = counter.id;
    targetToken.assignedOperatorId = actor?.id || counter.assignedOperatorId;
  } else {
    queue.servingNumber += 1;
    calledTokenId = `${queue.prefix}-${queue.servingNumber}`;
  }

  counter.currentToken = calledTokenId;
  counter.status = 'Serving';
  db.metrics.processedDelta += 1;

  // Notify approaching tokens (1-2 positions ahead)
  const approaching = db.tokens.filter(
    (t) =>
      t.facilityId === facilityId &&
      t.queueId === queue.id &&
      t.status === 'Waiting' &&
      t.numberValue - queue.servingNumber > 0 &&
      t.numberValue - queue.servingNumber <= 2
  );
  for (const appTok of approaching) {
    const ahead = appTok.numberValue - queue.servingNumber;
    pushNotification({
      facilityId,
      userId: appTok.userId,
      tokenId: appTok.tokenId,
      title: `Turn Approaching · ${appTok.tokenId}`,
      message: `${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you at ${queue.location}. Please walk back toward ${counter.label}.`,
      category: 'turn',
    });
  }

  pushNotification({
    facilityId,
    userId: targetToken?.userId,
    tokenId: calledTokenId,
    title: `Token ${calledTokenId} Called`,
    message: `${counter.label} (${counter.staffName}) is calling token ${calledTokenId} at ${queue.location}.`,
    category: 'turn',
  });

  if (actor) {
    recordAuditLog({
      actor,
      action: 'TOKEN_CALLED',
      targetType: 'token',
      targetId: calledTokenId,
      facilityId,
      details: `Called ${calledTokenId} at ${counter.label} (${queue.name}).`,
    });
  }

  dbStore.save();

  return {
    calledTokenId,
    queueId: queue.id,
    snapshot: getFacilitySnapshot(facilityId)!,
  };
}

export function transitionTokenAtCounter(params: {
  facilityId: string;
  counterId: string;
  tokenId: string;
  action: 'recall' | 'serve' | 'complete' | 'skip' | 'no-show';
  actor: ActorInfo;
}): { token: TokenRecord; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
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

  const nowTime = formatNowTime();

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
        }
      }
      token.status = 'Serving';
      token.servingStartedAt = nowTime;
      token.counterId = counter.id;
      token.assignedOperatorId = params.actor.id;
      counter.currentToken = token.tokenId;
      counter.status = 'Serving';

      const q = db.queues.find((fq) => fq.id === token.queueId);
      if (q && token.numberValue > q.servingNumber) {
        q.servingNumber = token.numberValue;
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
      token.counterId = counter.id;
      token.assignedOperatorId = params.actor.id;
      if (counter.currentToken === token.tokenId) {
        counter.currentToken = '—';
      }
      db.metrics.processedDelta += 1;
      pushNotification({
        facilityId: params.facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Service Completed · ${token.tokenId}`,
        message: `Your visit for ${token.queueName} at ${counter.label} is complete.`,
        category: 'token',
      });
      recordAuditLog({
        actor: params.actor,
        action: 'TOKEN_COMPLETED',
        targetType: 'token',
        targetId: token.tokenId,
        facilityId: params.facilityId,
        details: `Completed service for ${token.tokenId} at ${counter.label}.`,
      });
      break;
    }

    case 'skip': {
      if (!['Waiting', 'Called', 'Grace'].includes(token.status)) {
        throw new Error(`Cannot skip token in status '${token.status}'.`);
      }
      token.status = 'Skipped';
      if (counter.currentToken === token.tokenId) {
        counter.currentToken = '—';
      }
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
      break;
    }

    case 'no-show': {
      if (!['Waiting', 'Called', 'Grace'].includes(token.status)) {
        throw new Error(`Cannot mark no-show for token in status '${token.status}'.`);
      }
      token.status = 'NoShow';
      if (counter.currentToken === token.tokenId) {
        counter.currentToken = '—';
      }
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
      break;
    }
  }

  dbStore.save();
  return {
    token,
    snapshot: getFacilitySnapshot(params.facilityId)!,
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
  const token = db.tokens.find(
    (t) => t.facilityId === params.facilityId && t.tokenId === params.tokenId
  );
  if (!token) {
    throw new Error(`Token '${params.tokenId}' not found.`);
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
      t.queueId === swap.queueId
  );
  if (!callerToken) {
    throw new Error('Your active token is not eligible for this queue swap.');
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
  userId?: string
): { trustScore: number; snapshot: FacilitySnapshot } {
  const db = dbStore.getState();
  const token = db.tokens.find(
    (t) => t.facilityId === facilityId && t.tokenId === tokenId
  );
  if (!token) {
    throw new Error(`Token '${tokenId}' not found.`);
  }
  token.status = 'Serving';
  token.servingStartedAt = formatNowTime();
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
    snapshot: getFacilitySnapshot(facilityId)!,
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
  return new Date(token.createdAtMs || Date.now()).getHours();
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
      estimatedWaitMins: c.status === 'Closed' ? hq?.predictedWaitMins || 0 : hq?.predictedWaitMins || 0,
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
        ? computeQueueWaitMins(q, q.waitingCount, q.activeCounters + 1)
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
  const currentHour24 = new Date().getHours();
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
