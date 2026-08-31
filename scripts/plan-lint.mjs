#!/usr/bin/env node
/*
 * Copyright © 2026 Dmitry Batulin — https://github.com/dmitryprg-ai/Autonomic-Work-Kit
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Некоммерческое использование при указании авторства. Коммерческое —
 * только по письменному разрешению: dmitryprg@gmail.com. См. LICENSE.
 */
/**
 * plan-lint — механическая проверка PLAN.md.
 * Без зависимостей. Требуется Node ≥ 18.
 * Запуск: node scripts/plan-lint.mjs [PLAN.md]
 * Код возврата: 0 — план валиден, 1 — есть ошибки.
 *
 * ЯЗЫК. Ключи полей ниже — фиксированная схема, а не проза: линтер ищет
 * именно их. Проза задачи пишется на языке владельца, ключи остаются как
 * здесь. Чтобы перевести схему, отредактируйте KEYS/WORDS в этом файле
 * и одновременно — шаблон templates/PLAN.md и .claude/rules/plan-format.md.
 */
import { readFileSync } from 'node:fs';

/* ── схема: ключи полей Small-задачи ─────────────────────────────── */
const KEYS = {
  class: 'Класс',
  marks: 'Метки',
  when: 'Когда',
  role: 'Роль',
  wants: 'Хочет',
  soThat: 'Чтобы',
  gap: 'Закрывает gap',
  dod: 'DoD',
  runtime: 'Runtime evidence',
  outOfScope: 'Вне scope',
  dependsOn: 'Зависит от',
  state: 'Состояние',
  verdict: 'Вердикт',
};
const WORDS = {
  parent: 'родитель',
  na: 'н/д',              // допустимо в Runtime evidence у chore/spike
  none: '—',              // пустой список зависимостей
  alarm: 'Alarm',
  chainHeading: 'Критическая цепь',
  outcomeHeading: 'Outcome проекта',
  bottleneck: 'Узкое место',
  buffer: 'Буфер',
  rope: 'Верёвка',
  measure: /(замер|измер|прогон|бенчмарк|смоук|отчёт|§|эталон|baseline|лог|источник)/i,
  or: /\bили\b/i,
};
const REQUIRED = Object.values(KEYS);
const CLASSES = ['outcome', 'chore', 'spike'];
const STATES = ['PERSIST', 'EXECUTION', 'BLOCKED', 'CLOSE'];
const VERDICTS = ['⚪', '⚠️', '❌', '✅'];
const LIMITS = { big: [3, 7], medium: [2, 5], small: [2, 5] };

/* незаполненный шаблон: ‹плейсхолдер›, <плейсхолдер>, TODO, невыбранное «a | b | c» */
const PLACEHOLDER = /[‹›]|<[^>]{2,}>|\bTODO\b|\bTBD\b|\bFIXME\b/;
const UNCHOSEN = /^[^\s|]+(\s*\|\s*[^\s|]+)+$/;

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const FILE = process.argv[2] ?? 'PLAN.md';
let text;
try { text = readFileSync(FILE, 'utf8'); }
catch { console.error(`не читается: ${FILE}`); process.exit(1); }

/* ── разбор иерархии ─────────────────────────────────────────────── */
const bigs = [...text.matchAll(/^## (B-\d+) — (.+)$/gm)].map((m) => m[1]);
const mediums = [...text.matchAll(/^### (M-\d+\.\d+) — (.+)$/gm)].map((m) => m[1]);
const smallChunks = text.split(/^#### (T-\d+\.\d+\.\d+) — /m);

const tasks = new Map();
for (let i = 1; i < smallChunks.length; i += 2) {
  const id = smallChunks[i];
  const body = smallChunks[i + 1].split(/^#{1,4} /m)[0];
  // [ \t]* — не \s*: \s съедает перевод строки и подставляет соседнюю строку,
  // маскируя пустое поле. Дефект найден мутационным тестом, не рассуждением.
  const all = (name) =>
    [...body.matchAll(new RegExp(`^- ${name}:[ \t]*(.*)$`, 'gm'))].map((m) => m[1].trim());
  const field = (name) => all(name)[0] ?? '';
  const depLine = field(KEYS.dependsOn);
  const parents = [...depLine.matchAll(new RegExp(`${WORDS.parent}:\\s*(M-\\d+\\.\\d+)`, 'g'))]
    .map((m) => m[1]);
  if (tasks.has(id)) err(`${id}: идентификатор встречается дважды`);
  tasks.set(id, {
    body,
    fields: Object.fromEntries(REQUIRED.map((f) => [f, field(f)])),
    dupFields: REQUIRED.filter((f) => all(f).length > 1),
    parent: parents[0] ?? '',
    parents,
    deps: depLine.split(`${WORDS.parent}:`)[0].match(/T-\d+\.\d+\.\d+/g) || [],
    depsRaw: depLine.split(`${WORDS.parent}:`)[0].replace(/\|\s*$/, '').trim(),
  });
}
const classOf = (t) => t.fields[KEYS.class].split(/[\s|]/)[0];

/* ── 1. объёмные границы ─────────────────────────────────────────── */
const inRange = (n, [lo, hi]) => n >= lo && n <= hi;
if (!inRange(bigs.length, LIMITS.big))
  err(`Big: ${bigs.length}, допустимо ${LIMITS.big.join('–')}`);
for (const b of bigs) {
  const kids = mediums.filter((m) => m.startsWith(`M-${b.slice(2)}.`));
  if (!inRange(kids.length, LIMITS.medium))
    err(`${b}: Medium ${kids.length}, допустимо ${LIMITS.medium.join('–')}`);
}
for (const m of mediums) {
  const kids = [...tasks.keys()].filter((t) => t.startsWith(`T-${m.slice(2)}.`));
  if (!inRange(kids.length, LIMITS.small))
    err(`${m}: Small ${kids.length}, допустимо ${LIMITS.small.join('–')}`);
}

/* ── 2. поля: заполненность, плейсхолдеры, перечисления ──────────── */
for (const [id, t] of tasks) {
  const empty = REQUIRED.filter((f) => !t.fields[f]);
  if (empty.length) err(`${id}: пустые поля — ${empty.join(', ')}`);
  if (t.dupFields.length) err(`${id}: поле указано дважды — ${t.dupFields.join(', ')}`);

  for (const f of REQUIRED) {
    const v = t.fields[f];
    if (!v) continue;
    if (PLACEHOLDER.test(v)) err(`${id}.${f}: незаполненный плейсхолдер — «${v.slice(0, 60)}»`);
    else if (UNCHOSEN.test(v)) err(`${id}.${f}: вариант не выбран — «${v.slice(0, 60)}»`);
  }

  const cls = classOf(t);
  if (cls && !PLACEHOLDER.test(t.fields[KEYS.class]) && !UNCHOSEN.test(t.fields[KEYS.class])
      && !CLASSES.includes(cls))
    err(`${id}: класс «${cls}» вне ${CLASSES.join('/')}`);

  const marks = t.fields[KEYS.marks];
  if (marks && !PLACEHOLDER.test(marks) && ![WORDS.alarm, WORDS.none].includes(marks))
    err(`${id}: метка «${marks}» вне «${WORDS.alarm}» / «${WORDS.none}»`);

  const state = t.fields[KEYS.state];
  if (state && !UNCHOSEN.test(state) && !STATES.includes(state))
    err(`${id}: состояние «${state}» вне ${STATES.join('/')}`);

  const verdict = t.fields[KEYS.verdict];
  if (verdict && !VERDICTS.some((v) => verdict.startsWith(v)))
    err(`${id}: вердикт «${verdict}» вне ${VERDICTS.join('/')}`);

  // runtime evidence: «н/д» законно только для chore/spike
  const rt = t.fields[KEYS.runtime];
  if (rt === WORDS.na && cls === 'outcome')
    err(`${id}: Runtime evidence «${WORDS.na}» у класса outcome — доказательство обязательно`);
  if (rt && rt !== WORDS.na && ['chore', 'spike'].includes(cls) === false && rt.length < 12)
    warn(`${id}: Runtime evidence слишком коротко, чтобы быть наблюдаемым — «${rt}»`);

  // зависимости: либо «—», либо список T-ID
  if (t.depsRaw && t.depsRaw !== WORDS.none && t.deps.length === 0)
    err(`${id}: «${KEYS.dependsOn}» не распознан — ожидается «${WORDS.none}» или список T-…`);

  // родитель
  if (t.parents.length > 1) err(`${id}: указано несколько родителей — ${t.parents.join(', ')}`);
  if (!t.parent) err(`${id}: не указан родитель (M-…)`);
  else if (!mediums.includes(t.parent)) err(`${id}: родитель ${t.parent} не существует`);
  else if (!id.startsWith(`T-${t.parent.slice(2)}.`))
    err(`${id}: родитель ${t.parent} не соответствует нумерации`);
}

/* ── 3. зависимости: существование и ацикличность ────────────────── */
for (const [id, t] of tasks)
  for (const d of t.deps)
    if (!tasks.has(d)) err(`${id}: зависит от несуществующей ${d}`);
    else if (d === id) err(`${id}: зависит от самой себя`);

const color = new Map([...tasks.keys()].map((k) => [k, 0]));
const cycles = [];
const dfs = (n, stack) => {
  color.set(n, 1);
  for (const m of tasks.get(n).deps) {
    if (!tasks.has(m)) continue;
    if (color.get(m) === 1) cycles.push([...stack, n, m].join(' → '));
    else if (color.get(m) === 0) dfs(m, [...stack, n]);
  }
  color.set(n, 2);
};
for (const n of tasks.keys()) if (color.get(n) === 0) dfs(n, []);
for (const c of cycles) err(`цикл зависимостей: ${c}`);

/* ── 4. критическая цепь: звенья названы T-ID, на цепи только outcome ─ */
const chainRe = new RegExp(`## ${WORDS.chainHeading}[\\s\\S]*?(?=\\n## |$)`);
const chainBlock = (text.match(chainRe) || [''])[0];
if (!chainBlock) err(`нет раздела «${WORDS.chainHeading}»`);
const chainIds = [...new Set(chainBlock.match(/T-\d+\.\d+\.\d+/g) || [])];
if (chainBlock && chainIds.length === 0)
  err(`критическая цепь не ссылается ни на одну задачу: звено без T-… нечем проверить`);
if (chainIds.length === 1)
  warn('в критической цепи одно звено — цепь из одного звена обычно означает, что она не построена');
for (const id of chainIds) {
  if (!tasks.has(id)) { err(`критическая цепь ссылается на несуществующую ${id}`); continue; }
  const cls = classOf(tasks.get(id));
  if (cls !== 'outcome') err(`${id} (${cls}) стоит на критической цепи — там только outcome`);
}

/* ── 5. обязательные разделы плана ───────────────────────────────── */
if (!new RegExp(WORDS.bottleneck).test(text)) err(`в плане нет раздела «${WORDS.bottleneck}»`);
if (!/⛔/.test(text)) warn('узкое место не помечено значком ⛔ — его трудно найти глазами');
if (!new RegExp(WORDS.buffer).test(text) || !new RegExp(WORDS.rope).test(text))
  err(`нет «${WORDS.buffer}» и/или «${WORDS.rope}» в критической цепи`);
if (!new RegExp(`## ${WORDS.outcomeHeading}`).test(text))
  err(`нет раздела «${WORDS.outcomeHeading}»`);

/* ── 6. R3: числа без ссылки на замер ────────────────────────────── */
const R3_FIELDS = [KEYS.soThat, KEYS.when, KEYS.wants, KEYS.dod, KEYS.runtime];
for (const [id, t] of tasks) {
  for (const f of R3_FIELDS) {
    const v = t.fields[f];
    if (!v) continue;
    const stripped = v.replace(/T-\d+\.\d+\.\d+|A\d|M-\d+\.\d+|B-\d+/g, '');
    if (/\d/.test(stripped) && !WORDS.measure.test(v))
      warn(`${id}.${f}: число без ссылки на замер (R3) — «${v.slice(0, 70)}»`);
  }
}

/* ── 7. ИЛИ-запрет ───────────────────────────────────────────────── */
for (const [id, t] of tasks)
  if (WORDS.or.test(t.fields[KEYS.soThat]))
    warn(`${id}.${KEYS.soThat}: союз «или» — вероятно две задачи`);

/* ── отчёт ───────────────────────────────────────────────────────── */
const byClass = {};
for (const t of tasks.values()) {
  const c = classOf(t) || '∅';
  byClass[c] = (byClass[c] ?? 0) + 1;
}
const alarms = [...tasks].filter(([, t]) => t.fields[KEYS.marks] === WORDS.alarm).map(([id]) => id);
console.log(`plan-lint · ${FILE}`);
console.log('─'.repeat(56));
console.log(`Big ${bigs.length} · Medium ${mediums.length} · Small ${tasks.size}`);
console.log(`классы: ${Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`);
console.log(`на критической цепи: ${chainIds.length}`);
console.log(`${WORDS.alarm}: ${alarms.length ? alarms.join(', ') : 'нет'}`);
console.log('─'.repeat(56));
for (const w of warns) console.log(`  ⚠️  ${w}`);
for (const e of errors) console.log(`  ❌  ${e}`);
console.log('─'.repeat(56));
console.log(errors.length
  ? `НЕ СДАН: ошибок ${errors.length}, предупреждений ${warns.length}`
  : `ЗЕЛЁНЫЙ: ошибок 0, предупреждений ${warns.length}`);
process.exit(errors.length ? 1 : 0);
