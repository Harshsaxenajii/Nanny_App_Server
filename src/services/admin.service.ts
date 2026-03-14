import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { paginate, paginatedResult } from '../utils/response';
import { NannyStatus } from '@prisma/client';
import { createLogger } from '../utils/logger';

const log = createLogger('admin');

export class AdminService {

  /* ── GET /api/v1/admin/dashboard ─────────────────────────────────────── */
  async getDashboard() {
    const [
      totalUsers, totalNannies, pendingVerifications, verifiedNannies,
      totalBookings, activeBookings, completedBookings, cancelledBookings,
      totalRevenue,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.nanny.count(),
      prisma.nanny.count({ where: { status: NannyStatus.PENDING_VERIFICATION } }),
      prisma.nanny.count({ where: { status: NannyStatus.VERIFIED } }),
      prisma.booking.count(),
      prisma.booking.count({ where: { status: { in: ['CONFIRMED', 'NANNY_ASSIGNED', 'IN_PROGRESS'] } } }),
      prisma.booking.count({ where: { status: 'COMPLETED' } }),
      prisma.booking.count({ where: { status: { in: ['CANCELLED_BY_USER', 'CANCELLED_BY_NANNY', 'CANCELLED_BY_ADMIN'] } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'CAPTURED' } }),
    ]);

    return {
      users:    { total: totalUsers },
      nannies:  { total: totalNannies, pending: pendingVerifications, verified: verifiedNannies },
      bookings: { total: totalBookings, active: activeBookings, completed: completedBookings, cancelled: cancelledBookings },
      revenue:  { total: totalRevenue._sum.amount ?? 0, currency: 'INR' },
    };
  }

  /* ── GET /api/v1/admin/nannies/pending ───────────────────────────────── */
  async getPendingNannies(query: any) {
    const { page, limit, skip } = paginate(query);
    const where = { status: NannyStatus.PENDING_VERIFICATION };
    const [nannies, total] = await Promise.all([
      prisma.nanny.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, mobile: true, createdAt: true } } },
      }),
      prisma.nanny.count({ where }),
    ]);
    return paginatedResult(nannies, total, page, limit);
  }

  /* ── GET /api/v1/admin/nannies/:id ───────────────────────────────────── */
  async getNannyDetail(nannyId: string) {
    const nanny = await prisma.nanny.findUnique({
      where: { id: nannyId },
      include: { user: { select: { id: true, mobile: true, email: true, role: true, createdAt: true, lastLoginAt: true } } },
    });
    if (!nanny) throw new AppError('Nanny not found', 404);
    return nanny;
  }

  /* ── POST /api/v1/admin/nannies/:id/verify ───────────────────────────── */
  async verifyNanny(nannyId: string, adminId: string, notes?: string) {
    const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
    if (!nanny) throw new AppError('Nanny not found', 404);

    const verifiableStatuses: NannyStatus[] = [NannyStatus.PENDING_VERIFICATION, NannyStatus.TRAINING_ASSIGNED];
    if (!verifiableStatuses.includes(nanny.status)) {
      throw new AppError(`Cannot verify a nanny in status: ${nanny.status}`, 400);
    }

    const updated = await prisma.nanny.update({
      where: { id: nannyId },
      data: {
        status:     NannyStatus.VERIFIED,
        isActive:   true,
        verifiedAt: new Date(),
        verifiedBy: adminId,
        adminNotes: notes ?? null,
      },
    });
    console.log(updated)

    await prisma.auditLog.create({
      data: {
        actorId:     adminId,
        actorRole:   'ADMIN',
        action:      'NANNY_VERIFIED',
        resource:    'nanny',
        resourceId:  nannyId,
        previousData:{ status: nanny.status },
        newData:     { status: NannyStatus.VERIFIED },
      },
    });

    // Trigger notification to nanny
    const { bus, Events } = await import('../utils/eventBus');
    bus.emit(Events.NANNY_VERIFIED, { nannyId, adminId });

    log.info(`Nanny verified: ${nannyId} by ${adminId}`);
    return updated;
  }

  /* ── POST /api/v1/admin/nannies/:id/reject ───────────────────────────── */
  async rejectNanny(nannyId: string, adminId: string, reason: string) {
    const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
    if (!nanny) throw new AppError('Nanny not found', 404);

    if (nanny.status === NannyStatus.VERIFIED) {
      throw new AppError('Cannot reject an already verified nanny. Use suspend instead.', 400);
    }
    if (nanny.status === NannyStatus.REJECTED) {
      throw new AppError('Nanny is already rejected.', 400);
    }

    const updated = await prisma.nanny.update({
      where: { id: nannyId },
      data: {
        status:          NannyStatus.REJECTED,
        isActive:        false,
        isAvailable:     false,
        rejectionReason: reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId:     adminId,
        actorRole:   'ADMIN',
        action:      'NANNY_REJECTED',
        resource:    'nanny',
        resourceId:  nannyId,
        previousData:{ status: nanny.status },
        newData:     { status: NannyStatus.REJECTED, reason },
      },
    });

    const { bus, Events } = await import('../utils/eventBus');
    bus.emit(Events.NANNY_REJECTED, { nannyId, reason });

    return updated;
  }

  /* ── PATCH /api/v1/admin/nannies/:id/training ────────────────────────── */
  async updateTraining(nannyId: string, adminId: string, isTrainingCompleted: boolean, notes?: string) {
    const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
    if (!nanny) throw new AppError('Nanny not found', 404);

    const updated = await prisma.nanny.update({
      where: { id: nannyId },
      data: {
        isTrainingCompleted,
        status:    isTrainingCompleted ? NannyStatus.TRAINING_ASSIGNED : nanny.status,
        adminNotes:notes ?? nanny.adminNotes,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId:    adminId,
        actorRole:  'ADMIN',
        action:     isTrainingCompleted ? 'TRAINING_COMPLETED' : 'TRAINING_UPDATED',
        resource:   'nanny',
        resourceId: nannyId,
        newData:    { isTrainingCompleted, notes },
      },
    });

    return updated;
  }

  /* ── POST /api/v1/admin/nannies/:id/suspend ──────────────────────────── */
  async suspendNanny(nannyId: string, adminId: string, reason: string) {
    const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
    if (!nanny) throw new AppError('Nanny not found', 404);

    if (nanny.status === NannyStatus.SUSPENDED) throw new AppError('Nanny is already suspended', 400);

    const updated = await prisma.nanny.update({
      where: { id: nannyId },
      data: {
        status:      NannyStatus.SUSPENDED,
        isActive:    false,
        isAvailable: false,
        adminNotes:  reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId:     adminId,
        actorRole:   'ADMIN',
        action:      'NANNY_SUSPENDED',
        resource:    'nanny',
        resourceId:  nannyId,
        previousData:{ status: nanny.status },
        newData:     { status: NannyStatus.SUSPENDED, reason },
      },
    });

    return updated;
  }

  /* ── GET /api/v1/admin/audit-logs ────────────────────────────────────── */
  async getAuditLogs(query: any) {
    const { page, limit, skip } = paginate(query);
    const where: any = {};
    if (query.action)   where.action   = { contains: query.action,   mode: 'insensitive' };
    if (query.resource) where.resource = query.resource;
    if (query.actorId)  where.actorId  = query.actorId;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, name: true, mobile: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    return paginatedResult(logs, total, page, limit);
  }
}
