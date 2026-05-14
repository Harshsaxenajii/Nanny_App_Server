import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { sendPushToUser } from "./pushNotification.service";

const log = createLogger("user");

/* ─────────────────────────────── helpers ──────────────────────────────── */
async function findUserOrFail(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError("User not found", 404);
  return user;
}

async function findAddressOrFail(addressId: string, userId: string) {
  const addr = await prisma.address.findUnique({ where: { id: addressId } });
  if (!addr) throw new AppError("Address not found", 404);
  if (addr.userId !== userId)
    throw new AppError("You do not own this address", 403);
  return addr;
}

function ageInMonths(birthDate: Date): number {
  const now = new Date();
  return (
    (now.getFullYear() - birthDate.getFullYear()) * 12 +
    (now.getMonth() - birthDate.getMonth())
  );
}

/* ─────────────────────────── UserService ──────────────────────────────── */
export class UserService {
  async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] },
        childrens: true,
        pushTokens: true,
      },
    });
    if (!user) throw new AppError("User not found", 404);
    console.log("User profile retrieved for userId: ", userId);

    const {
      id,
      mobile,
      countryCode,
      name,
      email,
      gender,
      dateOfBirth,
      profilePhoto,
      isMobileVerified,
      role,
      pushTokens,
      platform,
      lastLoginAt,
      childrens,
      preferredNannyGender,
      languagesSpoken,
      notificationsSms,
      notificationsPush,
      emergencyContactName,
      emergencyContactMobile,
      emergencyContactRelationship,
      addresses,
      // createdAt,
      updatedAt,
    } = user;

    return {
      id,
      mobile,
      countryCode,
      name,
      email,
      gender,
      dateOfBirth,
      profilePhoto,
      isMobileVerified,
      role,
      pushTokens,
      platform,
      lastLoginAt,
      childrens,
      // createdAt,
      updatedAt,
      preferences: {
        preferredNannyGender,
        languagesSpoken,
        notificationsSms,
        notificationsPush,
      },
      emergencyContact: emergencyContactName
        ? {
            name: emergencyContactName,
            mobile: emergencyContactMobile,
            relationship: emergencyContactRelationship,
          }
        : null,
      addresses,
    };
  }

  async updateProfile(userId: string, body: any) {
    // Edge case: confirm user exists before updating
    await findUserOrFail(userId);

    const { preferences, dateOfBirth, ...rest } = body;
    const data: Record<string, any> = { ...rest };
    if (dateOfBirth) data.dateOfBirth = new Date(dateOfBirth);
    if (preferences) {
      if (preferences.preferredNannyGender !== undefined)
        data.preferredNannyGender = preferences.preferredNannyGender;
      if (preferences.languagesSpoken !== undefined)
        data.languagesSpoken = preferences.languagesSpoken;
      if (preferences.notificationsSms !== undefined)
        data.notificationsSms = preferences.notificationsSms;
      if (preferences.notificationsPush !== undefined)
        data.notificationsPush = preferences.notificationsPush;
    }
    if (Object.keys(data).length === 0)
      throw new AppError("No valid fields to update", 400);

    console.log("sending push notification to userId: ", userId);
    sendPushToUser(
      userId,
      "Profile Updated",
      "Your profile information has been updated successfully.",
    );

    return prisma.user.update({ where: { id: userId }, data });
  }

  // --- ADD CHILD---
  async addChild(userId: string, body: any) {
    await findUserOrFail(userId);

    // Ensure body is an array
    if (!Array.isArray(body) || body.length === 0) {
      throw new AppError("Body must be a non-empty array of children", 400);
    }

    const childrenData: any[] = [];

    for (const child of body) {
      const { name, birthDate, gender } = child;

      // Validate required fields
      if (!name || !birthDate || !gender) {
        throw new AppError(
          "Each child must have name, birthDate and gender",
          400,
        );
      }

      const parsedBirthDate = new Date(birthDate);

      // Validate date format
      if (isNaN(parsedBirthDate.getTime())) {
        throw new AppError(`Invalid birthDate for child: ${name}`, 400);
      }

      // Validate not future date
      if (parsedBirthDate > new Date()) {
        throw new AppError(
          `birthDate cannot be in the future for child: ${name}`,
          400,
        );
      }

      childrenData.push({
        userId,
        name,
        birthDate: parsedBirthDate,
        gender,
        age: ageInMonths(parsedBirthDate),
      });
    }

    // Bulk insert
    return prisma.children.createMany({
      data: childrenData,
    });
  }

  // --- UPDATE CHILD ---
  async updateChild(userId: string, childId: string, body: any) {
    await findUserOrFail(userId);

    // Verify the child exists and belongs to the user
    const existingChild = await prisma.children.findUnique({
      where: { id: childId },
    });

    if (!existingChild || existingChild.userId !== userId) {
      throw new AppError("Child not found or unauthorized", 404);
    }

    const { name, birthDate, gender } = body;
    console.log(name, birthDate, gender);
    const updateData: any = {};

    if (name) updateData.name = name;
    if (gender) updateData.gender = gender;

    if (birthDate) {
      const parsedBirthDate = new Date(birthDate);

      // Validate date format
      if (isNaN(parsedBirthDate.getTime())) {
        throw new AppError("Invalid birthDate format", 400);
      }

      // Validate not future date
      if (parsedBirthDate > new Date()) {
        throw new AppError("birthDate cannot be in the future", 400);
      }

      updateData.birthDate = parsedBirthDate;
      // Note: Omitted the previous age-in-months calculation here
      // so you can use the exact age calculation from the DOB directly.
    }

    // Execute the update
    return prisma.children.update({
      where: { id: childId },
      data: updateData,
    });
  }

  // --- DELETE CHILD ---
  async deleteChild(userId: string, childId: string) {
    await findUserOrFail(userId);

    // 1. Find the child AND look for any attached bookings
    const existingChild = await prisma.children.findUnique({
      where: { id: childId },
      include: {
        // NOTE: Change "bookings" to match the exact relation name in your schema.prisma
        bookings: {
          select: { id: true },
          take: 1, // We only need to find 1 booking to know we must block the deletion
        },
      },
    });

    // 2. Standard Auth Check
    if (!existingChild || existingChild.userId !== userId) {
      throw new AppError("Child not found or unauthorized", 404);
    }

    // 3. The Booking Check
    if (existingChild.bookings && existingChild.bookings.length > 0) {
      throw new AppError(
        "You have some bookings on this child so you can't delete this.",
        409, // 409 Conflict is the standard HTTP status for this kind of block
      );
    }

    // 4. Execute the deletion safely
    return prisma.children.delete({
      where: { id: childId },
    });
  }

  /* ── Addresses ─────────────────────────────────────────────────────── */
  async addAddress(userId: string, body: any) {
    // Edge case: user must exist
    await findUserOrFail(userId);

    const coords = body.coordinates?.coordinates;
    const data: any = {
      userId,
      label: body.label,
      addressLine1: body.addressLine1,
      addressLine2: body.addressLine2 || null,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      country: body.country || "IN",
      isDefault: body.isDefault ?? false,
      lat: coords ? coords[1] : null,
      lng: coords ? coords[0] : null,
    };

    // If this will be default, unset existing defaults first
    if (data.isDefault) {
      await prisma.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    // If user has no addresses yet, force this one as default
    const count = await prisma.address.count({ where: { userId } });
    if (count === 0) data.isDefault = true;

    return prisma.address.create({ data });
  }

  async getAddresses(userId: string) {
    await findUserOrFail(userId);
    return prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  }

  async updateAddress(userId: string, addressId: string, body: any) {
    const addr = await findAddressOrFail(addressId, userId);
    console.log("Existing address data: ", addr);
    console.log("Incoming update data: ", body);
    const coords = body.coordinates?.coordinates;
    const data: Record<string, any> = {};

    if (body.label !== undefined) data.label = body.label;
    if (body.addressLine1 !== undefined) data.addressLine1 = body.addressLine1;
    if (body.addressLine2 !== undefined) data.addressLine2 = body.addressLine2;
    if (body.city !== undefined) data.city = body.city;
    if (body.state !== undefined) data.state = body.state;
    if (body.pincode !== undefined) data.pincode = body.pincode;
    if (coords) {
      data.lat = coords[1];
      data.lng = coords[0];
    }

    // Setting a new default
    if (body.isDefault === true && !addr.isDefault) {
      await prisma.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      data.isDefault = true;
    }
    // Cannot un-default the only address
    if (body.isDefault === false && addr.isDefault) {
      const total = await prisma.address.count({ where: { userId } });
      if (total === 1)
        throw new AppError("Cannot remove default from your only address", 400);
      data.isDefault = false;
    }

    return prisma.address.update({ where: { id: addressId }, data });
  }

  async deleteAddress(userId: string, addressId: string) {
    const addr = await findAddressOrFail(addressId, userId);

    // Edge case: cannot delete the only address
    const total = await prisma.address.count({ where: { userId } });
    if (total === 1) throw new AppError("Cannot delete your only address", 400);

    // Edge case: cannot delete the default address without setting a new one
    if (addr.isDefault) {
      // Auto-promote the next oldest address to default
      const next = await prisma.address.findFirst({
        where: { userId, id: { not: addressId } },
        orderBy: { createdAt: "asc" },
      });
      if (next)
        await prisma.address.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
    }

    await prisma.address.delete({ where: { id: addressId } });
  }

  /* ── Emergency Contact ─────────────────────────────────────────────── */
  async setEmergencyContact(userId: string, body: any) {
    await findUserOrFail(userId);
    return prisma.user.update({
      where: { id: userId },
      data: {
        emergencyContactName: body.name,
        emergencyContactMobile: body.mobile,
        emergencyContactRelationship: body.relationship,
      },
    });
  }

  /* ── Device Token ──────────────────────────────────────────────────── */
  async registerDeviceToken(
    userId: string,
    deviceToken: string,
    platform: string,
  ) {
    await findUserOrFail(userId);
    if (!deviceToken) {
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: { notificationsPush: true },
    });

    return await prisma.pushToken.upsert({
      where: { token: deviceToken },
      update: { userId },
      create: { token: deviceToken, userId },
    });
  }

  async removeDeviceToken(userId: string, deviceToken: string) {
    await findUserOrFail(userId);
    prisma.user.update({
      where: { id: userId },
      data: {
        notificationsPush: false,
      },
    });

    return prisma.pushToken.deleteMany({
      where: { token: deviceToken, userId },
    });
  }

  async togglePushNotification(userId: string) {
    const user = await findUserOrFail(userId);

    return prisma.user.update({
      where: { id: userId },
      data: {
        notificationsPush: !user.notificationsPush,
      },
    });
  }

  async toggleSmsNotification(userId: string) {
    const user = await findUserOrFail(userId);

    return prisma.user.update({
      where: { id: userId },
      data: {
        notificationsSms: !user.notificationsSms,
      },
    });
  }

  async updateUserEmail(userId: string, emailId: string) {
    await findUserOrFail(userId);

    return prisma.user.update({
      where: { id: userId },
      data: {
        email: emailId,
      },
    });
  }

  async getMyPayments(userId: string) {
    await findUserOrFail(userId);
    return prisma.payment.findMany({
      where: {
        userId: userId,
      },
    });
  }

  async reportBug(userId: string, body: { title: string; description: string }) {
    await findUserOrFail(userId);
    return prisma.reportBug.create({
      data: {
        description: body.description,
        issueName: body.title,
        userId: userId,
      },
    });
  }

  async getDashboard(userId: string) {
    await findUserOrFail(userId);

    const now = new Date();

    const UPCOMING_STATUSES = [
      // 'PENDING_NANNY_CONFIRMATION',
      // 'PENDING_PAYMENT',
      'CONFIRMED',
      // 'NANNY_ASSIGNED',
      'IN_PROGRESS',
    ];

    const [upcomingBookings, unreadCount, children, completedCount] = await Promise.all([
      prisma.booking.findMany({
        where: { userId, status: { in: UPCOMING_STATUSES as any } },
        orderBy: { scheduledStartTime: 'asc' },
        take: 2,
        select: {
          id: true,
          status: true,
          serviceType: true,
          scheduledStartTime: true,
          scheduledEndTime: true,
          totalAmount: true,
          nanny: { select: { name: true, profilePhoto: true } },
          children: { select: { name: true } },
        },
      }),
      prisma.notification.count({ where: { userId, isRead: false } }),
      prisma.children.findMany({ where: { userId }, select: { id: true, name: true, birthDate: true } }),
      prisma.booking.count({ where: { userId, status: 'COMPLETED' } }),
    ]);

    // Birthday check: match month + day regardless of year
    const birthdayChildren = children
      .filter((c) => {
        if (!c.birthDate) return false;
        const bd = new Date(c.birthDate);
        return bd.getMonth() === now.getMonth() && bd.getDate() === now.getDate();
      })
      .map((c) => ({ id: c.id, name: c.name }));

    return {
      upcomingBookings,
      hasUnreadNotifications: unreadCount > 0,
      unreadNotificationCount: unreadCount,
      birthdayChildren,
      totalCompletedBookings: completedCount,
    };
  }

  async deleteAccount(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { nannyProfile: { select: { id: true } } },
    });
    if (!user) throw new AppError("User not found", 404);

    const nannyId = user.nannyProfile?.id ?? null;

    // Collect booking IDs first (needed for cascade deletes)
    const bookingIds = (
      await prisma.booking.findMany({ where: { userId }, select: { id: true } })
    ).map((b) => b.id);

    // Collect daily plan + task IDs for explicit deletion
    const planIds =
      bookingIds.length > 0
        ? (
            await prisma.dailyPlan.findMany({
              where: { bookingId: { in: bookingIds } },
              select: { id: true },
            })
          ).map((p) => p.id)
        : [];

    const taskIds =
      planIds.length > 0
        ? (
            await prisma.planTask.findMany({
              where: { planId: { in: planIds } },
              select: { id: true },
            })
          ).map((t) => t.id)
        : [];

    // Chat rooms linked to these bookings
    const chatRoomIds =
      bookingIds.length > 0
        ? (
            await prisma.chatRoom.findMany({
              where: { bookingId: { in: bookingIds } },
              select: { id: true },
            })
          ).map((r) => r.id)
        : [];

    // Delete in dependency order — deepest children first
    if (taskIds.length > 0)
      await prisma.taskLog.deleteMany({ where: { taskId: { in: taskIds } } });

    if (nannyId)
      await prisma.taskLog.deleteMany({ where: { nannyId } });

    if (planIds.length > 0)
      await prisma.planTask.deleteMany({ where: { planId: { in: planIds } } });

    if (planIds.length > 0)
      await prisma.dailyPlan.deleteMany({ where: { id: { in: planIds } } });

    if (bookingIds.length > 0) {
      await prisma.nannyPayment.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.attendanceRecord.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingExtension.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
    }

    // Chat: messages + participants cascade from ChatRoom (Prisma-level)
    if (chatRoomIds.length > 0) {
      await prisma.chatMessage.deleteMany({ where: { roomId: { in: chatRoomIds } } });
      await prisma.chatParticipant.deleteMany({ where: { roomId: { in: chatRoomIds } } });
      await prisma.chatRoom.deleteMany({ where: { id: { in: chatRoomIds } } });
    }

    // RequestedDayWiseDailyPlan + RequestedDailyPlan cascade from Booking (schema-level)
    // but delete explicitly to be safe
    if (bookingIds.length > 0) {
      const rdwdpIds = (
        await prisma.requestedDayWiseDailyPlan.findMany({
          where: { bookingId: { in: bookingIds } },
          select: { id: true },
        })
      ).map((r) => r.id);
      if (rdwdpIds.length > 0) {
        await prisma.requestedDailyPlan.deleteMany({
          where: { requestedDayWiseDailyPlanId: { in: rdwdpIds } },
        });
        await prisma.requestedDayWiseDailyPlan.deleteMany({
          where: { id: { in: rdwdpIds } },
        });
      }
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }

    // User-owned data
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.address.deleteMany({ where: { userId } });
    await prisma.children.deleteMany({ where: { userId } });
    await prisma.pushToken.deleteMany({ where: { userId } });
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.otpRecord.deleteMany({ where: { userId } });
    await prisma.chatParticipant.deleteMany({ where: { userId } });

    if (nannyId)
      await prisma.nanny.delete({ where: { id: nannyId } });

    await prisma.user.delete({ where: { id: userId } });

    log.info(`[deleteAccount] User ${userId} and all associated data deleted`);
  }
}
