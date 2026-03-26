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
    name: Joi.string().min(2).max(100),
    email: Joi.string().email(),
    gender: Joi.string().valid("MALE", "FEMALE", "OTHER"),
    dateOfBirth: isoDate,
    profilePhoto: Joi.string().uri(),
    preferences: Joi.object({
      preferredNannyGender: Joi.string()
        .valid("MALE", "FEMALE", "OTHER")
        .allow(null),
      languagesSpoken: Joi.array().items(Joi.string()),
      notificationsSms: Joi.boolean(),
      notificationsPush: Joi.boolean(),
    }),
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
          "BABYSITTING",
          "OVERNIGHT",
          "SPECIAL_NEEDS",
        ),
      )
      .min(1)
      .required(),
    specializations: Joi.array().items(Joi.string()).default([]),
    ageGroupsHandled: Joi.array().items(Joi.string()).min(1).required(),
    hourlyRate: Joi.number().min(0).required(),
    dailyRate: Joi.number().min(0),
    serviceRadius: Joi.number().integer().min(1).max(200),
    workingAreas: Joi.array().items(Joi.string()).default([]),
    documents: Joi.array()
      .items(
        Joi.object({
          type: Joi.string()
            .valid("AADHAR", "PAN", "PASSPORT", "DRIVING_LICENSE", "VOTER_ID")
            .required(),
          documentNumber: Joi.string().required(),
          frontImageUrl: Joi.string().uri().required(),
          backImageUrl: Joi.string().uri(),
        }),
      )
      .min(1)
      .required(),
  }),
  nannyUpdate: Joi.object({
    bio: Joi.string().min(20).max(1000),
    hourlyRate: Joi.number().min(0),
    dailyRate: Joi.number().min(0),
    languages: Joi.array().items(Joi.string()),
    workingAreas: Joi.array().items(Joi.string()),
    serviceRadius: Joi.number().integer().min(1).max(200),
    profilePhoto: Joi.string().uri(),
  }).min(1),
  availability: Joi.object({ isAvailable: Joi.boolean().required() }),

  /* Booking */
  createBooking: Joi.object({
    nannyId: oid(),
    serviceType: Joi.string()
      .valid(
        "FULL_TIME",
        "PART_TIME",
        "BABYSITTING",
        "OVERNIGHT",
        "SPECIAL_NEEDS",
      )
      .required(),
    scheduledStartTime: Joi.string().isoDate().required(),
    scheduledEndTime: Joi.string().isoDate().required(),
    specialInstructions: Joi.string().max(500).allow("", null),
    requestedTasks: Joi.array().items(Joi.string()).default([]),
    childrenId: Joi.string().required(),
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
  }),
  cancelBooking: Joi.object({
    reason: Joi.string().min(5).max(500).required(),
  }),
  review: Joi.object({
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().min(10).max(1000).required(),
  }),

  /* Payment */
  createOrder: Joi.object({ bookingId: oid().required() }),
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
