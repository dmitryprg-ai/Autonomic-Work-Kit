#!/usr/bin/env node
/*
 * Copyright © 2026 Dmitry Batulin — https://github.com/dmitryprg-ai/Autonomic-Work-Kit
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Некоммерческое использование при указании авторства. Коммерческое —
 * только по письменному разрешению: dmitryprg@gmail.com. См. LICENSE.
 */
/**
 * lint-selftest — проверка самих линтеров мутационными тестами.
 * Без зависимостей. Требуется Node ≥ 18.
 * Запуск из корня кита: node scripts/lint-selftest.mjs
 * Код возврата: 0 — все мутанты пойманы, 1 — линтер что-то пропускает.
 *
 * Зачем. Линтер, который никто не ломал, обычно зелёный не потому, что
 * файл верен, а потому, что проверка не срабатывает. Здесь в заведомо
 * корректные примеры вносится по одной поломке, и каждая обязана быть
 * поймана. Первая версия этого набора нашла два настоящих дефекта:
 * жадный `\s*` в разборе поля, из-за которого пустое поле подменялось
 * содержимым соседней строки, и `\b` после кириллицы, из-за которого
 * не срабатывала проверка «н/д без класса».
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lint-selftest-'));
const PLAN = 'examples/PLAN.example.md';
const STATE = 'examples/STATE.example.md';

let plan, state;
try {
  plan = readFileSync(PLAN, 'utf8');
  state = readFileSync(STATE, 'utf8');
} catch {
  console.error('запускать из корня кита: не найдены examples/PLAN.example.md и examples/STATE.example.md');
  process.exit(1);
}

const run = (linter, file) =>
  spawnSync(process.execPath, [`scripts/${linter}.mjs`, file], { encoding: 'utf8' });

const chain = plan.match(/## Критическая цепь[\s\S]*?(?=\n## )/)?.[0] ?? '';
const firstRuntime = (txt, val) => txt.replace(/- Runtime evidence: .*/, `- Runtime evidence: ${val}`);

/* мутанты: [имя, линтер, испорченный текст, ожидание] — expect: 'fail' | 'pass' */
const CASES = [
  // ── plan-lint ────────────────────────────────────────────────────
  ['план без поломок', 'plan-lint', plan, 'pass'],
  ['метка вне списка', 'plan-lint', plan.replace('- Метки: —', '- Метки: срочно'), 'fail'],
  ['состояние BLOCKED легально', 'plan-lint', plan.replace('- Состояние: PERSIST', '- Состояние: BLOCKED'), 'pass'],
  ['chore на критической цепи', 'plan-lint',
    plan.replace(/(#### T-1\.1\.1 —[^\n]*\n- Класс: )outcome/, '$1chore'), 'fail'],
  ['два родителя', 'plan-lint',
    plan.replace('- Зависит от: — | родитель: M-1.1', '- Зависит от: — | родитель: M-1.1 родитель: M-3.1'), 'fail'],
  ['пустое Runtime evidence', 'plan-lint', firstRuntime(plan, ''), 'fail'],
  ['«н/д» в Runtime evidence у outcome', 'plan-lint', firstRuntime(plan, 'н/д'), 'fail'],
  ['цепь без T-ID', 'plan-lint',
    plan.replace(chain, chain.replace(/\s*\(T-[\d., T-]+\)/g, '')), 'fail'],
  ['цепь в конце файла + chore на ней', 'plan-lint',
    plan.replace(chain, '').replace(/(#### T-1\.1\.1 —[^\n]*\n- Класс: )outcome/, '$1chore') + '\n' + chain, 'fail'],
  ['зависимость от несуществующей задачи', 'plan-lint',
    plan.replace('- Зависит от: — | родитель: M-1.1', '- Зависит от: T-9.9.9 | родитель: M-1.1'), 'fail'],

  // ── state-lint ───────────────────────────────────────────────────
  ['журнал без поломок', 'state-lint', state, 'pass'],
  ['✅ при пустом Runtime evidence', 'state-lint', firstRuntime(state, ''), 'fail'],
  ['✅ при «н/д» в Runtime evidence', 'state-lint', firstRuntime(state, 'н/д'), 'fail'],
  ['нет пункта «Ссылка на изменение»', 'state-lint', state.replace(/- Ссылка на изменение: .*\n/, ''), 'fail'],
  ['✅ без доказательства в таблице владельца', 'state-lint',
    state.replace(/(\| ✅ \| [^|]*\| )[^|]*(\|)/, '$1— $2'), 'fail'],
  ['проверка пересказана, а не показана', 'state-lint',
    state.replace(/- Проверка: .*/, '- Проверка: прогнал тесты импорта, прошло успешно'), 'fail'],
  ['нет блока Diff', 'state-lint', state.replace('### Diff vs предыдущий срез', '### Что поменялось'), 'fail'],
  ['«н/д» в красной фазе без класса', 'state-lint',
    state.replace(/- Красная фаза: .*/, '- Красная фаза: н/д'), 'fail'],
  ['«н/д, класс chore» в красной фазе легально', 'state-lint',
    state.replace(/- Красная фаза: .*/, '- Красная фаза: н/д, класс chore'), 'pass'],
];

let failed = 0;
console.log('lint-selftest');
console.log('─'.repeat(64));
CASES.forEach(([name, linter, text, expect], i) => {
  const file = join(dir, `case-${i}.md`);
  writeFileSync(file, text, 'utf8');
  const r = run(linter, file);
  if (r.error || r.status === null || !/plan-lint|state-lint/.test(r.stdout ?? '')) {
    console.log(`  ✗   ${linter.padEnd(10)} ${name}  линтер не запустился: ${r.stderr?.trim().split('\n')[0] ?? r.error?.message ?? 'нет вывода'}`);
    failed++;
    return;
  }
  const got = r.status === 0 ? 'pass' : 'fail';
  const ok = got === expect;
  if (!ok) failed++;
  const mark = ok ? '  ok  ' : '  ✗   ';
  const note = ok ? '' : `  ожидалось ${expect}, получено ${got}`;
  console.log(`${mark}${linter.padEnd(10)} ${name}${note}`);
});
console.log('─'.repeat(64));
console.log(failed
  ? `ПРОВАЛ: ${failed} из ${CASES.length} — линтер пропускает поломку либо ложно срабатывает`
  : `ЗЕЛЁНЫЙ: ${CASES.length} из ${CASES.length}`);
process.exit(failed ? 1 : 0);
