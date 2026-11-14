#!/usr/bin/env node
/**
 * Проверка словаря на дубликаты и структурные проблемы.
 *
 * Запуск из папки pages:
 *     node check-vocab.mjs
 *
 * Ничего не устанавливает, ничего не меняет. Только читает lv-data*.json.
 * Код возврата 1, если найдены ошибки (удобно для git pre-commit).
 */

import {chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE_RE = /^lv-data(-\d+)?\.json$/;
const LATVIAN_CHARS = /[āčēģīķļņšūž]/i;

// --- Установка git-хука ---------------------------------------------------
if (process.argv.includes('--install-hook')) {
    const hookSource = join(HERE, 'check-vocab-hook.sh');
    if (!existsSync(hookSource)) {
        console.error(`Не найден ${hookSource}`);
        process.exit(1);
    }

    let gitDir;
    try {
        gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {cwd: HERE, encoding: 'utf8'}).trim();
    } catch {
        console.error('Не git-репозиторий — хук установить нельзя.');
        process.exit(1);
    }

    // rev-parse может вернуть относительный путь (от корня репо) или абсолютный.
    const hooksDir = join(HERE, gitDir, 'hooks');
    mkdirSync(hooksDir, {recursive: true});
    const target = join(hooksDir, 'pre-commit');

    if (existsSync(target) && !readFileSync(target, 'utf8').includes('check-vocab')) {
        console.error(`Уже существует чужой pre-commit: ${target}\nУдалите или объедините его вручную.`);
        process.exit(1);
    }

    copyFileSync(hookSource, target);
    try {
        chmodSync(target, 0o755);
    } catch {
        // на Windows chmod может быть no-op — git всё равно запустит файл через sh
    }

    console.log(`✓ Установлен pre-commit хук: ${target}`);
    console.log('  Проверка запускается только если в коммит попадают lv-data*.json.');
    console.log('  Обход: git commit --no-verify');
    process.exit(0);
}

const files = readdirSync(HERE)
    .filter(f => FILE_RE.test(f))
    .sort((a, b) => {
        // lv-data.json идёт первым, затем по номеру
        const num = f => (f === 'lv-data.json' ? 0 : Number(f.match(/-(\d+)\.json$/)[1]));
        return num(a) - num(b);
    });

// --- 1. Непрерывность нумерации: страница грузит до первого пропуска ---
const numbered = files
    .filter(f => f !== 'lv-data.json')
    .map(f => Number(f.match(/-(\d+)\.json$/)[1]));

const numberingProblems = [];
if (!files.includes('lv-data.json')) {
    numberingProblems.push('отсутствует обязательный lv-data.json');
}
if (numbered.length) {
    const max = Math.max(...numbered);
    for (let i = 1; i <= max; i++) {
        if (!numbered.includes(i)) {
            numberingProblems.push(`пропущен lv-data-${i}.json — файлы с номером > ${i} НЕ загрузятся`);
        }
    }
}

// --- 2. Сбор слов ---
/**
 * Приводит слово к сопоставимой форме: нижний регистр, без пунктуации.
 * Диакритика СОХРАНЯЕТСЯ: латышский различает ņ/n, š/s, ž/z (viņam ≠ viņām).
 */
function normalize(word) {
    return String(word)
        .toLowerCase()
        .replace(/[^\p{L}\p{M}]/gu, ' ')   // всё, кроме букв и диакритики, → пробел
        .trim()
        .replace(/\s+/g, ' ');
}

/** Грубая основа: мн.ч. и падежные окончания сводятся к одной форме. */
function stems(normalized) {
    return normalized
        .split(' ')
        .map(stemWord)
        .filter(Boolean);
}

function stemWord(word) {
    if (word.length <= 4) return word;
    // длинные окончания — первыми
    const suffixes = [
        'ajiem', 'ajam', 'ajās', 'ajos', 'ajai', 'ajā', 'ās', 'ām', 'ai', 'us', 'as', 'es', 'is',
        'iem', 'īm', 'ēm', 'u', 'a', 'i', 'e', 's', 'ā', 'ē', 'ī', 'o', 'ū'
    ];
    for (const suf of suffixes) {
        if (word.endsWith(suf) && word.length - suf.length >= 3) {
            return word.slice(0, -suf.length);
        }
    }
    return word;
}

const entries = []; // { file, category, word, translation, type, raw }
const seenCategories = new Map(); // name -> Set(files)
const categoryIcons = new Map();  // name -> Map(icon -> file)
const structureProblems = [];

for (const file of files) {
    let data;
    try {
        data = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
    } catch (e) {
        structureProblems.push(`${file}: невалидный JSON — ${e.message}`);
        continue;
    }
    if (!Array.isArray(data.categories)) {
        // файл схемы и прочие не-данные просто пропускаем молча
        if (data.categories === undefined) continue;
        structureProblems.push(`${file}: categories должен быть массивом`);
        continue;
    }

    for (const cat of data.categories) {
        const name = cat.name || '(без name)';
        if (!seenCategories.has(name)) seenCategories.set(name, new Set());
        seenCategories.get(name).add(file);

        if (cat.icon) {
            if (!categoryIcons.has(name)) categoryIcons.set(name, new Map());
            const byIcon = categoryIcons.get(name);
            if (!byIcon.has(cat.icon)) byIcon.set(cat.icon, new Set());
            byIcon.get(cat.icon).add(file);
        }

        for (const item of cat.items || []) {
            if (cat.type === 'antonyms') {
                for (const suffix of ['a', 'b']) {
                    const word = item[`word_${suffix}`];
                    if (!word) {
                        structureProblems.push(`${file} / ${name}: у элемента-антонима нет word_${suffix}`);
                        continue;
                    }
                    if (!LATVIAN_CHARS.test(word) && /[а-яё]/i.test(word)) {
                        structureProblems.push(`${file} / ${name}: кириллица в латышском слове «${word}»`);
                    }
                    entries.push({
                        file,
                        category: name,
                        word,
                        translation: item[`translation_${suffix}`] || '',
                        type: 'antonyms'
                    });
                }
            } else {
                if (!item.word) {
                    structureProblems.push(`${file} / ${name}: элемент без поля word`);
                    continue;
                }
                if (/[а-яё]/i.test(item.word)) {
                    structureProblems.push(`${file} / ${name}: кириллица в латышском слове «${item.word}»`);
                }
                entries.push({
                    file,
                    category: name,
                    word: item.word,
                    translation: item.translation || '',
                    type: 'standard'
                });
            }
        }
    }
}

// --- 3. Дубликаты ---
// Слова могут содержать варианты через " / " — сравниваем каждый отдельно.
function variants(word) {
    return String(word)
        .split('/')
        .map(part => normalize(part))
        .filter(Boolean);
}

const exact = new Map();  // normalized -> entries[]
const byStem = new Map(); // stem -> entries[]

for (const entry of entries) {
    const seenVariants = new Set();
    for (const v of variants(entry.word)) {
        if (seenVariants.has(v)) continue; // «viņam patīk / viņam ir» — не дубликат сам с собой
        seenVariants.add(v);

        if (!exact.has(v)) exact.set(v, []);
        exact.get(v).push(entry);

        const s = stems(v).join(' ');
        if (!byStem.has(s)) byStem.set(s, []);
        byStem.get(s).push(entry);
    }
}

const keyOf = e => `${e.file}|${e.category}|${e.word}`;
const dedupe = list => [...new Map(list.map(e => [keyOf(e), e])).values()];

const exactDupes = [];
const reportedExact = new Set();
for (const [key, list] of exact) {
    const unique = dedupe(list);
    if (unique.length < 2) continue;
    const sig = unique.map(keyOf).sort().join('||');
    if (reportedExact.has(sig)) continue;
    reportedExact.add(sig);
    exactDupes.push({key, list: unique});
}

// Нечёткие: одинаковые основы, но разные написания (siers/siera).
// Стребуем, чтобы основы были содержательными (>= 4 символов) — иначе «kam»/~«kāmis» даёт шум.
const stemDupes = [];
const reported = new Set();
for (const [key, list] of byStem) {
    if (key.length < 4) continue;
    const unique = dedupe(list);
    const words = [...new Set(unique.map(e => e.word.toLowerCase()))];
    if (words.length < 2) continue;
    const sig = words.slice().sort().join('|');
    if (reported.has(sig)) continue;
    reported.add(sig);
    stemDupes.push({key, list: unique, words});
}

// --- 4. Отчёт ---
const RED = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

let problems = 0;

const totalWords = entries.length;
console.log(`\nФайлы: ${files.join(', ')}`);
console.log(`Категорий: ${seenCategories.size}, слов: ${totalWords}\n`);

if (structureProblems.length || numberingProblems.length) {
    console.log(RED('ОШИБКИ СТРУКТУРЫ'));
    for (const p of [...numberingProblems, ...structureProblems]) console.log(`  ✗ ${p}`);
    problems += numberingProblems.length + structureProblems.length;
    console.log('');
}

if (exactDupes.length) {
    console.log(RED(`ТОЧНЫЕ ДУБЛИКАТЫ: ${exactDupes.length}`));
    for (const {list} of exactDupes) {
        console.log(`  ✗ ${list[0].word}`);
        for (const e of list) {
            console.log(DIM(`      ${e.file} · ${e.category} · ${e.translation}`));
        }
    }
    problems += exactDupes.length;
    console.log('');
}

if (stemDupes.length) {
    console.log(YELLOW(`ВОЗМОЖНЫЕ ДУБЛИКАТЫ (общая основа): ${stemDupes.length}`));
    for (const {list, words} of stemDupes) {
        console.log(`  ? ${words.join(' / ')}`);
        for (const e of list) {
            console.log(DIM(`      ${e.file} · ${e.category} · ${e.translation}`));
        }
    }
    console.log(DIM('    (это могут быть разные формы одного слова — проверьте вручную)\n'));
}

// Разные иконки у одной категории — визуальная несогласованность
for (const [name, byIcon] of categoryIcons) {
    if (byIcon.size > 1) {
        console.log(YELLOW(`РАЗНЫЕ ИКОНКИ КАТЕГОРИИ «${name}»`));
        for (const [icon, fl] of byIcon) console.log(DIM(`      ${icon}: ${[...fl].join(', ')}`));
        console.log('');
    }
}

if (problems === 0 && !stemDupes.length) {
    console.log(GREEN(`✓ Дубликатов не найдено. Слов: ${totalWords}.`));
} else if (problems === 0) {
    console.log(YELLOW(`Точных дубликатов нет, но есть ${stemDupes.length} совпадений по основе.`));
}

process.exit(problems > 0 ? 1 : 0);
