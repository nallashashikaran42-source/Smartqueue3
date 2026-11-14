import { auth } from '../firebase';
import type { CounterStatus, EntryChannel, HourlyTrafficPoint, QueuePriority } from '../data/smartQueueData';
import type {
  AccountStatus,
  ApiCounter,
  ApiDepartment,
  ApiFacility,
  ApiQueue,
  ApiSwapRequest,
  ApiTokenRecord,
  AuditLogItem,
  AuthUser,
  CrowdLevel,
  FacilitySnapshotResponse,
  NotificationCategory,
  NotificationItem,
  OrganisationAnalyticsDashboardResponse,
  QueueLifecycleState,
  SystemSettings,
  TokenStatus,
  UserRole,
} from './api';
import type { QueueWsMessage } from '../hooks/useQueueSocket';
import {
  diffCalendarDaysIso,
  formatAppointmentCountdown,
  formatIstDateShort,
  getIstDateIso,
  getIstHourMinute,
  getIstTimeFormatted,
  parseSlotToMinutesOfDay,
} from '../utils/istTime';

const STATIC_DB_KEY = 'smartqueue_static_db_v1';
const STATIC_MODE_KEY = 'smartqueue_static_mode';

const BOOTSTRAPPED_ADMIN_EMAILS = new Set([
  'shahsikarnann@gmail.com',
  'nallashashikaran42@gmail.com',
  'shashikirannalla6@gmail.com',
]);

interface StoredUser extends AuthUser {
  password?: string;
}

interface StoredToken extends ApiTokenRecord {
  userId?: string;
  assignedOperatorId?: string;
  recallCount?: number;
  createdAtMs: number;
  checkedInAtMs?: number;
  servingStartedAtMs?: number;
  completedAtMs?: number;
}

interface StoredQueue {
  id: string;
  facilityId: string;
  departmentId: string;
  prefix: string;
  name: string;
  location: string;
  priority: QueuePriority;
  fee: string;
  avgServiceMinutes: number;
  servingNumber: number;
  nextIssueNumber: number;
  predictionConfidence: number;
  isActive: boolean;
  isPaused: boolean;
}

interface StoredCounter {
  id: string;
  facilityId: string;
  departmentId: string;
  label: string;
  staffName: string;
  assignedOperatorId?: string;
  queueId: string;
  status: CounterStatus;
  currentToken: string;
  avgCycleMins: number;
}

interface StoredDepartment {
  id: string;
  facilityId: string;
  name: string;
  code: string;
  floorOrWing: string;
  description: string;
  isActive: boolean;
  createdAt: string;
}

interface StoredFacility extends ApiFacility {
  createdAt: string;
}

interface StoredSwap extends ApiSwapRequest {
  acceptedByTokenId?: string;
  createdAt: string;
}

interface StaticDatabase {
  users: StoredUser[];
  facilities: StoredFacility[];
  departments: StoredDepartment[];
  queues: StoredQueue[];
  counters: StoredCounter[];
  tokens: StoredToken[];
  swaps: StoredSwap[];
  hourlyTraffic: Record<string, HourlyTrafficPoint[]>;
  notifications: NotificationItem[];
  auditLogs: AuditLogItem[];
  settings: SystemSettings;
  metrics: {
    baseInfraCalls: number;
    basePaperSlipsSaved: number;
    processedDelta: number;
  };
}

export class StaticApiHttpError extends Error {
  status: number;
  suggestedRole?: UserRole;

  constructor(message: string, status: number, suggestedRole?: UserRole) {
    super(message);
    this.status = status;
    this.suggestedRole = suggestedRole;
  }
}

export function isStaticHostMode(): boolean {
  try {
    return sessionStorage.getItem(STATIC_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setStaticHostMode(enabled: boolean): void {
  try {
    if (enabled) {
      sessionStorage.setItem(STATIC_MODE_KEY, '1');
    } else {
      sessionStorage.removeItem(STATIC_MODE_KEY);
    }
  } catch {
    // Ignore storage restriction
  }
}

const staticListeners = new Set<(msg: QueueWsMessage) => void>();
let broadcastChannel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel('smartqueue_static_ws');
    broadcastChannel.onmessage = (ev) => {
      const msg = ev.data as QueueWsMessage;
      for (const listener of staticListeners) {
        listener(msg);
      }
    };
  }
} catch {
  broadcastChannel = null;
}

export function subscribeStaticQueueEvents(
  facilityId: string,
  onEvent: (msg: QueueWsMessage) => void
): () => void {
  const handler = (msg: QueueWsMessage) => {
    if (msg.facilityId === facilityId || msg.facilityId === 'all' || facilityId === 'all') {
      onEvent(msg);
    }
  };
  staticListeners.add(handler);
  return () => {
    staticListeners.delete(handler);
  };
}

function emitStaticEvent(facilityId: string, event: string, payload?: unknown): void {
  const msg: QueueWsMessage = {
    event,
    facilityId,
    payload,
    timestamp: Date.now(),
  };
  for (const listener of staticListeners) {
    listener(msg);
  }
  try {
    broadcastChannel?.postMessage(msg);
  } catch {
    // Ignore BroadcastChannel errors
  }
}

function uid(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatNowTime(): string {
  return getIstTimeFormatted(new Date());
}

function normalizeRole(role?: string | null): UserRole {
  const raw = (role || '').trim().toLowerCase();
  if (raw === 'admin') return 'admin';
  if (raw === 'operator' || raw === 'staff') return 'operator';
  return 'citizen';
}

function toPublicUser(u: StoredUser): AuthUser {
  const { password: _ignored, ...rest } = u;
  return {
    ...rest,
    role: normalizeRole(rest.role),
    accountStatus: rest.accountStatus || 'active',
  };
}

function makeStaticToken(userId: string, kind: 'access' | 'refresh'): string {
  const exp = Math.floor(Date.now() / 1000) + (kind === 'access' ? 60 * 60 * 8 : 60 * 60 * 24 * 14);
  const payload = btoa(JSON.stringify({ sub: userId, type: kind, exp, static: true }));
  return `sq-static.${payload}.local`;
}

function parseStaticToken(token: string | null): { sub: string; exp: number } | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const parsed = JSON.parse(atob(parts[1])) as { sub?: string; exp?: number };
    if (!parsed.sub || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return { sub: parsed.sub, exp: parsed.exp };
  } catch {
    return null;
  }
}

function createSeedDatabase(): StaticDatabase {
  const nowIso = new Date().toISOString();
  const baseMs = Date.now();
  const todayIst = getIstDateIso();
  const defaultTraffic: HourlyTrafficPoint[] = [
    { hour: '8 AM', footfall: 28, avgWaitMins: 8 },
    { hour: '9 AM', footfall: 52, avgWaitMins: 14 },
    { hour: '10 AM', footfall: 84, avgWaitMins: 24, isPeak: true },
    { hour: '11 AM', footfall: 98, avgWaitMins: 31, isPeak: true },
    { hour: '12 PM', footfall: 68, avgWaitMins: 19 },
    { hour: '1 PM', footfall: 44, avgWaitMins: 12 },
    { hour: '2 PM', footfall: 24, avgWaitMins: 6, isRecommended: true },
    { hour: '3 PM', footfall: 34, avgWaitMins: 9, isRecommended: true },
    { hour: '4 PM', footfall: 48, avgWaitMins: 13 },
  ];

  return {
    users: [
      {
        id: 'usr-citizen-demo',
        name: 'Karthikeya Rao',
        email: 'citizen@smartqueue.local',
        phone: '+91 98480 11223',
        role: 'citizen',
        accountStatus: 'active',
        trustScore: 98,
        password: 'citizen123',
        createdAt: nowIso,
      },
      {
        id: 'usr-operator-demo',
        name: 'Dr. K. Venkatesh',
        email: 'operator@smartqueue.local',
        phone: '+91 98480 77889',
        role: 'operator',
        accountStatus: 'active',
        organisationId: 'org-ap-health',
        assignedFacilityId: 'vja-hospital',
        assignedDepartmentId: 'dept-opd',
        assignedCounterId: 'c2',
        shift: 'Morning (08:00 – 14:00)',
        permissions: ['call_next', 'recall', 'serve', 'complete', 'skip', 'no_show', 'toggle_counter'],
        trustScore: 100,
        password: 'operator123',
        createdAt: nowIso,
      },
      {
        id: 'usr-admin-demo',
        name: 'Ananya Deshmukh',
        email: 'admin@smartqueue.local',
        phone: '+91 98480 44556',
        role: 'admin',
        accountStatus: 'active',
        organisationId: 'org-ap-health',
        shift: 'Full Day Admin',
        permissions: ['all'],
        trustScore: 100,
        password: 'admin123',
        createdAt: nowIso,
      },
    ],
    facilities: [
      {
        id: 'vja-hospital',
        organisationId: 'org-ap-health',
        name: 'District Govt Civil Hospital',
        city: 'Vijayawada',
        code: 'SQ-VJA-01',
        address: 'MG Road, Governorpet, Vijayawada',
        phone: '+91 866 257 4401',
        workingHours: '08:00 – 18:00',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'eseva-center',
        organisationId: 'org-vja-municipal',
        name: 'Municipal Civic e-Seva Kendra',
        city: 'Vijayawada Central',
        code: 'SQ-CIV-04',
        address: 'Eluru Road Civic Complex, Vijayawada',
        phone: '+91 866 242 9900',
        workingHours: '09:00 – 17:30',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'passport-kendra',
        organisationId: 'org-vja-municipal',
        name: 'Regional Passport Seva Kendra',
        city: 'Benz Circle',
        code: 'SQ-PSK-02',
        address: 'NH-16 Service Plaza, Benz Circle',
        phone: '+91 866 249 3310',
        workingHours: '09:30 – 17:00',
        isActive: true,
        createdAt: nowIso,
      },
    ],
    departments: [
      {
        id: 'dept-opd',
        facilityId: 'vja-hospital',
        name: 'Outpatient Consultation (OPD)',
        code: 'OPD',
        floorOrWing: 'Ground Floor · East Wing',
        description: 'General medicine, follow-ups, and diagnostics referral.',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'dept-priority',
        facilityId: 'vja-hospital',
        name: 'Senior & Priority Care',
        code: 'SNR',
        floorOrWing: 'Ground Floor · Room 101',
        description: 'Dedicated low-wait desk for senior citizens and assisted visitors.',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'dept-emergency',
        facilityId: 'vja-hospital',
        name: 'Emergency & Trauma Triage',
        code: 'EMG',
        floorOrWing: 'Trauma Bay · Gate 1',
        description: 'Immediate acute screening and stabilization.',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'dept-appointments',
        facilityId: 'vja-hospital',
        name: 'Pre-Booked Appointments',
        code: 'APT',
        floorOrWing: 'First Floor · Desk 5',
        description: 'Scheduled specialist consultations and QR check-ins.',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'dept-eseva-civic',
        facilityId: 'eseva-center',
        name: 'Revenue & Utility Services',
        code: 'REV',
        floorOrWing: 'Hall A · Counters 1–4',
        description: 'Property tax, water bills, and municipal certificates.',
        isActive: true,
        createdAt: nowIso,
      },
      {
        id: 'dept-psk-docs',
        facilityId: 'passport-kendra',
        name: 'Passport Verification & Biometrics',
        code: 'PSK',
        floorOrWing: 'Bay A · Ground Floor',
        description: 'Document verification and biometric enrollment.',
        isActive: true,
        createdAt: nowIso,
      },
    ],
    queues: [
      {
        id: 'general-opd',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        prefix: 'A',
        name: 'General OPD',
        location: 'Room 104',
        priority: 'standard',
        fee: '₹0 fee',
        avgServiceMinutes: 3.5,
        servingNumber: 36,
        nextIssueNumber: 42,
        predictionConfidence: 92,
        isActive: true,
        isPaused: false,
      },
      {
        id: 'senior-citizen',
        facilityId: 'vja-hospital',
        departmentId: 'dept-priority',
        prefix: 'S',
        name: 'Senior Citizen Express',
        location: 'Room 101',
        priority: 'senior',
        fee: 'Priority Desk',
        avgServiceMinutes: 4.0,
        servingNumber: 12,
        nextIssueNumber: 15,
        predictionConfidence: 96,
        isActive: true,
        isPaused: false,
      },
      {
        id: 'emergency-triage',
        facilityId: 'vja-hospital',
        departmentId: 'dept-emergency',
        prefix: 'E',
        name: 'Emergency Triage',
        location: 'Trauma Bay',
        priority: 'emergency',
        fee: 'Immediate Slot',
        avgServiceMinutes: 2.0,
        servingNumber: 4,
        nextIssueNumber: 5,
        predictionConfidence: 98,
        isActive: true,
        isPaused: false,
      },
      {
        id: 'online-appointment',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        prefix: 'Q',
        name: 'Online Pre-Booked',
        location: 'Desk 5',
        priority: 'appointment',
        fee: 'QR / Booking ID',
        avgServiceMinutes: 3.0,
        servingNumber: 20,
        nextIssueNumber: 24,
        predictionConfidence: 94,
        isActive: true,
        isPaused: false,
      },
      {
        id: 'eseva-bills',
        facilityId: 'eseva-center',
        departmentId: 'dept-eseva-civic',
        prefix: 'B',
        name: 'Utility & Property Tax',
        location: 'Desk 2',
        priority: 'standard',
        fee: 'Standard',
        avgServiceMinutes: 3.0,
        servingNumber: 14,
        nextIssueNumber: 19,
        predictionConfidence: 93,
        isActive: true,
        isPaused: false,
      },
      {
        id: 'eseva-senior',
        facilityId: 'eseva-center',
        departmentId: 'dept-eseva-civic',
        prefix: 'S',
        name: 'Senior Pension Desk',
        location: 'Desk 1',
        priority: 'senior',
        fee: 'Priority Desk',
        avgServiceMinutes: 4.0,
        servingNumber: 7,
        nextIssueNumber: 10,
        predictionConfidence: 95,
        isActive: true,
        isPaused: false,
      },
      {
        id: 'psk-verify',
        facilityId: 'passport-kendra',
        departmentId: 'dept-psk-docs',
        prefix: 'P',
        name: 'Document Verification',
        location: 'Bay A',
        priority: 'appointment',
        fee: 'Slot Confirmed',
        avgServiceMinutes: 5.0,
        servingNumber: 22,
        nextIssueNumber: 27,
        predictionConfidence: 95,
        isActive: true,
        isPaused: false,
      },
    ],
    counters: [
      {
        id: 'c1',
        facilityId: 'vja-hospital',
        departmentId: 'dept-priority',
        label: 'Counter 1',
        staffName: 'Dr. Priya Sharma',
        queueId: 'senior-citizen',
        status: 'Serving',
        currentToken: 'S-12',
        avgCycleMins: 4,
      },
      {
        id: 'c2',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        label: 'Counter 2',
        staffName: 'Dr. K. Venkatesh',
        assignedOperatorId: 'usr-operator-demo',
        queueId: 'general-opd',
        status: 'Serving',
        currentToken: 'A-36',
        avgCycleMins: 3.5,
      },
      {
        id: 'c3',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        label: 'Counter 3',
        staffName: 'Dr. Anita Rao (Standby)',
        queueId: 'general-opd',
        status: 'Closed',
        currentToken: '—',
        avgCycleMins: 3.5,
      },
      {
        id: 'c4',
        facilityId: 'vja-hospital',
        departmentId: 'dept-emergency',
        label: 'Counter 4',
        staffName: 'Triage Nurse Desk',
        queueId: 'emergency-triage',
        status: 'Serving',
        currentToken: 'E-04',
        avgCycleMins: 2,
      },
      {
        id: 'c5',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        label: 'Desk 5',
        staffName: 'Dr. Madhavi Latha',
        queueId: 'online-appointment',
        status: 'Serving',
        currentToken: 'Q-20',
        avgCycleMins: 3,
      },
      {
        id: 'c-eseva-1',
        facilityId: 'eseva-center',
        departmentId: 'dept-eseva-civic',
        label: 'Desk 1',
        staffName: 'M. Rajasekhar',
        queueId: 'eseva-senior',
        status: 'Serving',
        currentToken: 'S-7',
        avgCycleMins: 4,
      },
      {
        id: 'c-eseva-2',
        facilityId: 'eseva-center',
        departmentId: 'dept-eseva-civic',
        label: 'Desk 2',
        staffName: 'S. Padma',
        queueId: 'eseva-bills',
        status: 'Serving',
        currentToken: 'B-14',
        avgCycleMins: 3,
      },
      {
        id: 'c-psk-1',
        facilityId: 'passport-kendra',
        departmentId: 'dept-psk-docs',
        label: 'Bay A',
        staffName: 'Verifier Officer 1',
        queueId: 'psk-verify',
        status: 'Serving',
        currentToken: 'P-22',
        avgCycleMins: 5,
      },
    ],
    tokens: [
      {
        tokenId: 'A-35',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 35,
        citizenName: 'Mohan Krishna',
        channel: 'SMS',
        priority: 'standard',
        status: 'Completed',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:12 AM',
        checkedInAtMs: baseMs - 45 * 60000,
        joinedAt: '10:12 AM',
        calledAt: '10:25 AM',
        servingStartedAt: '10:26 AM',
        servingStartedAtMs: baseMs - 34 * 60000,
        completedAt: '10:30 AM',
        completedAtMs: baseMs - 30 * 60000,
        actualServiceMinutes: 4,
        aheadCount: 0,
        etaMinutes: 0,
        createdAtMs: baseMs - 45 * 60000,
      },
      {
        tokenId: 'A-36',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 36,
        citizenName: 'Srinivas Rao',
        channel: 'App QR',
        priority: 'standard',
        status: 'Serving',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:34 AM',
        checkedInAtMs: baseMs - 24 * 60000,
        joinedAt: '10:34 AM',
        calledAt: '10:48 AM',
        servingStartedAt: '10:49 AM',
        servingStartedAtMs: baseMs - 9 * 60000,
        aheadCount: 0,
        etaMinutes: 0,
        createdAtMs: baseMs - 24 * 60000,
      },
      {
        tokenId: 'A-37',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 37,
        citizenName: 'Lakshmi Devi',
        channel: 'Missed Call',
        priority: 'standard',
        status: 'Waiting',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:36 AM',
        checkedInAtMs: baseMs - 22 * 60000,
        joinedAt: '10:36 AM',
        aheadCount: 1,
        etaMinutes: 4,
        createdAtMs: baseMs - 22 * 60000,
      },
      {
        tokenId: 'A-38',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 38,
        citizenName: 'Venkata Narayana',
        channel: 'SMS',
        priority: 'standard',
        status: 'Waiting',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:39 AM',
        checkedInAtMs: baseMs - 19 * 60000,
        joinedAt: '10:39 AM',
        aheadCount: 2,
        etaMinutes: 7,
        createdAtMs: baseMs - 19 * 60000,
      },
      {
        tokenId: 'A-39',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 39,
        citizenName: 'Ramesh Kumar',
        channel: 'App QR',
        priority: 'standard',
        status: 'Waiting',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:42 AM',
        checkedInAtMs: baseMs - 16 * 60000,
        joinedAt: '10:42 AM',
        aheadCount: 3,
        etaMinutes: 11,
        createdAtMs: baseMs - 16 * 60000,
      },
      {
        tokenId: 'A-40',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 40,
        citizenName: 'Padmavathi M.',
        channel: 'SMS',
        priority: 'standard',
        status: 'Waiting',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:45 AM',
        checkedInAtMs: baseMs - 13 * 60000,
        joinedAt: '10:45 AM',
        aheadCount: 4,
        etaMinutes: 14,
        createdAtMs: baseMs - 13 * 60000,
      },
      {
        tokenId: 'A-41',
        facilityId: 'vja-hospital',
        departmentId: 'dept-opd',
        queueId: 'general-opd',
        queueName: 'General OPD',
        counterId: 'c2',
        numberValue: 41,
        citizenName: 'Anil Kumar',
        channel: 'App QR',
        priority: 'standard',
        status: 'Waiting',
        appointmentDate: todayIst,
        isPreBooked: false,
        checkedIn: true,
        checkedInAt: '10:48 AM',
        checkedInAtMs: baseMs - 10 * 60000,
        joinedAt: '10:48 AM',
        aheadCount: 5,
        etaMinutes: 18,
        createdAtMs: baseMs - 10 * 60000,
      },
      {
        tokenId: 'Q-20',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        queueId: 'online-appointment',
        queueName: 'Online Pre-Booked',
        counterId: 'c5',
        numberValue: 20,
        citizenName: 'Sujatha Reddy',
        channel: 'App QR',
        priority: 'appointment',
        status: 'Serving',
        appointmentDate: todayIst,
        appointmentSlot: '10:30 AM',
        isPreBooked: true,
        checkedIn: true,
        checkedInAt: '10:22 AM',
        checkedInAtMs: baseMs - 18 * 60000,
        joinedAt: '10:15 AM',
        calledAt: '10:32 AM',
        servingStartedAt: '10:33 AM',
        servingStartedAtMs: baseMs - 5 * 60000,
        qrCodePayload: `SQ:vja-hospital:online-appointment:Q-20:${todayIst}`,
        aheadCount: 0,
        etaMinutes: 0,
        createdAtMs: baseMs - 25 * 60000,
      },
    ],
    swaps: [
      {
        id: 'swap-ramesh-a39',
        facilityId: 'vja-hospital',
        queueId: 'general-opd',
        fromTokenId: 'A-39',
        fromCitizenName: 'Ramesh Kumar',
        fromNumber: 39,
        reason: 'Needs 10 extra minutes at pharmacy before consultation',
        status: 'open',
        createdAt: nowIso,
      },
    ],
    hourlyTraffic: {
      'vja-hospital': defaultTraffic,
      'eseva-center': defaultTraffic.map((p) => ({
        ...p,
        footfall: Math.max(15, Math.round(p.footfall * 0.72)),
        avgWaitMins: Math.max(4, Math.round(p.avgWaitMins * 0.75)),
      })),
      'passport-kendra': defaultTraffic.map((p) => ({
        ...p,
        footfall: Math.max(18, Math.round(p.footfall * 0.65)),
        avgWaitMins: Math.max(5, Math.round(p.avgWaitMins * 0.85)),
      })),
    },
    notifications: [
      {
        id: 'notif-welcome-1',
        facilityId: 'vja-hospital',
        title: 'SmartQueue Live Telemetry Active',
        message: 'You can generate a virtual token anytime and wait comfortably outside the corridor.',
        category: 'system',
        channel: 'in-app',
        isRead: false,
        createdAt: nowIso,
      },
    ],
    auditLogs: [
      {
        id: 'audit-seed-1',
        actorId: 'usr-admin-demo',
        actorName: 'Ananya Deshmukh',
        actorRole: 'admin',
        action: 'SYSTEM_INITIALIZED',
        targetType: 'settings',
        targetId: 'global',
        facilityId: 'vja-hospital',
        details: 'SmartQueue platform initialized with 3 active service centers.',
        timestamp: nowIso,
      },
    ],
    settings: {
      organisationName: 'Andhra Pradesh Public Health & Civic Network',
      maxActiveTokensPerCitizen: 1,
      gracePeriodMinutes: 5,
      allowPeerSwaps: true,
      enableInAppNotifications: true,
      enableSmsNotifications: true,
      enableEmailNotifications: true,
      workingHoursStart: '08:00',
      workingHoursEnd: '18:00',
      timezone: 'Asia/Kolkata',
      checkInWindowBeforeMins: 120,
      autoAdvanceOnComplete: true,
      updatedAt: nowIso,
    },
    metrics: {
      baseInfraCalls: 1840,
      basePaperSlipsSaved: 4280,
      processedDelta: 0,
    },
  };
}

function normalizeStaticDb(db: StaticDatabase): StaticDatabase {
  const todayIst = getIstDateIso();
  if (!db.counters.some((c) => c.id === 'c5')) {
    db.counters.push({
      id: 'c5',
      facilityId: 'vja-hospital',
      departmentId: 'dept-appointments',
      label: 'Desk 5',
      staffName: 'Dr. Madhavi Latha',
      queueId: 'online-appointment',
      status: 'Serving',
      currentToken: 'Q-20',
      avgCycleMins: 3,
    });
  }
  db.settings = {
    ...db.settings,
    timezone: db.settings.timezone || 'Asia/Kolkata',
    checkInWindowBeforeMins: db.settings.checkInWindowBeforeMins ?? 120,
    autoAdvanceOnComplete: db.settings.autoAdvanceOnComplete ?? true,
  };
  for (const tok of db.tokens) {
    if (!tok.appointmentDate) tok.appointmentDate = todayIst;
    if (typeof tok.isPreBooked !== 'boolean') {
      tok.isPreBooked = Boolean(tok.appointmentSlot) || tok.queueId === 'online-appointment';
    }
    if (typeof tok.checkedIn !== 'boolean') {
      const diff = diffCalendarDaysIso(tok.appointmentDate, todayIst);
      tok.checkedIn = diff === 0 && (tok.status === 'Serving' || tok.status === 'Called' || tok.status === 'Completed' || !tok.isPreBooked);
    }
    if (!tok.qrCodePayload) {
      tok.qrCodePayload = `SQ:${tok.facilityId}:${tok.queueId}:${tok.tokenId}:${tok.appointmentDate}`;
    }
  }
  return db;
}

function loadDb(): StaticDatabase {
  try {
    const raw = localStorage.getItem(STATIC_DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StaticDatabase>;
      if (parsed && Array.isArray(parsed.facilities) && Array.isArray(parsed.queues)) {
        return normalizeStaticDb(parsed as StaticDatabase);
      }
    }
  } catch {
    // Ignore storage read error
  }
  const seed = normalizeStaticDb(createSeedDatabase());
  saveDb(seed);
  return seed;
}

function saveDb(db: StaticDatabase): void {
  try {
    localStorage.setItem(STATIC_DB_KEY, JSON.stringify(db));
  } catch {
    // Ignore storage quota error
  }
}

const PRIORITY_RANK: Record<QueuePriority, number> = {
  emergency: 0,
  senior: 1,
  appointment: 2,
  standard: 3,
};

const ACTIVE_STATUSES = new Set(['Waiting', 'Called', 'Serving', 'Grace']);

function computeQueueWaitMins(q: StoredQueue, ahead: number, activeCounters: number): number | null {
  if (q.isPaused || activeCounters <= 0) return null;
  if (ahead <= 0) return 0;
  return Math.max(1, Math.round((ahead * q.avgServiceMinutes) / activeCounters));
}

function computeQueueOverviewWaitMins(q: StoredQueue, waiting: number, activeCounters: number): number {
  if (waiting <= 0) return 0;
  return Math.max(1, Math.round((waiting * q.avgServiceMinutes) / Math.max(1, activeCounters)));
}

function compareActiveTokens(a: StoredToken, b: StoredToken): number {
  const rank = (t: StoredToken) => (t.status === 'Serving' ? 0 : t.status === 'Called' ? 1 : 2);
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  const pDiff = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
  if (pDiff !== 0) return pDiff;
  const timeDiff = (a.checkedInAtMs ?? a.createdAtMs) - (b.checkedInAtMs ?? b.createdAtMs);
  if (timeDiff !== 0) return timeDiff;
  return a.numberValue - b.numberValue;
}

function hydrateTokenWithContext(
  db: StaticDatabase,
  t: StoredToken,
  todayIst: string,
  now: Date
): ApiTokenRecord {
  const facility = db.facilities.find((f) => f.id === t.facilityId);
  const queue = db.queues.find((q) => q.id === t.queueId && q.facilityId === t.facilityId);
  const dept = db.departments.find((d) => d.id === (t.departmentId || queue?.departmentId));
  const queueCounters = db.counters.filter((c) => c.facilityId === t.facilityId && c.queueId === t.queueId);
  const cnt =
    queueCounters.find((c) => c.id === t.counterId) ||
    queueCounters.find((c) => c.status !== 'Closed') ||
    queueCounters[0];

  const apptDate = t.appointmentDate || todayIst;
  const diffDays = diffCalendarDaysIso(apptDate, todayIst);
  const checkedIn = typeof t.checkedIn === 'boolean' ? t.checkedIn : true;
  const countdownText = formatAppointmentCountdown(apptDate, todayIst);

  if (t.status === 'Completed') {
    return {
      ...t,
      facilityName: facility?.name,
      departmentName: dept?.name || 'General Services',
      counterLabel: cnt?.label,
      queueLifecycleState: 'Completed',
      bookingStatusLabel: 'Completed',
      queueStatusLabel: 'Completed',
      checkInEligible: false,
      checkInStatusText: t.completedAt ? `Completed at ${t.completedAt}` : 'Service Completed',
      countdownText: 'Completed',
      currentServingToken: null,
      aheadCount: 0,
      etaMinutes: 0,
      waitStatusMessage: t.actualServiceMinutes ? `Completed in ${t.actualServiceMinutes}m` : 'Service completed',
    };
  }

  if (['Cancelled', 'Skipped', 'NoShow'].includes(t.status)) {
    return {
      ...t,
      facilityName: facility?.name,
      departmentName: dept?.name || 'General Services',
      counterLabel: cnt?.label,
      queueLifecycleState: 'Cancelled',
      bookingStatusLabel: t.status,
      queueStatusLabel: t.status,
      checkInEligible: false,
      checkInStatusText: 'Appointment closed',
      countdownText: 'Closed',
      currentServingToken: null,
      aheadCount: null,
      etaMinutes: null,
      waitStatusMessage: `Booking ${t.status.toLowerCase()}`,
    };
  }

  if (diffDays > 0) {
    return {
      ...t,
      facilityName: facility?.name,
      departmentName: dept?.name || 'General Services',
      counterLabel: cnt?.label,
      queueLifecycleState: 'Upcoming Appointment',
      bookingStatusLabel: 'Upcoming',
      queueStatusLabel: 'Not Started',
      checkInEligible: false,
      checkInStatusText: 'Available on appointment day',
      countdownText,
      currentServingToken: null,
      aheadCount: null,
      etaMinutes: null,
      waitStatusMessage: 'Available after check-in',
    };
  }

  if (!checkedIn) {
    const windowMins = db.settings.checkInWindowBeforeMins ?? 120;
    const slotMins = t.appointmentSlot ? parseSlotToMinutesOfDay(t.appointmentSlot) : null;
    const hm = getIstHourMinute(now);
    const nowMins = hm.hour * 60 + hm.minute;
    const eligible =
      diffDays === 0 && (slotMins === null || nowMins >= slotMins - windowMins);

    return {
      ...t,
      facilityName: facility?.name,
      departmentName: dept?.name || 'General Services',
      counterLabel: cnt?.label,
      queueLifecycleState: 'Check-In Required',
      bookingStatusLabel: diffDays < 0 ? 'Expired' : 'Today',
      queueStatusLabel: diffDays < 0 ? 'Expired' : 'Check-In Pending',
      checkInEligible: eligible,
      checkInStatusText:
        diffDays < 0
          ? 'Appointment date passed'
          : eligible
            ? 'Ready for QR check-in now'
            : `Opens ${Math.floor(windowMins / 60)}h before slot`,
      countdownText,
      currentServingToken: null,
      aheadCount: null,
      etaMinutes: null,
      waitStatusMessage: 'Waiting time will be available after check-in.',
    };
  }

  const orderedActive = db.tokens
    .filter(
      (tok) =>
        tok.facilityId === t.facilityId &&
        tok.queueId === t.queueId &&
        (tok.appointmentDate || todayIst) === todayIst &&
        (typeof tok.checkedIn === 'boolean' ? tok.checkedIn : true) &&
        ACTIVE_STATUSES.has(tok.status)
    )
    .slice()
    .sort(compareActiveTokens);

  const serving = orderedActive.find((x) => x.status === 'Serving') || orderedActive.find((x) => x.status === 'Called');
  const activeCounterWithToken = queueCounters.find(
    (c) => (c.status === 'Serving' || c.status === 'Busy') && c.currentToken && c.currentToken !== '—'
  );
  const currentServingToken =
    serving?.tokenId || activeCounterWithToken?.currentToken || (queue ? `${queue.prefix}-${queue.servingNumber}` : null);

  const activeCounters = queueCounters.filter((c) => c.status === 'Serving' || c.status === 'Busy').length;
  const idx = orderedActive.findIndex((x) => x.tokenId === t.tokenId);
  const aheadCount =
    t.status === 'Serving' || t.status === 'Called'
      ? 0
      : idx >= 0
        ? orderedActive.slice(0, idx).filter((x) => x.status !== 'Serving' && x.status !== 'Called').length +
          (serving ? 1 : 0)
        : 0;
  const etaMinutes =
    t.status === 'Serving' || t.status === 'Called'
      ? 0
      : queue
        ? computeQueueWaitMins(queue, aheadCount, activeCounters)
        : null;

  let waitStatusMessage = `${etaMinutes ?? 0} min`;
  if (queue?.isPaused) waitStatusMessage = 'Queue paused — wait recalculating when resumed';
  else if (activeCounters <= 0) waitStatusMessage = 'No active counters open yet';
  else if (t.status === 'Serving' || t.status === 'Called') waitStatusMessage = 'Your turn now';
  else if (aheadCount === 0) waitStatusMessage = 'Next in queue';

  return {
    ...t,
    facilityName: facility?.name,
    departmentName: dept?.name || 'General Services',
    counterLabel: cnt?.label,
    queueLifecycleState: 'Active Queue' as QueueLifecycleState,
    bookingStatusLabel: 'Active',
    queueStatusLabel: t.status,
    checkInEligible: false,
    checkInStatusText: t.checkedInAt ? `Checked in at ${t.checkedInAt}` : 'Checked in',
    countdownText: 'Today',
    currentServingToken,
    aheadCount,
    etaMinutes,
    waitStatusMessage,
  };
}

function getSnapshot(db: StaticDatabase, facilityId: string, now = new Date()): FacilitySnapshotResponse | null {
  const facility = db.facilities.find((f) => f.id === facilityId);
  if (!facility) return null;

  const todayIst = getIstDateIso(now);
  const depts = db.departments.filter((d) => d.facilityId === facilityId);
  const queues = db.queues.filter((q) => q.facilityId === facilityId);
  const counters = db.counters.filter((c) => c.facilityId === facilityId);
  const activeTokens = db.tokens.filter(
    (t) =>
      t.facilityId === facilityId &&
      (t.appointmentDate || todayIst) === todayIst &&
      (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
      ACTIVE_STATUSES.has(t.status)
  );

  const hydratedQueues: ApiQueue[] = queues.map((q) => {
    const dept = depts.find((d) => d.id === q.departmentId);
    const activeCounters = counters.filter(
      (c) => c.queueId === q.id && (c.status === 'Serving' || c.status === 'Busy')
    ).length;
    const waitingTokens = activeTokens.filter(
      (t) => t.queueId === q.id && ['Waiting', 'Called', 'Grace'].includes(t.status)
    );
    const waitingCount = waitingTokens.length;
    return {
      ...q,
      departmentName: dept?.name || 'General Services',
      waitingCount,
      activeCounters,
      predictedWaitMins: computeQueueOverviewWaitMins(q, waitingCount, activeCounters),
    };
  });

  const hydratedCounters: ApiCounter[] = counters.map((c) => {
    const q = queues.find((fq) => fq.id === c.queueId);
    const dept = depts.find((d) => d.id === (c.departmentId || q?.departmentId));
    return {
      ...c,
      queueName: q?.name || 'General Queue',
      departmentName: dept?.name || 'General Services',
    };
  });

  const roster: ApiTokenRecord[] = activeTokens
    .slice()
    .sort(compareActiveTokens)
    .map((t) => hydrateTokenWithContext(db, t, todayIst, now));

  const openSwaps = db.swaps.filter((s) => s.facilityId === facilityId && s.status === 'open');
  const standbyCounter = counters.find((c) => c.status === 'Closed');
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
  const activeCountersCount = counters.filter((c) => c.status === 'Serving' || c.status === 'Busy').length;
  const avgWaitMins =
    hydratedQueues.length > 0
      ? Math.round(hydratedQueues.reduce((sum, q) => sum + q.predictedWaitMins, 0) / hydratedQueues.length)
      : 0;

  return {
    facilityId,
    todayIst,
    departments: depts as ApiDepartment[],
    queues: hydratedQueues,
    counters: hydratedCounters,
    roster,
    openSwaps,
    surgeAlert,
    summary: {
      totalWaiting,
      activeCountersCount,
      totalCountersCount: counters.length,
      avgWaitMins,
      onTimeReturnRate: 94,
    },
  };
}

function pushNotif(
  db: StaticDatabase,
  params: {
    facilityId: string;
    userId?: string;
    tokenId?: string;
    title: string;
    message: string;
    category: NotificationCategory;
  }
) {
  const notif: NotificationItem = {
    id: uid('notif'),
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
  if (db.notifications.length > 150) db.notifications = db.notifications.slice(0, 150);
  emitStaticEvent(params.facilityId, 'notification:new', { notification: notif });
}

function pushAudit(
  db: StaticDatabase,
  actor: { id: string; name: string; role: UserRole },
  action: string,
  targetType: string,
  targetId: string,
  details: string,
  facilityId?: string
) {
  db.auditLogs.unshift({
    id: uid('audit'),
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    targetType,
    targetId,
    facilityId,
    details,
    timestamp: new Date().toISOString(),
  });
  if (db.auditLogs.length > 250) db.auditLogs = db.auditLogs.slice(0, 250);
}

function requireStaticUser(db: StaticDatabase, authToken: string | null): StoredUser {
  const parsed = parseStaticToken(authToken);
  if (!parsed) throw new StaticApiHttpError('Authentication required.', 401);
  const user = db.users.find((u) => u.id === parsed.sub);
  if (!user || user.accountStatus === 'inactive') {
    throw new StaticApiHttpError('Account is inactive or no longer exists.', 403);
  }
  return user;
}

export async function handleStaticApiRequest<T>(
  rawUrl: string,
  options: RequestInit = {},
  authToken: string | null = null
): Promise<T> {
  const parsedUrl = new URL(rawUrl, 'https://smartqueue.local');
  const path = parsedUrl.pathname;
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
  const db = loadDb();

  // Auth routes
  if (path === '/api/auth/register' && method === 'POST') {
    const { name, email, password, phone, role } = body as {
      name?: string;
      email?: string;
      password?: string;
      phone?: string;
      role?: string;
    };
    if (role && normalizeRole(role) !== 'citizen') {
      throw new StaticApiHttpError(
        'Self-registration is restricted to Citizen accounts.',
        403
      );
    }
    if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
      throw new StaticApiHttpError(
        'Name, valid email, and password (min 6 characters) are required.',
        400
      );
    }
    const normEmail = email.trim().toLowerCase();
    if (db.users.some((u) => u.email.toLowerCase() === normEmail)) {
      throw new StaticApiHttpError('An account with this email already exists.', 409);
    }
    const newUser: StoredUser = {
      id: uid('usr'),
      name: name.trim(),
      email: normEmail,
      phone: phone?.trim() || undefined,
      role: 'citizen',
      accountStatus: 'active',
      trustScore: 95,
      password,
      createdAt: new Date().toISOString(),
    };
    db.users.push(newUser);
    saveDb(db);
    return {
      token: makeStaticToken(newUser.id, 'access'),
      refreshToken: makeStaticToken(newUser.id, 'refresh'),
      user: toPublicUser(newUser),
    } as T;
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const { email, identifier, password, expectedRole } = body as {
      email?: string;
      identifier?: string;
      password?: string;
      expectedRole?: string;
    };
    const loginInput = (identifier || email || '').trim().toLowerCase();
    const user = db.users.find(
      (u) => u.email.toLowerCase() === loginInput || u.id.toLowerCase() === loginInput
    );
    if (!user || !password || user.password !== password) {
      throw new StaticApiHttpError(
        'Invalid credentials. Please verify your email and password.',
        401
      );
    }
    if (user.accountStatus === 'inactive') {
      throw new StaticApiHttpError('Your account has been deactivated.', 403);
    }
    const actualRole = normalizeRole(user.role);
    if (expectedRole && normalizeRole(expectedRole) !== actualRole) {
      const roleLabels = {
        citizen: 'Citizen / Patient',
        operator: 'Token Operator',
        admin: 'Administrator',
      } as const;
      throw new StaticApiHttpError(
        `This account is registered under the ${roleLabels[actualRole]} role. Please sign in through the ${roleLabels[actualRole]} tab.`,
        403,
        actualRole
      );
    }
    return {
      token: makeStaticToken(user.id, 'access'),
      refreshToken: makeStaticToken(user.id, 'refresh'),
      user: toPublicUser(user),
    } as T;
  }

  if (path === '/api/auth/firebase-google' && method === 'POST') {
    const { expectedRole } = body as { expectedRole?: string };
    const fbUser = auth.currentUser;
    if (!fbUser || !fbUser.email || !fbUser.emailVerified) {
      throw new StaticApiHttpError('A verified Google account session is required.', 401);
    }
    const normEmail = fbUser.email.trim().toLowerCase();
    let user = db.users.find(
      (u) => u.firebaseUid === fbUser.uid || u.email.toLowerCase() === normEmail
    );
    if (user) {
      if (user.accountStatus === 'inactive') {
        throw new StaticApiHttpError('Your account has been deactivated.', 403);
      }
      const actualRole = normalizeRole(user.role);
      if (expectedRole && normalizeRole(expectedRole) !== actualRole) {
        const roleLabels = {
          citizen: 'Citizen / Patient',
          operator: 'Token Operator',
          admin: 'Administrator',
        } as const;
        throw new StaticApiHttpError(
          `This Google account is registered under the ${roleLabels[actualRole]} role. Please sign in through the ${roleLabels[actualRole]} tab.`,
          403,
          actualRole
        );
      }
      user.firebaseUid = fbUser.uid;
      user.authProvider = 'google';
      if (!user.profilePhoto && fbUser.photoURL) {
        user.profilePhoto = fbUser.photoURL;
      }
      saveDb(db);
      return {
        token: makeStaticToken(user.id, 'access'),
        refreshToken: makeStaticToken(user.id, 'refresh'),
        user: toPublicUser(user),
      } as T;
    }

    const requestedRole = expectedRole ? normalizeRole(expectedRole) : 'citizen';
    if (requestedRole === 'operator') {
      throw new StaticApiHttpError(
        'No Token Operator account is provisioned for this Google email. Ask an Administrator to create your Operator account first.',
        403
      );
    }
    const isWhitelistedAdmin = BOOTSTRAPPED_ADMIN_EMAILS.has(normEmail);
    if (requestedRole === 'admin' && !isWhitelistedAdmin) {
      throw new StaticApiHttpError(
        'No Administrator account is provisioned for this Google email. Public registration is disabled for administrative access.',
        403
      );
    }
    const isAdmin = requestedRole === 'admin' && isWhitelistedAdmin;
    user = {
      id: uid('usr'),
      name: fbUser.displayName?.trim() || normEmail.split('@')[0],
      email: normEmail,
      role: isAdmin ? 'admin' : 'citizen',
      accountStatus: 'active',
      profilePhoto: fbUser.photoURL || undefined,
      firebaseUid: fbUser.uid,
      authProvider: 'google',
      organisationId: isAdmin ? 'org-ap-health' : undefined,
      shift: isAdmin ? 'Full Day Admin' : undefined,
      permissions: isAdmin ? ['all'] : undefined,
      trustScore: isAdmin ? 100 : 95,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    pushAudit(
      db,
      { id: user.id, name: user.name, role: user.role },
      isAdmin ? 'ADMIN_GOOGLE_BOOTSTRAPPED' : 'GOOGLE_SIGNIN_REGISTERED',
      'user',
      user.id,
      `${user.name} (${user.email}) signed in with Google as ${user.role}.`
    );
    pushNotif(db, {
      facilityId: 'vja-hospital',
      userId: user.id,
      title: 'Google Account Connected',
      message: `Welcome ${user.name}! Your SmartQueue account is linked with Google Auth.`,
      category: 'account',
    });
    saveDb(db);
    return {
      token: makeStaticToken(user.id, 'access'),
      refreshToken: makeStaticToken(user.id, 'refresh'),
      user: toPublicUser(user),
    } as T;
  }

  if (path === '/api/auth/forgot-password' && method === 'POST') {
    const requestedRole = normalizeRole(body.role as string);
    return {
      ok: true,
      message:
        requestedRole === 'citizen'
          ? 'If a Citizen account matches this email, recovery instructions have been logged for your account.'
          : 'For security, Token Operator and Administrator password resets must be verified by an authorized System Administrator.',
    } as T;
  }

  if (path === '/api/auth/refresh' && method === 'POST') {
    const parsed = parseStaticToken((body.refreshToken as string) || null);
    if (!parsed) throw new StaticApiHttpError('Invalid refresh token.', 401);
    const user = db.users.find((u) => u.id === parsed.sub);
    if (!user || user.accountStatus === 'inactive') {
      throw new StaticApiHttpError('User account is inactive or missing.', 403);
    }
    return {
      token: makeStaticToken(user.id, 'access'),
      refreshToken: makeStaticToken(user.id, 'refresh'),
      user: toPublicUser(user),
    } as T;
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    return { ok: true } as T;
  }

  const user = requireStaticUser(db, authToken);

  if (path === '/api/auth/me' && method === 'GET') {
    return { user: toPublicUser(user) } as T;
  }

  if (path === '/api/auth/profile' && method === 'PATCH') {
    if (body.role !== undefined || body.accountStatus !== undefined) {
      throw new StaticApiHttpError('Users cannot modify their own role or account status.', 403);
    }
    const name = String(body.name || '').trim();
    if (!name) throw new StaticApiHttpError('Name cannot be empty.', 400);
    user.name = name;
    user.phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : undefined;
    if (typeof body.profilePhoto === 'string') {
      user.profilePhoto = body.profilePhoto.trim() || undefined;
    }
    saveDb(db);
    return { user: toPublicUser(user) } as T;
  }

  if (path === '/api/auth/change-password' && method === 'POST') {
    const { currentPassword, newPassword } = body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      throw new StaticApiHttpError('Current and new password (min 6 chars) are required.', 400);
    }
    if (user.password && user.password !== currentPassword) {
      throw new StaticApiHttpError('Current password is incorrect.', 401);
    }
    user.password = newPassword;
    saveDb(db);
    return { ok: true, message: 'Password updated successfully.' } as T;
  }

  // Notifications
  if (path === '/api/notifications' && method === 'GET') {
    const facilityId = parsedUrl.searchParams.get('facilityId') || 'all';
    const list = db.notifications
      .filter((n) => {
        const matchFac = facilityId === 'all' || !n.facilityId || n.facilityId === facilityId;
        const matchUser = !n.userId || n.userId === user.id;
        return matchFac && matchUser;
      })
      .slice(0, 60);
    return { notifications: list, unreadCount: list.filter((n) => !n.isRead).length } as T;
  }

  if (path === '/api/notifications/read-all' && method === 'POST') {
    const facilityId = (body.facilityId as string) || 'all';
    for (const n of db.notifications) {
      if ((facilityId === 'all' || !n.facilityId || n.facilityId === facilityId) && (!n.userId || n.userId === user.id)) {
        n.isRead = true;
      }
    }
    saveDb(db);
    return { ok: true } as T;
  }

  const notifReadMatch = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notifReadMatch && method === 'PATCH') {
    const id = decodeURIComponent(notifReadMatch[1]);
    const item = db.notifications.find((n) => n.id === id);
    if (!item) throw new StaticApiHttpError('Notification not found.', 404);
    item.isRead = true;
    saveDb(db);
    return { notification: item } as T;
  }

  // Citizen
  if (path === '/api/citizen/overview' && method === 'GET') {
    const todayIst = getIstDateIso();
    let notifMutated = false;
    for (const tok of db.tokens) {
      if (tok.userId !== user.id || !['Waiting', 'Grace'].includes(tok.status)) continue;
      const apptDate = tok.appointmentDate || todayIst;
      const diff = diffCalendarDaysIso(apptDate, todayIst);
      if (diff === 1 && !db.notifications.some((n) => n.tokenId === tok.tokenId && n.title.startsWith('Appointment Reminder'))) {
        pushNotif(db, {
          facilityId: tok.facilityId,
          userId: user.id,
          tokenId: tok.tokenId,
          title: `Appointment Reminder · ${tok.tokenId}`,
          message: `Your appointment in ${tok.queueName} is tomorrow (${formatIstDateShort(apptDate)}${tok.appointmentSlot ? ` at ${tok.appointmentSlot}` : ''} IST).`,
          category: 'token',
        });
        notifMutated = true;
      } else if (diff === 0 && tok.checkedIn === false && !db.notifications.some((n) => n.tokenId === tok.tokenId && n.title.startsWith('Check-In Available'))) {
        pushNotif(db, {
          facilityId: tok.facilityId,
          userId: user.id,
          tokenId: tok.tokenId,
          title: `Check-In Available · ${tok.tokenId}`,
          message: `Your appointment today (${tok.appointmentSlot || 'Scheduled'}) is ready for QR check-in at ${tok.queueName}.`,
          category: 'token',
        });
        notifMutated = true;
      }
    }
    if (notifMutated) saveDb(db);

    const centers = db.facilities
      .filter((f) => f.isActive)
      .map((f) => {
        const snap = getSnapshot(db, f.id);
        return {
          facility: f,
          departments: db.departments.filter((d) => d.isActive && d.facilityId === f.id),
          queues: snap?.queues.filter((q) => q.isActive) || [],
          counters: snap?.counters.filter((c) => c.status !== 'Closed') || [],
        };
      });
    const active = db.tokens.find(
      (t) => t.userId === user.id && ['Waiting', 'Called', 'Serving', 'Grace'].includes(t.status)
    );
    const activeToken = active ? hydrateTokenWithContext(db, active, todayIst, new Date()) : null;
    return { centers, activeToken } as T;
  }

  if (path === '/api/citizen/history' && method === 'GET') {
    const history = db.tokens
      .filter((t) => t.userId === user.id || (!t.userId && t.citizenName.toLowerCase() === user.name.toLowerCase()))
      .slice()
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((t) => {
        const fac = db.facilities.find((f) => f.id === t.facilityId);
        const dept = db.departments.find((d) => d.id === t.departmentId);
        const cnt = db.counters.find((c) => c.id === t.counterId);
        return {
          tokenId: t.tokenId,
          facilityId: t.facilityId,
          facilityName: fac?.name || t.facilityId,
          facilityCity: fac?.city || '',
          departmentId: t.departmentId,
          departmentName: dept?.name || 'General Services',
          queueId: t.queueId,
          queueName: t.queueName,
          counterLabel: cnt?.label || 'Desk Assigned',
          channel: t.channel,
          priority: t.priority,
          status: t.status,
          isPreBooked: t.isPreBooked,
          checkedIn: t.checkedIn,
          checkedInAt: t.checkedInAt,
          qrCodePayload: t.qrCodePayload,
          actualServiceMinutes: t.actualServiceMinutes,
          joinedAt: t.joinedAt,
          appointmentDate: t.appointmentDate,
          appointmentSlot: t.appointmentSlot,
          calledAt: t.calledAt,
          completedAt: t.completedAt,
          completedAtMs: t.completedAtMs,
          cancelledAt: t.cancelledAt,
          createdAtMs: t.createdAtMs,
        };
      });
    return { history } as T;
  }

  // Queues
  const queueStateMatch = path.match(/^\/api\/queues\/([^/]+)\/state$/);
  if (queueStateMatch && method === 'GET') {
    const snap = getSnapshot(db, decodeURIComponent(queueStateMatch[1]));
    if (!snap) throw new StaticApiHttpError('Facility not found.', 404);
    return snap as T;
  }

  const queueSlotsMatch = path.match(/^\/api\/queues\/([^/]+)\/slots$/);
  if (queueSlotsMatch && method === 'GET') {
    const facilityId = decodeURIComponent(queueSlotsMatch[1]);
    const queueId = parsedUrl.searchParams.get('queueId') || '';
    const dateParam = parsedUrl.searchParams.get('date') || '';
    const todayIst = getIstDateIso();
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayIst;
    const facility = db.facilities.find((f) => f.id === facilityId);
    const queue = db.queues.find((q) => q.id === queueId && q.facilityId === facilityId);
    if (!facility || !queue) throw new StaticApiHttpError('Queue not found.', 404);

    const activeCntForQueue = Math.max(
      1,
      db.counters.filter((c) => c.facilityId === facilityId && c.queueId === queue.id && c.status !== 'Closed').length
    );
    const maxCapacity = Math.min(
      12,
      Math.max(4, Math.floor(30 / Math.max(2, queue.avgServiceMinutes)) * activeCntForQueue)
    );
    const templates = [
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
    const hourTrafficMap = new Map((db.hourlyTraffic[facilityId] || []).map((h) => [h.hour, h]));
    const isPastDate = diffCalendarDaysIso(targetDate, todayIst) < 0;
    const slots = templates.map((tpl) => {
      const bookedCount = db.tokens.filter(
        (t) =>
          t.facilityId === facilityId &&
          t.queueId === queue.id &&
          t.appointmentSlot === tpl.slot &&
          (t.appointmentDate || todayIst) === targetDate &&
          !['Cancelled', 'Skipped', 'NoShow', 'Completed'].includes(t.status)
      ).length;
      const remainingSpots = isPastDate ? 0 : Math.max(0, maxCapacity - bookedCount);
      const hrMeta = hourTrafficMap.get(tpl.hourLabel);
      const isPeak = Boolean(hrMeta?.isPeak ?? (tpl.hourLabel === '10 AM' || tpl.hourLabel === '11 AM'));
      const isBestTime = Boolean(hrMeta?.isRecommended ?? (!isPeak && (tpl.hourLabel === '8 AM' || tpl.hourLabel === '1 PM' || tpl.hourLabel === '2 PM' || tpl.hourLabel === '3 PM')));
      const crowdLevel: CrowdLevel = isPeak ? 'High' : isBestTime ? 'Low' : 'Medium';
      const baseWait = hrMeta?.avgWaitMins ?? (isPeak ? 22 : isBestTime ? 8 : 13);
      return {
        slot: tpl.slot,
        hourLabel: tpl.hourLabel,
        bookedCount,
        maxCapacity,
        remainingSpots,
        isAvailable: !isPastDate && remainingSpots > 0,
        crowdLevel,
        isBestTime,
        isPeak,
        estimatedWaitMins: Math.max(2, Math.round(baseWait * 0.65 + bookedCount * 1.8)),
      };
    });
    return { facilityId, queueId: queue.id, queueName: queue.name, date: targetDate, slots } as T;
  }

  const issueTokenMatch = path.match(/^\/api\/queues\/([^/]+)\/tokens$/);
  if (issueTokenMatch && method === 'POST') {
    const now = new Date();
    const todayIst = getIstDateIso(now);
    const facilityId = decodeURIComponent(issueTokenMatch[1]);
    const queueId = String(body.queueId || '');
    const channel = (body.channel as EntryChannel) || 'App QR';
    const appointmentSlot = typeof body.appointmentSlot === 'string' && body.appointmentSlot.trim()
      ? body.appointmentSlot.trim()
      : undefined;
    const rawDate = typeof body.appointmentDate === 'string' ? body.appointmentDate.trim() : '';
    const appointmentDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayIst;
    if (diffCalendarDaysIso(appointmentDate, todayIst) < 0) {
      throw new StaticApiHttpError('Cannot book an appointment in the past (IST date).', 400);
    }

    const isPreBooked = Boolean(body.isPreBooked) || Boolean(appointmentSlot) || appointmentDate > todayIst;
    const isToday = appointmentDate === todayIst;
    const checkedIn = !isPreBooked && isToday;

    const facility = db.facilities.find((f) => f.id === facilityId && f.isActive);
    const queue = db.queues.find((q) => q.id === queueId && q.facilityId === facilityId && q.isActive);
    if (!facility || !queue) throw new StaticApiHttpError('Service queue not found.', 400);
    if (isToday && queue.isPaused) throw new StaticApiHttpError(`Service '${queue.name}' is paused.`, 400);

    const activeForUser = db.tokens.filter(
      (t) => t.userId === user.id && ['Waiting', 'Called', 'Serving', 'Grace'].includes(t.status)
    );
    if (activeForUser.length >= Math.max(1, db.settings.maxActiveTokensPerCitizen || 1)) {
      throw new StaticApiHttpError(
        `You already have an active token (${activeForUser[0].tokenId}). Cancel or complete it before booking another.`,
        400
      );
    }

    let numberValue: number;
    let tokenId: string;
    if (isToday) {
      numberValue = queue.nextIssueNumber;
      queue.nextIssueNumber += 1;
      tokenId = `${queue.prefix}-${numberValue}`;
      while (db.tokens.some((t) => t.facilityId === facilityId && t.queueId === queue.id && (t.appointmentDate || todayIst) === appointmentDate && t.tokenId === tokenId)) {
        numberValue += 1;
        tokenId = `${queue.prefix}-${numberValue}`;
      }
      queue.nextIssueNumber = Math.max(queue.nextIssueNumber, numberValue + 1);
    } else {
      const sameDayDateTokens = db.tokens.filter(
        (t) => t.facilityId === facilityId && t.queueId === queue.id && t.appointmentDate === appointmentDate
      );
      numberValue = sameDayDateTokens.reduce((m, t) => Math.max(m, t.numberValue), 0) + 1;
      const mmdd = appointmentDate.slice(5).replace('-', '');
      tokenId = `${queue.prefix}-${mmdd}-${numberValue}`;
    }

    const assignedCounter =
      db.counters.find((c) => c.facilityId === facilityId && c.queueId === queue.id && c.status !== 'Closed') ||
      db.counters.find((c) => c.facilityId === facilityId && c.queueId === queue.id);
    const nowTime = getIstTimeFormatted(now);
    const token: StoredToken = {
      tokenId,
      facilityId,
      departmentId: queue.departmentId,
      queueId: queue.id,
      queueName: queue.name,
      counterId: assignedCounter?.id,
      assignedOperatorId: assignedCounter?.assignedOperatorId,
      numberValue,
      citizenName: String(body.citizenName || user.name).trim() || 'Citizen Guest',
      userId: user.id,
      channel,
      priority: isPreBooked && queue.priority === 'standard' ? 'appointment' : queue.priority,
      status: 'Waiting',
      joinedAt: nowTime,
      appointmentDate,
      appointmentSlot,
      isPreBooked,
      checkedIn,
      checkedInAt: checkedIn ? nowTime : undefined,
      checkedInAtMs: checkedIn ? now.getTime() : undefined,
      qrCodePayload: `SQ:${facilityId}:${queue.id}:${tokenId}:${appointmentDate}`,
      aheadCount: null,
      etaMinutes: null,
      createdAtMs: now.getTime(),
    };
    db.tokens.push(token);
    db.metrics.processedDelta += 1;
    pushNotif(db, {
      facilityId,
      userId: user.id,
      tokenId,
      title: isPreBooked
        ? `Appointment Confirmed · ${tokenId}`
        : `Token ${tokenId} Confirmed`,
      message: isPreBooked
        ? `Booked in ${queue.name} for ${formatIstDateShort(appointmentDate)}${appointmentSlot ? ` at ${appointmentSlot}` : ''} IST at ${facility.name}. Scan your QR pass on appointment day to join the live queue.`
        : `Checked in to ${queue.name} (${queue.location}) at ${facility.name} via ${channel}.`,
      category: 'token',
    });
    saveDb(db);
    const snapshot = getSnapshot(db, facilityId, now)!;
    const hydrated = hydrateTokenWithContext(db, token, todayIst, now);
    emitStaticEvent(facilityId, 'token:issued', { token: hydrated, snapshot });
    return { token: hydrated, snapshot } as T;
  }

  const qrCheckInMatch = path.match(/^\/api\/queues\/([^/]+)\/check-in-qr$/);
  if (qrCheckInMatch && method === 'POST') {
    const facilityId = decodeURIComponent(qrCheckInMatch[1]);
    const now = new Date();
    const todayIst = getIstDateIso(now);
    const qrPayload = String(body.qrPayload || '').trim();
    const parts = qrPayload.startsWith('SQ:') ? qrPayload.split(':') : [];
    const targetTokenId = parts.length >= 4 ? parts[3] : String(body.tokenId || '').trim();
    const token = db.tokens.find((t) => t.facilityId === facilityId && t.tokenId === targetTokenId);
    if (!token) throw new StaticApiHttpError(`Token '${targetTokenId}' not found.`, 400);
    if (['Completed', 'Cancelled', 'Skipped', 'NoShow'].includes(token.status)) {
      throw new StaticApiHttpError(`Token ${token.tokenId} is ${token.status.toLowerCase()} and cannot check in.`, 400);
    }
    const apptDate = token.appointmentDate || todayIst;
    const diff = diffCalendarDaysIso(apptDate, todayIst);
    if (diff > 0) {
      throw new StaticApiHttpError(
        `Check-in blocked: appointment is scheduled for ${formatIstDateShort(apptDate)} IST (${diff} day(s) remaining).`,
        400
      );
    }
    if (diff < 0) {
      throw new StaticApiHttpError(`Appointment ${token.tokenId} expired on ${formatIstDateShort(apptDate)} IST.`, 400);
    }
    const queue = db.queues.find((q) => q.id === token.queueId && q.facilityId === facilityId);
    if (queue?.isPaused) {
      throw new StaticApiHttpError(`Queue '${queue.name}' is currently paused.`, 400);
    }
    if (!token.checkedIn) {
      const windowMins = db.settings.checkInWindowBeforeMins ?? 120;
      const slotMins = token.appointmentSlot ? parseSlotToMinutesOfDay(token.appointmentSlot) : null;
      const hm = getIstHourMinute(now);
      if (slotMins !== null && hm.hour * 60 + hm.minute < slotMins - windowMins) {
        throw new StaticApiHttpError(`Check-in opens ${Math.floor(windowMins / 60)}h before your ${token.appointmentSlot} IST slot.`, 400);
      }
      token.checkedIn = true;
      token.checkedInAt = getIstTimeFormatted(now);
      token.checkedInAtMs = now.getTime();
      pushNotif(db, {
        facilityId,
        userId: token.userId,
        tokenId: token.tokenId,
        title: `Checked In · ${token.tokenId}`,
        message: `You are now in the active ${token.queueName} queue. Live wait time is active.`,
        category: 'turn',
      });
      saveDb(db);
    }
    const snapshot = getSnapshot(db, facilityId, now)!;
    const hydrated = snapshot.roster.find((r) => r.tokenId === token.tokenId) || hydrateTokenWithContext(db, token, todayIst, now);
    emitStaticEvent(facilityId, 'token:checked-in', { tokenId: token.tokenId, token: hydrated, snapshot });
    return { token: hydrated, snapshot } as T;
  }

  const cancelTokenMatch = path.match(/^\/api\/queues\/([^/]+)\/tokens\/([^/]+)\/cancel$/);
  if (cancelTokenMatch && method === 'POST') {
    const facilityId = decodeURIComponent(cancelTokenMatch[1]);
    const tokenId = decodeURIComponent(cancelTokenMatch[2]);
    const token = db.tokens.find((t) => t.facilityId === facilityId && t.tokenId === tokenId);
    if (!token) throw new StaticApiHttpError('Token not found.', 400);
    if (user.role === 'citizen' && token.userId && token.userId !== user.id) {
      throw new StaticApiHttpError('You can only cancel your own queue token.', 403);
    }
    token.status = 'Cancelled';
    token.cancelledAt = formatNowTime();
    pushNotif(db, {
      facilityId,
      userId: token.userId,
      tokenId,
      title: `Token ${tokenId} Cancelled`,
      message: `Your slot in ${token.queueName} was cancelled and capacity has been released.`,
      category: 'token',
    });
    saveDb(db);
    const snapshot = getSnapshot(db, facilityId)!;
    emitStaticEvent(facilityId, 'token:cancelled', { tokenId, snapshot });
    return { ok: true, snapshot } as T;
  }

  const swapRequestMatch = path.match(/^\/api\/queues\/([^/]+)\/swaps\/request$/);
  if (swapRequestMatch && method === 'POST') {
    const facilityId = decodeURIComponent(swapRequestMatch[1]);
    const tokenId = String(body.tokenId || '');
    const token = db.tokens.find((t) => t.facilityId === facilityId && t.tokenId === tokenId);
    if (!token) throw new StaticApiHttpError('Token not found.', 400);
    const swap: StoredSwap = {
      id: uid('swap'),
      facilityId,
      queueId: token.queueId,
      fromTokenId: token.tokenId,
      fromCitizenName: token.citizenName,
      fromNumber: token.numberValue,
      reason: String(body.reason || 'Willing to trade turns fairly'),
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    db.swaps.push(swap);
    saveDb(db);
    const snapshot = getSnapshot(db, facilityId)!;
    emitStaticEvent(facilityId, 'swap:requested', { swap, snapshot });
    return { swap, snapshot } as T;
  }

  const swapAcceptMatch = path.match(/^\/api\/queues\/([^/]+)\/swaps\/([^/]+)\/accept$/);
  if (swapAcceptMatch && method === 'POST') {
    const facilityId = decodeURIComponent(swapAcceptMatch[1]);
    const swapId = decodeURIComponent(swapAcceptMatch[2]);
    const targetTokenId = String(body.targetTokenId || '');
    const swap = db.swaps.find((s) => s.facilityId === facilityId && s.id === swapId && s.status === 'open');
    const callerToken = db.tokens.find(
      (t) => t.facilityId === facilityId && t.tokenId === targetTokenId && swap && t.queueId === swap.queueId
    );
    if (!swap || !callerToken) throw new StaticApiHttpError('Swap is no longer available.', 400);
    const peerToken = db.tokens.find((t) => t.facilityId === facilityId && t.tokenId === swap.fromTokenId);
    const oldNum = callerToken.numberValue;
    const oldId = callerToken.tokenId;
    callerToken.numberValue = swap.fromNumber;
    callerToken.tokenId = swap.fromTokenId;
    if (peerToken) {
      peerToken.numberValue = oldNum;
      peerToken.tokenId = oldId;
    }
    swap.status = 'accepted';
    user.trustScore += 20;
    saveDb(db);
    const snapshot = getSnapshot(db, facilityId)!;
    emitStaticEvent(facilityId, 'swap:accepted', { snapshot });
    return {
      updatedTokenId: callerToken.tokenId,
      updatedNumber: callerToken.numberValue,
      trustScore: user.trustScore,
      snapshot,
    } as T;
  }

  const graceMatch = path.match(/^\/api\/queues\/([^/]+)\/tokens\/([^/]+)\/grace$/);
  if (graceMatch && method === 'POST') {
    const facilityId = decodeURIComponent(graceMatch[1]);
    const tokenId = decodeURIComponent(graceMatch[2]);
    const token = db.tokens.find((t) => t.facilityId === facilityId && t.tokenId === tokenId);
    if (!token) throw new StaticApiHttpError('Token not found.', 404);
    const graceExpiresAt = new Date(Date.now() + (db.settings.gracePeriodMinutes || 5) * 60000).toISOString();
    token.status = 'Grace';
    token.graceExpiresAt = graceExpiresAt;
    saveDb(db);
    const snapshot = getSnapshot(db, facilityId)!;
    emitStaticEvent(facilityId, 'grace:activated', { tokenId, graceExpiresAt, snapshot });
    return { graceExpiresAt, snapshot } as T;
  }

  const checkInMatch = path.match(/^\/api\/queues\/([^/]+)\/tokens\/([^/]+)\/check-in$/);
  if (checkInMatch && method === 'POST') {
    const facilityId = decodeURIComponent(checkInMatch[1]);
    const tokenId = decodeURIComponent(checkInMatch[2]);
    const token = db.tokens.find((t) => t.facilityId === facilityId && t.tokenId === tokenId);
    if (!token) throw new StaticApiHttpError('Token not found.', 404);
    token.status = 'Serving';
    token.servingStartedAt = formatNowTime();
    token.graceExpiresAt = undefined;
    user.trustScore += 5;
    saveDb(db);
    const snapshot = getSnapshot(db, facilityId)!;
    emitStaticEvent(facilityId, 'grace:checked-in', { tokenId, trustScore: user.trustScore, snapshot });
    return { trustScore: user.trustScore, snapshot } as T;
  }

  // Operator
  if (path === '/api/operator/workspace' && method === 'GET') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const assignedCounter =
      db.counters.find((c) => c.id === user.assignedCounterId) ||
      db.counters.find((c) => c.assignedOperatorId === user.id) ||
      db.counters.find((c) => c.facilityId === (user.assignedFacilityId || 'vja-hospital')) ||
      db.counters[0];
    const facilityId = user.assignedFacilityId || assignedCounter?.facilityId || db.facilities[0]?.id;
    const facility = db.facilities.find((f) => f.id === facilityId)!;
    const snapshot = getSnapshot(db, facilityId)!;
    const counter = snapshot.counters.find((c) => c.id === assignedCounter?.id) || snapshot.counters[0] || null;
    const queue = counter ? snapshot.queues.find((q) => q.id === counter.queueId) || null : null;
    const department =
      snapshot.departments.find((d) => d.id === (user.assignedDepartmentId || counter?.departmentId)) ||
      snapshot.departments[0] ||
      null;
    const todayIst = getIstDateIso();
    const liveQueue = snapshot.roster
      .filter((t) => !queue || t.queueId === queue.id)
      .map((t) => {
        const storedTok = db.tokens.find(
          (tok) => tok.tokenId === t.tokenId && tok.facilityId === facilityId
        );
        const createdAtMs = storedTok?.createdAtMs ?? Date.now();
        return {
          tokenId: t.tokenId,
          citizenLabel: t.citizenName,
          queueId: t.queueId,
          queueName: t.queueName,
          channel: t.channel,
          priority: t.priority,
          status: t.status,
          queueLifecycleState: t.queueLifecycleState,
          checkedIn: t.checkedIn,
          isPreBooked: t.isPreBooked,
          qrCodePayload: t.qrCodePayload,
          aheadCount: t.aheadCount,
          waitStatusMessage: t.waitStatusMessage,
          joinedAt: t.joinedAt,
          appointmentDate: storedTok?.appointmentDate,
          appointmentSlot: storedTok?.appointmentSlot,
          calledAt: t.calledAt,
          servingStartedAt: t.servingStartedAt,
          etaMinutes: t.etaMinutes,
          waitMinsSoFar: Math.max(0, Math.round((Date.now() - (storedTok?.checkedInAtMs || createdAtMs)) / 60000)),
          recallCount: storedTok?.recallCount || 0,
          createdAtMs,
        };
      });
    const pendingCheckIns = db.tokens
      .filter(
        (t) =>
          t.facilityId === facilityId &&
          (!queue || t.queueId === queue.id) &&
          (t.appointmentDate || todayIst) === todayIst &&
          t.checkedIn === false &&
          ['Waiting', 'Grace'].includes(t.status)
      )
      .map((t) => ({
        tokenId: t.tokenId,
        citizenLabel: t.citizenName,
        queueId: t.queueId,
        queueName: t.queueName,
        appointmentDate: t.appointmentDate,
        appointmentSlot: t.appointmentSlot,
        qrCodePayload: t.qrCodePayload,
      }));
    const allFacTokens = db.tokens.filter(
      (t) => t.facilityId === facilityId && (!queue || t.queueId === queue.id)
    );
    const history = allFacTokens
      .filter((t) => ['Completed', 'Skipped', 'NoShow', 'Cancelled'].includes(t.status))
      .slice()
      .sort((a, b) => (b.completedAtMs || b.createdAtMs) - (a.completedAtMs || a.createdAtMs))
      .slice(0, 50)
      .map((t) => ({
        tokenId: t.tokenId,
        citizenLabel: t.citizenName,
        queueName: t.queueName,
        channel: t.channel,
        status: t.status,
        appointmentDate: t.appointmentDate,
        appointmentSlot: t.appointmentSlot,
        joinedAt: t.joinedAt,
        calledAt: t.calledAt,
        completedAt: t.completedAt,
        actualServiceMinutes: t.actualServiceMinutes,
        waitMins: t.actualServiceMinutes ?? Math.max(1, Math.round(((t.completedAtMs || Date.now()) - t.createdAtMs) / 60000)),
      }));
    return {
      operator: {
        id: user.id,
        name: user.name,
        shift: user.shift || 'Day Shift',
        todayDate: new Date().toLocaleDateString('en-IN', {
          timeZone: 'Asia/Kolkata',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      },
      facility,
      department,
      counter,
      queue,
      liveQueue,
      pendingCheckIns,
      history,
      metrics: {
        totalTokensToday: allFacTokens.filter((t) => (t.appointmentDate || todayIst) === todayIst).length,
        waitingTokens: liveQueue.filter((t) => ['Waiting', 'Called', 'Grace'].includes(t.status)).length,
        completedTokens: allFacTokens.filter((t) => t.status === 'Completed').length,
        skippedTokens: allFacTokens.filter((t) => t.status === 'Skipped' || t.status === 'NoShow').length,
        avgWaitMins: queue?.predictedWaitMins ?? snapshot.summary.avgWaitMins,
      },
    } as T;
  }

  const opQrMatch = path.match(/^\/api\/operator\/counters\/([^/]+)\/check-in-qr$/);
  if (opQrMatch && method === 'POST') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const counterId = decodeURIComponent(opQrMatch[1]);
    const counter = db.counters.find((c) => c.id === counterId);
    if (!counter) throw new StaticApiHttpError('Counter not found.', 404);
    const now = new Date();
    const todayIst = getIstDateIso(now);
    const qrPayload = String(body.qrPayload || '').trim();
    const parts = qrPayload.startsWith('SQ:') ? qrPayload.split(':') : [];
    const targetTokenId = parts.length >= 4 ? parts[3] : String(body.tokenId || '').trim();
    const token = db.tokens.find((t) => t.facilityId === counter.facilityId && t.tokenId === targetTokenId);
    if (!token) throw new StaticApiHttpError(`Token '${targetTokenId}' not found.`, 400);
    if (diffCalendarDaysIso(token.appointmentDate || todayIst, todayIst) !== 0) {
      throw new StaticApiHttpError('QR check-in is only permitted on the appointment date (IST).', 400);
    }
    token.checkedIn = true;
    token.checkedInAt = getIstTimeFormatted(now);
    token.checkedInAtMs = now.getTime();
    saveDb(db);
    const snapshot = getSnapshot(db, counter.facilityId, now)!;
    const hydrated = snapshot.roster.find((r) => r.tokenId === token.tokenId) || hydrateTokenWithContext(db, token, todayIst, now);
    emitStaticEvent(counter.facilityId, 'token:checked-in', { tokenId: token.tokenId, token: hydrated, snapshot });
    return { token: hydrated, snapshot } as T;
  }

  const callNextMatch = path.match(/^\/api\/operator\/counters\/([^/]+)\/call-next$/);
  if (callNextMatch && method === 'POST') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const now = new Date();
    const todayIst = getIstDateIso(now);
    const counterId = decodeURIComponent(callNextMatch[1]);
    const counter = db.counters.find((c) => c.id === counterId);
    if (!counter) throw new StaticApiHttpError('Counter not found.', 404);
    const queue = db.queues.find((q) => q.id === counter.queueId && q.facilityId === counter.facilityId);
    if (!queue) throw new StaticApiHttpError('Queue not found.', 404);
    const nowTime = getIstTimeFormatted(now);
    for (const t of db.tokens) {
      if (
        t.facilityId === counter.facilityId &&
        t.queueId === queue.id &&
        (t.appointmentDate || todayIst) === todayIst &&
        (t.status === 'Serving' || t.status === 'Called') &&
        (!t.counterId || t.counterId === counter.id)
      ) {
        t.status = 'Completed';
        t.completedAt = nowTime;
        t.completedAtMs = now.getTime();
        t.actualServiceMinutes = Math.max(1, Math.round((now.getTime() - (t.servingStartedAtMs || t.checkedInAtMs || t.createdAtMs)) / 60000));
      }
    }
    const next = db.tokens
      .filter(
        (t) =>
          t.facilityId === counter.facilityId &&
          t.queueId === queue.id &&
          (t.appointmentDate || todayIst) === todayIst &&
          (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
          (t.status === 'Waiting' || t.status === 'Grace')
      )
      .sort(compareActiveTokens)[0];
    let calledTokenId: string;
    if (next) {
      queue.servingNumber = next.numberValue;
      calledTokenId = next.tokenId;
      next.status = 'Called';
      next.calledAt = nowTime;
      next.counterId = counter.id;
    } else {
      calledTokenId = '—';
    }
    counter.currentToken = calledTokenId;
    counter.status = 'Serving';
    db.metrics.processedDelta += 1;
    saveDb(db);
    const snapshot = getSnapshot(db, counter.facilityId, now)!;
    emitStaticEvent(counter.facilityId, 'token:called', { calledTokenId, queueId: queue.id, snapshot });
    return { calledTokenId, queueId: queue.id, snapshot } as T;
  }

  const tokenActionMatch = path.match(/^\/api\/operator\/counters\/([^/]+)\/tokens\/([^/]+)\/([^/]+)$/);
  if (tokenActionMatch && method === 'POST') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const now = new Date();
    const todayIst = getIstDateIso(now);
    const counterId = decodeURIComponent(tokenActionMatch[1]);
    const tokenId = decodeURIComponent(tokenActionMatch[2]);
    const action = decodeURIComponent(tokenActionMatch[3]);
    const counter = db.counters.find((c) => c.id === counterId);
    const token = db.tokens.find((t) => t.tokenId === tokenId && counter && t.facilityId === counter.facilityId);
    if (!counter || !token) throw new StaticApiHttpError('Token or counter not found.', 404);
    const queue = db.queues.find((q) => q.id === counter.queueId && q.facilityId === counter.facilityId);
    const nowTime = getIstTimeFormatted(now);
    const statusMap: Record<string, TokenStatus> = {
      serve: 'Serving',
      complete: 'Completed',
      skip: 'Skipped',
      'no-show': 'NoShow',
    };
    if (action === 'recall') {
      token.recallCount = (token.recallCount || 0) + 1;
      token.calledAt = nowTime;
    } else if (statusMap[action]) {
      token.status = statusMap[action];
      if (action === 'serve') {
        token.servingStartedAt = nowTime;
        token.servingStartedAtMs = now.getTime();
        token.counterId = counter.id;
        counter.currentToken = token.tokenId;
        if (queue) queue.servingNumber = token.numberValue;
      } else {
        if (action === 'complete') {
          token.completedAt = nowTime;
          token.completedAtMs = now.getTime();
          token.actualServiceMinutes = Math.max(1, Math.round((now.getTime() - (token.servingStartedAtMs || token.checkedInAtMs || token.createdAtMs)) / 60000));
        }
        if (db.settings.autoAdvanceOnComplete !== false && queue) {
          const next = db.tokens
            .filter(
              (t) =>
                t.facilityId === counter.facilityId &&
                t.queueId === queue.id &&
                (t.appointmentDate || todayIst) === todayIst &&
                (typeof t.checkedIn === 'boolean' ? t.checkedIn : true) &&
                (t.status === 'Waiting' || t.status === 'Grace')
            )
            .sort(compareActiveTokens)[0];
          if (next) {
            next.status = 'Called';
            next.calledAt = nowTime;
            next.counterId = counter.id;
            queue.servingNumber = next.numberValue;
            counter.currentToken = next.tokenId;
          } else {
            counter.currentToken = '—';
          }
        } else if (counter.currentToken === token.tokenId) {
          counter.currentToken = '—';
        }
      }
    }
    saveDb(db);
    const snapshot = getSnapshot(db, counter.facilityId, now)!;
    emitStaticEvent(counter.facilityId, `token:${action}`, { tokenId, token, snapshot });
    return { token: hydrateTokenWithContext(db, token, todayIst, now), snapshot } as T;
  }

  const counterStatusMatch = path.match(/^\/api\/operator\/counters\/([^/]+)\/status$/);
  if (counterStatusMatch && method === 'PATCH') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const counter = db.counters.find((c) => c.id === decodeURIComponent(counterStatusMatch[1]));
    if (!counter) throw new StaticApiHttpError('Counter not found.', 404);
    counter.status = body.status as CounterStatus;
    saveDb(db);
    const snapshot = getSnapshot(db, counter.facilityId)!;
    emitStaticEvent(counter.facilityId, 'counter:updated', { counter, snapshot });
    return { counter } as T;
  }

  const pauseQueueMatch = path.match(/^\/api\/operator\/queues\/([^/]+)\/pause$/);
  if (pauseQueueMatch && method === 'PATCH') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const queue = db.queues.find((q) => q.id === decodeURIComponent(pauseQueueMatch[1]));
    if (!queue) throw new StaticApiHttpError('Queue not found.', 404);
    queue.isPaused = Boolean(body.isPaused);
    saveDb(db);
    const snapshot = getSnapshot(db, queue.facilityId)!;
    emitStaticEvent(queue.facilityId, 'org:queue-updated', { queue, snapshot });
    return { queue } as T;
  }

  // Analytics
  if (path === '/api/analytics/organisation/dashboard' && method === 'GET') {
    if (user.role === 'citizen') throw new StaticApiHttpError('Forbidden.', 403);
    const scopeId = parsedUrl.searchParams.get('facilityId') || 'all';
    const rawPeriod = (parsedUrl.searchParams.get('period') || 'daily').toLowerCase();
    const period: 'daily' | 'weekly' | 'monthly' =
      rawPeriod === 'weekly' || rawPeriod === 'monthly' ? rawPeriod : 'daily';
    const surgeThreshold = Math.max(3, Math.min(30, Number(parsedUrl.searchParams.get('threshold')) || 5));

    const targetFacilities =
      scopeId === 'all' ? db.facilities : db.facilities.filter((f) => f.id === scopeId);
    if (targetFacilities.length === 0) throw new StaticApiHttpError('Facility not found.', 404);

    const facIds = new Set(targetFacilities.map((f) => f.id));
    const scopedQueues = db.queues.filter((q) => facIds.has(q.facilityId) && q.isActive);
    const scopedCounters = db.counters.filter((c) => facIds.has(c.facilityId));
    const scopedTokens = db.tokens.filter((t) => facIds.has(t.facilityId));
    const allHydratedQueues = targetFacilities.flatMap((f) =>
      (getSnapshot(db, f.id)?.queues || []).map((q) => ({ ...q, facilityName: f.name }))
    );

    const peopleInQueue = allHydratedQueues.reduce((s, q) => s + q.waitingCount, 0);
    const activeCounters = scopedCounters.filter((c) => c.status === 'Serving' || c.status === 'Busy').length;
    const totalCounters = scopedCounters.length;
    const avgServiceTimeMins =
      allHydratedQueues.length > 0
        ? Number((allHydratedQueues.reduce((s, q) => s + q.avgServiceMinutes, 0) / allHydratedQueues.length).toFixed(1))
        : 4;
    const avgWaitTimeMins =
      allHydratedQueues.length > 0
        ? Math.round(allHydratedQueues.reduce((s, q) => s + q.predictedWaitMins, 0) / allHydratedQueues.length)
        : 0;
    const completedCount = scopedTokens.filter((t) => t.status === 'Completed').length;
    const visitorsServedToday = Math.max(
      completedCount,
      scopedQueues.reduce((s, q) => s + Math.max(0, q.servingNumber - 1), 0) +
        completedCount +
        Math.floor(db.metrics.processedDelta / 2)
    );

    const parseHr = (lbl: string) => {
      const m = lbl.trim().match(/^(\d{1,2})\s*(AM|PM)$/i);
      if (!m) return 10;
      let hr = Number(m[1]);
      if (m[2].toUpperCase() === 'PM' && hr < 12) hr += 12;
      if (m[2].toUpperCase() === 'AM' && hr === 12) hr = 0;
      return hr;
    };

    const buckets = new Map<string, { hour: string; hour24: number; footfall: number; waitSum: number; count: number }>();
    for (const f of targetFacilities) {
      for (const pt of db.hourlyTraffic[f.id] || []) {
        const cur = buckets.get(pt.hour);
        if (cur) {
          cur.footfall += pt.footfall;
          cur.waitSum += pt.avgWaitMins;
          cur.count += 1;
        } else {
          buckets.set(pt.hour, {
            hour: pt.hour,
            hour24: parseHr(pt.hour),
            footfall: pt.footfall,
            waitSum: pt.avgWaitMins,
            count: 1,
          });
        }
      }
    }

    const liveByHr = new Map<number, number>();
    for (const tok of scopedTokens) {
      const hr = getIstHourMinute(new Date(tok.createdAtMs || Date.now())).hour;
      liveByHr.set(hr, (liveByHr.get(hr) || 0) + 1);
    }

    const capRatio = totalCounters > 0 ? activeCounters / totalCounters : 1;
    const waitFactor = Math.max(0.65, Math.min(1.25, 1.15 - (capRatio - 0.65) * 0.65));
    const periodScale = period === 'monthly' ? 26 : period === 'weekly' ? 7 : 1;

    const rawDaily = Array.from(buckets.values())
      .sort((a, b) => a.hour24 - b.hour24)
      .map((b) => {
        const liveInHour = liveByHr.get(b.hour24) || 0;
        return {
          hour: b.hour,
          hour24: b.hour24,
          dailyFootfall: b.footfall + liveInHour,
          liveTokensCount: liveInHour,
          avgWaitMins: Math.max(2, Math.round((b.waitSum / Math.max(1, b.count)) * waitFactor + Math.min(6, liveInHour * 0.4))),
        };
      });

    const maxDaily = Math.max(1, ...rawDaily.map((h) => h.dailyFootfall));
    const peakCutoff = Math.max(55 * targetFacilities.length, Math.round(maxDaily * 0.72));
    const recCutoff = Math.round(maxDaily * 0.48);

    const hourlyFootfall = rawDaily.map((h, idx) => {
      const isPeak = h.dailyFootfall >= peakCutoff;
      const isRecommended = !isPeak && h.dailyFootfall <= recCutoff;
      const variance = period === 'daily' ? 1 : period === 'weekly' ? 0.94 + (idx % 3) * 0.05 : 0.96 + (idx % 4) * 0.03;
      const crowdLevel: CrowdLevel = isPeak ? 'High' : h.dailyFootfall >= Math.round(peakCutoff * 0.68) ? 'Medium' : 'Low';
      return {
        hour: h.hour,
        hour24: h.hour24,
        footfall: Math.round(h.dailyFootfall * periodScale * variance),
        liveTokensCount: h.liveTokensCount,
        avgWaitMins: h.avgWaitMins,
        isPeak,
        isRecommended,
        crowdLevel,
      };
    });

    const dailyVisitors = rawDaily.reduce((s, h) => s + h.dailyFootfall, 0) + Math.max(0, peopleInQueue - 5);
    const busiest = hourlyFootfall.reduce((best, cur) => (cur.footfall > best.footfall ? cur : best), hourlyFootfall[0] || { hour: '11 AM', footfall: 0, avgWaitMins: 0 });
    const peakSlots = hourlyFootfall.filter((h) => h.isPeak);
    const nonPeakSlots = hourlyFootfall.filter((h) => !h.isPeak);
    const peakAvgWaitMins = peakSlots.length > 0 ? Math.round(peakSlots.reduce((s, p) => s + p.avgWaitMins, 0) / peakSlots.length) : avgWaitTimeMins;
    const nonPeakAvgWaitMins = nonPeakSlots.length > 0 ? Math.round(nonPeakSlots.reduce((s, p) => s + p.avgWaitMins, 0) / nonPeakSlots.length) : Math.max(4, Math.round(avgWaitTimeMins * 0.55));

    const surgeAlerts = allHydratedQueues
      .filter((q) => q.waitingCount >= surgeThreshold || q.predictedWaitMins >= 15)
      .map((q) => {
        const facCounters = scopedCounters.filter((c) => c.facilityId === q.facilityId);
        const standby = facCounters.find((c) => c.status === 'Closed' && c.queueId === q.id) || facCounters.find((c) => c.status === 'Closed');
        return {
          id: `surge-${q.facilityId}-${q.id}`,
          facilityId: q.facilityId,
          facilityName: q.facilityName,
          queueId: q.id,
          queueName: q.name,
          departmentName: q.departmentName || 'General Services',
          title: `High Crowd Detected – ${q.name}`,
          waitingCount: q.waitingCount,
          threshold: surgeThreshold,
          predictedWaitMins: q.predictedWaitMins,
          recommendation: standby
            ? `Shift standby desk ${standby.label} (${standby.staffName}) to ${q.name} to cut wait time by ~45%.`
            : `Reassign available staff to assist ${q.name}.`,
          standbyCounterId: standby?.id || null,
          standbyCounterLabel: standby?.label || null,
          standbyStaffName: standby?.staffName || null,
        };
      });

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
        estimatedWaitMins: hq?.predictedWaitMins || 0,
        avgCycleMins: c.avgCycleMins,
      };
    });

    const queuePredictions = allHydratedQueues.map((q) => {
      const overThreshold = q.waitingCount >= surgeThreshold || q.predictedWaitMins >= 15;
      const approachingThreshold = !overThreshold && (q.waitingCount >= Math.max(2, surgeThreshold - 2) || q.predictedWaitMins >= 10);
      const crowdLevel: CrowdLevel = overThreshold ? 'High' : approachingThreshold ? 'Medium' : 'Low';
      const standby = scopedCounters.find((c) => c.facilityId === q.facilityId && c.status === 'Closed');
      return {
        queueId: q.id,
        queueName: q.name,
        facilityId: q.facilityId,
        facilityName: q.facilityName,
        departmentName: q.departmentName || 'General Services',
        waitingCount: q.waitingCount,
        activeCounters: q.activeCounters,
        avgServiceMinutes: q.avgServiceMinutes,
        predictedWaitMins: q.predictedWaitMins,
        crowdLevel,
        approachingThreshold,
        overThreshold,
        confidence: q.predictionConfidence,
        suggestedAction:
          overThreshold && standby
            ? `Open ${standby.label} (${standby.staffName}) to cut wait to ~${Math.max(2, Math.round((q.waitingCount * q.avgServiceMinutes) / (q.activeCounters + 1)))}m`
            : overThreshold
              ? `High load: reallocate staff to ${q.name}`
              : approachingThreshold
                ? `Approaching threshold (${q.waitingCount}/${surgeThreshold})`
                : 'Optimal counter allocation',
        suggestedCounterId: (overThreshold || approachingThreshold) && standby ? standby.id : null,
      };
    });

    const upcomingBusyHours = hourlyFootfall
      .slice()
      .sort((a, b) => b.footfall - a.footfall)
      .slice(0, 4)
      .sort((a, b) => a.hour24 - b.hour24)
      .map((slot) => ({
        hour: slot.hour,
        expectedVisitors: slot.footfall + (period === 'daily' ? Math.round(peopleInQueue * 0.35) : 0),
        predictedWaitMins: slot.avgWaitMins + (surgeAlerts.length > 0 ? 3 : 0),
        crowdLevel: (slot.isPeak ? 'High' : slot.avgWaitMins >= 12 ? 'Medium' : 'Low') as CrowdLevel,
        confidence: slot.isPeak ? 94 : 89,
        suggestedAction: slot.isPeak ? 'Open additional standby counter 15 mins prior' : 'Normal staffing sufficient',
      }));

    const digitalTokensServed = db.metrics.basePaperSlipsSaved + db.metrics.processedDelta + completedCount;
    const estimatedTimeSavedMinutes = (visitorsServedToday + peopleInQueue) * Math.max(12, Math.round(peakAvgWaitMins * 0.72));
    const standbyOpenedCount = scopedCounters.filter((c) => c.id === 'c3' && c.status !== 'Closed').length;
    const physicalWaitReductionPct = Math.min(62, 41 + standbyOpenedCount * 5);
    const estimatedCrowdReductionPct = Math.min(58, 36 + standbyOpenedCount * 6 + activeCounters);

    const payload: OrganisationAnalyticsDashboardResponse = {
      facilityId: scopeId,
      facilityName: scopeId === 'all' ? 'All Organisation Service Centers' : targetFacilities[0].name,
      period,
      surgeThreshold,
      overviewCards: {
        peopleInQueue,
        avgServiceTimeMins,
        avgWaitTimeMins,
        activeCounters,
        totalCounters,
        onTimeServiceRate: Math.max(78, Math.min(99, 96 - surgeAlerts.length * 2 + (activeCounters >= totalCounters ? 2 : 0))),
        visitorsServedToday,
      },
      visitorStats: {
        dailyVisitors,
        weeklyVisitors: Math.round(dailyVisitors * 6.85),
        monthlyVisitors: Math.round(dailyVisitors * 26.2),
        busiestHour: busiest.hour,
        busiestHourVisitors: busiest.footfall,
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
        estimatedTimeSavedHours: Math.round(estimatedTimeSavedMinutes / 60),
        physicalWaitReductionPct,
        digitalTokensServed,
        estimatedCrowdReductionPct,
        corridorVisitorsAvoided: Math.round((visitorsServedToday + peopleInQueue) * (estimatedCrowdReductionPct / 100)),
        sdg9InfraCalls: db.metrics.baseInfraCalls + db.metrics.processedDelta,
        sdg12PaperSlipsSaved: digitalTokensServed,
      },
      operators: db.users
        .filter((u) => u.role === 'operator' && u.accountStatus === 'active')
        .map((u) => ({ id: u.id, name: u.name, assignedFacilityId: u.assignedFacilityId, assignedCounterId: u.assignedCounterId })),
      availableQueues: scopedQueues.map((q) => ({
        id: q.id,
        facilityId: q.facilityId,
        facilityName: targetFacilities.find((f) => f.id === q.facilityId)?.name || q.facilityId,
        departmentId: q.departmentId,
        name: q.name,
      })),
    };
    return payload as T;
  }

  const analyticsMatch = path.match(/^\/api\/analytics\/([^/]+)\/summary$/);
  if (analyticsMatch && method === 'GET') {
    const facilityId = decodeURIComponent(analyticsMatch[1]);
    const snap = getSnapshot(db, facilityId);
    if (!snap) throw new StaticApiHttpError('Facility not found.', 404);

    const facCounters = db.counters.filter((c) => c.facilityId === facilityId);
    const activeCnt = facCounters.filter((c) => c.status === 'Serving' || c.status === 'Busy').length;
    const capRatio = facCounters.length > 0 ? activeCnt / facCounters.length : 1;
    const waitFactor = Math.max(0.65, Math.min(1.25, 1.15 - (capRatio - 0.65) * 0.65));

    const parseHr = (lbl: string) => {
      const m = lbl.trim().match(/^(\d{1,2})\s*(AM|PM)$/i);
      if (!m) return 10;
      let hr = Number(m[1]);
      if (m[2].toUpperCase() === 'PM' && hr < 12) hr += 12;
      if (m[2].toUpperCase() === 'AM' && hr === 12) hr = 0;
      return hr;
    };

    const liveByHr = new Map<number, number>();
    for (const tok of db.tokens.filter((t) => t.facilityId === facilityId)) {
      const hr = getIstHourMinute(new Date(tok.createdAtMs || Date.now())).hour;
      liveByHr.set(hr, (liveByHr.get(hr) || 0) + 1);
    }

    const baseTraffic = db.hourlyTraffic[facilityId] || [];
    const adjusted = baseTraffic.map((pt) => {
      const hr24 = parseHr(pt.hour);
      const liveInHr = liveByHr.get(hr24) || 0;
      return {
        hour: pt.hour,
        hour24: hr24,
        footfall: pt.footfall + liveInHr,
        liveTokensCount: liveInHr,
        avgWaitMins: Math.max(2, Math.round(pt.avgWaitMins * waitFactor + Math.min(6, liveInHr * 0.4))),
      };
    });

    const maxFootfall = Math.max(1, ...adjusted.map((h) => h.footfall));
    const peakCutoff = Math.max(55, Math.round(maxFootfall * 0.72));
    const recCutoff = Math.round(maxFootfall * 0.48);

    const hourlyTraffic = adjusted.map((h) => {
      const isPeak = h.footfall >= peakCutoff;
      const isRecommended = !isPeak && h.footfall <= recCutoff;
      return {
        hour: h.hour,
        footfall: h.footfall,
        avgWaitMins: h.avgWaitMins,
        isPeak,
        isRecommended,
      };
    });

    const peakHours = hourlyTraffic.filter((h) => h.isPeak).map((h) => h.hour);
    const recommendedHours = hourlyTraffic.filter((h) => h.isRecommended).map((h) => h.hour);

    return {
      facilityId,
      hourlyTraffic,
      peakHours,
      recommendedHours,
      recommendationText:
        recommendedHours.length > 0
          ? `Shift non-urgent follow-ups from ${peakHours.join('–') || 'peak hours'} to ${recommendedHours[0]}.`
          : 'Queue flow balanced across current hours.',
      queues: snap.queues,
      sdgImpact: {
        sdg9InfraCalls: db.metrics.baseInfraCalls + db.metrics.processedDelta,
        sdg11CorridorDensityReduction: '-41%',
        sdg12PaperSlipsSaved: db.metrics.basePaperSlipsSaved + db.metrics.processedDelta,
      },
    } as T;
  }

  // Admin routes
  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'admin') throw new StaticApiHttpError('Forbidden. Requires role: admin.', 403);

    if (path === '/api/admin/overview' && method === 'GET') {
      const centersSummary = db.facilities.map((f) => {
        const snap = getSnapshot(db, f.id)!;
        return {
          facilityId: f.id,
          name: f.name,
          city: f.city,
          isActive: f.isActive,
          waiting: snap.summary.totalWaiting,
          activeCounters: snap.summary.activeCountersCount,
          totalCounters: snap.summary.totalCountersCount,
          avgWaitMins: snap.summary.avgWaitMins,
          hasSurge: Boolean(snap.surgeAlert?.active),
        };
      });
      return {
        kpis: {
          totalCitizens: db.users.filter((u) => u.role === 'citizen').length,
          totalOperators: db.users.filter((u) => u.role === 'operator').length,
          totalFacilities: db.facilities.length,
          totalDepartments: db.departments.length,
          activeCounters: db.counters.filter((c) => c.status === 'Serving' || c.status === 'Busy').length,
          totalCounters: db.counters.length,
          totalTokensToday: db.tokens.length,
          waitingTokens: db.tokens.filter((t) => ['Waiting', 'Called', 'Serving', 'Grace'].includes(t.status)).length,
          completedTokens: db.tokens.filter((t) => t.status === 'Completed').length,
          cancelledTokens: db.tokens.filter((t) => ['Cancelled', 'Skipped', 'NoShow'].includes(t.status)).length,
          avgWaitMins:
            centersSummary.length > 0
              ? Math.round(centersSummary.reduce((s, c) => s + c.avgWaitMins, 0) / centersSummary.length)
              : 0,
        },
        centersSummary,
        hourlyTraffic: db.hourlyTraffic[db.facilities[0]?.id || 'vja-hospital'] || [],
        recentAuditLogs: db.auditLogs.slice(0, 15),
      } as T;
    }

    if (path === '/api/admin/users' && method === 'GET') {
      const roleFilter = parsedUrl.searchParams.get('role') || 'all';
      const statusFilter = parsedUrl.searchParams.get('status') || 'all';
      const search = (parsedUrl.searchParams.get('search') || '').trim().toLowerCase();
      const users = db.users
        .filter((u) => {
          const matchRole = roleFilter === 'all' || u.role === roleFilter;
          const matchStatus = statusFilter === 'all' || u.accountStatus === statusFilter;
          const matchSearch =
            !search ||
            u.name.toLowerCase().includes(search) ||
            u.email.toLowerCase().includes(search) ||
            u.id.toLowerCase().includes(search);
          return matchRole && matchStatus && matchSearch;
        })
        .map(toPublicUser);
      return { users } as T;
    }

    if (path === '/api/admin/users' && method === 'POST') {
      const assignedRole = normalizeRole((body.role as string) || 'operator');
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      if (!name || !email) throw new StaticApiHttpError('Name and email are required.', 400);
      if (db.users.some((u) => u.email.toLowerCase() === email)) {
        throw new StaticApiHttpError('A user with this email already exists.', 409);
      }
      const created: StoredUser = {
        id: uid('usr'),
        name,
        email,
        phone: (body.phone as string)?.trim() || undefined,
        role: assignedRole,
        accountStatus: 'active',
        organisationId: assignedRole !== 'citizen' ? 'org-ap-health' : undefined,
        assignedFacilityId: body.assignedFacilityId as string | undefined,
        assignedDepartmentId: body.assignedDepartmentId as string | undefined,
        assignedCounterId: body.assignedCounterId as string | undefined,
        shift: (body.shift as string) || 'Morning (08:00 – 14:00)',
        trustScore: assignedRole === 'citizen' ? 95 : 100,
        password: String(body.password || ''),
        createdAt: new Date().toISOString(),
      };
      db.users.push(created);
      saveDb(db);
      return { user: toPublicUser(created) } as T;
    }

    const adminUserPatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserPatch && method === 'PATCH') {
      const target = db.users.find((u) => u.id === decodeURIComponent(adminUserPatch[1]));
      if (!target) throw new StaticApiHttpError('User not found.', 404);
      if (body.role) target.role = normalizeRole(String(body.role));
      if (body.accountStatus) target.accountStatus = body.accountStatus as AccountStatus;
      if (body.assignedFacilityId !== undefined) target.assignedFacilityId = body.assignedFacilityId as string;
      if (body.assignedDepartmentId !== undefined) target.assignedDepartmentId = body.assignedDepartmentId as string;
      if (body.assignedCounterId !== undefined) target.assignedCounterId = body.assignedCounterId as string;
      if (body.shift !== undefined) target.shift = body.shift as string;
      saveDb(db);
      return { user: toPublicUser(target) } as T;
    }

    if (path === '/api/admin/facilities' && method === 'GET') {
      const facilities = db.facilities.map((f) => {
        const snap = getSnapshot(db, f.id);
        return {
          ...f,
          departmentsCount: db.departments.filter((d) => d.facilityId === f.id).length,
          queuesCount: db.queues.filter((q) => q.facilityId === f.id).length,
          countersCount: db.counters.filter((c) => c.facilityId === f.id).length,
          waitingCount: snap?.summary.totalWaiting || 0,
          avgWaitMins: snap?.summary.avgWaitMins || 0,
        };
      });
      return { facilities } as T;
    }

    if (path === '/api/admin/facilities' && method === 'POST') {
      const name = String(body.name || '').trim();
      const city = String(body.city || '').trim();
      const facility: StoredFacility = {
        id: uid('fac'),
        organisationId: 'org-ap-health',
        name,
        city,
        code: `SQ-${city.slice(0, 3).toUpperCase()}-01`,
        address: String(body.address || `${city} Main Civic Campus`),
        phone: body.phone as string | undefined,
        workingHours: String(body.workingHours || '08:00 – 18:00'),
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      db.facilities.push(facility);
      db.hourlyTraffic[facility.id] = db.hourlyTraffic['vja-hospital'] || [];
      saveDb(db);
      return { facility } as T;
    }

    const adminFacPatch = path.match(/^\/api\/admin\/facilities\/([^/]+)$/);
    if (adminFacPatch && method === 'PATCH') {
      const fac = db.facilities.find((f) => f.id === decodeURIComponent(adminFacPatch[1]));
      if (!fac) throw new StaticApiHttpError('Facility not found.', 404);
      Object.assign(fac, body);
      saveDb(db);
      return { facility: fac } as T;
    }

    if (path === '/api/admin/departments' && method === 'GET') {
      const facilityId = parsedUrl.searchParams.get('facilityId');
      const departments = db.departments
        .filter((d) => !facilityId || d.facilityId === facilityId)
        .map((d) => ({
          ...d,
          facilityName: db.facilities.find((f) => f.id === d.facilityId)?.name || d.facilityId,
          services: db.queues.filter((q) => q.departmentId === d.id),
        }));
      return { departments } as T;
    }

    if (path === '/api/admin/departments' && method === 'POST') {
      const dept: StoredDepartment = {
        id: uid('dept'),
        facilityId: String(body.facilityId),
        name: String(body.name || ''),
        code: String(body.code || 'GEN').toUpperCase(),
        floorOrWing: String(body.floorOrWing || 'Ground Floor'),
        description: String(body.description || 'Service department'),
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      db.departments.push(dept);
      saveDb(db);
      return { department: dept } as T;
    }

    const adminDeptPatch = path.match(/^\/api\/admin\/departments\/([^/]+)$/);
    if (adminDeptPatch && method === 'PATCH') {
      const dept = db.departments.find((d) => d.id === decodeURIComponent(adminDeptPatch[1]));
      if (!dept) throw new StaticApiHttpError('Department not found.', 404);
      Object.assign(dept, body);
      saveDb(db);
      return { department: dept } as T;
    }

    if (path === '/api/admin/queues' && method === 'POST') {
      const q: StoredQueue = {
        id: uid('queue'),
        facilityId: String(body.facilityId),
        departmentId: String(body.departmentId || 'dept-opd'),
        prefix: String(body.prefix || 'Q').toUpperCase().slice(0, 2),
        name: String(body.name || 'Service Queue'),
        location: String(body.location || 'Desk 1'),
        priority: (body.priority as QueuePriority) || 'standard',
        fee: 'Standard',
        avgServiceMinutes: Math.max(1, Number(body.avgServiceMinutes) || 4),
        servingNumber: 1,
        nextIssueNumber: 1,
        predictionConfidence: 94,
        isActive: true,
        isPaused: false,
      };
      db.queues.push(q);
      saveDb(db);
      return { queue: q } as T;
    }

    const adminQueuePatch = path.match(/^\/api\/admin\/queues\/([^/]+)$/);
    if (adminQueuePatch && method === 'PATCH') {
      const q = db.queues.find((item) => item.id === decodeURIComponent(adminQueuePatch[1]));
      if (!q) throw new StaticApiHttpError('Queue not found.', 404);
      Object.assign(q, body);
      saveDb(db);
      return { queue: q } as T;
    }

    if (path === '/api/admin/counters' && method === 'GET') {
      const facilityId = parsedUrl.searchParams.get('facilityId');
      const counters = db.counters
        .filter((c) => !facilityId || c.facilityId === facilityId)
        .map((c) => ({
          ...c,
          facilityName: db.facilities.find((f) => f.id === c.facilityId)?.name || c.facilityId,
          departmentName: db.departments.find((d) => d.id === c.departmentId)?.name || 'General',
          queueName: db.queues.find((q) => q.id === c.queueId)?.name || 'General Queue',
        }));
      return { counters } as T;
    }

    if (path === '/api/admin/counters' && method === 'POST') {
      const q = db.queues.find((fq) => fq.id === body.queueId && fq.facilityId === body.facilityId);
      const cnt: StoredCounter = {
        id: uid('cnt'),
        facilityId: String(body.facilityId),
        departmentId: String(body.departmentId || q?.departmentId || 'dept-opd'),
        label: String(body.label || 'Counter'),
        staffName: String(body.staffName || 'Unassigned'),
        assignedOperatorId: body.assignedOperatorId as string | undefined,
        queueId: String(body.queueId),
        status: (body.status as CounterStatus) || 'Serving',
        currentToken: q ? `${q.prefix}-${q.servingNumber}` : '—',
        avgCycleMins: q?.avgServiceMinutes || 4,
      };
      db.counters.push(cnt);
      saveDb(db);
      return { counter: cnt } as T;
    }

    const adminCounterPatch = path.match(/^\/api\/admin\/counters\/([^/]+)$/);
    if (adminCounterPatch && method === 'PATCH') {
      const cnt = db.counters.find((c) => c.id === decodeURIComponent(adminCounterPatch[1]));
      if (!cnt) throw new StaticApiHttpError('Counter not found.', 404);
      Object.assign(cnt, body);
      saveDb(db);
      emitStaticEvent(cnt.facilityId, 'counter:updated', { counter: cnt });
      return { counter: cnt } as T;
    }

    if (path === '/api/admin/counters/reallocate' && method === 'POST') {
      const cnt = db.counters.find((c) => c.id === String(body.counterId || ''));
      if (!cnt) throw new StaticApiHttpError('Counter not found.', 404);
      if (body.targetQueueId) {
        const q = db.queues.find((fq) => fq.id === body.targetQueueId && fq.facilityId === cnt.facilityId);
        if (!q) throw new StaticApiHttpError('Target queue not found.', 404);
        cnt.queueId = q.id;
        cnt.departmentId = q.departmentId;
        cnt.avgCycleMins = q.avgServiceMinutes;
        cnt.currentToken = `${q.prefix}-${q.servingNumber}`;
      }
      if (body.operatorId) {
        const op = db.users.find((u) => u.id === body.operatorId && u.role === 'operator');
        if (op) {
          cnt.assignedOperatorId = op.id;
          cnt.staffName = op.name;
        }
      } else if (typeof body.staffName === 'string' && body.staffName.trim()) {
        cnt.staffName = body.staffName.trim();
      }
      cnt.status = (body.status as CounterStatus) || 'Serving';
      saveDb(db);
      const snapshot = getSnapshot(db, cnt.facilityId)!;
      emitStaticEvent(cnt.facilityId, 'counter:updated', { counter: cnt, snapshot });
      return { counter: cnt, snapshot } as T;
    }

    if (path === '/api/admin/queues/monitor' && method === 'GET') {
      const facilityId = parsedUrl.searchParams.get('facilityId') || 'all';
      const facs = facilityId === 'all' ? db.facilities : db.facilities.filter((f) => f.id === facilityId);
      const queues = facs.flatMap((f) =>
        (getSnapshot(db, f.id)?.queues || []).map((q) => ({ ...q, facilityName: f.name, overloaded: q.waitingCount >= 6 }))
      );
      const activeTokens = facs.flatMap((f) =>
        (getSnapshot(db, f.id)?.roster || []).map((t) => ({ ...t, facilityName: f.name }))
      );
      const surgeAlerts = facs
        .map((f) => {
          const s = getSnapshot(db, f.id)?.surgeAlert;
          return s ? { facilityName: f.name, facilityId: f.id, ...s } : null;
        })
        .filter(Boolean);
      return { queues, activeTokens, surgeAlerts } as T;
    }

    if (path === '/api/admin/reports' && method === 'GET') {
      const period = parsedUrl.searchParams.get('period') || 'daily';
      const facilityId = parsedUrl.searchParams.get('facilityId') || 'all';
      const mult = period === 'monthly' ? 26 : period === 'weekly' ? 7 : 1;
      const scoped = db.tokens.filter((t) => facilityId === 'all' || t.facilityId === facilityId);
      const completed = scoped.filter((t) => t.status === 'Completed').length * mult;
      const cancelled = scoped.filter((t) => ['Cancelled', 'Skipped', 'NoShow'].includes(t.status)).length * mult;
      return {
        period,
        facilityId,
        summary: {
          totalGenerated: scoped.length * mult,
          completed,
          cancelled,
          active: scoped.filter((t) => ['Waiting', 'Called', 'Serving', 'Grace'].includes(t.status)).length,
          completionRate: completed + cancelled > 0 ? Math.round((completed / (completed + cancelled)) * 100) : 100,
        },
        departmentPerformance: db.departments
          .filter((d) => facilityId === 'all' || d.facilityId === facilityId)
          .map((d) => ({
            departmentId: d.id,
            departmentName: d.name,
            facilityName: db.facilities.find((f) => f.id === d.facilityId)?.name || d.facilityId,
            totalTokens: scoped.filter((t) => t.departmentId === d.id).length * mult,
            completed: scoped.filter((t) => t.departmentId === d.id && t.status === 'Completed').length * mult,
            cancelled: 0,
            avgWaitMins: 8,
          })),
        counterPerformance: db.counters
          .filter((c) => facilityId === 'all' || c.facilityId === facilityId)
          .map((c) => ({
            counterId: c.id,
            label: c.label,
            staffName: c.staffName,
            facilityName: db.facilities.find((f) => f.id === c.facilityId)?.name || c.facilityId,
            status: c.status,
            tokensHandled: scoped.filter((t) => t.counterId === c.id).length * mult,
            completed: scoped.filter((t) => t.counterId === c.id && t.status === 'Completed').length * mult,
            avgCycleMins: c.avgCycleMins,
          })),
        centerComparison: db.facilities.map((f) => {
          const snap = getSnapshot(db, f.id)!;
          return {
            facilityId: f.id,
            name: f.name,
            city: f.city,
            totalTokens: db.tokens.filter((t) => t.facilityId === f.id).length * mult,
            waiting: snap.summary.totalWaiting,
            avgWaitMins: snap.summary.avgWaitMins,
            activeCounters: snap.summary.activeCountersCount,
          };
        }),
        hourlyTraffic: (db.hourlyTraffic[facilityId] || db.hourlyTraffic['vja-hospital'] || []).map((h) => ({
          ...h,
          footfall: h.footfall * mult,
        })),
        sdgImpact: {
          sdg9InfraCalls: (db.metrics.baseInfraCalls + db.metrics.processedDelta) * mult,
          sdg11CorridorDensityReduction: '-43%',
          sdg12PaperSlipsSaved: (db.metrics.basePaperSlipsSaved + db.metrics.processedDelta) * mult,
        },
      } as T;
    }

    if (path === '/api/admin/settings' && method === 'GET') {
      return { settings: db.settings } as T;
    }

    if (path === '/api/admin/settings' && method === 'PATCH') {
      Object.assign(db.settings, body, { updatedAt: new Date().toISOString() });
      saveDb(db);
      return { settings: db.settings } as T;
    }

    if (path === '/api/admin/audit-logs' && method === 'GET') {
      const limit = Math.min(100, Number(parsedUrl.searchParams.get('limit')) || 50);
      return { logs: db.auditLogs.slice(0, limit) } as T;
    }
  }

  throw new StaticApiHttpError(`Endpoint not available: ${method} ${path}`, 404);
}
