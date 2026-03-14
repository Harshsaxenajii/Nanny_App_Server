import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';
import { haversineKm } from '../utils/haversine';
import { createLogger } from '../utils/logger';
import { NannyStatus } from '@prisma/client';

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

    // 1. Update in-memory store (used for real-time tracking + nearby search)
    store.set(nanny.id, { nannyId: nanny.id, userId, lat, lng, updatedAt: new Date() });

    // 2. Upsert LIVE_LOCATION address in the addresses collection
    //    - If a LIVE_LOCATION address already exists for this user → update lat/lng only
    //    - If not → create a new address with label LIVE_LOCATION
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
}