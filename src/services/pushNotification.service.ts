// src/services/pushNotification.service.ts
import * as admin from "firebase-admin";
import { prisma } from "../config/prisma";

// ─── Payload builders ─────────────────────────────────────────────────────────
// CRITICAL: We send data-only messages (no `notification` field at all).
// If you add a `notification` field alongside `data`, FCM delivers TWO messages:
//   1. The data message  → triggers setBackgroundMessageHandler
//   2. The notification  → displayed automatically by the system tray (duplicate)
// Notifee handles ALL display via setBackgroundMessageHandler, so we never
// need the FCM `notification` field.

function buildNormalPayload(
  title: string,
  body: string,
  extra: Record<string, any> = {},
): Record<string, string> {
  const data: Record<string, string> = { type: "NORMAL", title, body };
  for (const [k, v] of Object.entries(extra)) {
    data[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return data;
}

function buildBookingPayload(booking: {
  bookingId:     string;
  parentName:    string;
  parentPhoto?:  string;
  location:      string;
  address:       string;
  price:         string;
  duration:      string;
  startTime:     string;
  childAge:      string;
  distance:      string;
  specialNotes?: string;
  expiresIn?:    number;
}): Record<string, string> {
  return {
    type:         "BOOKING_REQUEST",
    title:        "🚨 New Booking Request",
    body:         `${booking.parentName} · ${booking.location} · ${booking.price}`,
    bookingId:    booking.bookingId,
    parentName:   booking.parentName,
    parentPhoto:  booking.parentPhoto  ?? "",
    location:     booking.location,
    address:      booking.address,
    price:        booking.price,
    duration:     booking.duration,
    startTime:    booking.startTime,
    childAge:     booking.childAge,
    distance:     booking.distance,
    specialNotes: booking.specialNotes ?? "",
    expiresIn:    String(booking.expiresIn ?? 300_000),
  };
}

// ─── Core sender ──────────────────────────────────────────────────────────────
async function sendMessages(
  tokens:   string[],
  data:     Record<string, string>,
  isUrgent = false,
): Promise<void> {
  const chunkSize = 500;

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize);

    const message: admin.messaging.MulticastMessage = {
      tokens: chunk,

      // ✅ data-only — Notifee shows the notification via background handler
      // ❌ NO `notification` field — adding it causes double delivery on Android
      data,

      android: {
        priority: "high",
        ttl:      isUrgent ? 300_000 : 3_600_000,
      },

      apns: {
        headers: {
          // priority 10 = immediate, 5 = normal
          "apns-priority":   isUrgent ? "10" : "5",
          // content-available wakes the app in background on iOS
          "apns-push-type":  "background",
        },
        payload: {
          aps: {
            // content-available:1 wakes iOS background handler (no sound/banner from FCM)
            // Notifee displays the actual notification inside the handler
            contentAvailable: true,
            ...(isUrgent && { interruptionLevel: "time-sensitive" }),
          },
        },
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(
        `[FCM] Sent ${response.successCount}/${chunk.length} · failed ${response.failureCount}`,
      );

      // Clean up dead tokens
      if (response.failureCount > 0) {
        const deadTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const code = resp.error?.code ?? "";
            if (
              code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered"
            ) {
              deadTokens.push(chunk[idx]);
            }
          }
        });
        if (deadTokens.length) {
          await prisma.pushToken.deleteMany({
            where: { token: { in: deadTokens } },
          });
          console.log(`[FCM] Deleted ${deadTokens.length} dead tokens`);
        }
      }
    } catch (err) {
      console.error("[FCM] Chunk send error:", err);
    }
  }
}

// ─── Token lookup ─────────────────────────────────────────────────────────────
async function getTokensForUsers(userIds: string[]): Promise<string[]> {
  const records = await prisma.pushToken.findMany({
    where: {
      userId: { in: userIds },
      user:   { notificationsPush: true },
    },
  });
  return records.map((r) => r.token);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendNormalNotification(
  userId: string,
  title:  string,
  body:   string,
  extra:  Record<string, any> = {},
): Promise<void> {
  const tokens = await getTokensForUsers([userId]);
  if (!tokens.length) return;
  await sendMessages(tokens, buildNormalPayload(title, body, extra), false);
}

export async function sendBookingRequestNotification(
  nannyUserId: string,
  booking: {
    bookingId:     string;
    parentName:    string;
    parentPhoto?:  string;
    location:      string;
    address:       string;
    price:         string;
    duration:      string;
    startTime:     string;
    childAge:      string;
    distance:      string;
    specialNotes?: string;
    expiresIn?:    number;
  },
): Promise<void> {
  const tokens = await getTokensForUsers([nannyUserId]);
  if (!tokens.length) {
    console.log(`[FCM] No tokens for nanny ${nannyUserId}`);
    return;
  }
  console.log(
    `[FCM] Sending booking request to nanny ${nannyUserId} (${tokens.length} token/s)`,
  );
  await sendMessages(tokens, buildBookingPayload(booking), true);
}

export async function sendNormalToMultipleUsers(
  userIds: string[],
  title:   string,
  body:    string,
  extra:   Record<string, any> = {},
): Promise<void> {
  const tokens = await getTokensForUsers(userIds);
  if (!tokens.length) return;
  await sendMessages(tokens, buildNormalPayload(title, body, extra), false);
}

export async function broadcastNormalNotification(
  title: string,
  body:  string,
  extra: Record<string, any> = {},
): Promise<void> {
  const records = await prisma.pushToken.findMany({
    where: { user: { notificationsPush: true } },
  });
  const tokens = records.map((r) => r.token);
  if (!tokens.length) return;
  await sendMessages(tokens, buildNormalPayload(title, body, extra), false);
}

// Legacy alias
export const sendPushToUser = sendNormalNotification;