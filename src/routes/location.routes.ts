import { Router, Request, Response, NextFunction } from "express";
import { LocationService } from "../services/location.service";
import { auth, roles, validate } from "../middlewares/index";
import { S } from "../validators/index";
import { ok } from "../utils/response";
import { prisma } from "../config/prisma";
import { createLogger } from "../utils/logger";

const routeLog = createLogger("location-route");

const router = Router();
const service = new LocationService();

router.use(auth);

const parseStringArray = (queryParam: any): string[] => {
  return queryParam
    ? String(queryParam)
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
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
        startDate, startTime,   // accept either name from the client
        endDate,   endTime,
        preferredGender,
        languages,
        requirements,
        addressId,
      } = req.query;
      // console.log("Received explore query:", req.query);

      const reqStartDate = (startTime || startDate) as string | undefined;
      const reqEndDate   = (endDate   || endTime)   as string | undefined;

      routeLog.info(`[/explore] raw query: ${JSON.stringify(req.query)}`);
      routeLog.info(`[/explore] resolved: reqStartDate=${reqStartDate} reqEndDate=${reqEndDate}`);

      // Get address coordinates
      let lat: number | undefined;
      let lng: number | undefined;

      const user = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: {
          addresses: {
            where: addressId ? { id: String(addressId) } : { isDefault: true },
          },
        },
      });

      if (user?.addresses?.[0]?.lat && user?.addresses?.[0]?.lng) {
        lat = user.addresses[0].lat;
        lng = user.addresses[0].lng;
      }
      routeLog.info(`[/explore] user address: lat=${lat} lng=${lng}`);

      // Get child's age group
      let childAgeGroup: string | undefined;
      if (childId) {
        const child = await prisma.children.findUnique({
          where: { id: String(childId) },
        });
        if (child?.birthDate) {
          const ageInYears =
            (Date.now() - child.birthDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          if (ageInYears < 1) childAgeGroup = "0-1 years";
          else if (ageInYears < 3) childAgeGroup = "1-3 years";
          else if (ageInYears < 6) childAgeGroup = "3-6 years";
          else childAgeGroup = "6+ years";
        }
      }
      routeLog.info(`[/explore] childAgeGroup=${childAgeGroup}`);

      const matches = await service.exploreNannies({
        lat,
        lng,
        radius: 15,
        careType: careType as string,
        reqStartDate,
        reqEndDate,
        preferredGender: preferredGender as string,
        languages: parseStringArray(languages),
        requirements: parseStringArray(requirements),
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
        startDate, startTime,   // accept either name from the client
        endDate,   endTime,
        preferredGender,
        languages,
        requirements,
        addressId,
      } = req.query;

      const reqStartDate = (startTime || startDate) as string | undefined;
      const reqEndDate   = (endDate   || endTime)   as string | undefined;

      routeLog.info(`[/explore/count] raw query: ${JSON.stringify(req.query)}`);
      routeLog.info(`[/explore/count] resolved: reqStartDate=${reqStartDate} reqEndDate=${reqEndDate}`);

      // Get address coordinates — mirror explore route so both use the same address
      let lat: number | undefined;
      let lng: number | undefined;

      const user = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: {
          addresses: {
            where: addressId ? { id: String(addressId) } : { isDefault: true },
          },
        },
      });

      if (user?.addresses?.[0]?.lat && user?.addresses?.[0]?.lng) {
        lat = user.addresses[0].lat;
        lng = user.addresses[0].lng;
      }
      routeLog.info(`[/explore/count] user address: lat=${lat} lng=${lng}`);

      // Get child's age group
      let childAgeGroup: string | undefined;
      if (childId) {
        const child = await prisma.children.findUnique({
          where: { id: String(childId) },
        });
        if (child?.birthDate) {
          const ageInYears =
            (Date.now() - child.birthDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          if (ageInYears < 1) childAgeGroup = "0-1 years";
          else if (ageInYears < 3) childAgeGroup = "1-3 years";
          else if (ageInYears < 6) childAgeGroup = "3-6 years";
          else childAgeGroup = "6+ years";
        }
      }
      routeLog.info(`[/explore/count] childAgeGroup=${childAgeGroup}`);

      const count = await service.countAvailableNannies({
        lat,
        lng,
        radius: 15,
        careType: careType as string,
        reqStartDate,
        reqEndDate,
        preferredGender: preferredGender as string,
        languages: parseStringArray(languages),
        requirements: parseStringArray(requirements),
        childAgeGroup,
      });

      res.json(ok({ count }, "Nanny count retrieved successfully"));
    } catch (e) {
      next(e);
    }
  },
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
