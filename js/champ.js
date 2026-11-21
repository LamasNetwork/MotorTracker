// Campeonatos: classificações oficiais e classificação provisória de acordo com a prova em curso.
import { isLive } from './race.js';

const AUTO = new Set(['T0', 'T1', 'T1+', 'T2', 'T8', 'T9']);
const SSV = new Set(['T3', 'T4', 'T4EA']);
const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
const NOT_ROUND = new Set([...SMALL, 'baja', 'tt', 'rali', 'rally', 'raid', 'bp', 'ultimate', 'escuderia', 'fpak', 'auto', 'online', 'esc', 'campeonato', 'portugal', 'gin']);

export async function loadChamp(year) {
  const r = await fetch(`championships/cptt-${year}.json`, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = s => (plain(s).match(/[a-z]+/g) || []).filter(w => !SMALL.has(w));
const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

// Os números mudam de prova para prova, por isso a ligação ao campeonato é feita pelo nome.
export function matchRow(name, rows) {
  const a = tokens(name);
  if (!a.length) return null;
  let found = rows.filter(r => {
    const b = tokens(r.name);
    return b.length && same(a[0], b[0]) && b.slice(1).some(w => same(a[a.length - 1], w));
  });
  if (found.length > 1) {
    const strict = found.filter(r => { const b = new Set(tokens(r.name)); return a.every(w => b.has(w)); });
    if (strict.length) found = strict;
  }
  return new Set(found.map(r => tokens(r.name).join(' '))).size === 1 ? found[0] : null;
}

// Índice da ronda do campeonato que corresponde a uma corrida de automóveis.
export function roundOf(ch, raceName) {
  if (!ch || /\b(FIM|FMP|MINI)\b/i.test(raceName || '')) return -1;
  const want = new Set((plain(raceName).match(/[a-z]+/g) || []).filter(w => !NOT_ROUND.has(w)));
  let best = -1, score = 0, tie = false;
  (ch.rounds || []).forEach((name, i) => {
    const n = (plain(name).match(/[a-z]+/g) || []).filter(w => !NOT_ROUND.has(w) && want.has(w)).length;
    if (n > score) { best = i; score = n; tie = false; } else if (n && n === score) tie = true;
  });
  return tie ? -1 : best;
}

const inScope = (scope, group) => ['all', 'veterans', 'women'].includes(scope) || group === scope
  || (scope === 'auto' && AUTO.has(group)) || (scope === 'ssv' && SSV.has(group));
const isPrologue = s => /^PR/i.test(String(s?.special_name || ''));
const sumResult = r => r.reduce((n, x) => n + (x || 0), 0);

export function bestTotal(results, drop = 1) {
  const vals = results.filter(Boolean).map(sumResult).sort((a, b) => b - a);
  return vals.slice(0, Math.max(vals.length - drop, 1)).reduce((n, x) => n + x, 0);
}

// Posição no momento: último intermédio com pelo menos metade dos pilotos, ou último final.
function currentOrder(race, itin) {
  const sps = race.startedSpecials(itin).filter(s => !isPrologue(s));
  for (let i = sps.length - 1; i >= 0; i--) {
    const s = sps[i];
    if (isLive(s)) {
      const base = race.prevAcc(itin, s.id).map?.size || race.parts.size;
      for (let k = race.intermediates(s.id).length - 1; k >= 0; k--) {
        const rows = race.ranking(itin, s.id, k, 'overall');
        if (rows.length >= Math.max(3, base / 2)) return { rows, label: race.pointLabel(itin, { sid: s.id, k }) };
      }
      continue;
    }
    const rows = race.ranking(itin, s.id, 'F', 'overall').filter(r => !r.missing);
    if (rows.length) return { rows, label: `${s.special_name || 'Especial'} · Final` };
  }
  return { rows: [], label: '' };
}

export function provisional(ch, table, race, itin, R) {
  if (R < 0 || table.role !== 'driver' || !table.rows.length) return null;
  const rowOf = new Map();
  for (const p of race.parts.values()) {
    if (!inScope(table.scope, p.group)) continue;
    const row = matchRow(p.pilot, table.rows);
    if (row) rowOf.set(p.id, row);
  }
  const rules = ch.rules;
  const calc = new Map();
  const order = currentOrder(race, itin);
  let place = 0;
  for (const r of order.rows) {
    const row = rowOf.get(r.pid);
    if (!row || calc.has(row) || race.parts.get(r.pid)?.superrally_special_id > 0) continue;
    calc.set(row, [rules.points[place] ?? rules.after, 0, 0]);
    place++;
  }
  const bonus = (list, col, values) => {
    let n = 0;
    for (const e of [...list].filter(x => x.total > 0).sort((a, b) => a.total - b.total)) {
      const row = rowOf.get(e.participant_id);
      if (!row) continue;
      if (n >= values.length) break;
      if (!calc.has(row)) calc.set(row, [0, 0, 0]);
      calc.get(row)[col] += values[n++];
    }
  };
  const sps = race.specialsOf(itin);
  const prologue = sps.find(isPrologue);
  const prologueList = prologue ? race.clsOf(itin, prologue.id)?.special : null;
  if (prologueList && ['all', 'auto', 'ssv', 'veterans', 'women'].includes(table.scope)) bonus(prologueList, 1, rules.prologue);
  for (const s of sps) {
    if (isPrologue(s) || s.state !== 2) continue;
    const list = race.clsOf(itin, s.id)?.special;
    if (list) bonus(list, 2, [rules.stage]);
  }
  const factor = R === ch.rounds.length - 1 ? rules.lastFactor : 1;
  const raceIdent = new Map();
  for (const [pid, row] of rowOf) if (!raceIdent.has(row)) raceIdent.set(row, race.parts.get(pid)?.ident);
  const rows = table.rows.map(o => {
    const res = o.r.map(x => (x ? [...x] : null));
    // Linhas sem posição oficial não contam para o campeonato: mantêm o total publicado.
    const now = o.pos == null ? null : calc.get(o);
    if (now) res[R] = now.map(v => v * factor);
    const total = o.pos == null ? o.total : bestTotal(res, rules.drop);
    return { ...o, r: res, before: o.total, total, gain: now ? sumResult(res[R]) : 0, raceIdent: raceIdent.get(o) ?? null };
  });
  const ranked = rows.filter(r => r.pos != null).sort((a, b) => b.total - a.total || a.pos - b.pos);
  ranked.forEach((r, i) => { r.oldPos = r.pos; r.newPos = i + 1; });
  return { rows: [...ranked, ...rows.filter(r => r.pos == null)], label: order.label, factor, scored: calc.size };
}
