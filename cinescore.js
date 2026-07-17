/* ==========================================================================
   CineScore — плагин рейтингов для Lampa
   v1.0.0

   Показывает единой строкой рейтинги:
     IMDb · TMDb · Rotten Tomatoes · Metacritic · Кинопоиск

   Принципы:
     - Если источник недоступен/не настроен — показываем "—", а не ошибку
       и не прячем всю строку.
     - Кэш на 24 часа (Lampa.Storage), повторное открытие карточки — мгновенно.
     - TMDb рейтинг берём из уже загруженных Lampa данных (без запроса).
     - IMDb/RT/Metacritic — через OMDb API (один запрос отдаёт все три).
     - Кинопоиск — через kinopoisk.dev по externalId.imdb.

   Установка:
     Настройки Lampa → Расширения → Добавить плагин → указать URL этого файла.

   API-ключи (бесплатные, вводятся в настройках плагина внутри Lampa):
     OMDb:      http://www.omdbapi.com/apikey.aspx
     Kinopoisk: https://kinopoisk.dev
   ========================================================================== */

(function () {
    'use strict';

    var NAME = 'cinescore';
    var CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа
    var REQUEST_TIMEOUT = 8000;

    // -------------------- Хранилище настроек --------------------

    function isOn(key, def) {
        return Lampa.Storage.get(NAME + '_enable_' + key, def === undefined ? true : def);
    }

    function apiKey(name) {
        return (Lampa.Storage.get(NAME + '_' + name + '_key', '') || '').trim();
    }

    // -------------------- Кэш (24ч) --------------------

    function cacheStore() {
        try {
            var raw = Lampa.Storage.get(NAME + '_cache', {});
            if (typeof raw === 'string') raw = JSON.parse(raw || '{}');
            return raw || {};
        } catch (e) {
            return {};
        }
    }

    function cacheSave(store) {
        try {
            Lampa.Storage.set(NAME + '_cache', JSON.stringify(store));
        } catch (e) {}
    }

    function cacheGet(key) {
        var store = cacheStore();
        var entry = store[key];
        if (!entry || !entry.t) return null;
        if (Date.now() - entry.t > CACHE_TTL) return null;
        return entry.d;
    }

    function cacheSet(key, data) {
        var store = cacheStore();
        store[key] = { t: Date.now(), d: data };
        // не даём кэшу расти бесконечно
        var keys = Object.keys(store);
        if (keys.length > 500) {
            keys.sort(function (a, b) { return store[a].t - store[b].t; });
            delete store[keys[0]];
        }
        cacheSave(store);
    }

    // -------------------- Сеть с таймаутом --------------------

    function request(url, headers) {
        return new Promise(function (resolve, reject) {
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (controller) controller.abort();
                reject(new Error('timeout'));
            }, REQUEST_TIMEOUT);

            fetch(url, {
                headers: headers || {},
                signal: controller ? controller.signal : undefined
            }).then(function (res) {
                clearTimeout(timer);
                if (!res.ok) return reject(new Error('http_' + res.status));
                res.json().then(resolve).catch(reject);
            }).catch(function (err) {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    // -------------------- Источники данных --------------------

    // TMDb — уже есть в объекте movie, запрос не нужен
    function getTmdb(movie) {
        if (!movie.vote_average) return null;
        return (Math.round(movie.vote_average * 10) / 10).toFixed(1);
    }

    // OMDb отдаёт разом IMDb, Rotten Tomatoes, Metacritic по imdb_id
    function getOmdb(movie) {
        var key = apiKey('omdb');
        if (!key || !movie.imdb_id) return Promise.resolve({});

        var url = 'https://www.omdbapi.com/?apikey=' + encodeURIComponent(key) +
                   '&i=' + encodeURIComponent(movie.imdb_id);

        return request(url).then(function (data) {
            if (!data || data.Response === 'False') return {};

            var out = {};

            if (data.imdbRating && data.imdbRating !== 'N/A') {
                out.imdb = data.imdbRating;
            }

            (data.Ratings || []).forEach(function (r) {
                if (r.Source === 'Rotten Tomatoes') out.rt = r.Value; // "94%"
                if (r.Source === 'Metacritic') out.mc = (r.Value || '').split('/')[0]; // "81/100" -> "81"
            });

            return out;
        }).catch(function () {
            return {};
        });
    }

    // Кинопоиск — эндпоинт настраиваемый (URL-шаблон с {imdb}), т.к. готовые
    // публичные сервисы (kinopoisk.dev/kinopoiskapiunofficial.tech) обычно
    // завязаны на российскую инфраструктуру и могут быть недоступны без VPN
    // из некоторых стран. Если endpoint не задан в настройках — просто "—".
    function getKinopoisk(movie) {
        var key = apiKey('kp');
        var endpoint = (Lampa.Storage.get(NAME + '_kp_endpoint', '') || '').trim();
        if (!key || !endpoint || !movie.imdb_id) return Promise.resolve({});

        var url = endpoint.replace('{imdb}', encodeURIComponent(movie.imdb_id));

        return request(url, { 'X-API-KEY': key, 'accept': 'application/json' }).then(function (data) {
            // поддерживаем два распространённых формата ответа:
            // { docs: [{ rating: { kp: 8.5 } }] }  или  { rating: { kp: 8.5 } }
            var doc = (data && data.docs && data.docs[0]) || data;
            var rating = doc && doc.rating && doc.rating.kp;
            if (!rating) return {};
            return { kp: (Math.round(rating * 10) / 10).toFixed(1) };
        }).catch(function () {
            return {};
        });
    }

    // -------------------- Вёрстка блока рейтингов --------------------

    function ratingColor(raw, scale) {
        var num = parseFloat(raw);
        if (isNaN(num)) return '';
        var pct = scale === 100 ? num : num * 10; // приводим к шкале 0-100
        if (pct >= 70) return '#4caf50';   // зелёный
        if (pct >= 40) return '#ffc107';   // жёлтый
        return '#f44336';                  // красный
    }

    function badge(label, value) {
        return '<div class="cinescore__item">' +
                   '<div class="cinescore__label">' + label + '</div>' +
                   '<div class="cinescore__value">' + (value || '—') + '</div>' +
               '</div>';
    }

    function buildBlock() {
        var $el = $('<div class="cinescore"></div>');
        if (isOn('imdb')) $el.append(badge('IMDb', null));
        if (isOn('tmdb')) $el.append(badge('TMDb', null));
        if (isOn('rt')) $el.append(badge('RT', null));
        if (isOn('mc')) $el.append(badge('Metacritic', null));
        if (isOn('kp')) $el.append(badge('Кинопоиск', null));
        return $el;
    }

    function setValue($block, key, value) {
        var map = { imdb: 1, tmdb: 2, rt: 3, mc: 4, kp: 5 };
        var scale = { imdb: 10, tmdb: 10, rt: 100, mc: 100, kp: 10 };
        var idx = map[key];
        if (!idx) return;
        var $val = $block.find('.cinescore__item').eq(idx - 1).find('.cinescore__value');
        $val.text(value || '—');
        $val.css('color', value ? ratingColor(value, scale[key]) : '');
    }

    // -------------------- Основная логика на карточке --------------------

    function attach(render, movie) {
        try {
            render.find('.cinescore').remove();

            var $block = buildBlock();

            var anchor = render.find('.full-start-new__rate-line');
            if (!anchor.length) anchor = render.find('.full-start-new__title').parent();
            if (!anchor.length) anchor = render.find('.full-start-new');
            if (!anchor.length) return; // не нашли, куда вставлять — молча выходим

            anchor.after($block);

            var type = movie.name ? 'tv' : 'movie';
            var cacheKey = type + '_' + movie.id;

            // TMDb — сразу, без сети
            if (isOn('tmdb')) setValue($block, 'tmdb', getTmdb(movie));

            var cached = cacheGet(cacheKey);
            if (cached) {
                if (isOn('imdb') && cached.imdb) setValue($block, 'imdb', cached.imdb);
                if (isOn('rt') && cached.rt) setValue($block, 'rt', cached.rt);
                if (isOn('mc') && cached.mc) setValue($block, 'mc', cached.mc);
                if (isOn('kp') && cached.kp) setValue($block, 'kp', cached.kp);
                return; // данные свежие — сетевые запросы не нужны
            }

            var results = {};

            var need_omdb = isOn('imdb') || isOn('rt') || isOn('mc');
            var jobs = [];

            if (need_omdb) {
                jobs.push(getOmdb(movie).then(function (r) {
                    if (r.imdb) { results.imdb = r.imdb; if (isOn('imdb')) setValue($block, 'imdb', r.imdb); }
                    if (r.rt) { results.rt = r.rt; if (isOn('rt')) setValue($block, 'rt', r.rt); }
                    if (r.mc) { results.mc = r.mc; if (isOn('mc')) setValue($block, 'mc', r.mc); }
                }));
            }

            if (isOn('kp')) {
                jobs.push(getKinopoisk(movie).then(function (r) {
                    if (r.kp) { results.kp = r.kp; setValue($block, 'kp', r.kp); }
                }));
            }

            Promise.all(jobs).then(function () {
                if (Object.keys(results).length) cacheSet(cacheKey, results);
            });
        } catch (e) {
            // плагин никогда не должен ломать карточку фильма
            console.log('CineScore error', e);
        }
    }

    // -------------------- Стили --------------------

    function addStyle() {
        if ($('#cinescore-style').length) return;
        $('<style id="cinescore-style">' +
            '.cinescore{display:flex;flex-wrap:wrap;gap:1.5em;margin:1em 0;padding:.8em 1.2em;' +
            'background:rgba(255,255,255,.06);border-radius:.6em;}' +
            '.cinescore__item{display:flex;flex-direction:column;align-items:center;min-width:4.5em;}' +
            '.cinescore__label{font-size:.85em;opacity:.6;margin-bottom:.2em;white-space:nowrap;}' +
            '.cinescore__value{font-size:1.3em;font-weight:600;}' +
        '</style>').appendTo('head');
    }

    // -------------------- Настройки плагина --------------------

    function addSettings() {
        try {
            Lampa.SettingsApi.addComponent({
                component: NAME,
                name: 'CineScore'
            });

            [
                ['imdb', 'IMDb'],
                ['tmdb', 'TMDb'],
                ['rt', 'Rotten Tomatoes'],
                ['mc', 'Metacritic'],
                ['kp', 'Кинопоиск']
            ].forEach(function (item) {
                Lampa.SettingsApi.addParam({
                    component: NAME,
                    param: { name: NAME + '_enable_' + item[0], type: 'trigger', default: true },
                    field: { name: item[1] },
                    onChange: function () {}
                });
            });

        Lampa.SettingsApi.addParam({
            component: NAME,
            param: { name: NAME + '_omdb_key', type: 'input', default: '' },
            field: {
                name: 'OMDb API Key',
                description: 'Нужен для IMDb, Rotten Tomatoes, Metacritic. Бесплатно: omdbapi.com/apikey.aspx'
            },
            onChange: function () {}
        });

        Lampa.SettingsApi.addParam({
            component: NAME,
            param: { name: NAME + '_kp_endpoint', type: 'input', default: '' },
            field: {
                name: 'Kinopoisk API URL',
                description: 'Шаблон URL с {imdb} вместо IMDb ID, напр.: https://api.example.com/v1.4/movie?externalId.imdb={imdb}. Пусто = рейтинг Кинопоиска не запрашивается.'
            },
            onChange: function () {}
        });

        Lampa.SettingsApi.addParam({
            component: NAME,
            param: { name: NAME + '_kp_key', type: 'input', default: '' },
            field: {
                name: 'Kinopoisk API Key',
                description: 'Ключ доступа (заголовок X-API-KEY) для указанного выше сервиса.'
            },
            onChange: function () {}
        });
        } catch (e) {
            console.log('CineScore settings error', e);
        }
    }

    // -------------------- Инициализация --------------------

    function startPlugin() {
        window.plugin_cinescore_ready = true;

        addStyle();
        addSettings();

        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;
            try {
                var movie = e.data.movie;
                var render = e.object.activity.render();
                if (movie && render && render.length) attach(render, movie);
            } catch (err) {
                console.log('CineScore error', err);
            }
        });
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();
