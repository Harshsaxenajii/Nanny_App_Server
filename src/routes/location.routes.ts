import { Router, Request, Response, NextFunction } from "express";
import { LocationService } from "../services/location.service";
import { auth, roles, validate } from "../middlewares/index";
import { S } from "../validators/index";
import { ok } from "../utils/response";
import { prisma } from "../config/prisma";

const router = Router();
const service = new LocationService();

router.use(auth);

const parseStringArray = (queryParam: any): string[] => {
  return queryParam
    ? String(queryParam)
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0) // Filters out empty strings
    : [];
};

// PATCH /api/v1/location/nanny
router.patch(
  "/nanny",
  roles("NANNY"),
  validate(S.updateLocation),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(
        ok(
          await service.updateMyLocation(
            req.user!.userId,
            req.body.latitude,
            req.body.longitude,
          ),
          "Location updated",
        ),
      );
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/location/explore  ← MUST be before /nanny/:nannyId to avoid route collision
router.get(
  "/explore",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const {
        childId,
        careType,
        startTime,
        endTime,
        budget,
        preferredGender,
        languages,
        requirements,
        addressId,
      } = req.query;

      console.log("Explore query params:", req.query);

      // 1. Get Address Coordinates
      let lat: number | undefined;
      let lng: number | undefined;

      const addressWhere = addressId
        ? { id: String(addressId) }
        : { userId: String(userId), isDefault: true };

      const user = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: {
          addresses: {
            where: {
              isDefault: true,
            },
          },
        },
      });
      console.log("User addresses for explore:", user?.addresses);

      if (user?.addresses?.[0]?.lat && user?.addresses?.[0]?.lng) {
        lat = user.addresses[0].lat;
        lng = user.addresses[0].lng;
      }
      console.log("User coordinates for explore:", { lat, lng });
      // 2. Get Child's Age Group
      let childAgeGroup: string | undefined;
      if (childId) {
        const child = await prisma.children.findUnique({
          where: { id: String(childId) },
        });
        if (child && child.birthDate) {
          const ageInYears =
            (new Date().getTime() - child.birthDate.getTime()) /
            (1000 * 60 * 60 * 24 * 365.25);
          if (ageInYears < 1) childAgeGroup = "0-1 years";
          else if (ageInYears >= 1 && ageInYears < 3)
            childAgeGroup = "1-3 years";
          else if (ageInYears >= 3 && ageInYears < 6)
            childAgeGroup = "3-6 years";
          else childAgeGroup = "6+ years";
        }
      }

      // 3. Parse Budget String (✨ FIXED: Only uses the upper limit)
      let minRate = 0; // Forced to 0 so we don't restrict the lower bound
      let maxRate = 99999;

      if (budget && typeof budget === "string") {
        const numbers = budget.match(/\d+/g);
        if (numbers && numbers.length > 0) {
          // If string is "100-500", it grabs 500. If it's "500", it grabs 500.
          maxRate = parseInt(numbers[numbers.length - 1], 10);
        }
      }

      // 4. Pass parameters to the Explore Service
      const matches = await service.exploreNannies({
        lat,
        lng,
        radius: 15,
        careType: careType as string,
        reqStartTime: startTime as string,
        reqEndTime: endTime as string,
        minRate,
        maxRate,
        preferredGender: preferredGender as string,
        languages: languages ? String(languages).split(",") : [],
        requirements: requirements ? String(requirements).split(",") : [],
        childAgeGroup,
      });

      res.json(ok(matches, "Explore nannies successfully retrieved"));
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/explore/count",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const {
        childId,
        careType,
        startTime,
        endTime,
        budget,
        preferredGender,
        languages,
        requirements,
      } = req.query;

      // 1. Get Address Coordinates
      let lat: number | undefined;
      let lng: number | undefined;

      const user = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: {
          addresses: {
            where: { isDefault: true },
          },
        },
      });

      if (user?.addresses?.[0]?.lat && user?.addresses?.[0]?.lng) {
        lat = user.addresses[0].lat;
        lng = user.addresses[0].lng;
      }

      // 2. Get Child's Age Group
      let childAgeGroup: string | undefined;
      if (childId) {
        const child = await prisma.children.findUnique({
          where: { id: String(childId) },
        });
        if (child && child.birthDate) {
          const ageInYears =
            (new Date().getTime() - child.birthDate.getTime()) /
            (1000 * 60 * 60 * 24 * 365.25);
          if (ageInYears < 1) childAgeGroup = "0-1 years";
          else if (ageInYears >= 1 && ageInYears < 3) childAgeGroup = "1-3 years";
          else if (ageInYears >= 3 && ageInYears < 6) childAgeGroup = "3-6 years";
          else childAgeGroup = "6+ years";
        }
      }

      // 3. Parse Budget String Safely
      let maxRate = 99999;
      if (budget && typeof budget === "string") {
        const cleanBudget = budget.replace(/,/g, ""); // 🔥 Fixes "25,000" -> "25000"
        const numbers = cleanBudget.match(/\d+/g);

        if (numbers && numbers.length > 0) {
          maxRate = parseInt(numbers[numbers.length - 1], 10);
        }
      }

      // 4. Pass parameters to the Count Service
      const count = await service.countAvailableNannies({
        lat,
        lng,
        radius: 15,
        careType: careType as string,
        reqStartTime: startTime as string,
        reqEndTime: endTime as string,
        maxRate,
        preferredGender: preferredGender as string,
        languages: parseStringArray(languages),       // 🔥 Strictly parsed array
        requirements: parseStringArray(requirements), // 🔥 Strictly parsed array
        childAgeGroup,
      });

      res.json(ok({ count }, "Nanny count retrieved successfully"));
    } catch (e) {
      next(e);
    }
  }
);

// GET /api/v1/location/nannies/nearby  ← MUST be before /nanny/:nannyId
router.get(
  "/nannies/nearby",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lat = parseFloat(req.query.latitude as string);
      const lng = parseFloat(req.query.longitude as string);
      const radius = parseFloat(req.query.radius as string) || 10;

      if (isNaN(lat) || isNaN(lng)) {
        res.status(400).json({
          success: false,
          message: "latitude and longitude are required query parameters",
          statusCode: 400,
        });
        return;
      }
      res.json(ok(await service.findNearby(lat, lng, radius)));
    } catch (e) {
      next(e);
    }
  },
);

// GET /api/v1/location/nanny/:nannyId
router.get(
  "/nanny/:nannyId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(ok(await service.getNannyLocation(req.params.nannyId)));
    } catch (e) {
      next(e);
    }
  },
);

export { router as locationRouter };
