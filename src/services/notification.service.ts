import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { paginate, paginatedResult } from '../utils/response';
import { NotificationType } from '@prisma/client';
import { createLogger } from '../utils/logger';

const log = createLogger('notification');

export class NotificationService {
  async create(userId: string, type: NotificationType, title: string, body: string, data?: object) {
    try {
      return await prisma.notification.create({ data: { userId, type, title, body, data: data as any } });
    } catch (err: any) {
      log.error('Failed to create notification', { error: err.message });
    }
  }

  async getMyNotifications(userId: string, query: any) {
    const { page, limit, skip } = paginate(query);
    const where: any = { userId };
    if (query.isRead !== undefined && query.isRead !== '') {
      where.isRead = query.isRead === 'true';
    }

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return { ...paginatedResult(notifications, total, page, limit), unreadCount };
  }

  async markAsRead(userId: string, notificationId: string) {
    const n = await prisma.notification.findUnique({ where: { id: notificationId } });
    if (!n)              throw new AppError('Notification not found', 404);
    if (n.userId !== userId) throw new AppError('Access denied', 403);
    if (n.isRead) return n; // already read — idempotent
    return prisma.notification.update({ where: { id: notificationId }, data: { isRead: true } });
  }

  async markAllAsRead(userId: string) {
    const { count } = await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data:  { isRead: true },
    });
    return { updated: count };
  }
}
