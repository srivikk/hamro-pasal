import { orderTotalPaisa, toNpr } from '@hamro-pasal/ledger';
import type {
  DeliveryConfirmedResponseBody,
  DeliveryView,
  FeedEntry,
  FeedResponse,
  FeedVendor,
  LockView,
  Order,
  OrderSnapshotView,
  OrderView,
  PaymentView,
  Review,
  ReviewView,
  VendorMenu,
  VendorOrderView,
} from '@hamro-pasal/shared-types';

import type {
  CatalogVendor,
  VendorFeed,
  VendorMenu as CatalogMenu,
} from '../catalog/catalog-service';
import type { LockStatusView } from '../checkout/checkout-service';
import type { RiderDelivery } from '../deliveries/delivery-service';
import type { OrderDetail } from '../orders/order-service';
import type { VendorOrder } from '../orders/vendor-order-service';
import type { ConfirmedPayment } from '../payments/payment-confirmation';

/*
 * Mappers from domain objects to the public response contracts. The contracts themselves (types
 * and Zod schemas) live in @hamro-pasal/shared-types (src/api/responses.ts), shared with mobile.
 */

/** Never exposes the OTP hash, gateway refs or commission. */
export function orderView(order: Order): OrderView {
  return {
    id: order.id,
    vendor_id: order.vendor_id,
    state: order.state,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    fulfillment: order.fulfillment_locked,
    subtotal_npr: order.subtotal,
    delivery_fee_npr: order.delivery_fee,
    total_npr: toNpr(orderTotalPaisa(order)),
    created_at: order.created_at.toISOString(),
  };
}

export function lockView(lock: LockStatusView): LockView {
  return lock.status === 'ACTIVE'
    ? { status: lock.status, ttl_ms: lock.ttlMs, expires_at: lock.expiresAt.toISOString() }
    : { status: lock.status, ttl_ms: 0, expires_at: null };
}

export function paymentView(payment: ConfirmedPayment | null): PaymentView | null {
  return payment === null
    ? null
    : {
        order_id: payment.orderId,
        order_state: payment.orderState,
        payment_status: payment.paymentStatus,
        duplicate: !payment.newlyCaptured,
      };
}

/** Metres to kilometres, rounded to the metre. */
function toKm(metres: number): number {
  return Math.round(metres) / 1000;
}

export function feedVendorView(vendor: CatalogVendor): FeedVendor {
  return {
    id: vendor.id,
    business_name: vendor.businessName,
    delivery_scope: vendor.deliveryScope,
    radius_km: vendor.radiusKm,
    municipality_palika_string: vendor.municipalityPalika,
    min_order_value: vendor.minOrderValue,
    base_delivery_fee_npr: vendor.baseDeliveryFee,
    fulfillment_mode: vendor.fulfillmentMode,
    location: vendor.location,
  };
}

export function feedEntryView(vendor: CatalogVendor): FeedEntry {
  return {
    vendor: feedVendorView(vendor),
    distance_km: toKm(vendor.distanceM),
    serviceable: vendor.serviceable,
    delivery_available: vendor.deliveryAvailable,
    is_sponsored: vendor.sponsored === true,
  };
}

export function feedView(feed: VendorFeed): FeedResponse {
  return {
    serviceable: feed.serviceable.map(feedEntryView),
    explore_further: feed.unserviceable.map(feedEntryView),
    delivery_available: feed.deliveryAvailable,
  };
}

export function menuView(menu: CatalogMenu): VendorMenu {
  return {
    vendor: feedVendorView(menu.vendor),
    serviceable: menu.vendor.serviceable,
    delivery_available: menu.vendor.deliveryAvailable,
    products: menu.products.map((p) => ({
      id: p.id,
      name: p.name,
      price_npr: p.priceNpr,
      in_stock: p.inStock,
      stock_quantity: p.stockQuantity,
    })),
  };
}

/** SPEC OrderSnapshot for the customer. Still never exposes the OTP hash, refs or commission. */
export function orderSnapshotView({ order, items, address }: OrderDetail): OrderSnapshotView {
  return {
    ...orderView(order),
    customer_id: order.customer_id,
    refund_required: order.refund_required,
    placed_at: order.placed_at?.toISOString() ?? null,
    delivered_at: order.delivered_at?.toISOString() ?? null,
    delivery_address: orderAddressView(address),
    items: items.map(orderItemView),
  };
}

/** The vendor dashboard's order: what to pack and where, never the customer's identity. */
export function vendorOrderView({ order, items, address }: VendorOrder): VendorOrderView {
  if (order.placed_at === null) {
    throw new Error(`Order ${order.id} is ${order.state} but was never placed`);
  }
  return {
    ...orderView(order),
    placed_at: order.placed_at.toISOString(),
    delivery_address: orderAddressView(address),
    items: items.map(orderItemView),
  };
}

/** A handoff that went through (rider or vendor): the order is DELIVERED at `delivered_at`. */
export function deliveryConfirmedBody(order: Order): DeliveryConfirmedResponseBody {
  if (order.state !== 'DELIVERED' || order.delivered_at === null) {
    throw new Error(`Order ${order.id} delivery left it in ${order.state}`);
  }
  return {
    order_id: order.id,
    state: order.state,
    delivered_at: order.delivered_at.toISOString(),
  };
}

/**
 * The rider's delivery: its step, the pickup shop, drop-off address and contents; never the
 * customer's identity, another rider's id or the code's hash.
 */
export function deliveryView(
  { delivery, order, vendorBusinessName, items, address }: RiderDelivery,
  riderId: string,
): DeliveryView {
  if (order.state !== 'OUT_FOR_DELIVERY') {
    throw new Error(`Order ${order.id} is ${order.state}, not out for delivery`);
  }
  if (delivery.state === 'DELIVERED' || delivery.state === 'FAILED') {
    throw new Error(`Delivery ${delivery.id} is ${delivery.state}, not on the road`);
  }
  return {
    id: delivery.id,
    state: delivery.state,
    assigned_to_me: delivery.rider_id === riderId,
    accepted_at: delivery.accepted_at?.toISOString() ?? null,
    picked_up_at: delivery.picked_up_at?.toISOString() ?? null,
    order: {
      ...orderView(order),
      state: order.state,
      vendor_business_name: vendorBusinessName,
      delivery_address: orderAddressView(address),
      items: items.map(orderItemView),
    },
  };
}

function orderAddressView(address: OrderDetail['address']): OrderSnapshotView['delivery_address'] {
  return address === null
    ? null
    : {
        province_id: address.province_id,
        district_string: address.district_string,
        municipality_palika_string: address.municipality_palika_string,
        ward_number: address.ward_number,
        tole_locality: address.tole_locality,
        landmark: address.landmark,
        exact_lat: address.exact_lat,
        exact_lng: address.exact_lng,
      };
}

function orderItemView(item: OrderDetail['items'][number]): OrderSnapshotView['items'][number] {
  return {
    product_id: item.product_id,
    product_name: item.product_name,
    unit_price_npr: item.unit_price_npr,
    quantity: item.quantity,
  };
}

/** SPEC §6: the stored review as its author sees it; status reflects the double-blind quarantine. */
export function reviewView(review: Review): ReviewView {
  return {
    id: review.id,
    order_id: review.order_id,
    direction: review.direction,
    rating: review.rating,
    feedback: review.comment,
    status: review.is_published ? 'PUBLISHED' : 'QUARANTINED',
    published_at: review.published_at?.toISOString() ?? null,
    created_at: review.created_at.toISOString(),
  };
}
