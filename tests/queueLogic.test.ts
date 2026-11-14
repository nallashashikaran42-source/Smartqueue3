import assert from 'node:assert/strict';
import { dbStore } from '../server/db/store.ts';
import {
  cancelToken,
  getFacilitySnapshot,
  hydrateTokenForCitizen,
  issueToken,
  syncCitizenAppointmentNotifications,
  transitionTokenAtCounter,
  verifyAndCheckInQr,
} from '../server/services/queueEngine.ts';
import { getIstDateIso } from '../server/services/istTime.ts';

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

try {
  // TEST 1: Future Appointment Date (Nov 14 booking for Nov 18)
  runTest('Test 1: Future appointment date shows Upcoming Appointment and blocks live wait/check-in', () => {
    dbStore.reset();
    // 14 November 2026, 10:00 AM IST
    const nov14 = new Date('2026-11-14T04:30:00.000Z');
    assert.equal(getIstDateIso(nov14), '2026-11-14');

    const { token, snapshot } = issueToken(
      {
        facilityId: 'vja-hospital',
        queueId: 'online-appointment',
        channel: 'App QR',
        citizenName: 'Test Citizen 1',
        userId: 'usr-test-1',
        appointmentDate: '2026-11-18',
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
      },
      nov14
    );

    assert.equal(token.appointmentDate, '2026-11-18');
    assert.equal(token.appointmentSlot, '08:00 AM');
    assert.equal(token.queueLifecycleState, 'Upcoming Appointment');
    assert.equal(token.bookingStatusLabel, 'Upcoming Appointment');
    assert.equal(token.queueStatusLabel, 'Not Started');
    assert.equal(token.etaMinutes, null);
    assert.equal(token.aheadCount, null);
    assert.equal(token.currentServingToken, null);
    assert.equal(token.checkInEligible, false);
    assert.equal(token.waitStatusMessage, 'Available after check-in');
    assert.ok(token.countdownText?.includes('4 days'), `Unexpected countdown: ${token.countdownText}`);

    // Future appointment must NOT pollute today's active queue roster
    assert.equal(
      snapshot.roster.some((r) => r.tokenId === token.tokenId),
      false,
      'Future appointment must not be in active queue roster'
    );

    // Prevent joining active queue before appointment date
    assert.throws(
      () =>
        verifyAndCheckInQr(
          {
            facilityId: 'vja-hospital',
            qrPayload: token.qrCodePayload,
            actor: { id: 'usr-test-1', role: 'citizen', name: 'Test Citizen 1' },
          },
          nov14
        ),
      /only available on your appointment date/i
    );
  });

  // TEST 2: Today Appointment Without Check-In + 1-day-before reminder
  runTest('Test 2: Today appointment without check-in requires QR check-in and triggers reminders', () => {
    dbStore.reset();
    const nov17 = new Date('2026-11-17T04:30:00.000Z'); // 10:00 AM IST Nov 17
    const nov18Morning = new Date('2026-11-18T02:00:00.000Z'); // 07:30 AM IST Nov 18 (30m before 08:00 AM)

    const { token: booked } = issueToken(
      {
        facilityId: 'vja-hospital',
        queueId: 'online-appointment',
        channel: 'App QR',
        citizenName: 'Test Citizen 2',
        userId: 'usr-test-2',
        appointmentDate: '2026-11-18',
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
      },
      new Date('2026-11-14T04:30:00.000Z')
    );

    // 1-day-before reminder check on Nov 17
    syncCitizenAppointmentNotifications('usr-test-2', nov17);
    const dbAfterNov17 = dbStore.getState();
    assert.ok(
      dbAfterNov17.notifications.some(
        (n) => n.userId === 'usr-test-2' && n.title.includes('Appointment Reminder')
      ),
      'Expected 1-day-before reminder notification'
    );

    // Check state on Nov 18 before QR check-in
    syncCitizenAppointmentNotifications('usr-test-2', nov18Morning);
    const rawToken = dbStore.getState().tokens.find((t) => t.tokenId === booked.tokenId)!;
    const preCheckIn = hydrateTokenForCitizen(rawToken, nov18Morning);

    assert.equal(preCheckIn.queueLifecycleState, 'Check-In Required');
    assert.equal(preCheckIn.etaMinutes, null);
    assert.equal(preCheckIn.aheadCount, null);
    assert.equal(preCheckIn.checkInEligible, true);
    assert.equal(preCheckIn.waitStatusMessage, 'Waiting time will be available after check-in.');

    const snapBeforeCheckIn = getFacilitySnapshot('vja-hospital', nov18Morning)!;
    assert.equal(
      snapBeforeCheckIn.roster.some((r) => r.tokenId === booked.tokenId),
      false,
      'Unchecked-in patient must not be in active queue'
    );
    assert.ok(
      dbStore.getState().notifications.some(
        (n) => n.userId === 'usr-test-2' && n.title.includes('Check-In Available')
      ),
      'Expected check-in availability notification'
    );
  });

  // TEST 3, TEST 4, TEST 5: Exact Waiting Time Calculation, Service Completion Auto-Advance, Cancellation Recalculation
  runTest('Tests 3-5: Active queue formula, multi-counter split, completion auto-advance & cancellation recalculation', () => {
    dbStore.reset();
    const db = dbStore.getState();
    const nov18 = new Date('2026-11-18T02:15:00.000Z'); // 07:45 AM IST Nov 18
    const nov18Iso = '2026-11-18';

    // Set up deterministic department queue state matching Test 3:
    // online-appointment: avgServiceMinutes = 5, 1 active counter (c5),
    // Q-20 Serving, Q-21, Q-22, Q-23 Waiting (all checked in on 2026-11-18), then Q-24 checks in.
    const queue = db.queues.find((q) => q.facilityId === 'vja-hospital' && q.id === 'online-appointment')!;
    queue.avgServiceMinutes = 5;
    queue.servingNumber = 20;
    queue.nextIssueNumber = 24;

    // Ensure exactly 1 active counter (c5) for online-appointment
    for (const c of db.counters) {
      if (c.facilityId === 'vja-hospital' && c.queueId === 'online-appointment') {
        c.status = c.id === 'c5' ? 'Serving' : 'Closed';
        if (c.id === 'c5') c.currentToken = 'Q-20';
      }
    }

    // Replace online-appointment tokens with clean Nov 18 set: Q-20 Serving, Q-21/22/23 Waiting
    db.tokens = db.tokens.filter((t) => t.queueId !== 'online-appointment');
    const baseCreated = nov18.getTime() - 20 * 60000;

    db.tokens.push(
      {
        tokenId: 'Q-20',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        queueId: 'online-appointment',
        queueName: 'Online Pre-Booked',
        counterId: 'c5',
        numberValue: 20,
        citizenName: 'Patient 20',
        channel: 'App QR',
        priority: 'appointment',
        status: 'Serving',
        joinedAt: '07:20 AM',
        appointmentDate: nov18Iso,
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
        checkedIn: true,
        checkedInAt: '07:20 AM',
        checkedInAtMs: baseCreated,
        servingStartedAt: '07:35 AM',
        servingStartedAtMs: nov18.getTime() - 10 * 60000,
        createdAtMs: baseCreated,
      },
      {
        tokenId: 'Q-21',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        queueId: 'online-appointment',
        queueName: 'Online Pre-Booked',
        counterId: 'c5',
        numberValue: 21,
        citizenName: 'Patient 21',
        channel: 'App QR',
        priority: 'appointment',
        status: 'Waiting',
        joinedAt: '07:25 AM',
        appointmentDate: nov18Iso,
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
        checkedIn: true,
        checkedInAt: '07:25 AM',
        checkedInAtMs: baseCreated + 60000,
        createdAtMs: baseCreated + 60000,
      },
      {
        tokenId: 'Q-22',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        queueId: 'online-appointment',
        queueName: 'Online Pre-Booked',
        counterId: 'c5',
        numberValue: 22,
        citizenName: 'Patient 22',
        channel: 'App QR',
        priority: 'appointment',
        status: 'Waiting',
        joinedAt: '07:26 AM',
        appointmentDate: nov18Iso,
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
        checkedIn: true,
        checkedInAt: '07:26 AM',
        checkedInAtMs: baseCreated + 120000,
        createdAtMs: baseCreated + 120000,
      },
      {
        tokenId: 'Q-23',
        facilityId: 'vja-hospital',
        departmentId: 'dept-appointments',
        queueId: 'online-appointment',
        queueName: 'Online Pre-Booked',
        counterId: 'c5',
        numberValue: 23,
        citizenName: 'Patient 23',
        channel: 'App QR',
        priority: 'appointment',
        status: 'Waiting',
        joinedAt: '07:27 AM',
        appointmentDate: nov18Iso,
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
        checkedIn: true,
        checkedInAt: '07:27 AM',
        checkedInAtMs: baseCreated + 180000,
        createdAtMs: baseCreated + 180000,
      }
    );

    // Book Q-24 on Nov 18 (pre-booked, awaiting check-in)
    const { token: q24Pre } = issueToken(
      {
        facilityId: 'vja-hospital',
        queueId: 'online-appointment',
        channel: 'App QR',
        citizenName: 'Patient 24',
        userId: 'usr-test-24',
        appointmentDate: nov18Iso,
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
      },
      nov18
    );
    assert.equal(q24Pre.tokenId, 'Q-24');
    assert.equal(q24Pre.queueLifecycleState, 'Check-In Required');
    assert.equal(q24Pre.etaMinutes, null);

    // Perform QR check-in for Q-24
    const { token: q24CheckedIn } = verifyAndCheckInQr(
      {
        facilityId: 'vja-hospital',
        qrPayload: q24Pre.qrCodePayload,
        queueId: 'online-appointment',
        departmentId: 'dept-appointments',
        actor: { id: 'usr-test-24', role: 'citizen', name: 'Patient 24' },
      },
      new Date(nov18.getTime() + 1000)
    );

    // Q-20 (Serving), Q-21, Q-22, Q-23 are 4 people ahead of Q-24; avgService = 5, activeCounters = 1 -> 20 min
    assert.equal(q24CheckedIn.queueLifecycleState, 'Active Queue');
    assert.equal(q24CheckedIn.currentServingToken, 'Q-20');
    assert.equal(q24CheckedIn.aheadCount, 4);
    assert.equal(q24CheckedIn.etaMinutes, 20);

    // TEST 3b: Open an additional counter -> ETA halves to 10 min (4 * 5 / 2)
    db.counters.push({
      id: 'c6-test',
      facilityId: 'vja-hospital',
      departmentId: 'dept-appointments',
      label: 'Desk 6',
      staffName: 'Dr. Extra Staff',
      queueId: 'online-appointment',
      status: 'Serving',
      currentToken: '—',
      avgCycleMins: 5,
    });
    const rawQ24 = db.tokens.find((t) => t.tokenId === 'Q-24')!;
    const q24TwoCounters = hydrateTokenForCitizen(rawQ24, new Date(nov18.getTime() + 2000));
    assert.equal(q24TwoCounters.aheadCount, 4);
    assert.equal(q24TwoCounters.etaMinutes, 10);

    // Close extra counter back to 1 active counter for Test 4 & 5
    db.counters = db.counters.filter((c) => c.id !== 'c6-test');

    // TEST 4: Complete Q-20 -> Q-21 auto-called -> Q-24 drops to 3 ahead & 15 min
    const completeResult = transitionTokenAtCounter(
      {
        facilityId: 'vja-hospital',
        counterId: 'c5',
        tokenId: 'Q-20',
        action: 'complete',
        actor: { id: 'usr-operator-demo', role: 'operator', name: 'Dr. Madhavi' },
      },
      new Date(nov18.getTime() + 60000)
    );
    assert.equal(completeResult.token.status, 'Completed');
    assert.ok((completeResult.token.actualServiceMinutes || 0) >= 1);

    const q21After = db.tokens.find((t) => t.tokenId === 'Q-21')!;
    assert.equal(q21After.status, 'Called');

    const q24AfterComplete = hydrateTokenForCitizen(rawQ24, new Date(nov18.getTime() + 61000));
    assert.equal(q24AfterComplete.currentServingToken, 'Q-21');
    assert.equal(q24AfterComplete.aheadCount, 3);
    assert.equal(q24AfterComplete.etaMinutes, 15);

    // TEST 5: Cancel Q-22 -> Q-24 drops to 2 ahead & 10 min
    cancelToken('vja-hospital', 'Q-22', undefined, new Date(nov18.getTime() + 62000));
    const q24AfterCancel = hydrateTokenForCitizen(rawQ24, new Date(nov18.getTime() + 63000));
    assert.equal(q24AfterCancel.aheadCount, 2);
    assert.equal(q24AfterCancel.etaMinutes, 10);
  });

  // TEST 6: Midnight IST Rollover Check
  runTest('Midnight IST Rollover: 23:59 IST Nov 17 vs 00:01 IST Nov 18 transitions cleanly', () => {
    dbStore.reset();
    const beforeMidnightIst = new Date('2026-11-17T18:29:00.000Z'); // 23:59 IST Nov 17
    const afterMidnightIst = new Date('2026-11-17T18:31:00.000Z'); // 00:01 IST Nov 18

    assert.equal(getIstDateIso(beforeMidnightIst), '2026-11-17');
    assert.equal(getIstDateIso(afterMidnightIst), '2026-11-18');

    const { token } = issueToken(
      {
        facilityId: 'vja-hospital',
        queueId: 'online-appointment',
        channel: 'App QR',
        citizenName: 'Midnight Patient',
        userId: 'usr-midnight',
        appointmentDate: '2026-11-18',
        appointmentSlot: '08:00 AM',
        isPreBooked: true,
      },
      beforeMidnightIst
    );

    const raw = dbStore.getState().tokens.find((t) => t.tokenId === token.tokenId)!;
    assert.equal(
      hydrateTokenForCitizen(raw, beforeMidnightIst).queueLifecycleState,
      'Upcoming Appointment'
    );
    assert.equal(
      hydrateTokenForCitizen(raw, afterMidnightIst).queueLifecycleState,
      'Check-In Required'
    );
  });
} finally {
  // Always restore clean seeded state
  dbStore.reset();
}
console.log('ALL SMARTQUEUE LOGIC TESTS PASSED');
