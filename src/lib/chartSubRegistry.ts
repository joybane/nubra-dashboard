export interface ChartSubscription {
  payload: object;
  interval: string;
  exchange: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return [...value].map(canonical).sort((a, b) => String(a).localeCompare(String(b)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function chartSubscriptionKey(subscription: ChartSubscription): string {
  return JSON.stringify([
    subscription.exchange.toUpperCase(),
    subscription.interval,
    canonical(subscription.payload),
  ]);
}

export interface ChartSubRegistry {
  acquire(subscription: ChartSubscription): boolean;
  release(subscription: ChartSubscription): boolean;
  active(): ChartSubscription[];
}

/** Keeps chart feeds alive across shared consumers, cold starts, and WebSocket reconnects. */
export function createChartSubRegistry(): ChartSubRegistry {
  const entries = new Map<string, { count: number; subscription: ChartSubscription }>();

  return {
    acquire(subscription) {
      const normalized = { ...subscription, exchange: subscription.exchange.toUpperCase() };
      const key = chartSubscriptionKey(normalized);
      const current = entries.get(key);
      if (current) {
        current.count += 1;
        return false;
      }
      entries.set(key, { count: 1, subscription: normalized });
      return true;
    },

    release(subscription) {
      const key = chartSubscriptionKey(subscription);
      const current = entries.get(key);
      if (!current) return false;
      if (current.count === 1) {
        entries.delete(key);
        return true;
      }
      current.count -= 1;
      return false;
    },

    active() {
      return [...entries.values()].map(({ subscription }) => subscription);
    },
  };
}
