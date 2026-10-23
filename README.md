# Lampa Remote

Управление Lampa на Android TV из терминала, в том числе для LLM-агентов:
читать экран как JSON, выбирать элементы, менять настройки и вводить текст.
CLI и мост работают на компьютере, JS-плагин — внутри Lampa; связь идёт через ADB reverse.

## Чтение UI занимает около 0,2 секунды

Медианы на одном TV и одной панели "Интерфейс", версия 0.2.0:

| Способ | Время | Выборка |
|---|---:|---:|
| UIAutomator через ADB, XML | 2 801 мс | 3 |
| Lampa Remote CLI, работающий мост, JSON | 199 мс | 10 |
| Lampa Remote CLI, запуск моста по требованию | 508 мс | 3 |
| Прямой RPC работающего моста, без запуска CLI | 68 мс | 15 |

CLI в этом замере быстрее UIAutomator примерно в 14 раз.
[Исходные замеры](docs/benchmark.json); скриншоты и OCR не измерялись.

## Установите CLI и плагин

Нужны Node.js 22+, npm, ADB и авторизованный TV с ADB-отладкой.
На компьютере с доступом к TV выполните:

```sh
git clone https://github.com/krajcik/lampa-remote.git
cd lampa-remote
npm ci
npm run build
adb devices -l
node dist/cli.js start SERIAL
node dist/cli.js install-url
```

Замените `SERIAL` идентификатором TV из `adb devices -l`.
Добавьте `data.url` из JSON команды `install-url` в Lampa:
"Настройки" → "Расширения" → "Добавить плагин".
Это публичная ссылка на самостоятельный JS-плагин с GitHub Pages.
Токен и loader не нужны. Плагин загружается при старте Lampa и ждёт служебную клавишу CLI;
мост в это время может быть выключен. Для первой загрузки нужен доступ к GitHub.

Перезапустите Lampa и проверьте подключение:

```sh
node dist/cli.js app restart
node dist/cli.js status
node dist/cli.js doctor
```

Успех: `status` возвращает `appready: true`, `doctor` — `ready: true`.
Конфиг — `.local/config.json`: `serial`, порт, тайм-ауты; после правки выполните `stop`/`start`.
После смены port, browserWakeCode или wakeTimeoutMs повторите `install-url` и замените URL на TV.
При нескольких ADB-устройствах сохраните выбранный `serial` в конфиге.

## Управляйте через команды или скилл

```sh
node dist/cli.js ui
node dist/cli.js settings open interface
node dist/cli.js settings set background false
node dist/cli.js wait --setting background --value false --timeout 3000
node dist/cli.js key back
node dist/cli.js --help
```

Выбор элемента — `action --text 'Подпись'` или `action --key KEY`; ввод в открытое поле — `input 'Текст'`.
Успех — JSON в stdout, ошибка — JSON в stderr.
Обычные команды не открывают Lampa: для этого есть `app start|stop|restart`.
Мост запускается по требованию, выключается через 60 минут простоя или по `stop`.
Плагин в простое не опрашивает компьютер; `doctor` пассивен.
Мост слушает только `127.0.0.1`, HTTP-запросы браузеров блокируются, WebSocket допускает
только настроенный `appOrigin` (по умолчанию `http://lampa.mx`). Авторизации токеном нет:
доступны локальные процессы Mac и TV через ADB reverse; в LAN мост не публикуется.

Поставляемый [скилл lampa-remote](skills/lampa-remote/SKILL.md) содержит установку, команды и диагностику.
Для Codex скопируйте `skills/lampa-remote` в `.agents/skills/` нужного проекта;
в новой сессии вызовите `$lampa-remote`.

## Проверено на Philips с Android 12

Philips Google TV TA1, Android 12, Lampa 3.3.8 (`ru.twicker.lampa`), ADB по LAN;
macOS arm64 / Node.js 26. Проверены навигация, Unicode-ввод, настройки, заставка и переподключение.
Автотесты проверяются в CI на Ubuntu / Node.js 22; основные команды проверены также на Linux arm64.
Windows не проверен.
Внешний нативный плеер в возможности плагина не входит.

Правила разработки — в [AGENTS.md](AGENTS.md). Лицензия — [MIT](LICENSE).
