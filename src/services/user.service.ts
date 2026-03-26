import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";

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
      },
    });
    if (!user) throw new AppError("User not found", 404);

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
      fcmToken,
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
      createdAt,
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
      fcmToken,
      platform,
      lastLoginAt,
      childrens,
      createdAt,
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
    return prisma.user.update({
      where: { id: userId },
      data: { fcmToken: deviceToken, platform },
    });
  }
}
