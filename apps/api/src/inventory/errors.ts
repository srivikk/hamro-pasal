export interface StockShortfall {
  readonly productId: string;
  readonly requested: number;
  readonly available: number;
}

/** At least one line cannot be reserved; nothing was locked. */
export class InsufficientStockError extends Error {
  constructor(readonly shortfalls: readonly StockShortfall[]) {
    super(
      `Insufficient stock for ${shortfalls
        .map(
          (s) =>
            `${s.productId} (requested ${String(s.requested)}, available ${String(s.available)})`,
        )
        .join(', ')}`,
    );
    this.name = 'InsufficientStockError';
  }
}

/** A requested product is unknown, inactive, or not sold by the cart's vendor. */
export class ProductUnavailableError extends Error {
  constructor(readonly productIds: readonly string[]) {
    super(`Products unavailable for this vendor: ${productIds.join(', ')}`);
    this.name = 'ProductUnavailableError';
  }
}

/** The 600 s lock is gone (expired or released): SPEC §3 "Session Expired". */
export class ReservationExpiredError extends Error {
  constructor(readonly reservationId: string) {
    super(`Inventory reservation ${reservationId} has expired or was released`);
    this.name = 'ReservationExpiredError';
  }
}

/** Optimistic transaction kept conflicting; the caller may retry. */
export class ReservationContentionError extends Error {
  constructor(readonly attempts: number) {
    super(`Inventory reservation aborted after ${String(attempts)} conflicting attempts`);
    this.name = 'ReservationContentionError';
  }
}

export class InvalidCartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCartError';
  }
}
