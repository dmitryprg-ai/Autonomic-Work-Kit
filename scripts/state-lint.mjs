#!/usr/bin/env node
/*
 * Copyright © 2026 Dmitry Batulin — https://github.com/dmitryprg-ai/Autonomic-Work-Kit
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Некоммерческое использование при указании авторства. Коммерческое —
 * только по письменному разрешению: dmitryprg@gmail.com. См. LICENSE.
 */
/**
 * state-lint — механическая проверка последнего среза STATE.md.
 * Без зависимостей. Требуется Node ≥ 18.
 * Запуск: node scripts/state-lint.mjs [STATE.md]
 * Код возврата: 0 — срез оформлен, 1 — есть ошибки.
 *
 * Что проверяет: девять обязательных пунктов среза (loop-protocol §9),
 * наличие блока Diff, отсутствие ✅ без runtime evidence и в срезе,
 * и в таблице статуса для владельца. Содержательную верность доказательств
 * машина не проверяет — это работа верификатора.
 *
 * ЯЗЫК. Метки ниже — фиксированная схема. Перевод схемы = правка KEYS
 * здесь и templates/STATE.md одновременно.
 */
import { readFileSync } from 'node:fs';

const KEYS = {
  iteration: 'Итерация',
  announce: 'Announce',
  red: 'Красная фаза',
  done: 'Сделано',
  check: 'Проверка',
  runtime: 'Runtime evidence',
  verdict: 'Вердикт verifier',
  artifacts: 'Реализующие элементы',
  changeRef: 'Ссылка на изменение',
  state: 'Состояние',
  next: 'Следующее',
  diff: 'Diff vs предыдущий срез',
};
const REQUIRED = [
  KEYS.announce, KEYS.red, KEYS.done, KEYS.check, KEYS.runtime,
  KEYS.verdict, KEYS.artifacts, KEYS.changeRef, KEYS.state, KEYS.next,
];
const NA = /^\s*(н\/д|н\/п|н\.д\.|—|-)\s*($|[,.;:—-])/i;
const PLACEHOLDER = /[‹›]|<[^>]{2,}>|\bTODO\b|\bTBD\b/;
const STATES = ['PERSIST', 'EXECUTION', 'BLOCKED', 'CLOSE', 'REWORK'];

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const FILE = process.argv[2] ?? 'STATE.md';
let text;
try { text = readFileSync(FILE, 'utf8'); }
catch { console.error(`не читается: ${FILE}`); process.exit(1); }

/* ── срезы итераций ──────────────────────────────────────────────── */
const slices = [...text.matchAll(new RegExp(`^## ${KEYS.iteration} (.+)$`, 'gm'))];
if (slices.length === 0) {
  console.error(`в ${FILE} нет ни одного среза «## ${KEYS.iteration} …» — итерация без записи считается несостоявшейся`);
  process.exit(1);
}
const last = slices[slices.length - 1];
const from = last.index;
const rest = text.slice(from + 1);
const nextTop = rest.search(/^## /m);
const block = nextTop === -1 ? text.slice(from) : text.slice(from, from + 1 + nextTop);
const title = last[1].trim();

const field = (name) => {
  const m = block.match(new RegExp(`^- ${name}:[ \t]*(.*)$`, 'm'));
  return m === null ? null : m[1].trim();
};

/* ── 1. девять обязательных пунктов ──────────────────────────────── */
for (const f of REQUIRED) {
  const v = field(f);
  if (v === null) err(`срез «${title}»: нет пункта «${f}»`);
  else if (!v) err(`срез «${title}»: пункт «${f}» пуст`);
  else if (PLACEHOLDER.test(v)) err(`срез «${title}».${f}: незаполненный плейсхолдер`);
}

/* ── 2. блок Diff ────────────────────────────────────────────────── */
if (!new RegExp(`#{2,3} ${KEYS.diff}`).test(block))
  err(`срез «${title}»: нет блока «${KEYS.diff}»`);

/* ── 3. проверка: команда и её реальный вывод, а не «прошло» ─────── */
const check = field(KEYS.check) ?? '';
if (check && !/→|->/.test(check))
  err(`срез «${title}».${KEYS.check}: нет пары «команда → вывод» (нужен реальный вывод, не «прошло успешно»)`);
if (/^(прошл|успешн|всё ок|ok\b|зелён)/i.test(check.replace(/.*(→|->)\s*/, '')))
  warn(`срез «${title}».${KEYS.check}: вывод выглядит как пересказ, а не как вывод команды`);

/* ── 4. ✅ без runtime evidence ──────────────────────────────────── */
const verdict = field(KEYS.verdict) ?? '';
const runtime = field(KEYS.runtime) ?? '';
const verdictOk = verdict.startsWith('✅');
if (verdictOk && (!runtime || NA.test(runtime)))
  err(`срез «${title}»: вердикт ✅ при пустом Runtime evidence — запрещено протоколом (инвариант 2)`);
if (verdict && !/^[✅⚠️❌⚪]/.test(verdict) && !NA.test(verdict))
  err(`срез «${title}».${KEYS.verdict}: вердикт должен начинаться с ✅/⚠️/❌/⚪`);

/* ── 5. красная фаза: вывод падения либо явное «н/д, класс …» ────── */
const red = field(KEYS.red) ?? '';
if (red && NA.test(red) && !/класс/i.test(red))
  err(`срез «${title}».${KEYS.red}: «н/д» без указания класса задачи — отсутствие красной фазы должно быть решением, а не забывчивостью`);

/* ── 6. состояние ────────────────────────────────────────────────── */
const state = field(KEYS.state) ?? '';
const stateWord = state.split(/[\s(—-]/)[0];
if (stateWord && !STATES.includes(stateWord))
  err(`срез «${title}».${KEYS.state}: «${stateWord}» вне ${STATES.join('/')}`);

/* ── 7. таблица статуса для владельца: ✅ без доказательства ─────── */
const rows = [...text.matchAll(/^\|(?!\s*[-:| ]+\|)\s*(T-\d+\.\d+\.\d+[^|]*)\|([^\n]*)$/gm)];
for (const r of rows) {
  const cells = r[2].split('|').map((c) => c.trim());
  if (cells.length < 5) continue;
  const [, status, , proof] = cells;          // выгода · статус · что сделано · доказательство
  if (status?.startsWith('✅') && (!proof || proof === '—' || PLACEHOLDER.test(proof)))
    err(`таблица владельца, ${r[1].trim().split('—')[0].trim()}: ✅ без доказательства`);
}

/* ── 8. обязательные разделы журнала ─────────────────────────────── */
for (const h of ['DECISIONS', 'BLOCKERS', 'FOLLOW-UPS'])
  if (!new RegExp(`^## ${h}`, 'm').test(text)) warn(`нет раздела «${h}»`);

/* ── отчёт ───────────────────────────────────────────────────────── */
console.log(`state-lint · ${FILE}`);
console.log('─'.repeat(56));
console.log(`срезов: ${slices.length} · последний: ${title}`);
console.log(`вердикт последнего среза: ${verdict || '—'}`);
console.log('─'.repeat(56));
for (const w of warns) console.log(`  ⚠️  ${w}`);
for (const e of errors) console.log(`  ❌  ${e}`);
console.log('─'.repeat(56));
console.log(errors.length
  ? `НЕ СДАН: ошибок ${errors.length}, предупреждений ${warns.length}`
  : `ЗЕЛЁНЫЙ: ошибок 0, предупреждений ${warns.length}`);
process.exit(errors.length ? 1 : 0);
