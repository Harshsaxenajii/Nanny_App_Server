import { EventEmitter } from "events";

class AppEventBus extends EventEmitter {
  emit(event: string, payload?: any): boolean {
    setImmediate(() => super.emit(event, payload));
    return true;
  }
}

export const bus = new AppEventBus();
bus.setMaxListeners(50);

export const Events = {
  NANNY_VERIFIED: "nanny.verified",
  NANNY_REJECTED: "nanny.rejected",
  BOOKING_CREATED: "booking.created",
  BOOKING_CANCELLED: "booking.cancelled",
  BOOKING_COMPLETED: "booking.completed",
  PAYMENT_CAPTURED: "payment.captured",
  PAYMENT_FAILED: "payment.failed",
  BOOKING_CONFIRMED: "booking.confirmed",
} as const;
