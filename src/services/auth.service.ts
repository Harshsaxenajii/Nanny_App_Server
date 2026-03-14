import axios from 'axios';
import { prisma } from '../config/prisma';
import { config } from '../config';
import { AppError } from '../utils/AppError';
import { JwtUtils } from '../utils/jwt';
import { createLogger } from '../utils/logger';

const log = createLogger('auth');

function randomOtp(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');
}

async function sendSmsOtp(mobile: string, countryCode: string, otp: string): Promise<void> {
  if (!config.msg91.authKey) {
    log.info(`[DEV] OTP for ${countryCode}${mobile} → \x1b[33m${otp}\x1b[0m`);
    return;
  }
  try {
    await axios.post(
      'https://api.msg91.com/api/v5/otp',
      { template_id: config.msg91.templateId, mobile: `${countryCode}${mobile}`, authkey: config.msg91.authKey, otp },
      { timeout: 6000 },
    );
  } catch (err: any) {
    log.error('SMS send failed (non-fatal)', { error: err.message });
  }
}

export class AuthService {

  /* ── Request OTP ─────────────────────────────────────────────────────── */
  async requestOtp(mobile: string, countryCode: string) {
    const now = new Date();

    // Upsert user (create on first request)
    const user = await prisma.user.upsert({
      where:  { mobile },
      create: { mobile, countryCode },
      update: {},
    });

    // Check existing OTP record for block
    const existing = await prisma.otpRecord.findUnique({ where: { userId: user.id } });
    if (existing?.blockedUntil && existing.blockedUntil > now) {
      const mins = Math.ceil((existing.blockedUntil.getTime() - now.getTime()) / 60_000);
      throw new AppError(`Account blocked due to too many attempts. Try again in ${mins} minute(s).`, 429);
    }

    const otp = config.isDev ? '123456' : randomOtp(6);
    const expiresAt = new Date(now.getTime() + config.otp.expirySec * 1000);

    await prisma.otpRecord.upsert({
      where:  { userId: user.id },
      create: { userId: user.id, mobile, countryCode, otp, expiresAt, attempts: 0 },
      update: { mobile, countryCode, otp, expiresAt, attempts: 0, blockedUntil: null, updatedAt: now },
    });

    await sendSmsOtp(mobile, countryCode, otp);
    return { sent: true };
  }

  /* ── Verify OTP ──────────────────────────────────────────────────────── */
  async verifyOtp(mobile: string, countryCode: string, otp: string) {
    const now = new Date();

    const user = await prisma.user.findUnique({ where: { mobile } });
    if (!user) throw new AppError('No OTP was requested for this number. Please request OTP first.', 400);

    const record = await prisma.otpRecord.findUnique({ where: { userId: user.id } });
    if (!record) throw new AppError('OTP expired or not found. Please request a new OTP.', 400);

    if (record.blockedUntil && record.blockedUntil > now) {
      const mins = Math.ceil((record.blockedUntil.getTime() - now.getTime()) / 60_000);
      throw new AppError(`Account blocked. Try again in ${mins} minute(s).`, 429);
    }

    if (record.expiresAt < now) {
      await prisma.otpRecord.delete({ where: { userId: user.id } });
      throw new AppError('OTP has expired. Please request a new one.', 400);
    }

    if (record.otp !== otp) {
      const attempts = record.attempts + 1;
      const blocked  = attempts >= config.otp.maxAttempts;
      await prisma.otpRecord.update({
        where: { userId: user.id },
        data: {
          attempts,
          blockedUntil: blocked ? new Date(now.getTime() + config.otp.blockSec * 1000) : null,
        },
      });
      if (blocked) throw new AppError('Too many failed attempts. Account blocked for 30 minutes.', 429);
      throw new AppError(`Incorrect OTP. ${config.otp.maxAttempts - attempts} attempt(s) remaining.`, 400);
    }

    // ✅ OTP correct — clean up
    await prisma.otpRecord.delete({ where: { userId: user.id } });
    const isNewUser = !user.isMobileVerified;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isMobileVerified: true, lastLoginAt: now, countryCode },
    });

    const payload  = { userId: updated.id, role: updated.role, mobile: updated.mobile };
    const accessToken  = JwtUtils.signAccess(payload);
    const refreshToken = JwtUtils.signRefresh(payload);

    await prisma.refreshToken.create({
      data: {
        userId:    updated.id,
        tokenHash: JwtUtils.hash(refreshToken),
        expiresAt: new Date(now.getTime() + config.jwt.refreshExpiryMs),
      },
    });

    // Prune old expired tokens for this user (housekeeping)
    await prisma.refreshToken.deleteMany({
      where: { userId: updated.id, expiresAt: { lt: now } },
    }).catch(() => {});

    log.info(`Login: userId=${updated.id} role=${updated.role} new=${isNewUser}`);
    return {
      accessToken,
      refreshToken,
      isNewUser,
      user: {
        id:    updated.id,
        role:  updated.role,
        name:  updated.name || null,
        mobile: updated.mobile,
        isMobileVerified: updated.isMobileVerified,
      },
    };
  }

  /* ── Refresh Token ───────────────────────────────────────────────────── */
  async refreshToken(rawToken: string) {
    let payload;
    try { payload = JwtUtils.verifyRefresh(rawToken); }
    catch { throw new AppError('Invalid or expired refresh token. Please login again.', 401); }

    const hash   = JwtUtils.hash(rawToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!stored) throw new AppError('Refresh token not found or already used. Please login again.', 401);
    if (stored.expiresAt < new Date()) {
      await prisma.refreshToken.delete({ where: { tokenHash: hash } });
      throw new AppError('Refresh token expired. Please login again.', 401);
    }

    // Re-fetch user in case role changed
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) throw new AppError('User no longer exists.', 401);

    return {
      accessToken: JwtUtils.signAccess({ userId: user.id, role: user.role, mobile: user.mobile }),
    };
  }

  /* ── Logout ──────────────────────────────────────────────────────────── */
  async logout(rawToken: string) {
    const hash = JwtUtils.hash(rawToken);
    await prisma.refreshToken.deleteMany({ where: { tokenHash: hash } });
  }
}
