import { prisma } from "../config/prisma";
import { AppError } from "../utils/AppError";
import { createLogger } from "../utils/logger";
import { paginate, paginatedResult } from "../utils/response";
import { NannyStatus } from "@prisma/client";

const log = createLogger("nanny");

async function findNannyByUserOrFail(userId: string) {
  const nanny = await prisma.nanny.findUnique({ where: { userId } });
  if (!nanny)
    throw new AppError(
      "Nanny profile not found. Please register as a nanny first.",
      404,
    );
  return nanny;
}
import { BookingStatus } from "@prisma/client";

const UPCOMING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.CONFIRMED,
  BookingStatus.NANNY_ASSIGNED,
  BookingStatus.IN_PROGRESS,
];

const PAST_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED_BY_USER,
  BookingStatus.CANCELLED_BY_NANNY,
  BookingStatus.CANCELLED_BY_ADMIN,
];

export class NannyService {
  /* ── POST /api/v1/nannies/register (no auth — creates user + nanny) ── */
  async register(body: any) {
    const {
      mobile,
      countryCode = "+91",
      documents,
      dateOfBirth,
      gender,
      ...nannyFields
    } = body;

    if (!mobile) {
      throw new AppError("Mobile number is required", 400);
    }

    const existingNanny = await prisma.nanny.findFirst({
      where: {
        mobile,
      },
    });

    if (existingNanny)
      throw new AppError(
        "This mobile number is already registered as a nanny.",
        409,
      );

    // Edge case: if user account exists with this mobile, check they don't already have a nanny profile
    const existingUser = await prisma.user.findUnique({ where: { mobile } });
    if (existingUser) {
      const existingProfile = await prisma.nanny.findUnique({
        where: { userId: existingUser.id },
      });
      if (existingProfile)
        throw new AppError(
          "A nanny profile already exists for this account.",
          409,
        );
    }

    // Create or update user account and set role to NANNY
    const user = await prisma.user.upsert({
      where: { mobile },
      create: {
        mobile,
        countryCode,
        role: "NANNY",
        name: nannyFields.name,
        gender: gender ?? undefined,
      },
      update: {
        role: "NANNY",
        name: nannyFields.name,
        gender: gender ?? undefined,
        countryCode,
      },
    });

    const nanny = await prisma.nanny.create({
      data: {
        userId: user.id,
        mobile,
        name: nannyFields.name,
        email: nannyFields.email ?? null,
        gender: gender ?? null,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        experience: nannyFields.experience,
        bio: nannyFields.bio,
        languages: nannyFields.languages,
        serviceTypes: nannyFields.serviceTypes,
        specializations: nannyFields.specializations ?? [],
        ageGroupsHandled: nannyFields.ageGroupsHandled,
        hourlyRate: nannyFields.hourlyRate,
        dailyRate: nannyFields.dailyRate ?? null,
        serviceRadius: nannyFields.serviceRadius ?? null,
        workingAreas: nannyFields.workingAreas ?? [],
        documents: documents as any,
        status: NannyStatus.PENDING_VERIFICATION,
        isActive: false,
        isAvailable: false,
      },
    });

    log.info(`Nanny registered: ${nanny.id} mobile=${mobile}`);
    return {
      id: nanny.id,
      userId: user.id,
      status: nanny.status,
      message: "Registration successful. Your profile is under review.",
    };
  }

  /* ── GET /api/v1/nannies/search ─────────────────────────────────────── */
  async search(query: any) {
    const { page, limit, skip } = paginate(query);
    const where: any = {
      status: NannyStatus.VERIFIED,
      isAvailable: true,
      isActive: true,
    };

    if (query.serviceType) {
      where.serviceTypes = { has: query.serviceType };
    }
    if (query.city) {
      // Search in workingAreas (case-insensitive via contains is not supported in MongoDB Prisma,
      // so we use hasSome with exact match — tell users to search with exact city name)
      where.workingAreas = { has: query.city };
    }
    if (query.gender) {
      where.gender = query.gender;
    }
    if (query.minRate || query.maxRate) {
      where.hourlyRate = {};
      if (query.minRate) where.hourlyRate.gte = parseFloat(query.minRate);
      if (query.maxRate) where.hourlyRate.lte = parseFloat(query.maxRate);
    }

    const [nannies, total] = await Promise.all([
      prisma.nanny.findMany({
        where,
        skip,
        take: limit,
        orderBy: { rating: "desc" },
        select: {
          id: true,
          name: true,
          gender: true,
          profilePhoto: true,
          experience: true,
          bio: true,
          languages: true,
          serviceTypes: true,
          specializations: true,
          ageGroupsHandled: true,
          hourlyRate: true,
          dailyRate: true,
          serviceRadius: true,
          workingAreas: true,
          rating: true,
          totalReviews: true,
          totalBookings: true,
          isAvailable: true,
        },
      }),
      prisma.nanny.count({ where }),
    ]);

    return paginatedResult(nannies, total, page, limit);
  }

  async getMyProf(nannyId: string) {
    const nannyDetails = await prisma.nanny.findUnique({
      where: {
        userId: nannyId,
      },
    });
    // console.log(nannyDetails)
    if (!nannyDetails) throw new AppError("Nanny not found", 404);
    return nannyDetails;
  }

  /* ── GET /api/v1/nannies/:id ────────────────────────────────────────── */
  async getPublicProfile(nannyId: string) {
    const nanny = await prisma.nanny.findUnique({
      where: { id: nannyId },
      select: {
        id: true,
        name: true,
        gender: true,
        profilePhoto: true,
        status: true,
        experience: true,
        bio: true,
        languages: true,
        serviceTypes: true,
        specializations: true,
        ageGroupsHandled: true,
        hourlyRate: true,
        dailyRate: true,
        serviceRadius: true,
        workingAreas: true,
        rating: true,
        totalReviews: true,
        totalBookings: true,
        isAvailable: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!nanny) throw new AppError("Nanny not found", 404);
    return nanny;
  }

  /* ── PATCH /api/v1/nannies/me ───────────────────────────────────────── */
  async updateMyProfile(userId: string, body: any) {
    // Edge case: confirm nanny profile exists
    const nanny = await findNannyByUserOrFail(userId);

    const data: Record<string, any> = {};
    if (body.bio !== undefined) data.bio = body.bio;
    if (body.hourlyRate !== undefined) data.hourlyRate = body.hourlyRate;
    if (body.dailyRate !== undefined) data.dailyRate = body.dailyRate;
    if (body.languages !== undefined) data.languages = body.languages;
    if (body.workingAreas !== undefined) data.workingAreas = body.workingAreas;
    if (body.serviceRadius !== undefined)
      data.serviceRadius = body.serviceRadius;
    if (body.profilePhoto !== undefined) data.profilePhoto = body.profilePhoto;
    if (body.specializations !== undefined)
      data.specializations = body.specializations;
    if (body.idDocumentSubmitted !== undefined)
      data.idDocumentSubmitted = body.idDocumentSubmitted;
    if (body.documents !== undefined) data.documents = body.documents;

    return prisma.nanny.update({ where: { id: nanny.id }, data });
  }

  /* ── PATCH /api/v1/nannies/me/availability ──────────────────────────── */
  async setAvailability(userId: string, isAvailable: boolean) {
    const nanny = await findNannyByUserOrFail(userId);

    // Edge case: only VERIFIED nannies can go available
    if (isAvailable && nanny.status !== NannyStatus.VERIFIED) {
      throw new AppError(
        `Only verified nannies can set themselves as available. Your current status is: ${nanny.status}.`,
        400,
      );
    }
    // Edge case: suspended nannies cannot change availability
    if (nanny.status === NannyStatus.SUSPENDED) {
      throw new AppError(
        "Suspended nannies cannot change their availability.",
        403,
      );
    }

    return prisma.nanny.update({
      where: { id: nanny.id },
      data: { isAvailable },
    });
  }

  /* ── GET /api/v1/nannies/me/bookings ────────────────────────────────── */
  async getMyBookings(userId: string, query: any) {
    const nanny = await findNannyByUserOrFail(userId);
    const { page, limit, skip } = paginate(query);

    const where: any = { nannyId: nanny.id };

    // ── Tab filter (primary) ──────────────────────────────────────────────────
    if (query.tab === "upcoming") {
      where.status = { in: UPCOMING_STATUSES };
    } else if (query.tab === "past") {
      where.status = { in: PAST_STATUSES };
    }

    // ── Granular status override (optional, e.g. ?status=CONFIRMED) ──────────
    if (query.status) {
      where.status = query.status as BookingStatus;
    }

    // ── Service type filter ───────────────────────────────────────────────────
    if (query.serviceType) {
      where.serviceType = query.serviceType;
    }

    // ── Date range filter (optional) ─────────────────────────────────────────
    if (query.from || query.to) {
      where.scheduledStartTime = {};
      if (query.from) where.scheduledStartTime.gte = new Date(query.from);
      if (query.to) where.scheduledStartTime.lte = new Date(query.to);
    }

    // Upcoming: nearest first. Past: most recent first.
    const orderBy =
      query.tab === "upcoming"
        ? { scheduledStartTime: "asc" as const }
        : { scheduledStartTime: "desc" as const };

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          user: {
            select: { id: true, name: true, mobile: true, profilePhoto: true },
          },
          children: {
            select: { id: true, name: true, gender: true, birthDate: true },
          },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    return paginatedResult(bookings, total, page, limit);
  }
}
