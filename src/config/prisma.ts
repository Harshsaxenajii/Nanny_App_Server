import { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/logger';

const logger = createLogger('prisma');
const g = globalThis as unknown as { _prisma?: PrismaClient };

// Always cache on globalThis — prevents multiple clients during hot-reload (dev)
// and on serverless platforms where modules may be re-evaluated per invocation.
if (!g._prisma) g._prisma = new PrismaClient({ log: ['warn', 'error'] });
export const prisma: PrismaClient = g._prisma;

export async function connectDB(): Promise<void> {
  await prisma.$connect();
  logger.info('MongoDB connected via Prisma');
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
  logger.info('MongoDB disconnected');
}
