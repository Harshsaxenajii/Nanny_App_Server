/**
 * seed.service.ts
 *
 * Simulates the user/parent side of a booking flow for testing.
 * Only fills tables that a human would fill:
 *   Booking → Payment → ChildCollectionOfGoals → ChildGoal[]
 *
 * After this runs, call POST /api/v1/plan/generate/:bookingId
 * to trigger the real AI pipeline (ai.service → plan.service).
 */

import { prisma } from '../config/prisma';
import { createLogger } from '../utils/logger';

const log = createLogger('seed');

// ── Fixed test IDs (must exist in your DB) ────────────────────────────────────
const USER_ID  = '69d7749348b8e134e3796c93';
const CHILD_ID = '69d7749348b8e134e3796c95';
const NANNY_ID = '69d7749348b8e134e3796c96'; // Nanny.id (not userId)

export class SeedService {

  async seedTestBooking() {
    const startDate = new Date();
    const endDate   = new Date();
    endDate.setDate(startDate.getDate() + 35);

    // ── 1. Booking ──────────────────────────────────────────────────────────
    log.info('Creating booking...');
    const booking = await prisma.booking.create({
      data: {
        userId:             USER_ID,
        nannyId:            NANNY_ID,
        childrenId:         CHILD_ID,
        status:             'CONFIRMED',
        serviceType:        'FULL_TIME',
        scheduledStartTime: startDate,
        scheduledEndTime:   endDate,
        addressLine1:       'House 42, Green Avenue',
        addressCity:        'Bangalore',
        addressState:       'Karnataka',
        addressPincode:     '560102',
        addressCountry:     'IN',
        baseAmount:         40000,
        gstAmount:          7200,
        totalAmount:        47200,
        // This is what the parent types in the app during booking
        parentGoalPrompt:
          'I want my 3-year-old to improve their speech, learn to share ' +
          'with others, and develop fine motor skills for writing over the next month.',
        aiPlanGenerated: false,
      },
    });
    log.info('Booking created: %s', booking.id);

    // ── 2. Payment ──────────────────────────────────────────────────────────
    log.info('Creating payment...');
    await prisma.payment.create({
      data: {
        booking:           { connect: { id: booking.id } },
        userId:            USER_ID,
        amount:            47200,
        status:            'CAPTURED',
        capturedAt:        new Date(),
        razorpayOrderId:   'order_mock_test123',
        razorpayPaymentId: 'pay_mock_test123',
      },
    });
    log.info('Payment created');

    // ── 3. ChildCollectionOfGoals ───────────────────────────────────────────
    // This is the container — one per booking
    log.info('Creating goal collection...');
    const goalCollection = await prisma.childCollectionOfGoals.create({
      data: {
        booking: { connect: { id: booking.id } },
      },
    });
    log.info('ChildCollectionOfGoals created: %s', goalCollection.id);

    // ── 4. ChildGoals ───────────────────────────────────────────────────────
    // These are the goals the parent selects from the carousel in the app.
    // In production these come from goal.json templates; here we hardcode
    // the same goals that a parent of a 36-month-old would typically pick.
    log.info('Creating child goals...');
    const goalInputs = [
      {
        childCollectionOfGoalsId: goalCollection.id,
        childId:           CHILD_ID,
        name:              'Improve expressive language',
        category:          'COGNITIVE' as const,
        priority:          'HIGH'      as const,
        timelineMonths:    1,
        parentDescription: 'Improve their speech so they can form longer sentences and name more objects',
        milestones: [
          { week: 1, target: 'Attempts to repeat new words heard during play' },
          { week: 2, target: 'Uses 4-word sentences during activities' },
          { week: 3, target: 'Can name 5 new animals or objects unprompted' },
          { week: 4, target: 'Initiates short conversations with nanny' },
        ],
      },
      {
        childCollectionOfGoalsId: goalCollection.id,
        childId:           CHILD_ID,
        name:              'Learn to share and take turns',
        category:          'SOCIAL'  as const,
        priority:          'HIGH'    as const,
        timelineMonths:    1,
        parentDescription: 'Child needs to learn sharing toys and waiting for their turn',
        milestones: [
          { week: 1, target: "Understands the concept of 'my turn / your turn'" },
          { week: 2, target: 'Shares a toy when prompted without a meltdown' },
          { week: 3, target: 'Initiates turn-taking in a simple game' },
          { week: 4, target: 'Can play a full board game with basic turn-taking rules' },
        ],
      },
      {
        childCollectionOfGoalsId: goalCollection.id,
        childId:           CHILD_ID,
        name:              'Develop fine motor skills for writing',
        category:          'PHYSICAL' as const,
        priority:          'MEDIUM'   as const,
        timelineMonths:    1,
        parentDescription: 'Prepare hand and finger muscles for writing readiness',
        milestones: [
          { week: 1, target: 'Holds a crayon with a pincer grasp' },
          { week: 2, target: 'Traces straight and curved lines without lifting' },
          { week: 3, target: 'Cuts paper along a straight line with safety scissors' },
          { week: 4, target: 'Draws a recognisable circle and square' },
        ],
      },
    ];

    // createMany doesn't return records on MongoDB in Prisma,
    // so we create individually to keep the IDs
    const goals = await Promise.all(
      goalInputs.map((g) => prisma.childGoal.create({ data: g })),
    );
    log.info('%d ChildGoals created', goals.length);

    return {
      bookingId:       booking.id,
      goalCollectionId: goalCollection.id,
      goalIds:         goals.map((g) => g.id),
      message:
        `Seed complete. Now call POST /api/v1/plan/generate/${booking.id} to trigger the AI pipeline.`,
    };
  }
}
