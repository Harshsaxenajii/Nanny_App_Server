import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";

import { config } from "./config";
import { connectDB, disconnectDB } from "./config/prisma";
import { createLogger } from "./utils/logger";
import { registerEventHandlers } from "./utils/eventHandlers";
import { JwtUtils } from "./utils/jwt";

import { authRouter } from "./routes/auth.routes";
import { userRouter } from "./routes/user.routes";
import { nannyRouter } from "./routes/nanny.routes";
import { bookingRouter } from "./routes/booking.routes";
import { paymentRouter } from "./routes/payment.routes";
import { locationRouter } from "./routes/location.routes";
import { chatRouter } from "./routes/chat.routes";
import { notificationRouter } from "./routes/notification.routes";
import { adminRouter } from "./routes/admin.routes";
import { uploadRouter } from "./routes/uploadImages.routes";

import { errorHandler, notFound } from "./middlewares/index";
import { seedRouter } from "./routes/seed.routes";
import * as admin from "firebase-admin";

const serviceAccount = require("../service-account.json");
// const serviceAccount = require("/etc/secrets/service-account.json");

const data = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const log = createLogger("app");
const app = express();
const httpServer = createServer(app);

/* ── Socket.IO ─────────────────────────────────────────────────────────── */
const io = new SocketServer(httpServer, {
  cors: { origin: config.corsOrigins, credentials: true },
});

// Auth middleware for Socket.IO
io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.split(" ")[1];
  if (!token) return next(new Error("Authentication required"));
  try {
    const payload = JwtUtils.verifyAccess(token);
    (socket as any).user = payload;
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  const user = (socket as any).user;
  log.debug(`Socket connected: ${socket.id} user=${user?.userId}`);

  // Join a chat room
  socket.on("join_room", (roomId: string) => {
    socket.join(roomId);
    log.debug(`Socket ${socket.id} joined room ${roomId}`);
  });

  // Send message via socket (broadcasts to room)
  socket.on(
    "send_message",
    (data: { roomId: string; content: string; type?: string }) => {
      if (!data.roomId || !data.content) return;
      io.to(data.roomId).emit("new_message", {
        senderId: user?.userId,
        content: data.content,
        type: data.type || "TEXT",
        createdAt: new Date().toISOString(),
      });
    },
  );

  socket.on("disconnect", () => {
    log.debug(`Socket disconnected: ${socket.id}`);
  });
});

/* ── Express middleware ─────────────────────────────────────────────────── */
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(morgan(config.isDev ? "dev" : "combined"));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests. Please slow down.",
      statusCode: 429,
    },
    skip: () => config.isDev,
  }),
);

// Razorpay webhook needs raw body for HMAC verification — must be before express.json()
app.use("/api/v1/payments/webhook", express.text({ type: "*/*" }));

// All other routes use JSON
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ── Health check ───────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "nanny-app",
    env: config.env,
    timestamp: new Date().toISOString(),
  });
});

/* ── API Routes ─────────────────────────────────────────────────────────── */
app.use("/api/v1/pushData", seedRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/nannies", nannyRouter);
app.use("/api/v1/bookings", bookingRouter);
app.use("/api/v1/payments", paymentRouter);
app.use("/api/v1/location", locationRouter);
app.use("/api/v1/chat", chatRouter);
app.use("/api/v1/notifications", notificationRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/encrypted", uploadRouter);

/* ── 404 + error handler ────────────────────────────────────────────────── */
app.use(notFound);
app.use(errorHandler);

/* ── Start ──────────────────────────────────────────────────────────────── */
async function start() {
  registerEventHandlers();

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await connectDB();
      break;
    } catch (err: any) {
      log.warn(`DB connection attempt ${attempt}/10 failed: ${err.message}`);
      if (attempt === 10) {
        log.error("Cannot connect to DB — exiting");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  httpServer.listen(config.port, () => {
    log.info(`✅ Nanny App running on port ${config.port} [${config.env}]`);
    log.info(`   Health  → http://localhost:${config.port}/health`);
    log.info(`   API     → http://localhost:${config.port}/api/v1`);
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} — shutting down gracefully`);
    httpServer.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) =>
    log.error("Unhandled rejection", { reason }),
  );
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", { error: err.message });
    process.exit(1);
  });
}

start();
