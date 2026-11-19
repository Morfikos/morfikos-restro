import { EventEmitter } from "node:events";

import type { KitchenEventName } from "./constants.js";
import type { InventoryEventName } from "../inventory/constants.js";
import type { QrEventName } from "../qr/constants.js";
import type { PaymentEventName } from "../payments/constants.js";

/**
 * In-process publish/subscribe for live kitchen events, keyed by branch.
 *
 * Works for a single API server. When the API runs on several servers,
 * replace the emitter with a shared channel (e.g. Redis pub/sub) — callers
 * only use the three functions below.
 */

/** One event pushed to kitchen screens. */
export interface KitchenEvent {
  /** Kitchen events, plus inventory (low stock, dishes 86'd) and QR table (orders, waiter calls) events. */
  event: KitchenEventName | InventoryEventName | QrEventName | PaymentEventName;
  data: unknown;
}

type KitchenEventListener = (event: KitchenEvent) => void;

const emitter = new EventEmitter();

// Every connected kitchen screen is one listener; there is no fixed limit.
emitter.setMaxListeners(0);

const subscriberCounts = new Map<string, number>();

/**
 * Sends an event to every kitchen screen connected for the branch.
 *
 * @param branchId - The branch ID.
 * @param event - The event to send.
 */
export function publishKitchenEvent(branchId: string, event: KitchenEvent): void {
  emitter.emit(branchId, event);
}

/**
 * Subscribes a kitchen screen to a branch's events.
 *
 * @param branchId - The branch ID.
 * @param listener - Called for every event of the branch.
 * @returns A function that unsubscribes the listener.
 */
export function subscribeKitchenEvents(
  branchId: string,
  listener: KitchenEventListener,
): () => void {
  emitter.on(branchId, listener);
  subscriberCounts.set(branchId, (subscriberCounts.get(branchId) ?? 0) + 1);

  return () => {
    emitter.off(branchId, listener);

    const remaining = (subscriberCounts.get(branchId) ?? 1) - 1;

    if (remaining > 0) {
      subscriberCounts.set(branchId, remaining);
    } else {
      subscriberCounts.delete(branchId);
    }
  };
}

/**
 * Returns the branches that have at least one kitchen screen connected.
 *
 * @returns The branch IDs.
 */
export function getSubscribedBranchIds(): string[] {
  return [...subscriberCounts.keys()];
}
