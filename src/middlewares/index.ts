import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { JwtUtils } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { createLogger } from '../utils/logger';

const log = createLogger('middleware');

/* ── Auth ──────────────────────────────────────────────────────────────── */
export function auth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { next(new AppError('Authentication required', 401)); return; }
  try {
    req.user = JwtUtils.verifyAccess(header.slice(7));
    next();
  } catch {
    next(new AppError('Invalid or expired token. Please login again.', 401));
  }
}

export function roles(...allowed: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) { next(new AppError('Authentication required', 401)); return; }
    if (!allowed.includes(req.user.role)) {
      next(new AppError(`Access denied. Required role: ${allowed.join(' or ')}`, 403));
      return;
    }
    next();
  };
}

/* ── Body validation ───────────────────────────────────────────────────── */
export function validate(schema: Joi.ObjectSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: error.details.map(d => d.message.replace(/"/g, "'")),
        statusCode: 400,
      });
      return;
    }
    req.body = value;
    next();
  };
}

/* ── Error handler ─────────────────────────────────────────────────────── */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, message: err.message, statusCode: err.statusCode });
    return;
  }
  // Malformed JSON body (e.g. from curl or client sending bad JSON)
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ success: false, message: 'Invalid JSON in request body. Please check your request.', statusCode: 400 });
    return;
  }
  // Prisma known errors
  if (err.code === 'P2002') {
    res.status(409).json({ success: false, message: 'A record with this value already exists.', statusCode: 409 });
    return;
  }
  if (err.code === 'P2025' || err.code === 'P2015') {
    res.status(404).json({ success: false, message: 'Record not found.', statusCode: 404 });
    return;
  }
  if (err.code === 'P2023' || err.code === 'P2016' || err.message?.includes('ObjectId')) {
    res.status(400).json({ success: false, message: 'Invalid ID format.', statusCode: 400 });
    return;
  }
  log.error('Unhandled error', { path: req.path, method: req.method, error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: 'Internal server error', statusCode: 500 });
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found`, statusCode: 404 });
}

/* ── Extend Express ────────────────────────────────────────────────────── */
declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: string; mobile?: string };
    }
  }
}
