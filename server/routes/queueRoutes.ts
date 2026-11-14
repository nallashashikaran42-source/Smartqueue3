import { Router } from 'express';
import { dbStore } from '../db/store.ts';
import { requireAuth, requireRole } from '../middleware/authMiddleware.ts';
import type { EntryChannel } from '../models/types.ts';
import {
  acceptSwapRequest,
  activateGraceSlot,
  broadcastFacilitySnapshot,
  callNextAtCounter,
  cancelToken,
  checkInGraceSlot,
  createSwapRequest,
  getAppointmentSlots,
  getFacilitySnapshot,
  issueToken,
  verifyAndCheckInQr,
} from '../services/queueEngine.ts';

export const queueRoutes = Router();

// Get authoritative live queue snapshot for a facility (authenticated users)
queueRoutes.get('/:facilityId/state', requireAuth, (req, res) => {
  const { facilityId } = req.params;
  const snapshot = getFacilitySnapshot(facilityId);
  if (!snapshot) {
    res.status(404).json({ error: `Facility '${facilityId}' not found.` });
    return;
  }
  res.json(snapshot);
});

// Get available pre-booking time slots for a service queue & date
queueRoutes.get('/:facilityId/slots', requireAuth, (req, res) => {
  const { facilityId } = req.params;
  const queueId = (req.query.queueId as string) || '';
  const date = req.query.date as string | undefined;

  if (!queueId) {
    res.status(400).json({ error: 'queueId query parameter is required.' });
    return;
  }

  const slots = getAppointmentSlots({ facilityId, queueId, date });
  if (!slots) {
    res.status(404).json({ error: `Queue '${queueId}' in facility '${facilityId}' not found.` });
    return;
  }
  res.json(slots);
});

// Issue a digital token (App QR, Missed Call, SMS, Audio Kiosk) with optional pre-booked appointment time
queueRoutes.post('/:facilityId/tokens', requireAuth, (req, res) => {
  const { facilityId } = req.params;
  const { queueId, channel, citizenName, appointmentDate, appointmentSlot, isPreBooked } =
    req.body as {
      queueId?: string;
      channel?: EntryChannel;
      citizenName?: string;
      appointmentDate?: string;
      appointmentSlot?: string;
      isPreBooked?: boolean;
    };

  if (!queueId) {
    res.status(400).json({ error: 'queueId is required to issue a token.' });
    return;
  }

  const db = dbStore.getState();
  const user = db.users.find((u) => u.id === req.authUser?.sub);

  try {
    const result = issueToken({
      facilityId,
      queueId,
      channel: channel || 'App QR',
      citizenName: citizenName || user?.name,
      userId: req.authUser?.sub,
      appointmentDate,
      appointmentSlot,
      isPreBooked,
    });
    broadcastFacilitySnapshot(facilityId, 'token:issued', { token: result.token });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to issue token.',
    });
  }
});

// Verify QR payload & check in an appointment into the active queue on its appointment day (IST)
queueRoutes.post('/:facilityId/check-in-qr', requireAuth, (req, res) => {
  const { facilityId } = req.params;
  const { qrPayload, tokenId, queueId, departmentId } = req.body as {
    qrPayload?: string;
    tokenId?: string;
    queueId?: string;
    departmentId?: string;
  };

  if (!qrPayload && !tokenId) {
    res.status(400).json({ error: 'qrPayload or tokenId is required to check in.' });
    return;
  }

  const db = dbStore.getState();
  const actorUser = db.users.find((u) => u.id === req.authUser?.sub);

  try {
    const result = verifyAndCheckInQr({
      facilityId,
      qrPayload,
      tokenId,
      queueId,
      departmentId,
      actor: req.authUser
        ? {
            id: req.authUser.sub,
            role: req.authUser.role,
            name: actorUser?.name || 'Citizen',
          }
        : undefined,
    });
    broadcastFacilitySnapshot(facilityId, 'token:checked-in', {
      tokenId: result.token.tokenId,
      token: result.token,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'QR check-in failed.',
    });
  }
});

// Cancel an active token & free queue capacity
queueRoutes.post('/:facilityId/tokens/:tokenId/cancel', requireAuth, (req, res) => {
  const { facilityId, tokenId } = req.params;
  const db = dbStore.getState();
  const actorUser = db.users.find((u) => u.id === req.authUser?.sub);
  try {
    const snapshot = cancelToken(facilityId, tokenId, {
      id: req.authUser!.sub,
      role: req.authUser!.role,
      name: actorUser?.name || 'User',
    });
    broadcastFacilitySnapshot(facilityId, 'token:cancelled', { tokenId });
    res.json({ ok: true, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to cancel token.';
    const status = msg.includes('own queue token') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

// Call next token at a counter (Operator or Admin)
queueRoutes.post(
  '/:facilityId/counters/:counterId/call-next',
  requireAuth,
  requireRole('admin', 'operator'),
  (req, res) => {
    const { facilityId, counterId } = req.params;
    const db = dbStore.getState();
    const actorUser = db.users.find((u) => u.id === req.authUser?.sub);
    try {
      const result = callNextAtCounter(facilityId, counterId, {
        id: req.authUser!.sub,
        name: actorUser?.name || 'Operator',
        role: req.authUser!.role,
      });
      broadcastFacilitySnapshot(facilityId, 'token:called', {
        calledTokenId: result.calledTokenId,
        queueId: result.queueId,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to call next token.',
      });
    }
  }
);

// Create a peer swap request
queueRoutes.post('/:facilityId/swaps/request', requireAuth, (req, res) => {
  const { facilityId } = req.params;
  const { tokenId, reason } = req.body as { tokenId?: string; reason?: string };

  if (!tokenId) {
    res.status(400).json({ error: 'tokenId is required.' });
    return;
  }

  try {
    const result = createSwapRequest({ facilityId, tokenId, reason });
    broadcastFacilitySnapshot(facilityId, 'swap:requested', { swap: result.swap });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to create swap request.',
    });
  }
});

// Accept an open peer swap request
queueRoutes.post('/:facilityId/swaps/:swapId/accept', requireAuth, (req, res) => {
  const { facilityId, swapId } = req.params;
  const { targetTokenId } = req.body as { targetTokenId?: string };

  if (!targetTokenId) {
    res.status(400).json({ error: 'targetTokenId is required.' });
    return;
  }

  try {
    const result = acceptSwapRequest({
      facilityId,
      swapId,
      targetTokenId,
      userId: req.authUser?.sub,
    });
    broadcastFacilitySnapshot(facilityId, 'swap:accepted', {
      updatedTokenId: result.updatedTokenId,
      updatedNumber: result.updatedNumber,
      trustScore: result.trustScore,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to accept swap.',
    });
  }
});

// Trigger 5-minute missed-turn grace slot
queueRoutes.post('/:facilityId/tokens/:tokenId/grace', requireAuth, (req, res) => {
  const { facilityId, tokenId } = req.params;
  try {
    const result = activateGraceSlot(facilityId, tokenId);
    broadcastFacilitySnapshot(facilityId, 'grace:activated', {
      tokenId,
      graceExpiresAt: result.graceExpiresAt,
    });
    res.json(result);
  } catch (err) {
    res.status(404).json({
      error: err instanceof Error ? err.message : 'Unable to activate grace slot.',
    });
  }
});

// Check in during grace slot
queueRoutes.post('/:facilityId/tokens/:tokenId/check-in', requireAuth, (req, res) => {
  const { facilityId, tokenId } = req.params;
  try {
    const result = checkInGraceSlot(facilityId, tokenId, req.authUser?.sub);
    broadcastFacilitySnapshot(facilityId, 'grace:checked-in', {
      tokenId,
      trustScore: result.trustScore,
    });
    res.json(result);
  } catch (err) {
    res.status(404).json({
      error: err instanceof Error ? err.message : 'Unable to check in token.',
    });
  }
});

// Reset demo dataset cleanly (Admin only)
queueRoutes.post('/:facilityId/reset', requireAuth, requireRole('admin'), (req, res) => {
  const { facilityId } = req.params;
  dbStore.reset();
  const snapshot = getFacilitySnapshot(facilityId) || getFacilitySnapshot('vja-hospital');
  if (snapshot) {
    broadcastFacilitySnapshot(snapshot.facilityId, 'queue:reset');
  }
  res.json({ ok: true, snapshot });
});
