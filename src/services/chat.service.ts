import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { paginate, paginatedResult } from '../utils/response';
import { createLogger } from '../utils/logger';
import { BookingStatus } from '@prisma/client';

const log = createLogger('chat');

async function assertParticipant(roomId: string, userId: string) {
  const p = await prisma.chatParticipant.findUnique({ where: { roomId_userId: { roomId, userId } } });
  if (!p) throw new AppError('You are not a participant of this chat room', 403);
  return p;
}

export class ChatService {

  /* ── POST /api/v1/chat/rooms ─────────────────────────────────────────── */
  async getOrCreateRoom(userId: string, bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { nanny: { select: { userId: true } } },
    });
    if (!booking) throw new AppError('Booking not found', 404);

    // Edge case: only participants can create a chat room
    const nannyUserId = booking.nanny?.userId;
    const isUser  = booking.userId === userId;
    const isNanny = nannyUserId === userId;
    if (!isUser && !isNanny) throw new AppError('You are not a participant of this booking', 403);

    // Edge case: nanny must be assigned before chat can be opened
    if (!booking.nannyId) {
      throw new AppError('Chat is only available after a nanny has been assigned to the booking', 400);
    }

    const allowedStatuses: BookingStatus[] = [
      BookingStatus.CONFIRMED,
      BookingStatus.NANNY_ASSIGNED,
      BookingStatus.IN_PROGRESS,
      BookingStatus.COMPLETED,
    ];
    if (!allowedStatuses.includes(booking.status)) {
      throw new AppError(`Chat is not available for a booking in status: ${booking.status}`, 400);
    }

    // Return existing room if it exists
    const existing = await prisma.chatRoom.findUnique({
      where:   { bookingId },
      include: { participants: true, messages: { take: 1, orderBy: { createdAt: 'desc' } } },
    });
    if (existing) return existing;

    // Create new room with both participants
    const room = await prisma.chatRoom.create({
      data: {
        bookingId,
        participants: {
          create: [
            { userId: booking.userId },
            { userId: nannyUserId! },
          ],
        },
      },
      include: { participants: true },
    });

    log.info(`Chat room created: ${room.id} for booking ${bookingId}`);
    return room;
  }

  /* ── GET /api/v1/chat/rooms ──────────────────────────────────────────── */
  async getMyRooms(userId: string) {
    const participants = await prisma.chatParticipant.findMany({
      where: { userId },
      include: {
        room: {
          include: {
            booking: { select: { id: true, serviceType: true, scheduledStartTime: true, status: true } },
            participants: {
              include: { user: { select: { id: true, name: true, profilePhoto: true } } },
            },
            messages: { take: 1, orderBy: { createdAt: 'desc' } },
          },
        },
      },
      orderBy: { room: { updatedAt: 'desc' } },
    });

    return participants.map(p => ({
      ...p.room,
      unreadCount: p.unreadCount,
      otherParticipants: p.room.participants
        .filter(pp => pp.userId !== userId)
        .map(pp => pp.user),
      lastMessage: p.room.messages[0] ?? null,
    }));
  }

  /* ── GET /api/v1/chat/rooms/:id/messages ─────────────────────────────── */
  async getMessages(userId: string, roomId: string, query: any) {
    await assertParticipant(roomId, userId);

    const { page, limit, skip } = paginate(query);
    const [messages, total] = await Promise.all([
      prisma.chatMessage.findMany({
        where:   { roomId },
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
        include: { sender: { select: { id: true, name: true, profilePhoto: true } } },
      }),
      prisma.chatMessage.count({ where: { roomId } }),
    ]);

    return paginatedResult(messages, total, page, limit);
  }

  /* ── POST /api/v1/chat/rooms/:id/messages ────────────────────────────── */
  async sendMessage(userId: string, roomId: string, content: string, type: string, mediaUrl?: string) {
    const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
    if (!room)         throw new AppError('Chat room not found', 404);
    if (!room.isActive)throw new AppError('This chat room is no longer active', 400);

    await assertParticipant(roomId, userId);

    const message = await prisma.chatMessage.create({
      data: { roomId, senderId: userId, content, type: type as any, mediaUrl: mediaUrl ?? null },
      include: { sender: { select: { id: true, name: true, profilePhoto: true } } },
    });

    // Increment unread count for other participants
    await prisma.chatParticipant.updateMany({
      where: { roomId, userId: { not: userId } },
      data:  { unreadCount: { increment: 1 } },
    });

    // Touch room updatedAt
    await prisma.chatRoom.update({ where: { id: roomId }, data: {} });

    return message;
  }

  /* ── PATCH /api/v1/chat/rooms/:id/read ───────────────────────────────── */
  async markAsRead(userId: string, roomId: string) {
    const room = await prisma.chatRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new AppError('Chat room not found', 404);

    await assertParticipant(roomId, userId);

    await Promise.all([
      prisma.chatParticipant.update({
        where: { roomId_userId: { roomId, userId } },
        data:  { unreadCount: 0, lastReadAt: new Date() },
      }),
      prisma.chatMessage.updateMany({
        where: { roomId, senderId: { not: userId }, isRead: false },
        data:  { isRead: true },
      }),
    ]);
  }
}
