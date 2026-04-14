/**
 * goal.service.ts
 *
 * Handles:
 *   - Serving goal.json templates to the frontend (for the carousel/form)
 *   - Reading ChildGoal records for a child (nanny dashboard + parent insights)
 */

import { prisma }              from '../config/prisma';
import { AppError }            from '../utils/AppError';
import { createLogger }        from '../utils/logger';
import { getAllTemplates,
         getTemplateByAge,
         ageInMonths }         from '../utils/goalTemplates';

const log = createLogger('goal');

export class GoalService {

  // ── GET /api/v1/goals  (optionally filtered by ?ageMonths=X) ─────────────
  // Used by the frontend to power the goal selection carousel.
  getTemplates(ageMonths?: number) {
    if (ageMonths !== undefined) {
      const template = getTemplateByAge(ageMonths);
      if (!template) {
        throw new AppError(
          `No development goals available for age ${ageMonths} months`,
          404,
        );
      }
      return [template];
    }
    return getAllTemplates();
  }

  // ── GET /api/v1/goals/child/:childId ─────────────────────────────────────
  // Returns all ChildGoal records for a child across all bookings.
  // Used by nanny dashboard and parent insights.
  async getChildGoals(childId: string, requestingUserId: string, role: string) {
    // Verify child exists
    const child = await prisma.children.findUnique({ where: { id: childId } });
    if (!child) throw new AppError('Child not found', 404);

    // Users can only see their own child's goals
    if (role === 'USER' && child.userId !== requestingUserId) {
      throw new AppError('You do not have access to this child\'s goals', 403);
    }

    // Nannies can see goals for children in their bookings
    if (role === 'NANNY') {
      const nanny = await prisma.nanny.findUnique({
        where: { userId: requestingUserId },
      });
      if (!nanny) throw new AppError('Nanny profile not found', 404);

      const hasBooking = await prisma.booking.findFirst({
        where: { nannyId: nanny.id, childrenId: childId },
      });
      if (!hasBooking) {
        throw new AppError(
          'You are not assigned to any booking for this child',
          403,
        );
      }
    }

    return prisma.childGoal.findMany({
      where:   { childId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── GET /api/v1/goals/booking/:bookingId ─────────────────────────────────
  // Returns all ChildGoals for a specific booking.
  async getBookingGoals(bookingId: string, requestingUserId: string, role: string) {
    const booking = await prisma.booking.findUnique({
      where:   { id: bookingId },
      include: { childGoals: true },
    });
    if (!booking) throw new AppError('Booking not found', 404);

    if (role === 'USER' && booking.userId !== requestingUserId) {
      throw new AppError('You do not have access to this booking', 403);
    }

    if (role === 'NANNY') {
      const nanny = await prisma.nanny.findUnique({
        where: { userId: requestingUserId },
      });
      if (!nanny || booking.nannyId !== nanny.id) {
        throw new AppError('You are not assigned to this booking', 403);
      }
    }

    return booking.childGoals;
  }

  // ── GET /api/v1/goals/plan/:bookingId/today ───────────────────────────────
  // Returns today's PlanTasks for the nanny dashboard.
  async getTodaysTasks(bookingId: string, nannyUserId: string) {
    const nanny = await prisma.nanny.findUnique({ where: { userId: nannyUserId } });
    if (!nanny) throw new AppError('Nanny profile not found', 404);

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.nannyId !== nanny.id) {
      throw new AppError('You are not assigned to this booking', 403);
    }

    const plan = await prisma.dailyPlan.findUnique({ where: { bookingId } });
    if (!plan) throw new AppError('No AI plan found for this booking yet', 404);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    return prisma.planTask.findMany({
      where: {
        planId:  plan.id,
        forDate: { gte: todayStart, lte: todayEnd },
      },
      include: {
        goal: true,   // include the linked ChildGoal so nanny sees "why"
        log:  true,   // include TaskLog if already filled
      },
      orderBy: { scheduledTime: 'asc' },
    });
  }

  // ── PATCH /api/v1/goals/tasks/:taskId/log ─────────────────────────────────
  // Nanny submits their log for a completed/skipped task.
  async submitTaskLog(
    taskId:          string,
    nannyUserId:     string,
    body: {
      status:          'COMPLETED' | 'SKIPPED';
      completionPct:   number;
      engagementRating?: number;
      moodRating?:      number;
      nannyNote?:       string;
    },
  ) {
    const nanny = await prisma.nanny.findUnique({ where: { userId: nannyUserId } });
    if (!nanny) throw new AppError('Nanny profile not found', 404);

    const task = await prisma.planTask.findUnique({
      where:   { id: taskId },
      include: { plan: { include: { booking: true } } },
    });
    if (!task) throw new AppError('Task not found', 404);
    if (task.plan.booking.nannyId !== nanny.id) {
      throw new AppError('You are not assigned to this task\'s booking', 403);
    }

    // Update task status
    await prisma.planTask.update({
      where: { id: taskId },
      data:  { status: body.status },
    });

    // Upsert TaskLog (nanny can edit before end of day)
    return prisma.taskLog.upsert({
      where:  { taskId },
      update: {
        completionPct:    body.completionPct,
        engagementRating: body.engagementRating ?? null,
        moodRating:       body.moodRating ?? null,
        nannyNote:        body.nannyNote ?? null,
        completedAt:      body.status === 'COMPLETED' ? new Date() : null,
      },
      create: {
        taskId,
        nannyId:          nanny.id,
        completionPct:    body.completionPct,
        engagementRating: body.engagementRating ?? null,
        moodRating:       body.moodRating ?? null,
        nannyNote:        body.nannyNote ?? null,
        completedAt:      body.status === 'COMPLETED' ? new Date() : null,
      },
    });
  }
}
