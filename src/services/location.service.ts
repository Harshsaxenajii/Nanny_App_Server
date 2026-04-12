import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { haversineKm } from "../utils/haversine";
import { createLogger } from "../utils/logger";
import { NannyStatus, Prisma } from "@prisma/client";

const log = createLogger("location");
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// Label constant — no enum needed, Address.label is a plain String
export const LIVE_LOCATION_LABEL = "LIVE_LOCATION";

interface LocationEntry {
  nannyId: string;
  userId: string;
  lat: number;
  lng: number;
  updatedAt: Date;
}

// In-memory store: nannyId → LocationEntry
const store = new Map<string, LocationEntry>();

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const cutoff = new Date(Date.now() - TTL_MS);
  for (const [id, entry] of store.entries()) {
    if (entry.updatedAt < cutoff) store.delete(id);
  }
}, TTL_MS);

export class LocationService {
  /* ── PATCH /api/v1/location/nanny ────────────────────────────────────── */
  async updateMyLocation(userId: string, lat: number, lng: number) {
    const nanny = await prisma.nanny.findUnique({ where: { userId } });
    if (!nanny) throw new AppError("Nanny profile not found", 404);

    // Edge case: only active nannies can update location
    if (!nanny.isActive)
      throw new AppError("Your nanny account is not active", 403);

    // 1. Update in-memory store
    store.set(nanny.id, {
      nannyId: nanny.id,
      userId,
      lat,
      lng,
      updatedAt: new Date(),
    });

    // 2. Upsert LIVE_LOCATION address
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

    // Check TTL
    if (Date.now() - entry.updatedAt.getTime() > TTL_MS) {
      store.delete(nannyId);
      throw new AppError("Nanny location has expired (offline)", 404);
    }

    // Verify nanny exists
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
      if (entry.updatedAt < cutoff) continue; // stale
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

    // Fetch nanny details from DB
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
      reqStartTime,
      reqEndTime,
      maxRate,
      preferredGender,
      languages,
      requirements,
      childAgeGroup,
    } = params;

    console.log("\n--- STARTING NANNY EXPLORE FILTERS ---");

    // 1. Fetch Baseline Nannies (Verified, Active, Available)
    let availableNannies = await prisma.nanny.findMany({
      where: {
        status: "VERIFIED",
        isActive: true,
        isAvailable: true,
      },
      include: {
        user: {
          select: {
            name: true,
            profilePhoto: true,
            addresses: { where: { isDefault: true } },
          },
        },
        reservedSlot: true,
      },
    });

    console.log(
      `[Step 0] Baseline Available Nannies: ${availableNannies.length}`,
    );

    // Step 1: Strict Distance Calculation & Filtering
    if (lat && lng) {
      console.log("\n--- Calculating Distances ---");

      // 🔥 FIX: Strictly enforce the search radius limit (defaults to 15km if not provided)
      const searchRadius = radius ? Number(radius) : 15;

      availableNannies = availableNannies.filter((nanny: any) => {
        const nannyAddress = nanny.user?.addresses?.[0];
        if (!nannyAddress || !nannyAddress.lat || !nannyAddress.lng) {
          console.log(
            `Nanny: ${nanny.user?.name || nanny.name} | Distance: UNKNOWN (Skipping)`,
          );
          return false; // Exclude nannies with missing coordinates
        }

        const distanceKm = haversineKm(
          lat,
          lng,
          nannyAddress.lat,
          nannyAddress.lng,
        );
        console.log(
          `Nanny: ${nanny.user?.name || nanny.name} | Distance: ${distanceKm.toFixed(2)} km`,
        );

        nanny.distance = distanceKm;

        // 🔥 FIX: Distance must be strictly LESS than the parent's search radius
        // AND less than the nanny's maximum willing travel radius.
        const nannyMaxTravel = nanny.serviceRadius || 50; // Fallback if nanny didn't set one

        return distanceKm <= searchRadius && distanceKm <= nannyMaxTravel;
      });
      console.log(
        `[Step 1] Nannies strictly within ${searchRadius}km radius: ${availableNannies.length}`,
      );
    } else {
      console.log(
        `[Step 1] WARNING: No lat/lng provided! Skipping distance filter.`,
      );
    }

    // Step 2: Budget (Strictly Max Rate, ignoring minimum)
    if (maxRate) {
      availableNannies = availableNannies.filter((nanny: any) => {
        const rate = nanny.hourlyRate || 0;
        return rate <= maxRate;
      });
      console.log(
        `[Step 2] Nannies within budget (<= ₹${maxRate}): ${availableNannies.length}`,
      );
    }

    // Step 3: Gender
    if (preferredGender && preferredGender !== "Any") {
      availableNannies = availableNannies.filter(
        (nanny: any) => nanny.gender === preferredGender,
      );
      console.log(
        `[Step 3] Nannies matching gender (${preferredGender}): ${availableNannies.length}`,
      );
    }

    // Step 4: Languages (Has Some)
    if (languages && languages.length > 0) {
      availableNannies = availableNannies.filter((nanny: any) => {
        const nannyLangs = nanny.languages || [];
        return languages.some((lang: string) => nannyLangs.includes(lang));
      });
      console.log(
        `[Step 4] Nannies matching languages: ${availableNannies.length}`,
      );
    }

    // Step 5: Care Type
    if (careType) {
      const formattedType = careType.replace(" ", "_").toUpperCase();
      availableNannies = availableNannies.filter((nanny: any) => {
        const types = nanny.serviceTypes || [];
        return types.includes(formattedType);
      });
      console.log(
        `[Step 5] Nannies offering care type (${formattedType}): ${availableNannies.length}`,
      );
    }

    // Step 6: Requirements/Specializations (Has Every)
    if (requirements && requirements.length > 0) {
      availableNannies = availableNannies.filter((nanny: any) => {
        const specs = nanny.specializations || [];
        return requirements.every((req: string) => specs.includes(req));
      });
      console.log(
        `[Step 6] Nannies matching all requirements: ${availableNannies.length}`,
      );
    }

    // Step 7: Age Group
    if (childAgeGroup) {
      availableNannies = availableNannies.filter((nanny: any) => {
        const ages = nanny.ageGroupsHandled || [];
        return ages.includes(childAgeGroup);
      });
      console.log(
        `[Step 7] Nannies handling age group (${childAgeGroup}): ${availableNannies.length}`,
      );
    }

    // Step 8: Time Slot Availability (No overlaps)
    if (reqStartTime && reqEndTime) {
      const reqStart = new Date(reqStartTime).getTime();
      const reqEnd = new Date(reqEndTime).getTime();

      availableNannies = availableNannies.filter((nanny: any) => {
        const slots = nanny.reservedSlot || [];

        const hasOverlap = slots.some((slot: any) => {
          const slotStart = new Date(slot.startTime).getTime();
          const slotEnd = new Date(slot.endTime).getTime();
          return slotStart < reqEnd && slotEnd > reqStart;
        });

        return !hasOverlap;
      });
      console.log(
        `[Step 8] Nannies available during requested time: ${availableNannies.length}`,
      );
    }

    console.log("--- EXPLORE FILTERS COMPLETE ---\n");

    // 2. Sort remaining nannies by distance (closest first)
    availableNannies.sort(
      (a: any, b: any) => (a.distance || 0) - (b.distance || 0),
    );

    // 3. Format for the React Native Frontend
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
      avatar: nanny.user?.profilePhoto || nanny.profilePhoto,
      distance: nanny.distance ? Number(nanny.distance.toFixed(1)) : null,
      isOnline: true,
      isFavorite: false,
    }));
  }
}
