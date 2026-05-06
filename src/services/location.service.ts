import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { haversineKm } from "../utils/haversine";
import { createLogger } from "../utils/logger";
import { NannyStatus } from "@prisma/client";

const log = createLogger("location");
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export const LIVE_LOCATION_LABEL = "LIVE_LOCATION";

interface LocationEntry {
  nannyId: string;
  userId: string;
  lat: number;
  lng: number;
  updatedAt: Date;
}

const store = new Map<string, LocationEntry>();

setInterval(() => {
  const cutoff = new Date(Date.now() - TTL_MS);
  for (const [id, entry] of store.entries()) {
    if (entry.updatedAt < cutoff) store.delete(id);
  }
}, TTL_MS);

// Handles ISO strings, Date objects, and MongoDB extended JSON { $date: "..." }
function toMs(val: any): number {
  if (!val) return NaN;
  if (typeof val === "number") return val;
  if (val instanceof Date) return val.getTime();
  if (typeof val === "string") return new Date(val).getTime();
  if (typeof val === "object" && val.$date) return new Date(val.$date).getTime();
  return NaN;
}

function normalizeSlots(raw: unknown): { startTime: any; endTime: any }[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.flatMap((item: any) => {
      if (item && Array.isArray(item.slots)) return item.slots;
      if (item && (item.startTime || item.endTime)) return [item];
      return [];
    });
  }

  if (typeof raw === "object") {
    const obj = raw as any;
    if (Array.isArray(obj.slots)) return obj.slots;
    if (obj.startTime || obj.endTime) return [obj];
  }

  return [];
}

function hasTimeOverlap(
  reservedSlot: unknown,
  reqStart: number,
  reqEnd: number,
): boolean {
  const slots = normalizeSlots(reservedSlot);
  if (slots.length === 0) return false;

  return slots.some((slot) => {
    const slotStart = toMs(slot.startTime);
    const slotEnd = toMs(slot.endTime);
    if (isNaN(slotStart) || isNaN(slotEnd)) return false;
    return slotStart < reqEnd && slotEnd > reqStart;
  });
}

// Returns true if the nanny has any reserved slot ending in the future
function hasAnyFutureSlot(reservedSlot: unknown): boolean {
  const slots = normalizeSlots(reservedSlot);
  if (slots.length === 0) return false;
  const now = Date.now();
  return slots.some((slot) => {
    const slotEnd = toMs(slot.endTime);
    return !isNaN(slotEnd) && slotEnd > now;
  });
}

// Normalise language param — may arrive as "Hindi,English" or ["Hindi","English"]
function parseLanguages(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((l: any) => String(l).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((l) => l.trim()).filter(Boolean);
  return [];
}

export class LocationService {
  /* ── PATCH /api/v1/location/nanny ────────────────────────────────────── */
  async updateMyLocation(userId: string, lat: number, lng: number) {
    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    if (!nanny.isActive)
      throw new AppError("Your nanny account is not active", 403);

    store.set(nanny.id, { nannyId: nanny.id, userId, lat, lng, updatedAt: new Date() });

    const existing = await prisma.address.findFirst({
      where: { userId, label: LIVE_LOCATION_LABEL },
    });

    if (existing) {
      await prisma.address.update({ where: { id: existing.id }, data: { lat, lng } });
      log.debug(`LIVE_LOCATION address updated: ${existing.id} lat=${lat} lng=${lng}`);
    } else {
      await prisma.address.create({
        data: {
          userId,
          label: LIVE_LOCATION_LABEL,
          addressLine1: "Live Location",
          addressLine2: null,
          city: "Live",
          state: "Live",
          pincode: "000000",
          country: "IN",
          isDefault: false,
          lat,
          lng,
        },
      });
      log.debug(`LIVE_LOCATION address created for userId=${userId} lat=${lat} lng=${lng}`);
    }

    log.debug(`Location updated: nanny=${nanny.id} lat=${lat} lng=${lng}`);
    return { updated: true, lat, lng };
  }

  /* ── GET /api/v1/location/nanny/:nannyId ─────────────────────────────── */
  async getNannyLocation(nannyId: string) {
    const entry = store.get(nannyId);
    if (!entry)
      throw new AppError("Nanny is offline or location unavailable", 404);

    if (Date.now() - entry.updatedAt.getTime() > TTL_MS) {
      store.delete(nannyId);
      throw new AppError("Nanny location has expired (offline)", 404);
    }

    const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
    if (!nanny) throw new AppError("Nanny not found", 404);

    return { nannyId, lat: entry.lat, lng: entry.lng, updatedAt: entry.updatedAt, name: nanny.name };
  }

  /* ── GET /api/v1/location/nannies/nearby ─────────────────────────────── */
  async findNearby(lat: number, lng: number, radiusKm: number) {
    const cutoff = new Date(Date.now() - TTL_MS);
    const nearby: Array<{ nannyId: string; distance: number; lat: number; lng: number }> = [];

    for (const [, entry] of store.entries()) {
      if (entry.updatedAt < cutoff) continue;
      const dist = haversineKm(lat, lng, entry.lat, entry.lng);
      if (dist <= radiusKm)
        nearby.push({ nannyId: entry.nannyId, distance: dist, lat: entry.lat, lng: entry.lng });
    }

    if (nearby.length === 0) return { nannies: [], count: 0 };

    const nannyIds = nearby.map((n) => n.nannyId);
    const nannyDocs = await prisma.nanny.findMany({
      where: { id: { in: nannyIds }, status: NannyStatus.VERIFIED, isAvailable: true, isActive: true },
      select: {
        id: true, name: true, gender: true, profilePhoto: true,
        hourlyRate: true, rating: true, serviceTypes: true, experience: true,
      },
    });

    const result = nannyDocs
      .map((n) => {
        const loc = nearby.find((x) => x.nannyId === n.id)!;
        return { ...n, distanceKm: parseFloat(loc.distance.toFixed(2)), lat: loc.lat, lng: loc.lng };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return { nannies: result, count: result.length, searchRadius: radiusKm };
  }

  /* ── GET /api/v1/location/explore ────────────────────────────────────── */
  async exploreNannies(params: any) {
    const {
      lat, lng, radius, careType,
      reqStartDate, reqEndDate,   // booking period — used for slot overlap check
      preferredGender, languages, requirements, childAgeGroup,
    } = params;

    const whereClause: any = { status: "VERIFIED", isActive: true, isAvailable: true };

    if (preferredGender && preferredGender !== "Any")
      whereClause.gender = preferredGender;
    if (careType)
      whereClause.serviceTypes = { has: careType.replace(/[\s-]/g, "_").toUpperCase() };

    const langList = parseLanguages(languages);
    if (langList.length > 0)
      whereClause.languages = { hasSome: langList };

    if (requirements && requirements.length > 0)
      whereClause.specializations = { hasEvery: requirements };
    if (childAgeGroup)
      whereClause.ageGroupsHandled = { has: childAgeGroup };

    let availableNannies = await prisma.nanny.findMany({
      where: whereClause,
      select: {
        id: true, name: true, rating: true, totalReviews: true,
        experience: true, bio: true, specializations: true,
        hourlyRate: true, dailyRate: true, profilePhoto: true,
        serviceRadius: true, reservedSlot: true, serviceTypes: true,
        user: {
          select: {
            name: true,
            profilePhoto: true,
            addresses: { where: { isDefault: true }, select: { lat: true, lng: true } },
          },
        },
      },
    });

    // Reserved slot filter — only applies when a booking period is specified
    if (reqStartDate && reqEndDate) {
      const reqStart = toMs(reqStartDate);
      const reqEnd = toMs(reqEndDate);

      if (!isNaN(reqStart) && !isNaN(reqEnd)) {
        availableNannies = availableNannies.filter(
          (nanny: any) => !hasTimeOverlap(nanny.reservedSlot, reqStart, reqEnd),
        );
      }
    }

    // Distance filter
    if (lat && lng) {
      const searchRadius = radius ? Number(radius) : 15;

      availableNannies = availableNannies.filter((nanny: any) => {
        const nannyAddress = nanny.user?.addresses?.[0];
        if (!nannyAddress?.lat || !nannyAddress?.lng) return false;
        const distanceKm = haversineKm(lat, lng, nannyAddress.lat, nannyAddress.lng);
        nanny._distanceKm = distanceKm;
        const nannyMaxTravel = nanny.serviceRadius || 50;
        return distanceKm <= searchRadius && distanceKm <= nannyMaxTravel;
      });
    }

    availableNannies.sort((a: any, b: any) => (a._distanceKm || 0) - (b._distanceKm || 0));

    return availableNannies.map((nanny: any) => ({
      id: nanny.id,
      name: nanny.user?.name || nanny.name,
      isVerified: true,
      rating: nanny.rating,
      reviews: nanny.totalReviews,
      experience: nanny.experience,
      description: nanny.bio,
      tags: nanny.specializations,
      hourlyRate: nanny.hourlyRate,
      dailyRate: nanny.dailyRate,
      avatar: nanny.user?.profilePhoto || nanny.profilePhoto,
      distance: nanny._distanceKm ? Number(nanny._distanceKm.toFixed(1)) : null,
      serviceTypes: nanny.serviceTypes,
      isOnline: true,
      isFavorite: false,
    }));
  }

  /* ── GET /api/v1/location/explore/count ──────────────────────────────── */
  async countAvailableNannies(params: any): Promise<number> {
    const {
      lat, lng, radius, careType,
      reqStartDate, reqEndDate,   // booking period — used for slot overlap check
      preferredGender, languages, requirements, childAgeGroup,
    } = params;

    const whereClause: any = { status: "VERIFIED", isActive: true, isAvailable: true };

    if (preferredGender && preferredGender !== "Any")
      whereClause.gender = preferredGender;
    if (careType)
      whereClause.serviceTypes = { has: careType.replace(/[\s-]/g, "_").toUpperCase() };

    const langList = parseLanguages(languages);
    if (langList.length > 0)
      whereClause.languages = { hasSome: langList };

    if (requirements && requirements.length > 0)
      whereClause.specializations = { hasEvery: requirements };
    if (childAgeGroup)
      whereClause.ageGroupsHandled = { has: childAgeGroup };

    let nanniesForCount = await prisma.nanny.findMany({
      where: whereClause,
      select: {
        id: true,
        serviceRadius: true,
        reservedSlot: true,
        user: {
          select: {
            addresses: { where: { isDefault: true }, select: { lat: true, lng: true } },
          },
        },
      },
    });

    if (reqStartDate && reqEndDate) {
      const reqStart = toMs(reqStartDate);
      const reqEnd = toMs(reqEndDate);

      if (!isNaN(reqStart) && !isNaN(reqEnd)) {
        nanniesForCount = nanniesForCount.filter(
          (nanny: any) => !hasTimeOverlap(nanny.reservedSlot, reqStart, reqEnd),
        );
      }
    } else {
      // No booking period sent — conservatively exclude nannies with any future reservation
      // so count never exceeds the results exploreNannies returns for a given booking window
      nanniesForCount = nanniesForCount.filter(
        (nanny: any) => !hasAnyFutureSlot(nanny.reservedSlot),
      );
    }

    if (lat && lng) {
      const searchRadius = radius ? Number(radius) : 15;

      nanniesForCount = nanniesForCount.filter((nanny: any) => {
        const address = nanny.user?.addresses?.[0];
        if (!address?.lat || !address?.lng) return false;
        const distanceKm = haversineKm(lat, lng, address.lat, address.lng);
        const maxTravel = nanny.serviceRadius || 50;
        return distanceKm <= searchRadius && distanceKm <= maxTravel;
      });
    }

    return nanniesForCount.length;
  }
}
