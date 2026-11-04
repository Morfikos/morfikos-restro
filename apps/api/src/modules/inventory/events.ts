import { AsyncLocalStorage } from "node:async_hooks";

import { publishKitchenEvent } from "../kitchen/events.js";
import type { InventoryEventName } from "./constants.js";

/**
 * Live inventory events (low stock, out of stock, dishes 86'd or restored).
 *
 * Stock changes happen inside database transactions, which can still roll
 * back. Events raised inside a transaction are therefore queued and only
 * published once the surrounding {@link withInventoryEvents} work succeeds.
 * They go out on the branch's live stream (`GET /branches/:id/kitchen/stream`),
 * which POS and kitchen screens already listen to.
 */

/** One inventory event for a branch. */
export interface InventoryEvent {
  branchId: string;
  event: InventoryEventName;
  data: unknown;
}

const pendingEvents = new AsyncLocalStorage<InventoryEvent[]>();

/**
 * Queues events to publish when the current work commits. Outside of
 * {@link withInventoryEvents} they are published at once.
 *
 * @param events - The events to send.
 */
export function queueInventoryEvents(events: InventoryEvent[]): void {
  const queue = pendingEvents.getStore();

  if (queue) {
    queue.push(...events);
    return;
  }

  publishInventoryEvents(events);
}

/**
 * Runs work (usually a database transaction) and publishes the inventory
 * events it queued only if it succeeds. A failed attempt drops its events.
 *
 * @param work - The work to run.
 * @returns The work's result.
 */
export async function withInventoryEvents<T>(work: () => Promise<T>): Promise<T> {
  const queue: InventoryEvent[] = [];
  const result = await pendingEvents.run(queue, work);

  publishInventoryEvents(queue);

  return result;
}

/**
 * Sends events to every screen connected for their branch.
 *
 * @param events - The events to send.
 */
function publishInventoryEvents(events: InventoryEvent[]): void {
  for (const { branchId, event, data } of events) {
    publishKitchenEvent(branchId, { event, data });
  }
}
