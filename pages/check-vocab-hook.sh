#!/bin/sh
# Pre-commit: проверка словаря на дубликаты и битую нумерацию.
# Устанавливается командой: node pages/check-vocab.mjs --install-hook
# Запускается из корня репозитория силами git.

set -e

# Где лежит check-vocab.mjs — относительно корня репозитория.
CHECKER=""
for candidate in "pages/check-vocab.mjs" "check-vocab.mjs"; do
    if [ -f "$candidate" ]; then
        CHECKER="$candidate"
        break
    fi
done

if [ -z "$CHECKER" ]; then
    echo "pre-commit: не найден check-vocab.mjs — пропускаю проверку словаря." >&2
    exit 0
fi

# Проверяем только если в коммит попадают файлы данных словаря.
STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
if ! echo "$STAGED" | grep -qE '(^|/)lv-data(-[0-9]+)?\.json$'; then
    exit 0
fi

echo "pre-commit: проверяю словарь на дубликаты..."

if command -v node >/dev/null 2>&1; then
    NODE=node
elif command -v node.exe >/dev/null 2>&1; then
    NODE=node.exe
else
    echo "pre-commit: node не найден — пропускаю проверку словаря." >&2
    exit 0
fi

if ! "$NODE" "$CHECKER"; then
    cat >&2 <<'EOF'

pre-commit: коммит отменён из-за ошибок в словаре (см. вывод выше).
Исправьте дубликаты / нумерацию. Обойти проверку: git commit --no-verify
EOF
    exit 1
fi

exit 0
