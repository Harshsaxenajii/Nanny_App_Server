// /**
//  * seed.service.ts
//  *
//  * Simulates the user/parent side of a booking flow for testing.
//  * Dynamically fetches an existing User, Child, and Nanny from the DB.
//  *
//  * After this runs, call POST /api/v1/plan/generate/:bookingId
//  * to trigger the real AI pipeline (ai.service → plan.service).
//  */

// import { prisma } from '../config/prisma';
// import { createLogger } from '../utils/logger';

// const log = createLogger('seed');

// export class SeedService {
//   async seedTestBooking() {
//     // ── 0. Dynamically fetch prerequisites ──────────────────────────────────
//     log.info('Fetching existing User, Child, and Nanny from DB...');

//     // Find a user who has at least one child registered
//     const user = await prisma.user.findFirst({
//       where: {
//         childrens: { some: {} } // Ensures the user has a child
//       },
//       include: {
//         childrens: true // Bring the children data along
//       }
//     });

//     if (!user) {
//       throw new Error('Database Error: No User with a registered Child found. Please register a parent and child via the app first.');
//     }

//     const child = user.childrens[0]; // Just grab their first child

//     // Find any verified nanny
//     const nanny = await prisma.nanny.findFirst({
//       where: { status: 'VERIFIED' } // Adjust this if your test nannies have a different status
//     });

//     if (!nanny) {
//       throw new Error('Database Error: No VERIFIED Nanny found. Please register and verify a nanny first.');
//     }

//     log.info(`Found prerequisites - User: ${user.id}, Child: ${child.id}, Nanny: ${nanny.id}`);

//     // ── Setup Dates ─────────────────────────────────────────────────────────
//     const startDate = new Date();
//     const endDate   = new Date();
//     endDate.setDate(startDate.getDate() + 35);

//     // ── 1. Booking ──────────────────────────────────────────────────────────
//     log.info('Creating booking...');
//     const booking = await prisma.booking.create({
//       data: {
//         userId:             user.id,
//         nannyId:            nanny.id,
//         childrenId:         child.id,
//         status:             'CONFIRMED',
//         serviceType:        'FULL_TIME',
//         scheduledStartTime: startDate,
//         scheduledEndTime:   endDate,
//         addressLine1:       'House 42, Green Avenue',
//         addressCity:        'Bangalore',
//         addressState:       'Karnataka',
//         addressPincode:     '560102',
//         addressCountry:     'IN',
//         baseAmount:         40000,
//         gstAmount:          7200,
//         totalAmount:        47200,
//         // This is what the parent types in the app during booking
//         parentGoalPrompt:
//           'I want my 3-year-old to improve their speech, learn to share ' +
//           'with others, and develop fine motor skills for writing over the next month.',
//         aiPlanGenerated: false,
//       },
//     });
//     log.info('Booking created: %s', booking.id);

//     // ── 2. Payment ──────────────────────────────────────────────────────────
//     log.info('Creating payment...');
//     await prisma.payment.create({
//       data: {
//         booking:           { connect: { id: booking.id } },
//         userId:            user.id,
//         amount:            47200,
//         status:            'CAPTURED',
//         capturedAt:        new Date(),
//         razorpayOrderId:   'order_mock_test123',
//         razorpayPaymentId: 'pay_mock_test123',
//       },
//     });
//     log.info('Payment created');

//     // ── 3. ChildCollectionOfGoals ───────────────────────────────────────────
//     log.info('Creating goal collection...');
//     const goalCollection = await prisma.childCollectionOfGoals.create({
//       data: {
//         booking: { connect: { id: booking.id } },
//       },
//     });
//     log.info('ChildCollectionOfGoals created: %s', goalCollection.id);

//     // ── 4. ChildGoals ───────────────────────────────────────────────────────
//     log.info('Creating child goals...');
//     const goalInputs = [
//       {
//         childCollectionOfGoalsId: goalCollection.id,
//         childId:           child.id,
//         name:              'Improve expressive language',
//         category:          'COGNITIVE' as const,
//         priority:          'HIGH'      as const,
//         timelineMonths:    1,
//         parentDescription: 'Improve their speech so they can form longer sentences and name more objects',
//         milestones: [
//           { week: 1, target: 'Attempts to repeat new words heard during play' },
//           { week: 2, target: 'Uses 4-word sentences during activities' },
//           { week: 3, target: 'Can name 5 new animals or objects unprompted' },
//           { week: 4, target: 'Initiates short conversations with nanny' },
//         ],
//       },
//       {
//         childCollectionOfGoalsId: goalCollection.id,
//         childId:           child.id,
//         name:              'Learn to share and take turns',
//         category:          'SOCIAL'  as const,
//         priority:          'HIGH'    as const,
//         timelineMonths:    1,
//         parentDescription: 'Child needs to learn sharing toys and waiting for their turn',
//         milestones: [
//           { week: 1, target: "Understands the concept of 'my turn / your turn'" },
//           { week: 2, target: 'Shares a toy when prompted without a meltdown' },
//           { week: 3, target: 'Initiates turn-taking in a simple game' },
//           { week: 4, target: 'Can play a full board game with basic turn-taking rules' },
//         ],
//       },
//       {
//         childCollectionOfGoalsId: goalCollection.id,
//         childId:           child.id,
//         name:              'Develop fine motor skills for writing',
//         category:          'PHYSICAL' as const,
//         priority:          'MEDIUM'   as const,
//         timelineMonths:    1,
//         parentDescription: 'Prepare hand and finger muscles for writing readiness',
//         milestones: [
//           { week: 1, target: 'Holds a crayon with a pincer grasp' },
//           { week: 2, target: 'Traces straight and curved lines without lifting' },
//           { week: 3, target: 'Cuts paper along a straight line with safety scissors' },
//           { week: 4, target: 'Draws a recognisable circle and square' },
//         ],
//       },
//     ];

//     // createMany doesn't return records on MongoDB in Prisma,
//     // so we create individually to keep the IDs
//     const goals = await Promise.all(
//       goalInputs.map((g) => prisma.childGoal.create({ data: g })),
//     );
//     log.info('%d ChildGoals created', goals.length);

//     return {
//       bookingId:       booking.id,
//       goalCollectionId: goalCollection.id,
//       goalIds:         goals.map((g) => g.id),
//       message:
//         `Seed complete. Now call POST /api/v1/plan/generate/${booking.id} to trigger the AI pipeline.`,
//     };
//   }
// }

