import {
  dbInsertOrder,
  dbUpdateOrder,
  dbModifyOrder,
  dbSetOrderSlTriggered,
  dbLoadOrders,
  dbInsertFill,
  dbUpsertPosition,
  dbLoadPositions,
  dbLoadClosedPositions,
  dbInsertPnlTick,
  dbUpsertName,
  dbLoadNameMap,
  dbGetMeta,
  dbSetMeta,
  dbRenameStrategy,
} from './paperDb.ts';

// ─── Live Broker Simulation (SimBroker) ──────────────────────────────────────
// All paper orders are simulated locally against real-time PROD WebSocket data.
// No orders are sent to any live or UAT brokerage account.

export function simSpread(ltp: number): number {
  // Half-spread per side in paise, calibrated to Indian equity/options markets
  if (ltp <= 0) return 1;
  if (ltp < 100) return Math.max(1, Math.round(ltp * 0.005));
  if (ltp < 1_000) return Math.max(2, Math.round(ltp * 0.004));
  if (ltp < 10_000) return Math.max(5, Math.round(ltp * 0.003));
  return Math.max(10, Math.round(ltp * 0.002));
}

/**
 * Read one optional non-negative whole number off an order amendment — a price in paise or a
 * quantity in units.
 *
 * `null` means "absent, leave it alone", `false` means "present but not a usable number" — the
 * caller must reject rather than treat it as absent, or a typo'd price would silently no-op.
 */
function readAmendedNumber(raw: unknown): number | null | false {
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return false;
  return Math.round(raw);
}

export interface SimOrder {
  order_id: number;
  ref_id: number;
  nubraName: string;
  display_name: string;
  order_type: string;
  order_side: string;
  order_price: number; // paise; 0 = market
  trigger_price: number; // paise; 0 = none
  order_qty: number;
  filled_qty: number;
  avg_filled_price: number; // paise
  order_status: string;
  order_time: number; // nanoseconds epoch
  filled_time: number | null;
  order_delivery_type: string;
  validity_type: string;
  tag?: string;
  sl_triggered: boolean;
  basket_group_id?: string;
  strategy_name?: string;
  margin_required?: number; // paise, basket-level margin snapshot
}

export interface SimPosition {
  ref_id: number;
  nubraName: string;
  display_name: string;
  qty: number; // positive = long, negative = short
  avg_price: number; // paise
  realized_pnl: number; // paise
  last_traded_price: number; // paise, kept current by tick feed
  order_delivery_type: string;
  basket_group_id?: string;
  strategy_name?: string;
  entry_time?: number; // nanoseconds epoch
  exit_time?: number; // nanoseconds epoch
  exit_price?: number; // paise
  margin_required?: number; // paise, snapshot at entry
  entry_qty?: number; // original entry qty (positive=long, negative=short), preserved after close
}

export class SimBroker {
  private orders = new Map<number, SimOrder>();
  private positions = new Map<string, SimPosition>(); // key: "ref_id:basket_group_id"
  private ticks = new Map<number, number>(); // ref_id → ltp paise
  private nameMap = new Map<string, number>(); // normalised name → ref_id
  private nextId = 1;
  private pnlTickCounter = 0;

  private posKey(refId: number, basketGroupId?: string): string {
    return `${refId}:${basketGroupId || ''}`;
  }

  restore(): void {
    this.nameMap = dbLoadNameMap();
    const savedNextId = dbGetMeta('nextOrderId');
    if (savedNextId) this.nextId = Number(savedNextId);

    for (const row of dbLoadOrders()) {
      const o: SimOrder = {
        order_id: row.order_id as number,
        ref_id: row.ref_id as number,
        nubraName: row.nubra_name as string,
        display_name: row.display_name as string,
        order_type: row.order_type as string,
        order_side: row.order_side as string,
        order_price: row.order_price as number,
        trigger_price: row.trigger_price as number,
        order_qty: row.order_qty as number,
        filled_qty: row.filled_qty as number,
        avg_filled_price: row.avg_filled_price as number,
        order_status: row.order_status as string,
        order_time: row.order_time as number,
        filled_time: row.filled_time as number | null,
        order_delivery_type: row.order_delivery_type as string,
        validity_type: row.validity_type as string,
        tag: row.tag as string | undefined,
        sl_triggered: !!(row.sl_triggered as number),
        basket_group_id: row.basket_group_id as string | undefined,
        strategy_name: row.strategy_name as string | undefined,
        margin_required: row.margin_required as number | undefined,
      };
      this.orders.set(o.order_id, o);
      if (o.order_id >= this.nextId) this.nextId = o.order_id + 1;
    }

    for (const row of [...dbLoadPositions(), ...dbLoadClosedPositions()]) {
      const p: SimPosition = {
        ref_id: row.ref_id as number,
        nubraName: row.nubra_name as string,
        display_name: row.display_name as string,
        qty: row.qty as number,
        avg_price: row.avg_price as number,
        realized_pnl: row.realized_pnl as number,
        last_traded_price: row.last_traded_price as number,
        order_delivery_type: row.order_delivery_type as string,
        basket_group_id: (row.basket_group_id as string) || '',
        strategy_name: row.strategy_name as string | undefined,
        entry_time: row.entry_time as number | undefined,
        exit_time: row.exit_time as number | undefined,
        exit_price: row.exit_price as number | undefined,
        margin_required: row.margin_required as number | undefined,
        entry_qty: (row.entry_qty as number | null) ?? undefined,
      };
      this.positions.set(this.posKey(p.ref_id, p.basket_group_id), p);
      if (p.qty !== 0) this.ticks.set(p.ref_id, p.last_traded_price);
    }
    console.log(
      `[SimBroker] Restored ${this.orders.size} orders, ${this.positions.size} positions`,
    );
  }

  registerName(nubraName: string, refId: number): void {
    const norm = nubraName.toLowerCase().replace(/^(nse|bse)_/, '');
    const lower = nubraName.toLowerCase();
    if (!this.nameMap.has(lower)) {
      this.nameMap.set(lower, refId);
      dbUpsertName(lower, refId);
    }
    if (norm !== lower && !this.nameMap.has(norm)) {
      this.nameMap.set(norm, refId);
      dbUpsertName(norm, refId);
    }
  }

  onLtp(refId: number, ltpPaise: number): { ref_id: number; ltp: number }[] {
    if (ltpPaise <= 0) return [];
    const prev = this.ticks.get(refId);
    this.ticks.set(refId, ltpPaise);
    const changed: { ref_id: number; ltp: number }[] = [];
    for (const pos of this.positions.values()) {
      if (pos.ref_id !== refId) continue;
      if (pos.qty !== 0 && pos.last_traded_price !== ltpPaise) {
        changed.push({ ref_id: pos.ref_id, ltp: ltpPaise });
      }
      pos.last_traded_price = ltpPaise;
      if (pos.qty !== 0 && ++this.pnlTickCounter % 5 === 0) {
        const unrealized = (ltpPaise - pos.avg_price) * pos.qty;
        dbInsertPnlTick({
          ts: Date.now(),
          ref_id: refId,
          ltp: ltpPaise,
          qty: pos.qty,
          avg_price: pos.avg_price,
          unrealized_pnl: unrealized,
          realized_pnl: pos.realized_pnl,
          total_pnl: unrealized + pos.realized_pnl,
        });
      }
    }
    if (prev !== ltpPaise) this.checkFills(refId, ltpPaise);
    return changed;
  }

  // Called for index / OHLCV ticks (identified by name string)
  onNamedLtp(rawName: string, ltpPaise: number): { ref_id: number; ltp: number }[] {
    if (ltpPaise <= 0) return [];
    const norm = rawName.toLowerCase().replace(/^(nse|bse)_/, '');
    const refId = this.nameMap.get(norm) ?? this.nameMap.get(rawName.toLowerCase());
    if (refId !== undefined) return this.onLtp(refId, ltpPaise);
    return [];
  }

  private checkFills(refId: number, ltp: number): void {
    const half = simSpread(ltp);
    const bid = ltp - half;
    const ask = ltp + half;
    for (const order of this.orders.values()) {
      if (order.ref_id !== refId) continue;
      if (order.order_status !== 'ORDER_STATUS_OPEN') continue;
      this.tryFill(order, bid, ask);
    }
  }

  private tryFill(order: SimOrder, bid: number, ask: number): void {
    const isBuy = order.order_side === 'ORDER_SIDE_BUY';

    if (order.order_type === 'ORDER_TYPE_MARKET') {
      this.fill(order, isBuy ? ask : bid);
    } else if (order.order_type === 'ORDER_TYPE_REGULAR') {
      // Limit: buy when ask crosses down through limit; sell when bid crosses up
      if (isBuy && ask <= order.order_price) this.fill(order, Math.min(ask, order.order_price));
      if (!isBuy && bid >= order.order_price) this.fill(order, Math.max(bid, order.order_price));
    } else if (order.order_type === 'ORDER_TYPE_STOPLOSS') {
      if (!order.sl_triggered) {
        // Trigger: BUY SL when ask rises to trigger; SELL SL when bid falls to trigger
        const hit = isBuy ? ask >= order.trigger_price : bid <= order.trigger_price;
        if (hit) {
          order.sl_triggered = true;
          if (order.order_price > 0) {
            // SL-Limit: fill only if price is within the limit after trigger
            if (isBuy && ask <= order.order_price) this.fill(order, ask);
            if (!isBuy && bid >= order.order_price) this.fill(order, bid);
          } else {
            this.fill(order, isBuy ? ask : bid); // SL-Market
          }
          // An SL-Limit can trigger without filling — the price gapped past the limit. Only
          // `fill()` writes to SQLite, so until now that armed state lived in memory alone and a
          // restart un-triggered the order: it would then demand a *second* crossing of a
          // trigger the market had already gone through, which for a gap-down never comes.
          if (order.order_status !== 'ORDER_STATUS_FILLED') {
            dbSetOrderSlTriggered(order.order_id, true);
          }
        }
      } else if (order.order_price > 0) {
        if (isBuy && ask <= order.order_price) this.fill(order, ask);
        if (!isBuy && bid >= order.order_price) this.fill(order, bid);
      } else {
        this.fill(order, isBuy ? ask : bid);
      }
    }
  }

  private fill(order: SimOrder, fillPaise: number): void {
    order.filled_qty = order.order_qty;
    order.avg_filled_price = Math.round(fillPaise);
    order.order_status = 'ORDER_STATUS_FILLED';
    order.filled_time = Date.now() * 1_000_000;

    const isBuy = order.order_side === 'ORDER_SIDE_BUY';
    const delta = isBuy ? order.order_qty : -order.order_qty;
    const key = this.posKey(order.ref_id, order.basket_group_id);
    let pos = this.positions.get(key);

    if (!pos) {
      pos = {
        ref_id: order.ref_id,
        nubraName: order.nubraName,
        display_name: order.display_name,
        qty: 0,
        avg_price: 0,
        realized_pnl: 0,
        last_traded_price: this.ticks.get(order.ref_id) ?? Math.round(fillPaise),
        order_delivery_type: order.order_delivery_type,
        basket_group_id: order.basket_group_id || '',
        strategy_name: order.strategy_name,
        margin_required: order.margin_required,
      };
      this.positions.set(key, pos);
    }

    const prev = pos.qty;
    const next = prev + delta;

    if (prev === 0) {
      pos.qty = delta;
      pos.avg_price = Math.round(fillPaise);
      pos.entry_time = order.filled_time ?? Date.now() * 1_000_000;
      pos.exit_time = undefined;
      pos.exit_price = undefined;
      pos.entry_qty = delta;
    } else if (Math.sign(prev) === Math.sign(delta)) {
      // Same direction: weighted average price
      const totalQty = Math.abs(prev) + order.order_qty;
      pos.avg_price = Math.round(
        (Math.abs(pos.avg_price) * Math.abs(prev) + fillPaise * order.order_qty) / totalQty,
      );
      pos.qty = next;
    } else {
      // Closing / reversing: realise P&L on the closed portion
      const closedQty = Math.min(Math.abs(prev), order.order_qty);
      pos.realized_pnl += isBuy
        ? (pos.avg_price - fillPaise) * closedQty // buying to cover a short
        : (fillPaise - pos.avg_price) * closedQty; // selling to close a long
      pos.qty = next;
      if (next === 0) {
        pos.exit_time = order.filled_time ?? Date.now() * 1_000_000;
        pos.exit_price = Math.round(fillPaise);
      } else if (Math.sign(next) !== Math.sign(prev)) {
        pos.avg_price = Math.round(fillPaise); // reversed into opposite direction
      }
    }

    // Persist to SQLite
    dbUpdateOrder({
      order_id: order.order_id,
      filled_qty: order.filled_qty,
      avg_filled_price: order.avg_filled_price,
      order_status: order.order_status,
      filled_time: order.filled_time,
      sl_triggered: order.sl_triggered,
    });
    dbInsertFill({
      order_id: order.order_id,
      ref_id: order.ref_id,
      fill_price: Math.round(fillPaise),
      fill_qty: order.order_qty,
      fill_time: order.filled_time!,
      side: order.order_side,
    });
    dbUpsertPosition({
      ref_id: pos.ref_id,
      nubraName: pos.nubraName,
      display_name: pos.display_name,
      qty: pos.qty,
      avg_price: pos.avg_price,
      realized_pnl: pos.realized_pnl,
      last_traded_price: pos.last_traded_price,
      order_delivery_type: pos.order_delivery_type,
      basket_group_id: pos.basket_group_id,
      strategy_name: pos.strategy_name,
      entry_time: pos.entry_time,
      exit_time: pos.exit_time,
      exit_price: pos.exit_price,
      margin_required: pos.margin_required,
      entry_qty: pos.entry_qty,
    });
    // Record P&L at fill time
    const unrealizedAtFill = (pos.last_traded_price - pos.avg_price) * pos.qty;
    dbInsertPnlTick({
      ts: Date.now(),
      ref_id: pos.ref_id,
      ltp: pos.last_traded_price,
      qty: pos.qty,
      avg_price: pos.avg_price,
      unrealized_pnl: unrealizedAtFill,
      realized_pnl: pos.realized_pnl,
      total_pnl: unrealizedAtFill + pos.realized_pnl,
    });

    console.log(
      `[SimBroker] Filled #${order.order_id}: ${order.order_side} ${order.order_qty} ${order.display_name} @ ₹${(fillPaise / 100).toFixed(2)}`,
    );
  }

  placeOrder(p: {
    nubraName: string;
    liveRefId: number;
    display_name?: string;
    order_type: string;
    order_side: string;
    order_qty: number;
    order_price?: number;
    trigger_price?: number;
    order_delivery_type: string;
    validity_type: string;
    tag?: string;
    basket_group_id?: string;
    strategy_name?: string;
    margin_required?: number;
  }): SimOrder {
    const id = this.nextId++;
    const order: SimOrder = {
      order_id: id,
      ref_id: p.liveRefId,
      nubraName: p.nubraName,
      display_name: p.display_name || p.nubraName,
      order_type: p.order_type,
      order_side: p.order_side,
      order_price: p.order_price ?? 0,
      trigger_price: p.trigger_price ?? 0,
      order_qty: p.order_qty,
      filled_qty: 0,
      avg_filled_price: 0,
      order_status: 'ORDER_STATUS_OPEN',
      order_time: Date.now() * 1_000_000,
      filled_time: null,
      order_delivery_type: p.order_delivery_type,
      validity_type: p.validity_type || 'DAY',
      tag: p.tag,
      sl_triggered: false,
      basket_group_id: p.basket_group_id,
      strategy_name: p.strategy_name,
      margin_required: p.margin_required,
    };
    this.orders.set(id, order);
    this.registerName(p.nubraName, p.liveRefId);
    dbInsertOrder(order);
    dbSetMeta('nextOrderId', String(this.nextId));

    // Attempt immediate fill if we already have a live tick for this instrument
    const ltp = this.ticks.get(p.liveRefId);
    if (ltp) {
      const half = simSpread(ltp);
      this.tryFill(order, ltp - half, ltp + half);
    }
    return order;
  }

  cancelOrder(id: number): boolean {
    const o = this.orders.get(id);
    if (!o || o.order_status !== 'ORDER_STATUS_OPEN') return false;
    o.order_status = 'ORDER_STATUS_CANCELLED';
    dbUpdateOrder({
      order_id: o.order_id,
      filled_qty: o.filled_qty,
      avg_filled_price: o.avg_filled_price,
      order_status: o.order_status,
      filled_time: o.filled_time,
      sl_triggered: o.sl_triggered,
    });
    return true;
  }

  /**
   * Amend a still-open order's price, trigger or quantity.
   *
   * Three things this deliberately does beyond mutating the in-memory record:
   *
   * 1. **Persists.** The amendment used to live in memory alone, so a restart silently reverted
   *    the order to the price it was placed at — and the user had no way to tell.
   * 2. **Rejects nonsense.** Prices are paise and quantity is a lot count; a negative or
   *    non-finite value would have been written straight through into the fill comparison.
   * 3. **Re-evaluates against the last tick**, exactly as `placeOrder` does. Fills are otherwise
   *    only checked when a price *changes*, so moving a limit onto the wrong side of a market
   *    that is standing still would sit unfilled until the next differing tick.
   */
  modifyOrder(id: number, updates: Record<string, unknown>): boolean {
    const o = this.orders.get(id);
    if (!o || o.order_status !== 'ORDER_STATUS_OPEN') return false;

    const price = readAmendedNumber(updates.order_price);
    const trigger = readAmendedNumber(updates.trigger_price);
    const qty = readAmendedNumber(updates.order_qty);
    if (price === false || trigger === false || qty === false) return false;
    if (qty != null && qty <= 0) return false;

    if (price != null) o.order_price = price;
    if (trigger != null) o.trigger_price = trigger;
    if (qty != null) o.order_qty = qty;

    dbModifyOrder({
      order_id: o.order_id,
      order_price: o.order_price,
      trigger_price: o.trigger_price,
      order_qty: o.order_qty,
    });

    const ltp = this.ticks.get(o.ref_id);
    if (ltp) {
      const half = simSpread(ltp);
      this.tryFill(o, ltp - half, ltp + half);
    }
    return true;
  }

  getOrders(filter: 'live' | 'executed' | 'all'): SimOrder[] {
    const all = Array.from(this.orders.values()).sort((a, b) => b.order_time - a.order_time);
    if (filter === 'live') return all.filter((o) => o.order_status === 'ORDER_STATUS_OPEN');
    if (filter === 'executed') return all.filter((o) => o.order_status !== 'ORDER_STATUS_OPEN');
    return all;
  }

  getPositions(): SimPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.qty !== 0);
  }

  getClosedPositions(): SimPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.qty === 0 && p.realized_pnl !== 0);
  }

  renameStrategy(basketGroupId: string, newName: string): boolean {
    let found = false;
    for (const o of this.orders.values()) {
      if (o.basket_group_id === basketGroupId) {
        o.strategy_name = newName;
        found = true;
      }
    }
    for (const p of this.positions.values()) {
      if (p.basket_group_id === basketGroupId) {
        p.strategy_name = newName;
        found = true;
      }
    }
    if (found) dbRenameStrategy(basketGroupId, newName);
    return found;
  }
}
