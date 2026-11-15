import { useEffect, useMemo, useState } from 'react';
import {
  COLUMN_BY_KEY,
  formatCell,
  quantile,
  type Column,
  type DayRow,
} from '../lib/tradeExplorer';
import { crossTrait, crossWorst } from '../lib/tradeExplorerCompare';
import { glossFor } from '../lib/tradeExplorerGlossary';
import { AFTER_KEYS, ENTRY_KEYS, type Outcome } from '../lib/tradeExplorerSplits';
import {
  conditions,
  groupTraitSet,
  lossGroups,
  pairTrait,
  prepare,
  traceBack,
  traitChance,
  worstChance,
  worstCriteria,
  type Cond,
  type LossGroup,
  type PairTrait,
  type Prepared,
  type Trait,
  type WorstLine,
} from '../lib/tradeExplorerTraits';

type Pick = { key: string; side: DayRow[]; label: string };

interface LossViewProps {
  rows: DayRow[];
  outcome: Outcome;
  linePct: number;
  onPick(picks: Pick[], close: boolean): void;
  onOpenDay(date: string): void;
  /** The other index's days, for the cross-check. */
  other?: { name: string; rows: DayRow[] };
}

interface CrossCtx {
  name: string;
  po: Prepared;
  lineO: number;
  groupsO: LossGroup[];
}

const MIN_DAYS = 30;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (x: number) => x.toLocaleString('en-IN');

function useShared(props: LossViewProps) {
  const { rows, outcome, linePct } = props;
  const outCol = COLUMN_BY_KEY.get(outcome) as Column;
  const p = useMemo(() => prepare(rows, outcome), [rows, outcome]);
  const line = useMemo(() => quantile(p.y, linePct) ?? 0, [p, linePct]);
  const entry = useMemo(() => conditions(p, ENTRY_KEYS), [p]);
  const after = useMemo(() => conditions(p, AFTER_KEYS), [p]);
  const fmt = (v: number) => formatCell(outCol, v);
  const sideOf = (c: Cond) => p.rows.filter((_, i) => c.has[i] === 1);
  const pick = (c: Cond): Pick => ({ key: c.key, side: sideOf(c), label: c.label });
  // Keyed on the rows, not on the `other` object, which is new on every parent render.
  const otherRows = props.other?.rows;
  const otherName = props.other?.name;
  const cross = useMemo<CrossCtx | null>(() => {
    if (!otherRows || !otherName) return null;
    const po = prepare(otherRows, outcome);
    const lineO = quantile(po.y, linePct) ?? 0;
    return { name: otherName, po, lineO, groupsO: lossGroups(po, lineO, String) };
  }, [otherRows, otherName, outcome, linePct]);
  return { p, line, entry, after, fmt, pick, cross };
}

function InfoBox({ keys }: { keys: string[] }) {
  return (
    <div className="te-loss-info">
      {keys.map((k) => {
        const g = glossFor(k);
        const name = COLUMN_BY_KEY.get(k)?.label ?? k;
        return (
          <dl key={k}>
            {keys.length > 1 && <dt className="te-loss-info-name">{name}</dt>}
            <dt>What it is</dt>
            <dd>{g.what}</dd>
            {g.unlike && (
              <>
                <dt>Not the same as</dt>
                <dd>{g.unlike}</dd>
              </>
            )}
            <dt>Where to see it</dt>
            <dd>{g.where}</dd>
          </dl>
        );
      })}
    </div>
  );
}

function Reading(props: {
  label: string;
  onClick: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button type="button" className="te-loss-label" onClick={props.onClick}>
        {props.label}
      </button>
      <button
        type="button"
        className="te-loss-help"
        aria-expanded={props.open}
        title="What is this reading?"
        onClick={props.onToggle}
      >
        ?
      </button>
    </>
  );
}

function Examples(props: { dates: string[]; onOpenDay(d: string): void }) {
  if (!props.dates.length) return null;
  return (
    <span>
      Examples:{' '}
      {props.dates.map((d) => (
        <button key={d} type="button" className="te-loss-date" onClick={() => props.onOpenDay(d)}>
          {d}
        </button>
      ))}
    </span>
  );
}

const KIND_WORD = { unique: 'Unique', lean: 'Lean', weak: 'Weak' } as const;

function TraitLine(props: {
  trait: Trait | PairTrait;
  muted?: boolean;
  chanceBadge?: boolean;
  /** The other index's cross-check sentence, if any. */
  cross?: string | null;
  onPick: LossViewProps['onPick'];
  pick: (c: Cond) => Pick;
  onOpenDay(d: string): void;
}) {
  const { trait: t } = props;
  const [open, setOpen] = useState(false);
  const pair = 'second' in t ? t : null;
  const keys = pair ? [pair.first.key, pair.second.key] : [t.cond.key];
  const click = () =>
    props.onPick(
      pair ? [props.pick(pair.first), props.pick(pair.second)] : [props.pick(t.cond)],
      false,
    );
  return (
    <div className={`te-loss-trait${props.muted ? ' te-split-muted' : ''}`}>
      <span className={`te-badge te-loss-kind-${t.kind}`}>{KIND_WORD[t.kind]}</span>
      {props.chanceBadge && <span className="te-badge">Could be chance</span>}
      <Reading label={t.cond.label} onClick={click} open={open} onToggle={() => setOpen(!open)} />
      <div className="te-loss-counts">
        {num(t.inGroup)} of {num(t.groupSize)} here · {num(t.elsewhere)} of {num(t.elseSize)}{' '}
        elsewhere
      </div>
      <div className="te-split-muted te-loss-more">
        {t.same.length > 0 && <span>Same days as: {t.same.join(', ')}</span>}
        {t.years && <span>{t.years}</span>}
        <Examples dates={t.examples} onOpenDay={props.onOpenDay} />
      </div>
      {props.cross && <div className="te-split-muted te-loss-more">{props.cross}</div>}
      {open && <InfoBox keys={keys} />}
    </div>
  );
}

function TooFew({ n }: { n: number }) {
  return <p className="te-caption">Too few days ({n}). Widen the criteria.</p>;
}

// ── Loss groups ──────────────────────────────────────────────────────────────

interface GroupSets {
  group: LossGroup;
  signal: ReturnType<typeof groupTraitSet>;
  day: ReturnType<typeof groupTraitSet>;
  pair: PairTrait | null;
}

function TraitSection(props: {
  eyebrow: string;
  caption?: string;
  traits: Trait[];
  pair?: PairTrait | null;
  chance: number | null | undefined;
  nothing: string;
  /** Signal-time section only: cross-check each trait against the other index. */
  cross?: { ctx: CrossCtx; groupId: string } | null;
  onPick: LossViewProps['onPick'];
  pick: (c: Cond) => Pick;
  onOpenDay(d: string): void;
}) {
  const { traits, chance } = props;
  const common = { onPick: props.onPick, pick: props.pick, onOpenDay: props.onOpenDay };
  const crossText = (t: Trait) => {
    if (!props.cross) return null;
    const { ctx, groupId } = props.cross;
    const r = crossTrait(ctx.po, ctx.groupsO, groupId, t);
    return r
      ? `${ctx.name}: ${pct(r.a)} of its ${num(r.days)} days here, ${pct(r.b)} elsewhere · ${r.word}`
      : null;
  };
  let body;
  if (!traits.length) body = <p className="te-caption">{props.nothing}</p>;
  else if (chance == null) body = <p className="te-caption">checking…</p>;
  else if (chance >= 0.2)
    body = (
      <>
        <p className="te-caption">{props.nothing}</p>
        <TraitLine trait={traits[0]} muted chanceBadge cross={crossText(traits[0])} {...common} />
      </>
    );
  else
    body = (
      <>
        {chance >= 0.05 && <span className="te-badge">Could be chance</span>}
        {traits.map((t) => (
          <TraitLine key={t.cond.label} trait={t} cross={crossText(t)} {...common} />
        ))}
        {props.pair && (
          <div>
            <span className="te-eyebrow">Together</span>
            <TraitLine trait={props.pair} {...common} />
          </div>
        )}
      </>
    );
  return (
    <div className="te-loss-section">
      <span className="te-eyebrow">{props.eyebrow}</span>
      {props.caption && <span className="te-caption"> {props.caption}</span>}
      {body}
    </div>
  );
}

function SeenSection(props: { p: Prepared; day: Trait[]; entry: Cond[] }) {
  const strong = props.day.filter((t) => t.strong).slice(0, 2);
  const traces = useMemo(
    () => strong.map((t) => [t, traceBack(props.p, t.cond, props.entry)] as const),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.p, props.day, props.entry],
  );
  const [open, setOpen] = useState<string | null>(null);
  if (!traces.length) return null;
  return (
    <div className="te-loss-section">
      <span className="te-eyebrow">COULD IT BE SEEN AT THE SIGNAL?</span>
      {traces.map(([t, r]) =>
        r ? (
          <div key={t.cond.label} className="te-loss-trait">
            <span>
              {t.cond.label}: yes. {r.cond.label} → {pct(r.withRate)} of {num(r.days)} days, against{' '}
              {pct(r.withoutRate)} otherwise.
              {!r.sure && ' Few days: could be chance.'}
            </span>
            <button
              type="button"
              className="te-loss-help"
              aria-expanded={open === t.cond.label}
              title="What is this reading?"
              onClick={() => setOpen(open === t.cond.label ? null : t.cond.label)}
            >
              ?
            </button>
            {open === t.cond.label && <InfoBox keys={[r.cond.key]} />}
          </div>
        ) : (
          <div key={t.cond.label} className="te-loss-trait">
            {t.cond.label}: not visible at the signal.
          </div>
        ),
      )}
    </div>
  );
}

export function LossGroupsView(props: LossViewProps) {
  const { p, line, entry, after, fmt, pick, cross } = useShared(props);
  const enough = p.n >= MIN_DAYS;
  const sets = useMemo<GroupSets[]>(() => {
    if (!enough) return [];
    return lossGroups(p, line, fmt).map((group) => {
      const signal = groupTraitSet(p, group, entry);
      return {
        group,
        signal,
        day: groupTraitSet(p, group, after),
        pair: pairTrait(p, group, signal.kept),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, line, entry, after, enough]);

  const [chances, setChances] = useState<{ for: GroupSets[]; map: Record<string, number> } | null>(
    null,
  );
  useEffect(() => {
    if (!sets.length) return;
    let live = true;
    const t = setTimeout(() => {
      const map: Record<string, number> = {};
      for (const s of sets) {
        if (s.signal.traits.length)
          map[`${s.group.id}|signal`] = traitChance(p, s.group, entry, s.signal.traits[0].diff);
        if (s.day.traits.length)
          map[`${s.group.id}|day`] = traitChance(p, s.group, after, s.day.traits[0].diff);
      }
      if (live) setChances({ for: sets, map });
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sets, p, entry, after]);
  const ready = chances && chances.for === sets ? chances.map : null;

  if (!enough) return <TooFew n={p.n} />;
  const above = sets[0]?.group.idx.length ?? 0;
  const common = { onPick: props.onPick, pick, onOpenDay: props.onOpenDay };
  return (
    <div className="te-loss">
      <p className="te-caption">
        Loss line {fmt(line)} · {num(above)} of {num(p.n)} days above it
      </p>
      {cross && (
        <p className="te-caption">
          Cross-check uses all {cross.name} days of the same trade set, not your criteria.
        </p>
      )}
      {sets.map((s) => (
        <section
          key={s.group.id}
          className={`te-chart-card te-loss-card${s.group.id === 'below' ? '' : ' te-loss-above'}`}
        >
          <div className="te-card-heading">
            <div>
              <h2>{s.group.label}</h2>
            </div>
            <span>
              <span className="te-badge">{num(s.group.idx.length)} days</span>
              {s.group.rare && <span className="te-badge">rare</span>}
              {s.group.idx.length < 20 && <span className="te-badge">few</span>}
            </span>
          </div>
          <TraitSection
            eyebrow="AT THE SIGNAL"
            traits={s.signal.traits}
            pair={s.pair}
            chance={ready ? ready[`${s.group.id}|signal`] : null}
            nothing="Nothing at the signal marks these days."
            cross={cross ? { ctx: cross, groupId: s.group.id } : null}
            {...common}
          />
          <TraitSection
            eyebrow="DURING THE DAY"
            caption="Known only after the day is over."
            traits={s.day.traits}
            chance={ready ? ready[`${s.group.id}|day`] : null}
            nothing="Nothing during the day marks these days."
            {...common}
          />
          <SeenSection p={p} day={s.day.traits} entry={entry} />
        </section>
      ))}
    </div>
  );
}

// ── Worst criteria ───────────────────────────────────────────────────────────

function WorstRow(props: {
  line: WorstLine;
  muted?: boolean;
  prefix?: string;
  onPick: LossViewProps['onPick'];
  pick: (c: Cond) => Pick;
  onOpenDay(d: string): void;
  fmt: (v: number) => string;
  cross?: string | null;
}) {
  const { line: l } = props;
  const [open, setOpen] = useState(false);
  const shown = l.second ?? l.cond;
  const click = () =>
    props.onPick(
      l.second ? [props.pick(l.cond), props.pick(l.second)] : [props.pick(l.cond)],
      false,
    );
  return (
    <div className={`te-loss-trait${props.muted ? ' te-split-muted' : ''}`}>
      {props.prefix && <span className="te-split-muted">{props.prefix}</span>}
      <Reading label={shown.label} onClick={click} open={open} onToggle={() => setOpen(!open)} />
      <span>{num(l.days)} days</span>
      <span>{pct(l.share)} above the line</span>
      <span>median {props.fmt(l.median)}</span>
      <div className="te-split-muted te-loss-more">
        {l.same.length > 0 && <span>Same days as: {l.same.join(', ')}</span>}
        {l.years && <span>{l.years}</span>}
        {!l.second && <Examples dates={l.examples} onOpenDay={props.onOpenDay} />}
      </div>
      {props.cross && <div className="te-split-muted te-loss-more">{props.cross}</div>}
      {open && <InfoBox keys={[shown.key]} />}
    </div>
  );
}

export function WorstCriteriaView(props: LossViewProps) {
  const { p, line, entry, fmt, pick, cross } = useShared(props);
  const enough = p.n >= MIN_DAYS;
  const worst = useMemo(
    () => (enough ? worstCriteria(p, line, entry) : null),
    [p, line, entry, enough],
  );
  const needChance = !!worst && !p.canHalves && worst.lines.length > 0;
  const [chance, setChance] = useState<{ for: typeof worst; value: number } | null>(null);
  useEffect(() => {
    if (!worst || !needChance) return;
    let live = true;
    const t = setTimeout(() => {
      const value = worstChance(p, line, entry, worst.lines[0].lift);
      if (live) setChance({ for: worst, value });
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [worst, needChance, p, line, entry]);

  if (!enough) return <TooFew n={p.n} />;
  if (!worst)
    return (
      <p className="te-caption">Too few days for a worst-criteria list ({p.n}). It needs 60.</p>
    );
  const value = needChance && chance && chance.for === worst ? chance.value : null;
  const checking = needChance && value == null;
  const nothing = value != null && value >= 0.2;
  const maybe = value != null && value >= 0.05 && value < 0.2;
  const common = { onPick: props.onPick, pick, onOpenDay: props.onOpenDay, fmt };
  const crossText = (l: WorstLine) => {
    if (!cross) return null;
    const r = crossWorst(cross.po, cross.lineO, l, worst.base);
    return `${cross.name}: ${pct(r.a)} of ${num(r.days)} days above its line (all days ${pct(r.b)}) · ${r.word}`;
  };
  return (
    <section className="te-chart-card te-loss-card">
      <div className="te-card-heading">
        <div>
          <span className="te-eyebrow">WORST CRITERIA</span>
          <h2>
            {nothing
              ? 'No condition clearly raises the losses on these days.'
              : 'Which conditions put the most days above the line?'}
          </h2>
        </div>
        {checking && <span className="te-badge">checking…</span>}
        {maybe && <span className="te-badge">Could be chance</span>}
      </div>
      <p className="te-caption">
        Of all these days, {pct(worst.base)} are above {fmt(line)}.
        {!p.canHalves && ' Too few days to check earlier against later years.'}
      </p>
      {cross && (
        <p className="te-caption">
          Cross-check uses all {cross.name} days of the same trade set, not your criteria.
        </p>
      )}
      <div className="te-loss-list">
        {worst.lines.map((l) => (
          <div key={l.cond.label}>
            <WorstRow line={l} muted={nothing} cross={crossText(l)} {...common} />
            {l.worseWith.map((w) => (
              <div key={w.second!.label} className="te-loss-indent">
                <WorstRow
                  line={w}
                  muted={nothing}
                  prefix="made worse by"
                  cross={crossText(w)}
                  {...common}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
