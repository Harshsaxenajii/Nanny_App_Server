import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const seedTestBooking = async () => {
  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(startDate.getDate() + 35);

  try {
    // 1. Create the base Booking record (No nested relations)
    const testBooking = await prisma.booking.create({
      data: {
        userId: "69d7749348b8e134e3796c93",
        nannyId: "69d7749348b8e134e3796c96",
        childrenId: "69d7749348b8e134e3796c95",
        status: "CONFIRMED",
        serviceType: "FULL_TIME",
        scheduledStartTime: startDate,
        scheduledEndTime: endDate,
        addressLine1: "House 42, Green Avenue",
        addressCity: "Bangalore",
        addressState: "Karnataka",
        addressPincode: "560102",
        addressCountry: "IN",
        baseAmount: 40000,
        gstAmount: 7200,
        totalAmount: 47200,
        parentGoalPrompt: "I want my 3-year-old to improve their speech, learn to share with others, and develop fine motor skills for writing over the next month.",
        aiPlanGenerated: true,
        aiPlanGeneratedAt: new Date(),
      }
    });

    const bookingId = testBooking.id;

    // 2. Create the Payment
    await prisma.payment.create({
      data: {
        bookingId: bookingId,
        userId: "69d7749348b8e134e3796c93",
        amount: 47200,
        status: "CAPTURED",
        capturedAt: new Date(),
        razorpayOrderId: "order_mock_test123",
        razorpayPaymentId: "pay_mock_test123",
      }
    });

    // 3. Create the RequestedDailyPlan (Parent's version)
    await prisma.requestedDailyPlan.create({
      data: {
        bookingId: bookingId,
        name: "Parent's Requested Routine",
        status: "ACTIVE",
        childAgeMonths: 36,
        childGender: "BOY",
        additionalNotes: [
          "Loves dinosaur toys", 
          "Needs a nap at 1 PM"
        ],
      }
    });

    // 4. Create the ChildGoals using createMany
    await prisma.childGoal.createMany({
      data: [
        {
          bookingId: bookingId,
          childId: "69d7749348b8e134e3796c95",
          name: "Improve expressive language",
          category: "COGNITIVE",
          priority: "HIGH",
          timelineMonths: 1,
          parentDescription: "improve their speech",
          milestones: [
            { week: 2, target: "Uses 4-word sentences" },
            { week: 4, target: "Can name 10 new animals" }
          ]
        },
        {
          bookingId: bookingId,
          childId: "69d7749348b8e134e3796c95",
          name: "Develop fine motor skills",
          category: "PHYSICAL",
          priority: "MEDIUM",
          timelineMonths: 1,
          parentDescription: "develop fine motor skills for writing",
          milestones: [
            { week: 1, target: "Holds crayon with pincer grasp" },
            { week: 4, target: "Traces straight lines" }
          ]
        }
      ]
    });

    // 5. Create the Master DailyPlan
    await prisma.dailyPlan.create({
      data: {
        bookingId: bookingId,
        childId: "69d7749348b8e134e3796c95",
        overallStrategy: "Play-based approach focusing on verbal communication and tactile activities.",
        weeklyFocusAreas: [
          { week: 1, focus: "Introduction and basic speech games" },
          { week: 2, focus: "Fine motor through clay and drawing" }
        ],
        difficultyLevel: "MEDIUM",
        totalPlannedMinutes: 120,
        rawAiResponse: { status: "Mock AI parsed output for UI testing" }
      }
    });

    console.log("✅ Booking and all records successfully created sequentially!", bookingId);
    return testBooking;

  } catch (error) {
    console.error("❌ Seeding failed:", error);
  }
};