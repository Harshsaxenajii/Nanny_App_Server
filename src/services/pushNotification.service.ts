// src/services/pushNotification.service.ts
import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "../config/prisma";

const expo = new Expo();

// ── Single user ko notification bhejo ────────────────────────────────────────
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data: Record<string, any> = {},
): Promise<void> {
  const pushTokens = await prisma.pushToken.findMany({
    where: { 
      userId,
      // ✨ ADDED: Only fetch if user has notificationsPush set to true
      user: {
        notificationsPush: true
      }
    },
  });

  console.log(`Found ${pushTokens.length} push tokens for userId: ${userId}`);

  if (!pushTokens.length) return;

  const messages: ExpoPushMessage[] = [];

  for (const { token } of pushTokens) {
    if (!Expo.isExpoPushToken(token)) {
      console.warn(`Invalid token: ${token}`);
      continue;
    }
    console.log(`Adding message for token: ${token}`);

    messages.push({
      to: token,
      sound: "default",
      title,
      body,
      data,
      channelId: "default", // Android channel
    });
  }

  await sendMessages(messages);
}

// ── Multiple users ko notification bhejo ─────────────────────────────────────
export async function sendPushToMultipleUsers(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, any> = {},
): Promise<void> {
  const pushTokens = await prisma.pushToken.findMany({
    where: { 
      userId: { in: userIds },
      // ✨ ADDED: Only fetch if user has notificationsPush set to true
      user: {
        notificationsPush: true
      }
    },
  });

  if (!pushTokens.length) return;

  const messages: ExpoPushMessage[] = [];

  for (const { token } of pushTokens) {
    if (!Expo.isExpoPushToken(token)) continue;

    messages.push({
      to: token,
      sound: "default",
      title,
      body,
      data,
      channelId: "default",
    });
  }

  await sendMessages(messages);
}

// ── Sabko notification bhejo (broadcast) ─────────────────────────────────────
export async function sendPushToAll(
  title: string,
  body: string,
  data: Record<string, any> = {},
): Promise<void> {
  const pushTokens = await prisma.pushToken.findMany({
    where: {
      // ✨ ADDED: Only fetch tokens for users who have push notifications enabled
      user: {
        notificationsPush: true
      }
    }
  });

  if (!pushTokens.length) return;

  const messages: ExpoPushMessage[] = pushTokens
    .filter(({ token }) => Expo.isExpoPushToken(token))
    .map(({ token }) => ({
      to: token,
      sound: "default",
      title,
      body,
      data,
      channelId: "default",
    }));

  await sendMessages(messages);
}

// ── Internal helper — chunked sending + receipt check ────────────────────────
async function sendMessages(messages: ExpoPushMessage[]): Promise<void> {
  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error("Error sending chunk:", error);
    }
  }

  // Invalid token cleanup — expired tokens delete karo
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i] as any;
    if (
      ticket.status === "error" &&
      ticket.details?.error === "DeviceNotRegistered"
    ) {
      const invalidToken = (messages[i] as any).to;
      await prisma.pushToken.deleteMany({
        where: { token: invalidToken },
      });
      console.log(`Deleted invalid token: ${invalidToken}`);
    }
  }
}