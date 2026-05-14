import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { haversineKm } from "../utils/haversine";
import { createLogger } from "../utils/logger";
import { NannyStatus } from "@prisma/client";

const log = createLogger("location");
const TTL_MS = 15 * 60 * 1000; // 15 minutes (nanny pings every 10 min)

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

/**
 * Converts any date-like value from a Prisma Json field to milliseconds.
 *
 * Prisma+MongoDB can return Date values inside Json columns in several forms:
 *   • JavaScript Date object          (newer Prisma versions)
 *   • ISO string "2026-05-11T..."     (some serialisation paths)
 *   • { $date: "2026-05-11T..." }     (MongoDB extended JSON — most common)
 *   • { $date: { $numberLong: "..." } } (canonical extended JSON v2)
 *
 * Returning NaN on an unknown format is intentional — callers treat NaN
 * as "unparseable" and skip that slot (see hasSlotConflict).
 */
function toMs(val: unknown): number {
  if (val === null || val === undefined) return NaN;
  if (typeof val === "number") return val;
  if (val instanceof Date) return val.getTime();
  if (typeof val === "string") return new Date(val).getTime();

  if (typeof val === "object" && val !== null) {
    const obj = val as any;
    // { $date: "2026-05-11T03:30:00.000Z" }
    if (typeof obj.$date === "string" || typeof obj.$date === "number") {
      return new Date(obj.$date).getTime();
    }
    // { $date: { $numberLong: "1747019400000" } }
    if (
      typeof obj.$date === "object" &&
      obj.$date !== null &&
      typeof obj.$date.$numberLong === "string"
    ) {
      return parseInt(obj.$date.$numberLong, 10);
    }
  }

  return NaN;
}

/**
 * Reserved slots: [{ startTime, endTime, bookingId, isBlock }]
 *
 * Returns true when ANY stored slot overlaps the requested [reqStart, reqEnd) window.
 * Both regular bookings and blocked slots prevent availability.
 * A slot with unparseable times is treated as a conflict (safe default).
 *
 * Overlap logic: two time ranges [a1,a2) and [b1,b2) overlap iff a1 < b2 && b1 < a2
 */
function hasSlotConflict(
  reservedSlots: unknown,
  reqStart: number,
  reqEnd: number,
): boolean {
  if (!Array.isArray(reservedSlots) || reservedSlots.length === 0) return false;

  return (reservedSlots as any[]).some((slot) => {
    // Validate slot structure
    if (!slot || typeof slot !== "object") return false;

    const slotStart = toMs(slot.startTime);
    const slotEnd = toMs(slot.endTime);

    // Unparseable times → treat as conflict (safer than silently skipping)
    if (isNaN(slotStart) || isNaN(slotEnd)) {
      log.warn(
        `[hasSlotConflict] Unparseable slot detected: startTime=${slot.startTime} endTime=${slot.endTime} bookingId=${slot.bookingId}`,
      );
      return true;
    }

    // Validate time range sanity
    if (slotStart >= slotEnd) {
      log.warn(
        `[hasSlotConflict] Invalid slot: startTime (${slotStart}) >= endTime (${slotEnd}) bookingId=${slot.bookingId}`,
      );
      return true;
    }

    // Check for overlap: both regular bookings and blocks prevent availability
    const hasOverlap = slotStart < reqEnd && slotEnd > reqStart;

    if (hasOverlap) {
      log.debug(
        `[hasSlotConflict] Overlap detected: slot [${slotStart}-${slotEnd}] vs req [${reqStart}-${reqEnd}] isBlock=${slot.isBlock} bookingId=${slot.bookingId}`,
      );
    }

    return hasOverlap;
  });
}

// Normalise language param — may arrive as "Hindi,English" or ["Hindi","English"]
function parseLanguages(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw))
    return raw.map((l: any) => String(l).trim()).filter(Boolean);
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
  return [];
}

export class LocationService {
  /* ── PATCH /api/v1/location/nanny ────────────────────────────────────── */
  async updateMyLocation(userId: string, lat: number, lng: number) {
    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    // Allow during an active shift even if isActive flag isn't set
    const hasActiveShift = await prisma.booking.findFirst({
      where: { nannyId: nanny.id, status: "IN_PROGRESS" },
      select: { id: true },
    });

    if (!nanny.isActive && !hasActiveShift)
      throw new AppError("Your nanny account is not active", 403);

    store.set(nanny.id, {
      nannyId: nanny.id,
      userId,
      lat,
      lng,
      updatedAt: new Date(),
    });

    const existing = await prisma.address.findFirst({
      where: { userId, label: LIVE_LOCATION_LABEL },
    });

    if (existing) {
      await prisma.address.update({
        where: { id: existing.id },
        data: { lat, lng },
      });
      log.debug(
        `LIVE_LOCATION address updated: ${existing.id} lat=${lat} lng=${lng}`,
      );
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
      log.debug(
        `LIVE_LOCATION address created for userId=${userId} lat=${lat} lng=${lng}`,
      );
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

    return {
      nannyId,
      lat: entry.lat,
      lng: entry.lng,
      updatedAt: entry.updatedAt,
      name: nanny.name,
    };
  }

  /* ── GET /api/v1/location/nannies/nearby ─────────────────────────────── */
  async findNearby(lat: number, lng: number, radiusKm: number) {
    const cutoff = new Date(Date.now() - TTL_MS);
    const nearby: Array<{
      nannyId: string;
      distance: number;
      lat: number;
      lng: number;
    }> = [];

    for (const [, entry] of store.entries()) {
      if (entry.updatedAt < cutoff) continue;
      const dist = haversineKm(lat, lng, entry.lat, entry.lng);
      if (dist <= radiusKm)
        nearby.push({
          nannyId: entry.nannyId,
          distance: dist,
          lat: entry.lat,
          lng: entry.lng,
        });
    }

    if (nearby.length === 0) return { nannies: [], count: 0 };

    const nannyIds = nearby.map((n) => n.nannyId);
    const nannyDocs = await prisma.nanny.findMany({
      where: {
        id: { in: nannyIds },
        status: NannyStatus.VERIFIED,
        isAvailable: true,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        gender: true,
        profilePhoto: true,
        hourlyRate: true,
        rating: true,
        serviceTypes: true,
        experience: true,
      },
    });

    const result = nannyDocs
      .map((n) => {
        const loc = nearby.find((x) => x.nannyId === n.id)!;
        return {
          ...n,
          distanceKm: parseFloat(loc.distance.toFixed(2)),
          lat: loc.lat,
          lng: loc.lng,
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return { nannies: result, count: result.length, searchRadius: radiusKm };
  }

  /* ── GET /api/v1/location/explore ────────────────────────────────────── */
  async exploreNannies(params: any) {
    const {
      lat,
      lng,
      radius,
      careType,
      reqStartDate,
      reqEndDate, // booking period — used for slot overlap check
      preferredGender,
      languages,
      requirements,
      childAgeGroup,
    } = params;

    log.info(
      `[explore] Start - lat=${lat} lng=${lng} careType=${careType} gender=${preferredGender} start=${reqStartDate} end=${reqEndDate} childAgeGroup=${childAgeGroup}`,
    );

    const whereClause: any = {
      status: "VERIFIED",
      isActive: true,
      isAvailable: true,
    };

    if (preferredGender && preferredGender !== "Any")
      whereClause.gender = preferredGender;
    if (careType)
      whereClause.serviceTypes = {
        has: careType.replace(/[\s-]/g, "_").toUpperCase(),
      };

    const langList = parseLanguages(languages);
    if (langList.length > 0) whereClause.languages = { hasSome: langList };

    if (requirements && requirements.length > 0)
      whereClause.specializations = { hasEvery: requirements };
    if (childAgeGroup) whereClause.ageGroupsHandled = { has: childAgeGroup };

    let availableNannies = await prisma.nanny.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        rating: true,
        totalReviews: true,
        experience: true,
        bio: true,
        specializations: true,
        hourlyRate: true,
        dailyRate: true,
        profilePhoto: true,
        serviceRadius: true,
        reservedSlot: true,
        serviceTypes: true,
        user: {
          select: {
            name: true,
            profilePhoto: true,
            addresses: {
              where: { isDefault: true },
              select: { lat: true, lng: true },
            },
          },
        },
      },
    });

    log.info(
      `[explore] DB query returned ${availableNannies.length} verified nannies`,
    );

    // STEP 1: Filter by reserved slots (booking period overlap check)
    // This MUST be done before distance filter to avoid unnecessary distance calculations
    if (reqStartDate && reqEndDate) {
      const reqStart = toMs(reqStartDate);
      const reqEnd = toMs(reqEndDate);

      if (isNaN(reqStart) || isNaN(reqEnd)) {
        log.warn(
          `[explore] Invalid date range: start=${reqStartDate} end=${reqEndDate}. Skipping slot filter.`,
        );
      } else {
        const preSlotCount = availableNannies.length;
        availableNannies = availableNannies.filter((nanny: any) => {
          const hasConflict = hasSlotConflict(
            nanny.reservedSlot,
            reqStart,
            reqEnd,
          );
          if (hasConflict) {
            log.debug(
              `[explore] Nanny ${nanny.id} excluded due to slot conflict with booking [${reqStart}-${reqEnd}]`,
            );
          }
          // console.log(
          //   "you are going to check slot for this",
          //   nanny.reservedSlot,
          //   reqStart,
          //   reqEnd,
          // );
          return !hasConflict;
        });
        log.info(
          `[explore] After slot filter: ${preSlotCount} → ${availableNannies.length} nannies`,
        );
      }
    } else {
      log.debug(`[explore] No booking dates specified. Skipping slot filter.`);
    }

    // STEP 2: Filter by distance
    if (
      lat !== undefined &&
      lat !== null &&
      lng !== undefined &&
      lng !== null
    ) {
      const searchRadius = radius ? Math.max(1, Number(radius)) : 15; // minimum 1km

      const preDistanceCount = availableNannies.length;
      availableNannies = availableNannies.filter((nanny: any) => {
        const nannyAddress = nanny.user?.addresses?.[0];

        // Missing address = skip
        if (!nannyAddress?.lat || !nannyAddress?.lng) {
          log.debug(
            `[explore] Nanny ${nanny.id} excluded: missing default address coordinates`,
          );
          return false;
        }

        const distanceKm = haversineKm(
          lat,
          lng,
          nannyAddress.lat,
          nannyAddress.lng,
        );
        nanny._distanceKm = distanceKm;

        const nannyMaxTravel = Math.max(1, nanny.serviceRadius || 50); // minimum 1km
        const withinSearch = distanceKm <= searchRadius;
        const withinNannyRadius = distanceKm <= nannyMaxTravel;

        if (!withinSearch || !withinNannyRadius) {
          log.debug(
            `[explore] Nanny ${nanny.id} excluded: distance=${distanceKm.toFixed(2)}km (search=${searchRadius}, nanny service radius=${nannyMaxTravel})`,
          );
          return false;
        }

        return true;
      });

      log.info(
        `[explore] After distance filter: ${preDistanceCount} → ${availableNannies.length} nannies`,
      );
    } else {
      log.debug(`[explore] No location provided. Distance filter skipped.`);
    }

    // STEP 3: Sort by distance (if available)
    if (
      availableNannies.length > 0 &&
      availableNannies[0].serviceRadius !== undefined
    ) {
      availableNannies.sort(
        (a: any, b: any) => (a.serviceRadius || 0) - (b.serviceRadius || 0),
      );
      log.debug(`[explore] Results sorted by distance`);
    }

    log.info(
      `[explore] Final result: ${availableNannies.length} available nannies`,
    );

    // Transform to response format
    const result = availableNannies.map((nanny: any) => ({
      id: nanny.id,
      name: nanny.user?.name || nanny.name,
      isVerified: true,
      rating: nanny.rating || 0,
      reviews: nanny.totalReviews || 0,
      experience: nanny.experience || 0,
      description: nanny.bio || "",
      tags: nanny.specializations || [],
      hourlyRate: nanny.hourlyRate || 0,
      dailyRate: nanny.dailyRate || 0,
      avatar: nanny.user?.profilePhoto || nanny.profilePhoto,
      distance: nanny._distanceKm ? Number(nanny._distanceKm.toFixed(1)) : null,
      serviceTypes: nanny.serviceTypes || [],
      isOnline: true,
      isFavorite: false,
    }));

    return result;
  }

  /* ── GET /api/v1/location/explore/count ──────────────────────────────── */
  async countAvailableNannies(params: any): Promise<number> {
    log.info(
      `[countAvailableNannies] Start with params: ${JSON.stringify(params)}`,
    );
    try {
      const results = await this.exploreNannies(params);
      log.info(`[countAvailableNannies] Count result: ${results.length}`);
      return results.length;
    } catch (error) {
      log.error(
        `[countAvailableNannies] Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
