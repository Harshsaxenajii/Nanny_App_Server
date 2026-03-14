const GST = 0.18;

export function calcPricing(hourlyRate: number, start: Date, end: Date) {
  const ms    = end.getTime() - start.getTime();
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  const base  = parseFloat((hourlyRate * hours).toFixed(2));
  const gst   = parseFloat((base * GST).toFixed(2));
  const total = parseFloat((base + gst).toFixed(2));
  return { baseAmount: base, gstAmount: gst, totalAmount: total, hours };
}
