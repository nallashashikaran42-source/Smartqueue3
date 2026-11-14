import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type { ApiTokenRecord, AuthUser } from './services/api';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const TERMINAL_STATUSES = new Set(['Completed', 'Cancelled', 'Skipped', 'NoShow']);
const OWNER_ADMIN_EMAILS = new Set([
  'shahsikarnann@gmail.com',
  'nallashashikaran42@gmail.com',
  'shashikirannalla6@gmail.com',
]);

function sanitizeString(value: string | undefined, maxLength: number, fallback = ''): string {
  const trimmed = (value ?? '').trim() || fallback.trim();
  return trimmed.slice(0, maxLength);
}

export async function syncUserToFirestore(
  firebaseUser: FirebaseUser,
  appUser: AuthUser
): Promise<void> {
  if (!auth.currentUser || auth.currentUser.uid !== firebaseUser.uid) return;
  if (!VALID_ID_REGEX.test(firebaseUser.uid) || firebaseUser.uid.length > 128) return;

  const userPath = `users/${firebaseUser.uid}`;
  const userRef = doc(db, 'users', firebaseUser.uid);

  const displayName = sanitizeString(
    appUser.name || firebaseUser.displayName || firebaseUser.email?.split('@')[0],
    120,
    'SmartQueue User'
  );
  const rawPhoto = appUser.profilePhoto || firebaseUser.photoURL || '';
  const photoURL = rawPhoto && !rawPhoto.startsWith('data:') ? sanitizeString(rawPhoto, 2048) : '';
  const normalizedEmail = (firebaseUser.email || appUser.email || '').trim().toLowerCase();
  const isOwnerAdmin =
    OWNER_ADMIN_EMAILS.has(normalizedEmail) &&
    firebaseUser.emailVerified &&
    appUser.role === 'admin';

  try {
    const existingSnap = await getDoc(userRef);
    if (!existingSnap.exists()) {
      const payload: Record<string, unknown> = {
        uid: firebaseUser.uid,
        displayName,
        role: isOwnerAdmin ? 'admin' : 'citizen',
        accountStatus: 'active',
        trustScore: isOwnerAdmin ? 100 : 95,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (photoURL) {
        payload.photoURL = photoURL;
      }
      await setDoc(userRef, payload);
    } else {
      const updatePayload: Record<string, unknown> = {
        displayName,
        updatedAt: serverTimestamp(),
      };
      if (photoURL) {
        updatePayload.photoURL = photoURL;
      }
      if (isOwnerAdmin && existingSnap.data()?.role !== 'admin') {
        updatePayload.role = 'admin';
        updatePayload.trustScore = 100;
      }
      await updateDoc(userRef, updatePayload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }

  const privatePath = `users/${firebaseUser.uid}/private/info`;
  const privateRef = doc(db, 'users', firebaseUser.uid, 'private', 'info');
  try {
    const existingPrivate = await getDoc(privateRef);
    const phone = sanitizeString(appUser.phone, 32);
    if (!existingPrivate.exists()) {
      const email = sanitizeString(normalizedEmail, 254);
      if (email.length >= 3) {
        const privatePayload: Record<string, unknown> = {
          uid: firebaseUser.uid,
          email,
          updatedAt: serverTimestamp(),
        };
        if (phone) {
          privatePayload.phone = phone;
        }
        await setDoc(privateRef, privatePayload);
      }
    } else if (phone) {
      await updateDoc(privateRef, {
        phone,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, privatePath);
  }
}

export async function syncTicketToFirestore(
  uid: string,
  token: ApiTokenRecord,
  facilityName: string
): Promise<void> {
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;
  if (
    !VALID_ID_REGEX.test(uid) ||
    !VALID_ID_REGEX.test(token.tokenId) ||
    !VALID_ID_REGEX.test(token.facilityId) ||
    !VALID_ID_REGEX.test(token.queueId)
  ) {
    return;
  }

  const ticketPath = `users/${uid}/tickets/${token.tokenId}`;
  const ticketRef = doc(db, 'users', uid, 'tickets', token.tokenId);

  try {
    const existingSnap = await getDoc(ticketRef);
    if (!existingSnap.exists()) {
      if (token.status !== 'Waiting') return;
      const displayJoinedOrSlot = token.appointmentSlot
        ? sanitizeString(
            `${token.appointmentDate || ''} · ${token.appointmentSlot}`.replace(/^\s*·\s*/, ''),
            64,
            token.joinedAt
          )
        : sanitizeString(token.joinedAt, 64, 'Just now');
      await setDoc(ticketRef, {
        tokenId: sanitizeString(token.tokenId, 64),
        uid,
        facilityId: sanitizeString(token.facilityId, 64),
        facilityName: sanitizeString(facilityName, 120, 'Service Center'),
        queueId: sanitizeString(token.queueId, 64),
        queueName: sanitizeString(token.queueName, 120, 'Queue'),
        status: token.status,
        joinedAt: displayJoinedOrSlot,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const prevStatus = existingSnap.data()?.status as string | undefined;
      if (prevStatus && TERMINAL_STATUSES.has(prevStatus)) {
        return;
      }
      if (prevStatus !== token.status) {
        await updateDoc(ticketRef, {
          status: token.status,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, ticketPath);
  }
}

export interface FirestoreTicketItem {
  tokenId: string;
  facilityName: string;
  queueName: string;
  status: string;
  joinedAt: string;
}

export function subscribeToUserTickets(
  uid: string,
  onTickets: (tickets: FirestoreTicketItem[]) => void
): Unsubscribe {
  const path = `users/${uid}/tickets`;
  const q = query(collection(db, 'users', uid, 'tickets'), where('uid', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const docsWithOrder = snapshot.docs.map((d) => {
        const data = d.data();
        const createdAtMs =
          data.createdAt && typeof data.createdAt.toMillis === 'function'
            ? data.createdAt.toMillis()
            : 0;
        return {
          createdAtMs,
          item: {
            tokenId: String(data.tokenId || d.id),
            facilityName: String(data.facilityName || ''),
            queueName: String(data.queueName || ''),
            status: String(data.status || 'Waiting'),
            joinedAt: String(data.joinedAt || ''),
          },
        };
      });
      docsWithOrder.sort((a, b) => b.createdAtMs - a.createdAtMs);
      onTickets(docsWithOrder.map((entry) => entry.item));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}
