import { prisma } from "../config/prisma";

const getRandom = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const getRating = () => parseFloat((Math.random() * (5 - 4) + 4).toFixed(1));

const ratingData = [
  {
    rating: 5,
    review: "Very caring and professional nanny.",
    reviewerName: "Parent A",
    createdAt: new Date(),
  },
  {
    rating: 4,
    review: "Good with kids, punctual.",
    reviewerName: "Parent B",
    createdAt: new Date(),
  },
];

export const runSeedLogic = async () => {
  const nannies = [
    // 🔵 Bangalore (Sarjapur / HSR / Bellandur)
    {
      name: "Anjali Verma",
      mobile: "9000000011",
      exp: 4,
      lat: 12.8221,
      lng: 77.663,
      city: "Bangalore",
      area: "Sarjapur Road",
      pincode: "560035",
    },
    {
      name: "Pooja Sharma",
      mobile: "9000000012",
      exp: 6,
      lat: 12.8195,
      lng: 77.6612,
      city: "Bangalore",
      area: "HSR Layout",
      pincode: "560102",
    },
    {
      name: "Meena Kumari",
      mobile: "9000000013",
      exp: 3,
      lat: 12.825,
      lng: 77.6655,
      city: "Bangalore",
      area: "Bellandur",
      pincode: "560103",
    },
    {
      name: "Kavita Reddy",
      mobile: "9000000014",
      exp: 7,
      lat: 12.8238,
      lng: 77.6601,
      city: "Bangalore",
      area: "Electronic City",
      pincode: "560100",
    },
    {
      name: "Sunita Yadav",
      mobile: "9000000015",
      exp: 5,
      lat: 12.8202,
      lng: 77.6599,
      city: "Bangalore",
      area: "Sarjapur",
      pincode: "560035",
    },
    {
      name: "Ritu Singh",
      mobile: "9000000016",
      exp: 2,
      lat: 12.821,
      lng: 77.667,
      city: "Bangalore",
      area: "Bellandur",
      pincode: "560103",
    },

    // 🔴 Delhi (your requested coords: 28.6455788, 77.080968)
    {
      name: "Seema Arora",
      mobile: "9000000021",
      exp: 6,
      lat: 28.646,
      lng: 77.0815,
      city: "Delhi",
      area: "Janakpuri",
      pincode: "110058",
    },
    {
      name: "Kiran Bala",
      mobile: "9000000022",
      exp: 4,
      lat: 28.6448,
      lng: 77.0799,
      city: "Delhi",
      area: "Tilak Nagar",
      pincode: "110018",
    },
    {
      name: "Rashmi Kapoor",
      mobile: "9000000023",
      exp: 7,
      lat: 28.6472,
      lng: 77.0821,
      city: "Delhi",
      area: "Rajouri Garden",
      pincode: "110027",
    },
    {
      name: "Neetu Sharma",
      mobile: "9000000024",
      exp: 5,
      lat: 28.645,
      lng: 77.083,
      city: "Delhi",
      area: "Janakpuri West",
      pincode: "110058",
    },
    {
      name: "Pinky Devi",
      mobile: "9000000025",
      exp: 8,
      lat: 28.6465,
      lng: 77.08,
      city: "Delhi",
      area: "Tilak Nagar",
      pincode: "110018",
    },
    {
      name: "Mamta Yadav",
      mobile: "9000000026",
      exp: 9,
      lat: 28.6459,
      lng: 77.0812,
      city: "Delhi",
      area: "Rajouri Garden",
      pincode: "110027",
    },
  ];

  const createdNannies = [];

  for (const nanny of nannies) {
    const user = await prisma.user.upsert({
      where: { mobile: nanny.mobile },
      update: {},
      create: {
        mobile: nanny.mobile,
        countryCode: "+91",
        name: nanny.name,
        role: "NANNY",
        isMobileVerified: true,

        addresses: {
          create: {
            label: "Home",
            addressLine1: `House ${getRandom(10, 200)}`,
            addressLine2: nanny.area,
            city: nanny.city,
            state: nanny.city === "Delhi" ? "Delhi" : "Karnataka",
            pincode: nanny.pincode,
            lat: nanny.lat,
            lng: nanny.lng,
            isDefault: true,
          },
        },

        nannyProfile: {
          create: {
            name: nanny.name,
            mobile: nanny.mobile,
            gender: "FEMALE",
            status: "VERIFIED",
            isActive: true,
            isAvailable: true,
            isTrainingCompleted: true,

            experience: nanny.exp,
            bio: "Experienced nanny skilled in childcare and early learning.",

            languages: ["Hindi", "English"],
            serviceTypes: ["HOURLY", "PART_TIME", "FULL_TIME"],
            specializations: ["Infant Care", "Toddler Care"],
            ageGroupsHandled: ["0-2 years", "2-5 years"],

            hourlyRate: getRandom(200, 500),
            dailyRate: getRandom(1500, 3000),
            serviceRadius: 10,

            workingAreas: [nanny.area],

            rating: getRating(),
            totalReviews: getRandom(10, 80),
            ratingData: ratingData,

            totalBookings: getRandom(20, 150),

            verifiedAt: new Date(),
          },
        },
      },
      include: {
        nannyProfile: true,
        addresses: true,
      },
    });

    createdNannies.push(user);
  }

  return {
    totalNannies: createdNannies.length,
    sampleNanny: createdNannies[0],
    timestamp: new Date().toISOString(),
  };
};
