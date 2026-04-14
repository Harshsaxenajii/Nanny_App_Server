import { Router } from "express";
import { seedTestBooking } from "../services/seed.service";

const router = Router();

/**
 * @route   GET /api/v1/dev/seed
 * @desc    Initialize database with dummy Admin, User, Nanny, and Bookings
 * @access  Development Only
 */
router.get("/seed", async (req, res) => {
  try {
    // Call the decoupled logic function with 0 arguments
    const seedResult = await seedTestBooking();

    return res.status(200).json({
      success: true,
      message: "Database seeded successfully! 🚀",
      data: seedResult,
      service: "nanny-app",
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("Seed Error:", error);
    return res.status(500).json({
      success: false,
      message: "Seeding failed",
      error: error.message
    });
  }
});

export { router as seedRouter };