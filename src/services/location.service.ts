import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { haversineKm } from '../utils/haversine';
import { createLogger } from '../utils/logger';
import { NannyStatus, Prisma } from '@prisma/client';

const log = createLogger('location');
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// Label constant — no enum needed, Address.label is a plain String
export const LIVE_LOCATION_LABEL = 'LIVE_LOCATION';

interface LocationEntry {
  nannyId:   string;
  userId:    string;
  lat:       number;
  lng:       number;
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
    if (!nanny) throw new AppError('Nanny profile not found', 404);

    // Edge case: only active nannies can update location
    if (!nanny.isActive) throw new AppError('Your nanny account is not active', 403);

    // 1. Update in-memory store
    store.set(nanny.id, { nannyId: nanny.id, userId, lat, lng, updatedAt: new Date() });

    // 2. Upsert LIVE_LOCATION address
    const existing = await prisma.address.findFirst({
      where: { userId, label: LIVE_LOCATION_LABEL },
    });

    if (existing) {
      await prisma.address.update({
        where: { id: existing.id },
        data:  { lat, lng },
      });
      log.debug(`LIVE_LOCATION address updated: ${existing.id} lat=${lat} lng=${lng}`);
    } else {
      await prisma.address.create({
        data: {
          userId,
          label:        LIVE_LOCATION_LABEL,
          addressLine1: 'Live Location',
          addressLine2: null,
          city:         'Live',
          state:        'Live',
          pincode:      '000000',
          country:      'IN',
          isDefault:    false,
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
    if (!entry) throw new AppError('Nanny is offline or location unavailable', 404);

    // Check TTL
    if (Date.now() - entry.updatedAt.getTime() > TTL_MS) {
      store.delete(nannyId);
      throw new AppError('Nanny location has expired (offline)', 404);
    }

    // Verify nanny exists
    const nanny = await prisma.nanny.findUnique({ where: { id: nannyId } });
    if (!nanny) throw new AppError('Nanny not found', 404);

    return {
      nannyId,
      lat:       entry.lat,
      lng:       entry.lng,
      updatedAt: entry.updatedAt,
      name:      nanny.name,
    };
  }

  /* ── GET /api/v1/location/nannies/nearby ─────────────────────────────── */
  async findNearby(lat: number, lng: number, radiusKm: number) {
    const cutoff = new Date(Date.now() - TTL_MS);
    const nearby: Array<{ nannyId: string; distance: number; lat: number; lng: number }> = [];

    for (const [, entry] of store.entries()) {
      if (entry.updatedAt < cutoff) continue; // stale
      const dist = haversineKm(lat, lng, entry.lat, entry.lng);
      if (dist <= radiusKm) nearby.push({ nannyId: entry.nannyId, distance: dist, lat: entry.lat, lng: entry.lng });
    }

    if (nearby.length === 0) return { nannies: [], count: 0 };

    // Fetch nanny details from DB
    const nannyIds  = nearby.map(n => n.nannyId);
    const nannyDocs = await prisma.nanny.findMany({
      where: {
        id:          { in: nannyIds },
        status:      NannyStatus.VERIFIED,
        isAvailable: true,
        isActive:    true,
      },
      select: {
        id: true, name: true, gender: true, profilePhoto: true,
        hourlyRate: true, rating: true, serviceTypes: true, experience: true,
      },
    });

    const result = nannyDocs.map(n => {
      const loc = nearby.find(x => x.nannyId === n.id)!;
      return { ...n, distanceKm: parseFloat(loc.distance.toFixed(2)), lat: loc.lat, lng: loc.lng };
    }).sort((a, b) => a.distanceKm - b.distanceKm);

    return { nannies: result, count: result.length, searchRadius: radiusKm };
  }

  /* ── GET /api/v1/location/explore ────────────────────────────────────── */
  async exploreNannies(params: any) {
    const { 
      lat, lng, radius, careType, reqStartTime, reqEndTime, 
      minRate, maxRate, preferredGender, languages, 
      requirements, childAgeGroup 
    } = params;

    // 1. Build the Base Prisma Query
    const whereClause: Prisma.NannyWhereInput = {
      status: "VERIFIED",
      isActive: true,
      isAvailable: true,
    };

    // Filter: Gender (Only apply if it's not "Any" or empty)
    if (preferredGender && preferredGender !== "Any") {
      whereClause.gender = preferredGender;
    }

    // Filter: Languages (Nanny must speak AT LEAST ONE of the requested languages)
    if (languages && languages.length > 0) {
      whereClause.languages = { hasSome: languages };
    }

    // Filter: Care Type (Nanny must offer this service type)
    if (careType) {
      // Assuming careType string from frontend matches ServiceType enum
      const formattedType = careType.replace(" ", "_").toUpperCase();
      whereClause.serviceTypes = { has: formattedType as any };
    }

    // Filter: Requirements/Specializations (Nanny must have ALL requested skills)
    if (requirements && requirements.length > 0) {
      whereClause.specializations = { hasEvery: requirements };
    }

    // Filter: Age Group
    if (childAgeGroup) {
      whereClause.ageGroupsHandled = { has: childAgeGroup };
    }

    // Filter: Budget (Hourly Rate)
    if (minRate || maxRate) {
      whereClause.hourlyRate = {
        gte: minRate || 0,
        lte: maxRate || 99999
      };
    }

    // Filter: Time Slot Availability (Using Composite Types)
    if (reqStartTime && reqEndTime) {
      const start = new Date(reqStartTime);
      const end = new Date(reqEndTime);
      
      whereClause.reservedSlot = {
        none: {
          // Exclude nannies if they have a slot that overlaps with requested time
          startTime: { lt: end },
          endTime: { gt: start },
        },
      };
    }

    // 2. Fetch Nannies from DB
    const nannies = await prisma.nanny.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            name: true,
            profilePhoto: true,
            addresses: {
              where: { isDefault: true } // Get the Nanny's default address for distance calculation
            }
          }
        }
      }
    });

    // 3. Post-Process Distance Filtering
    let matchingNannies = nannies;

    if (lat && lng) {
      matchingNannies = nannies.filter(nanny => {
        const nannyAddress = nanny.user.addresses[0];
        if (!nannyAddress || !nannyAddress.lat || !nannyAddress.lng) return false;

        const distanceKm = haversineKm(lat, lng, nannyAddress.lat, nannyAddress.lng);
        
        // Use the Nanny's custom serviceRadius if they set one, otherwise use the parent's search radius
        const allowedRadius = nanny.serviceRadius || radius || 15;
        
        return distanceKm <= allowedRadius;
      });
    }

    // 4. Format for the React Native Frontend
    return matchingNannies.map(nanny => ({
      id: nanny.id,
      name: nanny.user.name || nanny.name,
      isVerified: true,
      rating: nanny.rating,
      reviews: nanny.totalReviews,
      experience: nanny.experience,
      description: nanny.bio,
      tags: nanny.specializations,
      hourlyRate: nanny.hourlyRate,
      avatar: nanny.user.profilePhoto || nanny.profilePhoto,
      isOnline: true, 
      isFavorite: false, // Could integrate UserFavorites check here later
    }));
  }
}