import { MongoClient, type Db } from 'mongodb';
import { ENV } from '../config/env.ts';
import type {
  AuditLogRecord,
  CounterRecord,
  DepartmentRecord,
  FacilityRecord,
  HourlyTrafficRecord,
  NotificationRecord,
  OrganisationRecord,
  RefreshSessionRecord,
  ServiceQueueRecord,
  SmartQueueDatabase,
  SwapRequestRecord,
  SystemSettingsRecord,
  TokenRecord,
  UserRecord,
} from '../models/types.ts';

type StringIdDoc<T extends object> = Omit<T, '_id'> & { _id: string };

interface AppConfigDoc {
  _id: string;
  settings: SystemSettingsRecord;
  hourlyTraffic: Record<string, HourlyTrafficRecord[]>;
  metrics: {
    baseInfraCalls: number;
    basePaperSlipsSaved: number;
    processedDelta: number;
  };
  updatedAt: string;
}

class MongoPersistence {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connected = false;
  private lastError: string | null = null;

  async connect(): Promise<boolean> {
    if (!ENV.MONGODB_URI) {
      this.connected = false;
      this.lastError = 'MONGODB_URI is not configured.';
      return false;
    }
    if (this.connected && this.db) {
      return true;
    }

    try {
      this.client = new MongoClient(ENV.MONGODB_URI, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
      });
      await this.client.connect();
      this.db = this.client.db(ENV.MONGODB_DB_NAME);
      await this.db.command({ ping: 1 });
      this.connected = true;
      this.lastError = null;
      console.log(`Connected to MongoDB database "${ENV.MONGODB_DB_NAME}".`);
      return true;
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : 'Unable to connect to MongoDB.';
      console.error('MongoDB connection failed, using local JSON fallback:', this.lastError);
      try {
        await this.client?.close();
      } catch {
        // Ignore cleanup errors
      }
      this.client = null;
      this.db = null;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.db !== null;
  }

  getStatus(): { connected: boolean; dbName: string; lastError: string | null } {
    return {
      connected: this.isConnected(),
      dbName: ENV.MONGODB_DB_NAME,
      lastError: this.lastError,
    };
  }

  private stripMongoId<T extends object>(doc: T & { _id?: unknown }): T {
    const { _id: _ignored, ...rest } = doc;
    return rest as T;
  }

  async loadDatabase(): Promise<Partial<SmartQueueDatabase> | null> {
    if (!this.db) return null;

    const [
      users,
      organisations,
      facilities,
      departments,
      queues,
      counters,
      tokens,
      swaps,
      notifications,
      auditLogs,
      refreshSessions,
      configDoc,
    ] = await Promise.all([
      this.db.collection<StringIdDoc<UserRecord>>('users').find({}).toArray(),
      this.db.collection<StringIdDoc<OrganisationRecord>>('organisations').find({}).toArray(),
      this.db.collection<StringIdDoc<FacilityRecord>>('facilities').find({}).toArray(),
      this.db.collection<StringIdDoc<DepartmentRecord>>('departments').find({}).toArray(),
      this.db.collection<StringIdDoc<ServiceQueueRecord>>('queues').find({}).toArray(),
      this.db.collection<StringIdDoc<CounterRecord>>('counters').find({}).toArray(),
      this.db.collection<StringIdDoc<TokenRecord>>('tokens').find({}).toArray(),
      this.db.collection<StringIdDoc<SwapRequestRecord>>('swaps').find({}).toArray(),
      this.db.collection<StringIdDoc<NotificationRecord>>('notifications').find({}).toArray(),
      this.db.collection<StringIdDoc<AuditLogRecord>>('audit_logs').find({}).toArray(),
      this.db.collection<StringIdDoc<RefreshSessionRecord>>('refresh_sessions').find({}).toArray(),
      this.db.collection<AppConfigDoc>('app_config').findOne({ _id: 'global' }),
    ]);

    if (facilities.length === 0 && queues.length === 0 && users.length === 0) {
      return null;
    }

    return {
      users: users.map((d) => this.stripMongoId(d)),
      organisations: organisations.map((d) => this.stripMongoId(d)),
      facilities: facilities.map((d) => this.stripMongoId(d)),
      departments: departments.map((d) => this.stripMongoId(d)),
      queues: queues.map((d) => this.stripMongoId(d)),
      counters: counters.map((d) => this.stripMongoId(d)),
      tokens: tokens.map((d) => this.stripMongoId(d)),
      swaps: swaps.map((d) => this.stripMongoId(d)),
      notifications: notifications.map((d) => this.stripMongoId(d)),
      auditLogs: auditLogs.map((d) => this.stripMongoId(d)),
      refreshSessions: refreshSessions.map((d) => this.stripMongoId(d)),
      settings: configDoc?.settings,
      hourlyTraffic: configDoc?.hourlyTraffic,
      metrics: configDoc?.metrics,
    };
  }

  private async replaceCollection<T extends object>(
    collectionName: string,
    items: T[],
    getKey: (item: T) => string
  ): Promise<void> {
    if (!this.db) return;
    interface MongoStringRecord {
      _id: string;
      [key: string]: unknown;
    }
    const col = this.db.collection<MongoStringRecord>(collectionName);

    if (items.length === 0) {
      await col.deleteMany({});
      return;
    }

    const entries = items.map((item) => {
      const { _id: _ignored, ...rest } = item as T & { _id?: unknown };
      return {
        key: getKey(item),
        replacement: rest as Record<string, unknown>,
      };
    });

    const keys = entries.map((e) => e.key);
    await col.bulkWrite(
      entries.map((entry) => ({
        replaceOne: {
          filter: { _id: entry.key },
          replacement: entry.replacement,
          upsert: true,
        },
      })),
      { ordered: false }
    );
    await col.deleteMany({ _id: { $nin: keys } });
  }

  async saveDatabase(snapshot: SmartQueueDatabase): Promise<void> {
    if (!this.db) return;

    await Promise.all([
      this.replaceCollection('users', snapshot.users, (u) => u.id),
      this.replaceCollection('organisations', snapshot.organisations, (o) => o.id),
      this.replaceCollection('facilities', snapshot.facilities, (f) => f.id),
      this.replaceCollection('departments', snapshot.departments, (d) => d.id),
      this.replaceCollection('queues', snapshot.queues, (q) => q.id),
      this.replaceCollection('counters', snapshot.counters, (c) => c.id),
      this.replaceCollection(
        'tokens',
        snapshot.tokens,
        (t) => `${t.facilityId}::${t.tokenId}::${t.createdAtMs}`
      ),
      this.replaceCollection('swaps', snapshot.swaps, (s) => s.id),
      this.replaceCollection('notifications', snapshot.notifications, (n) => n.id),
      this.replaceCollection('audit_logs', snapshot.auditLogs, (a) => a.id),
      this.replaceCollection('refresh_sessions', snapshot.refreshSessions, (r) => r.tokenId),
      this.db.collection<AppConfigDoc>('app_config').replaceOne(
        { _id: 'global' },
        {
          settings: snapshot.settings,
          hourlyTraffic: snapshot.hourlyTraffic,
          metrics: snapshot.metrics,
          updatedAt: new Date().toISOString(),
        },
        { upsert: true }
      ),
    ]);
  }
}

export const mongoPersistence = new MongoPersistence();
