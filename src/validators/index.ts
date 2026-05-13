import Joi from "joi";

const mob = Joi.string()
  .pattern(/^[0-9]{7,15}$/)
  .required()
  .messages({ "string.pattern.base": "mobile must be 7–15 digits" });
const cc = Joi.string().default("+91");
const oid = () => Joi.string().length(24).hex();
const isoDate = Joi.string().isoDate();

/* ── Auth ───────────────────────────────────────────────────────────────── */
export const S = {
  otpRequest: Joi.object({ mobile: mob, countryCode: cc }),
  otpVerify: Joi.object({
    mobile: mob,
    countryCode: cc,
    otp: Joi.string()
      .length(6)
      .pattern(/^\d+$/)
      .required()
      .messages({ "string.length": "OTP must be 6 digits" }),
  }),
  refreshToken: Joi.object({ refreshToken: Joi.string().required() }),
  logout: Joi.object({ refreshToken: Joi.string().required() }),

  /* User */
  updateProfile: Joi.object({
    name: Joi.string().min(2).max(100).allow(null, ""),
    email: Joi.string().email().allow(null, ""),
    gender: Joi.string().valid("MALE", "FEMALE", "OTHER").allow(null, ""),

    // Assuming isoDate is a pre-defined Joi rule like Joi.string().isoDate()
    // We append .allow(null, "") to it so it accepts empty values
    dateOfBirth: isoDate.allow(null, ""),

    profilePhoto: Joi.string().uri().allow(null, ""),

    preferences: Joi.object({
      preferredNannyGender: Joi.string()
        .valid("MALE", "FEMALE", "OTHER")
        .allow(null, ""),
      languagesSpoken: Joi.array().items(Joi.string()).allow(null),
      notificationsSms: Joi.boolean().allow(null),
      notificationsPush: Joi.boolean().allow(null),
    }).allow(null),
  }).min(1),
  addChild: Joi.object({
    children: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().min(1).max(100).required(),
          birthDate: isoDate.required(),
          gender: Joi.string().valid("BOY", "GIRL", "OTHER").required(),
        }),
      )
      .min(1)
      .required(),
  }),
  updateChild: Joi.object({
    name: Joi.string().min(1).max(100).required(),
    birthDate: isoDate.required(),
    gender: Joi.string().valid("BOY", "GIRL", "OTHER").required(),
  }).min(1),
  addAddress: Joi.object({
    label: Joi.string().required(),
    addressLine1: Joi.string().required(),
    addressLine2: Joi.string().allow("", null),
    city: Joi.string().required(),
    state: Joi.string().required(),
    pincode: Joi.string().required(),
    country: Joi.string().default("IN"),
    isDefault: Joi.boolean().default(false),
    coordinates: Joi.object({
      type: Joi.string(),
      coordinates: Joi.array().items(Joi.number()).length(2),
    }),
  }),
  updateAddress: Joi.object({
    label: Joi.string(),
    addressLine1: Joi.string(),
    addressLine2: Joi.string().allow("", null),
    city: Joi.string(),
    state: Joi.string(),
    pincode: Joi.string(),
    isDefault: Joi.boolean(),
    coordinates: Joi.object({
      type: Joi.string(),
      coordinates: Joi.array().items(Joi.number()).length(2),
    }),
  }).min(1),
  emergencyContact: Joi.object({
    name: Joi.string().min(2).max(100).required(),
    mobile: Joi.string()
      .pattern(/^[0-9]{7,15}$/)
      .required(),
    relationship: Joi.string().required(),
  }),
  deviceToken: Joi.object({
    deviceToken: Joi.string().required(),
    platform: Joi.string().valid("android", "ios").required(),
  }),

  /* Nanny */
  nannyRegister: Joi.object({
    mobile: mob,
    countryCode: cc,
    name: Joi.string().min(2).max(100).required(),
    gender: Joi.string().valid("MALE", "FEMALE", "OTHER"),
    dateOfBirth: isoDate,
    experience: Joi.number().integer().min(0).max(60).required(),
    bio: Joi.string().min(20).max(1000).required(),
    languages: Joi.array().items(Joi.string()).min(1).required(),
    serviceTypes: Joi.array()
      .items(
        Joi.string().valid(
          "FULL_TIME",
          "PART_TIME",
          "ONE_TIME",
          "OVERNIGHT",
          "EMERGENCY",
        ),
      )
      .min(1)
      .required(),
    specializations: Joi.array().items(Joi.string()).default([]),
    ageGroupsHandled: Joi.array().items(Joi.string()).min(1).required(),
    hourlyRate: Joi.number().min(0).required(),
    dailyRate: Joi.number().min(0),
    serviceRadius: Joi.number().integer().min(1).max(200),
    // workingAreas: Joi.array().items(Joi.string()).default([]),
    // documents: Joi.array()
    //   .items(
    //     Joi.object({
    //       type: Joi.string()
    //         .valid("AADHAR", "PAN", "PASSPORT", "DRIVING_LICENSE", "VOTER_ID")
    //         .required(),
    //       documentNumber: Joi.string().required(),
    //       frontImageUrl: Joi.string().uri().required(),
    //       backImageUrl: Joi.string().uri(),
    //     }),
    //   )
    //   .min(1)
    //   .required(),
  }),
  nannyUpdate: Joi.object({
    bio: Joi.string().min(20).max(1000).optional(),
    hourlyRate: Joi.number().min(0).optional(),
    dailyRate: Joi.number().min(0).optional(),
    languages: Joi.array().items(Joi.string()).optional(),
    workingAreas: Joi.array().items(Joi.string()).optional(),
    serviceRadius: Joi.number().integer().min(1).max(200).optional(),
    profilePhoto: Joi.string().uri().optional(),
    specializations: Joi.array().items(Joi.string()).default([]).optional(),
    idDocumentSubmitted: Joi.boolean().optional(),
    documents: Joi.object().optional(),
  }).min(1),
  availability: Joi.object({ isAvailable: Joi.boolean().required() }),

  /* Booking */
  createBooking: Joi.object({
    nannyId: oid(),
    serviceType: Joi.string()
      .valid("FULL_TIME", "PART_TIME", "ONE_TIME", "OVERNIGHT", "EMERGENCY")
      .required(),
    scheduledStartTime: Joi.string().isoDate().required(),
    scheduledEndTime: Joi.string().isoDate().required(),
    specialInstructions: Joi.string().max(500).allow("", null),
    requestedTasks: Joi.array().items(Joi.string()).default([]),
    childrenId: Joi.string().required(),
    lunch: Joi.boolean().default(false),
    address: Joi.object({
      label: Joi.string(),
      addressLine1: Joi.string().required(),
      addressLine2: Joi.string().allow("", null),
      city: Joi.string().required(),
      state: Joi.string().required(),
      pincode: Joi.string().required(),
      country: Joi.string().default("IN"),
      coordinates: Joi.object({
        type: Joi.string(),
        coordinates: Joi.array().items(Joi.number()).length(2),
      }),
    }).required(),
    workingDays: Joi.array()
      .items(
        Joi.string().valid("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"),
      )
      .when("serviceType", {
        is: Joi.string().valid(
          "FULL_TIME",
          "PART_TIME",
          "MONTHLY_SUBSCRIPTION",
        ),
        then: Joi.required(),
        otherwise: Joi.optional().default([]),
      }),

    dailyStartTime: Joi.string()
      .isoDate()
      .when("serviceType", {
        is: Joi.string().valid(
          "FULL_TIME",
          "PART_TIME",
          "MONTHLY_SUBSCRIPTION",
        ),
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),

    dailyEndTime: Joi.string()
      .isoDate()
      .when("serviceType", {
        is: Joi.string().valid(
          "FULL_TIME",
          "PART_TIME",
          "MONTHLY_SUBSCRIPTION",
        ),
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),

    couponCode: Joi.string().max(20).uppercase().allow("", null).optional(),

    selectedGoals: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().required(),
          category: Joi.string()
            .valid(
              "COGNITIVE",
              "PHYSICAL",
              "ROUTINE",
              "SOCIAL",
              "EMOTIONAL",
              "CREATIVE",
            )
            .required(),
          priority: Joi.string()
            .valid("HIGH", "MEDIUM", "LOW")
            .default("MEDIUM"),
          parentDescription: Joi.string().required(),
          milestones: Joi.array().default([]),
          pricePerMonth: Joi.number().min(0).default(0),
        }),
      )
      .default([]),
  }),
  cancelBooking: Joi.object({
    reason: Joi.string().min(5).max(500).required(),
  }),
  review: Joi.object({
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().min(10).max(1000).required(),
  }),

  /* Booking — requested plan & extension */
  addRequestedPlan: Joi.object({
    date: Joi.string().isoDate().required(),
    tasks: Joi.array().items(Joi.string()).min(1).required(),
  }),
  extendBooking: Joi.object({
    newEndDate: Joi.string().isoDate().required(),
    workingDays: Joi.array()
      .items(Joi.string().valid("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"))
      .optional(),
    updatedTasks: Joi.array().items(Joi.string()).optional(),
    updatedGoals: Joi.array()
      .items(
        Joi.object({
          goalId: Joi.string().optional(),
          name: Joi.string().required(),
          category: Joi.string().required(),
          priority: Joi.string().valid("HIGH", "MEDIUM", "LOW").optional(),
          parentDescription: Joi.string().optional().allow(""),
          milestones: Joi.array().optional(),
          pricePerMonth: Joi.number().min(0).optional(),
        }),
      )
      .optional(),
    lunch: Joi.boolean().optional(),
    specialInstructions: Joi.string().max(500).optional().allow(""),
    couponCode: Joi.string().optional().allow(""),
    pricingEstimate: Joi.object().optional(),
  }),

  /* Payment */
  createOrder: Joi.object({ bookingId: oid().required() }),
  createExtensionOrder: Joi.object({ extensionId: oid().required() }),
  verifyPayment: Joi.object({
    razorpayOrderId: Joi.string().required(),
    razorpayPaymentId: Joi.string().required(),
    razorpaySignature: Joi.string().required(),
  }),

  /* Chat */
  createRoom: Joi.object({ bookingId: oid().required() }),
  sendMessage: Joi.object({
    content: Joi.string().min(1).max(2000).required(),
    type: Joi.string().valid("TEXT", "IMAGE", "DOCUMENT").default("TEXT"),
    mediaUrl: Joi.string()
      .uri()
      .when("type", {
        is: Joi.valid("IMAGE", "DOCUMENT"),
        then: Joi.required(),
      }),
  }),

  /* Location */
  updateLocation: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
  }),

  /* Admin */
  verifyNanny: Joi.object({ notes: Joi.string().max(500) }),
  rejectNanny: Joi.object({ reason: Joi.string().min(5).max(500).required() }),
  suspendNanny: Joi.object({ reason: Joi.string().min(5).max(500).required() }),
  training: Joi.object({
    isTrainingCompleted: Joi.boolean().required(),
    notes: Joi.string().max(500),
  }),
  adminCancel: Joi.object({ reason: Joi.string().min(5).max(500).required() }),
  refund: Joi.object({
    amount: Joi.number().min(1),
    reason: Joi.string().min(5).max(500).required(),
  }),
};
