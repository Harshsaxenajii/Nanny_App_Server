import { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/logger';

const logger = createLogger('prisma');
const g = globalThis as unknown as { _prisma?: PrismaClient };

export const prisma: PrismaClient =
  g._prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') g._prisma = prisma;

export async function connectDB(): Promise<void> {
  await prisma.$connect();
  logger.info('MongoDB connected via Prisma');
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
  logger.info('MongoDB disconnected');
}
