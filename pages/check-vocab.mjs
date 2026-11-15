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

// --- 2. Загрузка данных ---
const docs = [];
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
        structureProblems.push(`${file}: categories должен быть массивом`);
        continue;
    }
    docs.push({file, data});
}

// --- 3. Сбор слов ---
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

// Категория может быть ГРУППОЙ подкатегорий: тогда в её `items` лежат не слова,
// а карточки-категории (у каждой свой name и свой массив items).
// Проверка однородная: ВСЕ элементы — объекты с массивом items → группа.
const isGroupCategory = cat => (cat.items || []).length > 0
    && cat.items.every(it => it && typeof it === 'object' && Array.isArray(it.items));

// --- 3a. Слияние дерева (те же правила, что на странице) ---
// Узел: { name, icon, type, items: [{...слово, _file}], subs: [узел] }

/** Иконка, заданная раньше, побеждает (как card_title/description в DATA_FORMAT §2). */
function takeMeta(target, source) {
    if (!target.icon && source.icon) target.icon = source.icon;
    if (!target.type && source.type) target.type = source.type;
    if (!target.card_title && source.card_title) target.card_title = source.card_title;
    if (!target.description && source.description) target.description = source.description;
}

/** Дописывает слова и метаданные в существующий узел. */
function mergeInto(target, node) {
    target.items.push(...node.items);
    takeMeta(target, node);
}

/** Слияние групп: дочерние узлы сводятся по name, новые встают на место вставки. */
function mergeGroup(target, node) {
    takeMeta(target, node);
    node.subs.forEach((sub, i) => {
        const existing = target.subs.find(s => s.name === sub.name);
        if (existing) {
            mergeInto(existing, sub);
            return;
        }
        // новая подкатегория встаёт сразу после той, что шла перед ней в файле
        const prevNames = node.subs.slice(0, i).map(s => s.name);
        let at = 0;
        for (let p = prevNames.length - 1; p >= 0; p--) {
            const idx = target.subs.findIndex(s => s.name === prevNames[p]);
            if (idx >= 0) {
                at = idx + 1;
                break;
            }
        }
        target.subs.splice(at, 0, sub);
    });
}

const mergedTree = [];
for (const {file, data} of docs) {
    for (const cat of data.categories) {
        if (!cat.name) {
            structureProblems.push(`${file}: категория без поля name`);
            continue;
        }

        const node = {
            name: cat.name,
            icon: cat.icon,
            type: cat.type,
            card_title: cat.card_title,
            description: cat.description,
            items: [],
            subs: []
        };
        if (isGroupCategory(cat)) {
            node.subs = cat.items.map(sub => ({
                name: sub.name || '(без name)',
                icon: sub.icon,
                type: sub.type,
                card_title: sub.card_title,
                description: sub.description,
                items: (sub.items || []).map(item => ({...item, _file: file})),
                subs: []
            }));
        } else {
            node.items = cat.items.map(item => ({...item, _file: file}));
        }

        const target = mergedTree.find(c => c.name === cat.name);
        if (!target) {
            mergedTree.push(node);
        } else if (target.subs.length || node.subs.length) {
            if (target.items.length || node.items.length) {
                structureProblems.push(`${file} / ${cat.name}: группа подкатегорий и обычные слова в одной категории`);
                target.items.push(...node.items);
            }
            mergeGroup(target, node);
        } else {
            mergeInto(target, node);
        }
    }
}

/** Карточка = обычная категория или подкатегория внутри группы. */
const cards = [];
for (const cat of mergedTree) {
    if (cat.subs.length) {
        for (const sub of cat.subs) cards.push({...sub, label: `${cat.name} / ${sub.name}`});
    } else {
        cards.push({...cat, label: cat.name});
    }
}

// --- 3b. Слова из итогового дерева (уже с учётом слияния) ---
const entries = []; // { file, category, word, translation, type }
for (const card of cards) {
    const label = card.label;
    for (const item of card.items) {
        const file = item._file || '(слито)';
        if (card.type === 'antonyms') {
            for (const suffix of ['a', 'b']) {
                const word = item[`word_${suffix}`];
                if (!word) {
                    structureProblems.push(`${file} / ${label}: у элемента-антонима нет word_${suffix}`);
                    continue;
                }
                if (/[а-яё]/i.test(word)) {
                    structureProblems.push(`${file} / ${label}: кириллица в латышском слове «${word}»`);
                }
                entries.push({
                    file,
                    category: label,
                    word,
                    translation: item[`translation_${suffix}`] || '',
                    type: 'antonyms'
                });
            }
            continue;
        }
        if (!item.word) {
            structureProblems.push(`${file} / ${label}: элемент без поля word`);
            continue;
        }
        if (/[а-яё]/i.test(item.word)) {
            structureProblems.push(`${file} / ${label}: кириллица в латышском слове «${item.word}»`);
        }
        entries.push({file, category: label, word: item.word, translation: item.translation || '', type: 'standard'});
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
const groupCount = mergedTree.filter(c => c.subs.length).length;
console.log(`\nФайлы: ${files.join(', ')}`);
console.log(`Категорий: ${mergedTree.length} (из них групп: ${groupCount}), карточек: ${cards.length}, слов: ${totalWords}\n`);

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

// Разные иконки внутри одного файла — визуальная несогласованность вкладки.
// Для группы проверяется и сама вкладка, и каждая подкатегория.
const iconTargets = cards;
for (const card of iconTargets) {
    const iconsByFile = new Map();
    for (const item of card.items) {
        const file = item._file || '(слито)';
        if (!iconsByFile.has(file)) iconsByFile.set(file, new Set());
        iconsByFile.get(file).add(card.icon || '');
    }
    const differing = [...iconsByFile].filter(([, set]) => set.size > 1);
    if (differing.length) {
        console.log(YELLOW(`РАЗНЫЕ ИКОНКИ КАТЕГОРИИ «${card.name}»`));
        for (const [file, set] of differing) console.log(DIM(`      ${file}: ${[...set].map(i => i || '(нет)').join(', ')}`));
        console.log('');
    }
}

if (problems === 0 && !stemDupes.length) {
    console.log(GREEN(`✓ Дубликатов не найдено. Слов: ${totalWords}.`));
} else if (problems === 0) {
    console.log(YELLOW(`Точных дубликатов нет, но есть ${stemDupes.length} совпадений по основе.`));
}

process.exit(problems > 0 ? 1 : 0);
