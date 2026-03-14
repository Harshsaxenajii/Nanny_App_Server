import winston from 'winston';

const fmt = winston.format.printf(({ level, message, timestamp, service, ...meta }) => {
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${timestamp} [${service || 'app'}] ${level}: ${message}${extra}`;
});

export function createLogger(service: string) {
  return winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
      winston.format(i => ({ ...i, service }))(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      process.env.NODE_ENV !== 'production' ? winston.format.colorize() : winston.format.uncolorize(),
      fmt,
    ),
    transports: [new winston.transports.Console()],
  });
}
