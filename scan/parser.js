/*
 * Helper — разбор техпаспорта (свидетельства о регистрации ТС) после OCR.
 *
 * Вход:  pages из HelperScan.scanDocument() — [{width, height, lines: [{text, confidence, box: {x, y, w, h}}]}]
 *        (box нормализован 0…1, начало в левом верхнем углу). Также принимаются: объект {pages},
 *        массив строк, массив страниц-массивов строк, одна строка с переводами строк.
 * Выход: только данные автомобиля + уверенность по каждому полю + строки-кандидаты.
 *        Данные владельца (ФИО, IDNP/CNP, адрес) распознаются как «зона владельца» и отбрасываются:
 *        они не попадают ни в поля, ни в candidates.
 *
 * Документы: Молдова (Certificat de înmatriculare, RO/RU, коды ЕС A, B, D.1–D.3, E, J, P.1, P.3, R…),
 *            Румыния (те же коды ЕС), Россия (СТС), Украина, Казахстан (похожие подписи).
 *
 * Чистый ES2019 без зависимостей: window.HelperScanParser в браузере/WebView, module.exports в node.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HelperScanParser = api;
})(function () {
  'use strict';

  var VERSION = '1.0.0';

  // Марки — как в списке MAKES приложения.
  var MAKES = ['Audi', 'BMW', 'Chevrolet', 'Citroën', 'Dacia', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Kia', 'Lada',
    'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Renault', 'Seat',
    'Škoda', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'];

  // ---------------------------------------------------------------------------
  // Нормализация текста. Все преобразования посимвольные (1 символ → 1 символ),
  // поэтому индексы в «скелете» совпадают с индексами исходной строки.
  // ---------------------------------------------------------------------------
  var SPECIAL = {
    '³': '3', '²': '2', '¹': '1', '№': 'N', '–': '-', '—': '-', '‑': '-', '−': '-', '’': "'", 'ʼ': "'", '`': "'",
    '´': "'", '‘': "'", '«': '"', '»': '"', '“': '"', '”': '"', 'ß': 'S', 'Ł': 'L', 'ł': 'L', 'Ø': 'O', 'ø': 'O',
    'Đ': 'D', 'đ': 'D', 'Æ': 'A', 'æ': 'A', 'Œ': 'O', 'œ': 'O', 'ı': 'I', '·': '.'
  };
  // Кириллица, похожая на латиницу (для кодов: VIN, номер, категория).
  var HOMO = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y',
    'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S'
  };
  // Дополнительно для поиска подписей: строчные кириллические буквы, которые OCR путает с латиницей.
  var SKEL_EXTRA = {
    'Ү': 'Y', 'Ұ': 'Y', 'Қ': 'K', 'Ң': 'H', 'Һ': 'H', 'Ө': 'O', 'Є': 'E', 'Ә': 'A', 'П': 'N', 'И': 'U', 'Ь': 'B',
    'Ъ': 'B', 'Г': 'R'
  };
  // Латиница → кириллица для российских номеров.
  var LAT_TO_CYR = {A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х'};

  var ALNUM_RE = /[A-Z0-9Ѐ-ӿ]/;
  var SEP_ONLY_RE = /^[\s.,:;\/()\[\]\-'"|*]*$/;

  function foldChar(c) {
    if (SPECIAL[c]) return SPECIAL[c];
    var u = c.toUpperCase();
    if (u.length !== 1) u = c;
    if (u.charCodeAt(0) > 127) {
      var d = u.normalize('NFD');
      if (d.length > 1 && /[A-ZЀ-ӿ]/.test(d.charAt(0))) u = d.charAt(0);
    }
    return u;
  }
  function fold(s) {
    var o = '';
    for (var i = 0; i < s.length; i++) o += foldChar(s.charAt(i));
    return o;
  }
  function skel(s) {
    var f = fold(s), o = '';
    for (var i = 0; i < f.length; i++) { var c = f.charAt(i); o += HOMO[c] || SKEL_EXTRA[c] || c; }
    return o;
  }
  function latin(s) {
    var f = fold(s), o = '';
    for (var i = 0; i < f.length; i++) { var c = f.charAt(i); o += HOMO[c] || c; }
    return o;
  }
  function cleanText(t) {
    return String(t == null ? '' : t)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/[  -​  　]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function collapse(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function trimSeps(s) { return collapse(s).replace(/^[\s.,:;\/()\[\]\-'"|*=]+|[\s,:;\/(\[\-'"|*=]+$/g, '').trim(); }
  function hasContent(s) { return /[A-Za-z0-9À-ɏЀ-ӿ]/.test(s || ''); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // Цифровой контекст: O/o/О/о/Q → 0, I/l/| → 1 рядом с цифрами (год, дата, объём, масса).
  function fixDigits(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var prevD = i > 0 && /[0-9]/.test(s.charAt(i - 1));
      var nextD = i + 1 < s.length && /[0-9]/.test(s.charAt(i + 1));
      if ((prevD || nextD) && /[OoОоQ]/.test(c)) c = '0';
      else if ((prevD || nextD) && /[Il|]/.test(c)) c = '1';
      out += c;
    }
    return out;
  }

  function sentenceCase(s) {
    var t = collapse(s).toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function titleWord(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }

  // Модель: «PASSAT» → «Passat», «CX-5», «RAV4», «E 220 CDI», «C-MAX» → «C-Max».
  function formatModel(s) {
    return collapse(s).split(' ').map(function (tok) {
      return tok.split('-').map(function (p) {
        if (!p) return p;
        if (/[0-9]/.test(p) || p.length <= 3) return p.toUpperCase();
        if (p === p.toUpperCase()) return titleWord(p);
        return p;
      }).join('-');
    }).join(' ');
  }

  function levenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // ---------------------------------------------------------------------------
  // Подписи полей (RO / RU / UA / KZ / EN). Сопоставление по «скелету», допускается 1–2 опечатки OCR.
  // ---------------------------------------------------------------------------
  var LABELS = {
    makeModel: ['МАРКА, МОДЕЛЬ', 'МАРКА МОДЕЛЬ', 'MARCA/MODELUL', 'MARCA, MODELUL', 'MARCA SI MODELUL', 'МАРКА ТА МОДЕЛЬ'],
    engineNo: ['МОДЕЛЬ, № ДВИГАТЕЛЯ', 'МОДЕЛЬ ДВИГАТЕЛЯ', 'НОМЕР ДВИГАТЕЛЯ', '№ ДВИГАТЕЛЯ', 'NUMARUL MOTORULUI',
      'NR. MOTOR', 'SERIA MOTORULUI', 'CODUL MOTORULUI', 'COD MOTOR', 'НОМЕР ДВИГУНА', 'ENGINE NUMBER', 'ENGINE CODE'],
    make: ['MARCA', 'МАРКА', 'MAKE'],
    model: ['MODELUL', 'MODEL', 'МОДЕЛЬ', 'МОДЕЛІ', 'DENUMIREA COMERCIALA', 'DENUMIRE COMERCIALA', 'COMMERCIAL NAME',
      'КОММЕРЧЕСКОЕ НАИМЕНОВАНИЕ', 'КОМЕРЦІЙНИЙ ОПИС', 'ТОРГОВОЕ НАИМЕНОВАНИЕ'],
    type: ['TIPUL', 'TIP', 'ТИП', 'TYPE', 'VARIANTA', 'VERSIUNE', 'ВАРИАНТ', 'ВЕРСИЯ'],
    vin: ['VIN', 'NUMARUL DE IDENTIFICARE', 'NUMAR DE IDENTIFICARE', 'NR. DE IDENTIFICARE', 'NR. IDENTIFICARE',
      'IDENTIFICATION NUMBER', 'ИДЕНТИФИКАЦИОННЫЙ НОМЕР', 'ІДЕНТИФІКАЦІЙНИЙ НОМЕР', 'СӘЙКЕСТЕНДІРУ НӨМІРІ',
      'КУЗОВ', 'ШАССИ', 'NR. SASIU', 'SERIA SASIU'],
    plate: ['NUMARUL DE INMATRICULARE', 'NUMAR DE INMATRICULARE', 'NR. DE INMATRICULARE', 'NR. INMATRICULARE',
      'NUMARUL DE INREGISTRARE', 'REGISTRATION NUMBER', 'РЕГИСТРАЦИОННЫЙ ЗНАК', 'РЕГИСТРАЦИОННЫЙ НОМЕР',
      'ГОСУДАРСТВЕННЫЙ РЕГИСТРАЦИОННЫЙ', 'ГОС. НОМЕР', 'ГОСНОМЕР', 'НОМЕРНОЙ ЗНАК', 'НОМЕРНИЙ ЗНАК',
      'РЕЄСТРАЦІЙНИЙ НОМЕР', 'ТІРКЕУ НӨМІРІ'],
    year: ['ANUL FABRICATIEI', 'ANUL DE FABRICATIE', 'AN FABRICATIE', 'ANUL FABRICARII', 'ANUL PRODUCERII',
      'YEAR OF MANUFACTURE', 'ГОД ВЫПУСКА', 'ГОД ИЗГОТОВЛЕНИЯ', 'ГОД ПРОИЗВОДСТВА', 'РІК ВИПУСКУ', 'РІК ВИГОТОВЛЕННЯ',
      'ШЫҒАРЫЛҒАН ЖЫЛЫ'],
    firstReg: ['DATA PRIMEI INMATRICULARI', 'DATA PRIMEI INREGISTRARI', 'PRIMA INMATRICULARE', 'DATE OF FIRST REGISTRATION',
      'ДАТА ПЕРВОЙ РЕГИСТРАЦИИ', 'ДАТА ПЕРВИЧНОЙ РЕГИСТРАЦИИ', 'ДАТА ПЕРШОЇ РЕЄСТРАЦІЇ', 'ДАТА ПЕРВИННОЇ РЕЄСТРАЦІЇ'],
    cc: ['CAPACITATEA CILINDRICA', 'CAPACITATE CILINDRICA', 'CAPACITATEA MOTORULUI', 'CAPACITATE MOTOR', 'CILINDREE',
      'CYLINDER CAPACITY', 'ENGINE CAPACITY', 'ОБЪЕМ ДВИГАТЕЛЯ', 'РАБОЧИЙ ОБЪЕМ', "ОБ'ЄМ ДВИГУНА", 'ОБЄМ ДВИГУНА',
      "РОБОЧИЙ ОБ'ЄМ", 'ҚОЗҒАЛТҚЫШ КӨЛЕМІ', 'КОЗГАЛТКЫШ КОЛЕМІ'],
    power: ['PUTEREA', 'PUTERE', 'NET POWER', 'МОЩНОСТЬ', 'ПОТУЖНІСТЬ', 'ҚУАТЫ'],
    fuel: ['TIPUL COMBUSTIBILULUI', 'TIP COMBUSTIBIL', 'TIPUL DE COMBUSTIBIL', 'COMBUSTIBIL', 'CARBURANT',
      'SURSA DE ENERGIE', 'ТИП ТОПЛИВА', 'ВИД ТОПЛИВА', 'ТОПЛИВО', 'ТИП ДВИГАТЕЛЯ', 'ИСТОЧНИК ЭНЕРГИИ', 'ТИП ПАЛЬНОГО',
      'ПАЛЬНЕ', 'ПАЛИВО', 'ОТЫН', 'FUEL'],
    color: ['CULOAREA', 'CULOARE', 'COLOUR', 'COLOR', 'ЦВЕТ', 'КОЛІР', 'ТҮСІ'],
    category: ['CATEGORIA', 'CATEGORIE', 'CATEGORY', 'КАТЕГОРИЯ', 'КАТЕГОРІЯ', 'САНАТЫ'],
    massMax: ['MASA MAXIMA', 'MASA TOTALA', 'MASA MAX', 'MAXIMUM PERMISSIBLE', 'РАЗРЕШЕННАЯ MAX МАССА',
      'РАЗРЕШЕННАЯ МАКС', 'МАКСИМАЛЬНАЯ МАССА', 'МАКС. МАССА', 'ПОВНА МАСА', 'МАКСИМАЛЬНА МАСА'],
    massEmpty: ['MASA PROPRIE', 'MASA IN SERVICIU', 'MASA VEHICULULUI', 'MASS IN SERVICE', 'МАССА БЕЗ НАГРУЗКИ',
      'СНАРЯЖЕННАЯ МАССА', 'МАССА В СНАРЯЖЕННОМ', 'МАСА БЕЗ НАВАНТАЖЕННЯ'],
    owner: ['PROPRIETAR', 'DETINATOR', 'UTILIZATOR', 'NUMELE', 'PRENUME', 'NUME', 'ADRESA', 'DOMICILIU', 'SEDIUL',
      'IDNP', 'IDNO', 'CNP', 'COD PERSONAL', 'DATA NASTERII', 'LOCALITATEA', 'STRADA', 'OWNER', 'HOLDER', 'NAME',
      'ADDRESS', 'ВЛАДЕЛЕЦ', 'СОБСТВЕННИК', 'ФАМИЛИЯ', 'ИМЯ', 'ОТЧЕСТВО', 'ФИО', 'Ф.И.О.', 'АДРЕС', 'МЕСТО ЖИТЕЛЬСТВА',
      'РЕСПУБЛИКА, КРАЙ, ОБЛАСТЬ', 'КРАЙ, ОБЛАСТЬ', 'РАЙОН', 'НАС. ПУНКТ', 'НАСЕЛЕННЫЙ ПУНКТ', 'УЛИЦА', 'ДОМ', 'КОРП',
      'КВ', 'ДАТА РОЖДЕНИЯ', 'ЛИЧНЫЙ КОД', 'ПЕРСОНАЛЬНЫЙ КОД', 'ВЛАСНИК', 'ПРІЗВИЩЕ', "ІМ'Я", 'ПО БАТЬКОВІ',
      'МІСЦЕ ПРОЖИВАННЯ', 'ИЕСІ', 'ТЕГІ'],
    other: ['CERTIFICAT DE INMATRICULARE', 'СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ', 'СВІДОЦТВО ПРО РЕЄСТРАЦІЮ', 'REPUBLICA MOLDOVA',
      'РЕСПУБЛИКА МОЛДОВА', 'ROMANIA', 'ТИП ТС', 'ТИП ТРАНСПОРТНОГО', 'TIPUL CAROSERIEI', 'CAROSERIA',
      'ЭКОЛОГИЧЕСКИЙ КЛАСС', 'CLASA ECOLOGICA', 'NORMA DE POLUARE', 'ПАСПОРТ ТС', 'ОСОБЫЕ ОТМЕТКИ', 'MENTIUNI',
      'NUMARUL DE LOCURI', 'NUMAR DE LOCURI', 'КОЛИЧЕСТВО МЕСТ', 'ЧИСЛО МЕСТ', 'SERIA', 'DATA ELIBERARII',
      'ДАТА ВЫДАЧИ', 'ВЫДАНО', 'ELIBERAT', 'VALABIL', 'SPECIMEN', 'ОБРАЗЕЦ', 'ЗРАЗОК', 'OMOLOGARE']
  };
  var VEHICLE_KINDS = {
    makeModel: 1, make: 1, model: 1, type: 1, vin: 1, plate: 1, year: 1, firstReg: 1, cc: 1, fuel: 1, color: 1,
    category: 1, massMax: 1, massEmpty: 1
  };
  var SEP_CLASS = "[\\s.,:;/()\\[\\]\\-'\"|*]*";
  var SPLIT_SEP_RE = /[\s.,:;\/()\[\]\-'"|*]+/;

  function compileKw(kw, kind) {
    var s = skel(kw);
    var parts = s.split(SPLIT_SEP_RE).filter(Boolean);
    var letters = parts.join('');
    var short = letters.length <= 4;
    var src = '(^|[^A-Z0-9\\u0400-\\u04FF])(' + parts.map(escapeRe).join(SEP_CLASS) + ')' +
      (short ? '(?![A-Z0-9\\u0400-\\u04FF])' : '');
    return {kw: kw, kind: kind, re: new RegExp(src, 'g'), letters: letters, cyr: /[Ѐ-ӿ]/.test(kw),
      neutral: kw === 'VIN'};
  }
  var KW = [];
  Object.keys(LABELS).forEach(function (kind) {
    LABELS[kind].forEach(function (kw) { KW.push(compileKw(kw, kind)); });
  });

  function fuzzyFind(text, kw) {
    var proj = '', map = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (ALNUM_RE.test(c)) { proj += c; map.push(i); }
    }
    if (proj.length < kw.length - 2) return null;
    if (proj.indexOf(kw.substr(0, 3)) < 0 && proj.indexOf(kw.substr(-3)) < 0) return null;
    var maxD = kw.length >= 14 ? 2 : 1, best = null;
    for (var p = 0; p < proj.length; p++) {
      var oi = map[p];
      if (oi > 0 && ALNUM_RE.test(text.charAt(oi - 1))) continue; // только с начала слова
      for (var L = kw.length - maxD; L <= kw.length + maxD; L++) {
        if (p + L > proj.length) break;
        var d = levenshtein(proj.substr(p, L), kw, maxD);
        if (d <= maxD && (!best || d < best.d)) best = {start: oi, end: map[p + L - 1] + 1, d: d};
      }
      if (best && best.d === 0) break;
    }
    return best ? {start: best.start, end: best.end, fuzzy: true} : null;
  }

  function findKw(text, ck) {
    var res = [], m;
    ck.re.lastIndex = 0;
    while ((m = ck.re.exec(text))) {
      var start = m.index + m[1].length;
      res.push({start: start, end: start + m[2].length});
      if (!m[0].length) ck.re.lastIndex++;
    }
    if (!res.length && ck.letters.length >= 8) {
      var f = fuzzyFind(text, ck.letters);
      if (f) res.push(f);
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Коды гармонизированного свидетельства ЕС (A, B, C.1…, D.1–D.3, E, F.1, G, J, P.1–P.5, R…)
  // ---------------------------------------------------------------------------
  var CODE_RE = /^[\s(\[]*([A-Z0])(?:\s{0,2}[.,]?\s{0,2}([0-9IL|]))?(?:\s{0,2}[.,]\s{0,2}([0-9IL|]))?\s*([.:)\]])?(?=\s|$)/;
  var SINGLE_CODES = {A: 'plate', B: 'firstReg', E: 'vin', G: 'massEmpty', J: 'category', R: 'color',
    H: 'other', I: 'other', K: 'other', Q: 'other', Y: 'other', Z: 'other'};
  var DIGIT_CODES = {'D.1': 'make', 'D.2': 'type', 'D.3': 'model', 'F.1': 'massMax', 'F.2': 'other', 'F.3': 'other',
    'P.1': 'cc', 'P.2': 'power', 'P.3': 'fuel', 'P.4': 'other', 'P.5': 'engineNo'};

  function parseCode(lineSkel) {
    var m = CODE_RE.exec(lineSkel);
    if (!m) return null;
    var letter = m[1], d1 = m[2] ? m[2].replace(/[IL|]/, '1') : '', d2 = m[3] ? m[3].replace(/[IL|]/, '1') : '';
    var punct = !!m[4];
    var from = m[0].length - m[0].replace(/^[\s(\[]*/, '').length;
    var kind = null, code;
    if (!d1) {
      if (letter === '0') return null;
      kind = SINGLE_CODES[letter] || null;
      if (!kind || (kind === 'other' && !punct)) return null;
      code = letter;
    } else {
      if (letter === '0') letter = 'D';
      code = letter + '.' + d1 + (d2 ? '.' + d2 : '');
      if (letter === 'C') kind = 'owner';
      else if (DIGIT_CODES[letter + '.' + d1]) kind = d2 ? 'other' : DIGIT_CODES[letter + '.' + d1];
      else if (/[FOPSUV]/.test(letter)) kind = 'other';
      else return null;
    }
    return {code: code, kind: kind, from: from, to: m[0].length, single: !d1, punct: punct};
  }

  // ---------------------------------------------------------------------------
  // Марки: синонимы и WMI (первые символы VIN)
  // ---------------------------------------------------------------------------
  // [марка, синонимы, синонимы только для распознавания (не вырезаются из модели)]
  var MAKE_ALIASES = [
    ['Audi', ['AUDI', 'АУДИ']],
    ['BMW', ['BMW', 'БМВ', 'B.M.W.']],
    ['Chevrolet', ['CHEVROLET', 'ШЕВРОЛЕ', 'ШЕВРОЛЕТ']],
    ['Citroën', ['CITROEN', 'СИТРОЕН', 'СИТРОЭН']],
    ['Dacia', ['DACIA', 'ДАЧИЯ', 'ДАЧИА']],
    ['Fiat', ['FIAT', 'ФИАТ']],
    ['Ford', ['FORD', 'ФОРД']],
    ['Honda', ['HONDA', 'ХОНДА']],
    ['Hyundai', ['HYUNDAI', 'ХЕНДЭ', 'ХЕНДАЙ', 'ХУНДАЙ', 'ХЮНДАЙ']],
    ['Kia', ['KIA', 'КИА']],
    ['Lada', ['LADA', 'ЛАДА', 'VAZ', 'ВАЗ']],
    ['Land Rover', ['LAND ROVER', 'LANDROVER', 'LAND-ROVER', 'ЛЕНД РОВЕР', 'ЛЭНД РОВЕР', 'ЛЕНД-РОВЕР'], ['RANGE ROVER']],
    ['Lexus', ['LEXUS', 'ЛЕКСУС']],
    ['Mazda', ['MAZDA', 'МАЗДА']],
    ['Mercedes-Benz', ['MERCEDES-BENZ', 'MERCEDES BENZ', 'MERCEDESBENZ', 'MERCEDES', 'МЕРСЕДЕС-БЕНЦ', 'МЕРСЕДЕС БЕНЦ', 'МЕРСЕДЕС']],
    ['Mitsubishi', ['MITSUBISHI', 'МИЦУБИСИ', 'МИТСУБИСИ']],
    ['Nissan', ['NISSAN', 'НИССАН']],
    ['Opel', ['OPEL', 'ОПЕЛЬ']],
    ['Peugeot', ['PEUGEOT', 'ПЕЖО']],
    ['Renault', ['RENAULT', 'РЕНО']],
    ['Seat', ['SEAT', 'СЕАТ']],
    ['Škoda', ['SKODA', 'ШКОДА']],
    ['Subaru', ['SUBARU', 'СУБАРУ']],
    ['Suzuki', ['SUZUKI', 'СУЗУКИ']],
    ['Tesla', ['TESLA', 'ТЕСЛА']],
    ['Toyota', ['TOYOTA', 'ТОЙОТА']],
    ['Volkswagen', ['VOLKSWAGEN', 'VW', 'ФОЛЬКСВАГЕН']],
    ['Volvo', ['VOLVO', 'ВОЛЬВО']]
  ];
  var ALIAS_LIST = [];
  MAKE_ALIASES.forEach(function (e) {
    e[1].forEach(function (a) { ALIAS_LIST.push({make: e[0], skel: skel(a), strip: true}); });
    (e[2] || []).forEach(function (a) { ALIAS_LIST.push({make: e[0], skel: skel(a), strip: false}); });
  });
  ALIAS_LIST.sort(function (a, b) { return b.skel.length - a.skel.length; });

  function isWordChar(c) { return !!c && ALNUM_RE.test(c); }

  // Все вхождения синонимов марок (целыми словами) в скелет строки.
  function findMakes(sk) {
    var out = [];
    ALIAS_LIST.forEach(function (a) {
      var from = 0, idx;
      while ((idx = sk.indexOf(a.skel, from)) >= 0) {
        var end = idx + a.skel.length;
        if (!isWordChar(sk.charAt(idx - 1)) && !isWordChar(sk.charAt(end))) {
          var overlap = out.some(function (o) { return idx < o.end && o.start < end; });
          if (!overlap) out.push({make: a.make, start: idx, end: end, strip: a.strip});
        }
        from = idx + 1;
      }
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  function normalizeMake(s) {
    if (!s) return null;
    var hits = findMakes(skel(String(s)));
    return hits.length ? hits[0].make : null;
  }

  var WMI = {
    WVW: 'Volkswagen', WV1: 'Volkswagen', WV2: 'Volkswagen', WV3: 'Volkswagen', '1VW': 'Volkswagen', '3VW': 'Volkswagen',
    '9BW': 'Volkswagen', XW8: 'Volkswagen',
    WBA: 'BMW', WBS: 'BMW', WBY: 'BMW', '5UX': 'BMW', X4X: 'BMW',
    WDD: 'Mercedes-Benz', WDB: 'Mercedes-Benz', WDC: 'Mercedes-Benz', WDF: 'Mercedes-Benz', W1K: 'Mercedes-Benz',
    W1N: 'Mercedes-Benz', W1V: 'Mercedes-Benz', W1W: 'Mercedes-Benz', '4JG': 'Mercedes-Benz', '55S': 'Mercedes-Benz',
    VF1: 'Renault', VF2: 'Renault', X7L: 'Renault',
    UU1: 'Dacia', UU2: 'Dacia', UU3: 'Dacia',
    TMB: 'Škoda',
    VF3: 'Peugeot', VR3: 'Peugeot',
    VF7: 'Citroën', VR7: 'Citroën',
    ZFA: 'Fiat', ZFC: 'Fiat',
    JTH: 'Lexus', JTJ: 'Lexus', '2T2': 'Lexus', '58A': 'Lexus',
    JTD: 'Toyota', JTE: 'Toyota', JTM: 'Toyota', JTN: 'Toyota', JT: 'Toyota', SB1: 'Toyota', NMT: 'Toyota', '4T1': 'Toyota',
    '4T3': 'Toyota', '5TD': 'Toyota', '2T1': 'Toyota', VNK: 'Toyota', MR0: 'Toyota', AHT: 'Toyota', XW7: 'Toyota',
    KMH: 'Hyundai', TMA: 'Hyundai', '5NP': 'Hyundai', KM8: 'Hyundai', Z94: 'Hyundai',
    KNA: 'Kia', KNE: 'Kia', KND: 'Kia', U5Y: 'Kia', U6Y: 'Kia', '5XY': 'Kia', XWE: 'Kia',
    JN1: 'Nissan', JN8: 'Nissan', SJN: 'Nissan', VSK: 'Nissan', '1N4': 'Nissan', '5N1': 'Nissan', Z8N: 'Nissan',
    JMB: 'Mitsubishi', JMY: 'Mitsubishi', JA3: 'Mitsubishi', JA4: 'Mitsubishi', MMB: 'Mitsubishi', MMC: 'Mitsubishi',
    JM: 'Mazda',
    SAL: 'Land Rover',
    YV1: 'Volvo', YV4: 'Volvo', LVY: 'Volvo', '7JR': 'Volvo',
    XTA: 'Lada',
    W0L: 'Opel', W0V: 'Opel', VXK: 'Opel',
    VSS: 'Seat',
    JHM: 'Honda', JHL: 'Honda', SHH: 'Honda', SHS: 'Honda', '1HG': 'Honda', '2HG': 'Honda', '5J6': 'Honda',
    JS: 'Suzuki', TSM: 'Suzuki', MA3: 'Suzuki',
    '5YJ': 'Tesla', '7SA': 'Tesla', LRW: 'Tesla', XP7: 'Tesla',
    JF1: 'Subaru', JF2: 'Subaru', '4S3': 'Subaru', '4S4': 'Subaru',
    WAU: 'Audi', WA1: 'Audi', TRU: 'Audi',
    '1FA': 'Ford', '1FM': 'Ford', '1FT': 'Ford', WF0: 'Ford', '3FA': 'Ford', '2FM': 'Ford', X9F: 'Ford',
    '1G1': 'Chevrolet', '1GN': 'Chevrolet', '3GN': 'Chevrolet', KL1: 'Chevrolet', KL7: 'Chevrolet', XUU: 'Chevrolet'
  };

  function makeFromVin(vin) {
    if (!vin || vin.length < 3) return null;
    var v = String(vin).toUpperCase();
    return WMI[v.substr(0, 3)] || WMI[v.substr(0, 2)] || null;
  }

  var VIN_YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  // Модельный год по 10-му символу — только слабая подсказка (в ЕС кодируется не всегда).
  function vinModelYear(vin, now) {
    if (!vin || vin.length !== 17) return null;
    var i = VIN_YEAR_CODES.indexOf(vin.charAt(9).toUpperCase());
    if (i < 0) return null;
    var maxY = (now instanceof Date ? now : new Date()).getFullYear() + 1, best = null;
    for (var y = 1980 + i; y <= maxY; y += 30) best = y;
    return best;
  }

  var VIN_TR = {A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3,
    U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9};
  var VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  function vinCheckDigitOk(vin) {
    if (!vin || vin.length !== 17) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) {
      var c = vin.charAt(i);
      var v = /[0-9]/.test(c) ? +c : VIN_TR[c];
      if (v == null) return false;
      sum += v * VIN_W[i];
    }
    var r = sum % 11;
    return vin.charAt(8) === (r === 10 ? 'X' : String(r));
  }
  function vinCheckStatus(vin) {
    var p9 = vin.charAt(8);
    if (!/[0-9X]/.test(p9)) return 'n/a';
    if (vinCheckDigitOk(vin)) return 'ok';
    return /^[1-5]/.test(vin) ? 'fail' : 'n/a'; // обязательна только для Северной Америки
  }

  // ---------------------------------------------------------------------------
  // Разбор значений полей
  // ---------------------------------------------------------------------------
  function vinToken(tok) {
    var l = latin(tok), out = '';
    for (var i = 0; i < l.length; i++) {
      var c = l.charAt(i);
      if (c === 'O' || c === 'Q') c = '0';
      else if (c === 'I') c = '1';
      if (/[A-Z0-9]/.test(c)) out += c;
      else if (/[Ѐ-ӿ]/.test(c)) return null;
    }
    return out;
  }
  function vinPlausible(v) {
    var letters = v.replace(/[0-9]/g, '').length, digits = 17 - letters;
    return letters >= 2 && digits >= 5 && /[0-9]{3}$/.test(v) && /[A-Z]/.test(v.substr(0, 3)) && !/^(.)\1+$/.test(v);
  }
  function findVins(text) {
    var toks = String(text).split(/[\s:;,()\[\]\/|№#=]+/).map(vinToken).filter(function (t) { return t; });
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var acc = '';
      for (var j = i; j < toks.length && j < i + 3; j++) {
        acc += toks[j];
        if (acc.length > 17) break;
        if (acc.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(acc)) {
          out.push({value: acc, joined: j > i});
          break;
        }
      }
    }
    return out;
  }
  function parseVinValue(text) {
    var found = findVins(text);
    for (var i = 0; i < found.length; i++) {
      var v = found[i].value, st = vinCheckStatus(v);
      var q = st === 'ok' ? 1 : st === 'fail' ? 0.6 : vinPlausible(v) ? 0.97 : 0.75;
      if (found[i].joined) q *= 0.95;
      return {value: v, q: q, check: st};
    }
    return null;
  }

  // Номера. Группы цифр допускают O/I/Q (исправляются в 0/1/0).
  var D = '[0-9OIQ]';
  var RO_COUNTIES = 'AB|AR|AG|BC|BH|BN|BT|BV|BR|BZ|CS|CL|CJ|CT|CV|DB|DJ|GL|GR|GJ|HR|HD|IL|IS|IF|MM|MH|MS|NT|OT|PH|SM|SJ|SB|SV|TR|TM|TL|VS|VL|VN';
  var PLATE_PATTERNS = [
    {cc: 'RU', strong: true, re: new RegExp('([ABEKMHOPCTYX])\\s?(' + D + '{3})\\s?([ABEKMHOPCTYX]{2})\\s?[|]?\\s?(' + D + '{2,3})'),
      fmt: function (m) { return toCyr(m[1]) + dg(m[2]) + toCyr(m[3]) + ' ' + dg(m[4]); }},
    {cc: 'UA', strong: true, re: new RegExp('([ABCEHIKMOPTX]{2})\\s?(' + D + '{4})\\s?([ABCEHIKMOPTX]{2})'),
      fmt: function (m) { return m[1] + ' ' + dg(m[2]) + ' ' + m[3]; }},
    {cc: 'RO', strong: true, re: new RegExp('(B)\\s?(' + D + '{2,3})\\s?([A-Z]{3})'),
      fmt: function (m) { return m[1] + ' ' + dg(m[2]) + ' ' + m[3]; }},
    {cc: 'RO', strong: true, re: new RegExp('(' + RO_COUNTIES + ')\\s?(' + D + '{2})\\s?([A-Z]{3})'),
      fmt: function (m) { return m[1] + ' ' + dg(m[2]) + ' ' + m[3]; }},
    {cc: 'MD', strong: true, re: new RegExp('([A-Z]{1,2})\\s([A-Z]{2})\\s?(' + D + '{3})'),
      fmt: function (m) { return m[1] + ' ' + m[2] + ' ' + dg(m[3]); }},
    {cc: 'KZ', strong: false, re: new RegExp('(' + D + '{3})\\s?([A-Z]{2,3})\\s?(' + D + '{2})'),
      fmt: function (m) { return dg(m[1]) + ' ' + m[2] + ' ' + dg(m[3]); }},
    {cc: 'MD', strong: false, re: new RegExp('([A-Z]{3})\\s?(' + D + '{3})'),
      fmt: function (m) { return m[1] + ' ' + dg(m[2]); }}
  ];
  function dg(s) { return s.replace(/[OQ]/g, '0').replace(/I/g, '1'); }
  function toCyr(s) { return s.split('').map(function (c) { return LAT_TO_CYR[c] || c; }).join(''); }

  function parsePlate(text, prefer) {
    var s = latin(String(text)).replace(/[|\-]/g, ' ').replace(/\s+/g, ' ');
    var order = PLATE_PATTERNS.slice();
    if (prefer) {
      order.sort(function (a, b) { return (b.cc === prefer) - (a.cc === prefer); });
    }
    var best = null;
    for (var i = 0; i < order.length; i++) {
      var p = order[i];
      var re = new RegExp('(^|[^A-Z0-9])' + p.re.source + '(?![A-Z0-9])', 'g'), m;
      while ((m = re.exec(s))) {
        var groups = m.slice(1);
        var digits = groups.join('').replace(/[^0-9]/g, '').length;
        var digitSlots = groups.slice(1).filter(function (g) { return g && /^[0-9OIQ]+$/.test(g); }).join('').length;
        if (digitSlots && digits < Math.min(2, digitSlots)) continue; // не менее двух настоящих цифр
        var mm = [m[0]].concat(groups.slice(1));
        var value = p.fmt(mm);
        var index = m.index + m[1].length;
        var len = m[0].length - m[1].length;
        var alnum = s.replace(/[^A-Z0-9Ѐ-ӿ]/g, '').length || 1;
        var cand = {value: value, country: p.cc, strong: p.strong, index: index,
          coverage: (m[0].replace(/[^A-Z0-9]/g, '').length) / alnum, len: len};
        if (!best) best = cand;
        break;
      }
      if (best) break;
    }
    return best;
  }

  function yearsIn(text, maxYear) {
    var s = fixDigits(String(text)), re = /(^|[^0-9])((?:19|20)[0-9]{2})(?![0-9])/g, m, out = [];
    while ((m = re.exec(s))) {
      var y = +m[2];
      if (y >= 1950 && y <= maxYear) out.push(y);
    }
    return out;
  }
  function parseYearValue(text, ctx) {
    var ys = yearsIn(text, ctx.maxYear);
    return ys.length ? {value: ys[0], q: 1} : null;
  }
  function parseDateYearValue(text, ctx) {
    var s = fixDigits(String(text));
    var m = /(^|[^0-9])([0-3]?[0-9])\s?[.\/\-]\s?([01]?[0-9])\s?[.\/\-]\s?((?:19|20)[0-9]{2})(?![0-9])/.exec(s);
    if (m) { var y = +m[4]; if (y >= 1950 && y <= ctx.maxYear) return {value: y, q: 1, date: true}; }
    m = /((?:19|20)[0-9]{2})-([01][0-9])-([0-3][0-9])/.exec(s);
    if (m) { var y2 = +m[1]; if (y2 >= 1950 && y2 <= ctx.maxYear) return {value: y2, q: 1, date: true}; }
    var ys = yearsIn(s, ctx.maxYear);
    return ys.length ? {value: ys[0], q: 0.85} : null;
  }

  // Числа из значения: «1968», «1 968», «1.968», «1968cm3»; единицы и слова отбрасываются.
  function numbersIn(text) {
    var toks = fixDigits(skel(String(text))).split(/[\s()\[\]\/:;=]+/).filter(Boolean), nums = [];
    for (var i = 0; i < toks.length; i++) {
      var m = /^([0-9][0-9.,']*)([A-ZЀ-ӿ].*)?$/.exec(toks[i]);
      if (!m) continue;
      var raw = m[1].replace(/[.,']$/, '');
      if (/^[0-9]{1,2}$/.test(raw) && i + 1 < toks.length && /^[0-9]{3}$/.test(toks[i + 1])) {
        nums.push({v: +(raw + toks[i + 1]), dec: false}); i++; continue;
      }
      if (/^[0-9]{1,2}[.,'][0-9]{3}$/.test(raw)) { nums.push({v: +raw.replace(/[.,']/, ''), dec: false}); continue; }
      if (/^[0-9]+[.,][0-9]{1,2}$/.test(raw)) { nums.push({v: +raw.replace(',', '.'), dec: true}); continue; }
      if (/^[0-9]+$/.test(raw)) nums.push({v: +raw, dec: false});
    }
    return nums;
  }
  function parseCcValue(text) {
    var nums = numbersIn(text);
    for (var i = 0; i < nums.length; i++) {
      var n = nums[i];
      if (!n.dec && n.v >= 50 && n.v <= 8500) return {value: n.v, q: 1};
      if (n.dec && n.v >= 0.6 && n.v <= 8.5) return {value: Math.round(n.v * 1000), q: 0.8, liters: true};
    }
    return null;
  }
  function parseMassValue(text) {
    var nums = numbersIn(text);
    for (var i = 0; i < nums.length; i++) if (!nums[i].dec && nums[i].v >= 300 && nums[i].v <= 60000) return {value: nums[i].v, q: 1};
    return null;
  }

  function ccToLiters(cc) {
    if (!cc || !isFinite(cc) || cc <= 0) return null;
    return (Math.round(cc / 100) / 10).toFixed(1);
  }

  // Топливо. Короткие слова (ГАЗ/GAZ/ДТ) — только в подписанном поле «топливо».
  var FUEL_WORDS = [
    ['hybrid', ['HIBRID', 'HYBRID', 'ГИБРИД', 'ГІБРИД', 'PHEV', 'HEV', 'PLUG-IN']],
    ['ev', ['ELECTRIC', 'ELEKTRO', 'ELECTRO', 'ЭЛЕКТР', 'ЕЛЕКТР', 'EV', 'BEV']],
    ['lpg', ['GPL', 'LPG', 'PROPAN', 'ПРОПАН', 'CNG', 'METAN', 'МЕТАН', 'GNC']],
    ['diesel', ['MOTORIN', 'DIESEL', 'DIZEL', 'ДИЗЕЛ', 'GASOIL', 'ДИЗ']],
    ['petrol', ['BENZIN', 'PETROL', 'GASOLINE', 'ESSENCE', 'БЕНЗИН']]
  ];
  var FUEL_LABELED_ONLY = [['lpg', ['ГАЗ', 'GAZ', 'ГАЗОВЫЙ']], ['diesel', ['ДТ']]];
  function compileWords(list) {
    return list.map(function (e) {
      return [e[0], e[1].map(function (w) {
        var s = skel(w), short = s.replace(/[^A-Z0-9Ѐ-ӿ]/g, '').length <= 3;
        return new RegExp('(^|[^A-Z0-9\\u0400-\\u04FF])' + escapeRe(s) + (short ? '(?![A-Z0-9\\u0400-\\u04FF])' : ''));
      })];
    });
  }
  var FUEL_RE = compileWords(FUEL_WORDS), FUEL_LABELED_RE = compileWords(FUEL_LABELED_ONLY);

  function parseFuel(text, labeled) {
    var sk = skel(String(text)), flags = {};
    FUEL_RE.concat(labeled ? FUEL_LABELED_RE : []).forEach(function (e) {
      e[1].forEach(function (re) { if (re.test(sk)) flags[e[0]] = true; });
    });
    var v = null;
    if (flags.hybrid || (flags.ev && (flags.petrol || flags.diesel))) v = 'hybrid';
    else if (flags.lpg) v = 'lpg';
    else if (flags.ev) v = 'ev';
    else if (flags.diesel && !flags.petrol) v = 'diesel';
    else if (flags.petrol && !flags.diesel) v = 'petrol';
    else if (flags.petrol && flags.diesel) v = sk.search(/BENZIN|БЕНЗИН|PETROL/) < sk.search(/MOTORIN|DIESEL|ДИЗЕЛ/) ? 'petrol' : 'diesel';
    return v ? {value: v, q: 1} : null;
  }

  var COLOR_STEMS = [
    ['white', ['ALB', 'WHITE', 'БЕЛ', 'БІЛ', 'АҚ']],
    ['black', ['NEGRU', 'NEAGR', 'BLACK', 'ЧЕРН', 'ЧОРН', 'ҚАРА']],
    ['silver', ['ARGINT', 'SILVER', 'СЕРЕБР', 'СРІБЛ', 'КҮМІС']],
    ['grey', ['GRI', 'GREY', 'GRAY', 'СЕР', 'СІР', 'СҰР']],
    ['red', ['ROSU', 'ROSI', 'RED', 'КРАСН', 'ЧЕРВОН', 'ҚЫЗЫЛ']],
    ['blue', ['ALBASTR', 'BLUE', 'СИН', 'ГОЛУБ', 'БЛАКИТ', 'КӨК']],
    ['green', ['VERDE', 'GREEN', 'ЗЕЛЕН', 'ЖАСЫЛ']],
    ['yellow', ['GALBEN', 'YELLOW', 'ЖЕЛТ', 'ЖОВТ', 'САРЫ']],
    ['brown', ['MARO', 'BRUN', 'BROWN', 'КОРИЧН']],
    ['beige', ['BEJ', 'BEIGE', 'БЕЖ']],
    ['orange', ['PORTOCALI', 'ORANGE', 'ОРАНЖ', 'ПОМАРАНЧ']],
    ['violet', ['VIOLET', 'MOV', 'PURPLE', 'ФИОЛЕТ', 'ФІОЛЕТ']],
    ['burgundy', ['VISINI', 'BORDO', 'БОРДО', 'ВИШН']],
    ['gold', ['AURI', 'GOLD', 'ЗОЛОТ']]
  ];
  var COLOR_NAMES_RU = {white: 'Белый', black: 'Чёрный', silver: 'Серебристый', grey: 'Серый', red: 'Красный',
    blue: 'Синий', green: 'Зелёный', yellow: 'Жёлтый', brown: 'Коричневый', beige: 'Бежевый', orange: 'Оранжевый',
    violet: 'Фиолетовый', burgundy: 'Бордовый', gold: 'Золотистый'};
  var COLOR_WHOLE = {};
  ['RED', 'MOV', 'АҚ', 'GOLD'].forEach(function (w) { COLOR_WHOLE[skel(w)] = true; });
  var COLOR_LIST = [];
  COLOR_STEMS.forEach(function (e) { e[1].forEach(function (st) { COLOR_LIST.push({key: e[0], skel: skel(st)}); }); });
  COLOR_LIST.sort(function (a, b) { return b.skel.length - a.skel.length; });

  function colorKey(text) {
    var sk = skel(String(text));
    for (var i = 0; i < COLOR_LIST.length; i++) {
      var c = COLOR_LIST[i], from = 0, idx;
      while ((idx = sk.indexOf(c.skel, from)) >= 0) {
        var whole = COLOR_WHOLE[c.skel];
        if (!isWordChar(sk.charAt(idx - 1)) && (!whole || !isWordChar(sk.charAt(idx + c.skel.length)))) {
          return c.key;
        }
        from = idx + 1;
      }
    }
    return null;
  }
  function parseColorValue(text) {
    var parts = String(text).split(/[\/|,;]+/).map(trimSeps).filter(function (p) { return hasContent(p) && !/[0-9]/.test(p) && p.length <= 30; });
    if (!parts.length) return null;
    for (var i = 0; i < parts.length; i++) {
      var k = colorKey(parts[i]);
      if (k) return {value: sentenceCase(parts[i]), q: 1, key: k};
    }
    if (!/^[A-Za-zÀ-ɏЀ-ӿ][A-Za-zÀ-ɏЀ-ӿ \-]{2,}$/.test(parts[0])) return null;
    return {value: sentenceCase(parts[0]), q: 0.55, key: null};
  }

  var CATEGORY_RE = /^(M[123]G?|N[123]G?|O[1-4]|L[1-7]E?|T[1-5]?|BE|CE|DE|C1E|D1E|A1|A2|B1|C1|D1|A|B|C|D)$/;
  function parseCategoryValue(text) {
    var toks = latin(String(text)).split(/[^A-Z0-9|]+/).filter(Boolean).map(function (t) {
      return /^[MNLO][IL|]$/.test(t) ? t.charAt(0) + '1' : t;
    });
    var best = null, eu = null;
    toks.forEach(function (t) {
      if (CATEGORY_RE.test(t)) { best = t; if (/^[MNOL][0-9]/.test(t)) eu = t; }
    });
    var v = eu || best;
    return v ? {value: v, q: 1} : null;
  }

  var STOP_VALUES = /^(ОТСУТСТВУЕТ|ОТСУТСТВ|НЕТ|NU ESTE|LIPSA|NONE|N\/A|-+|—)$/i;

  function parseModelValue(text) {
    var parts = String(text).split(/[\/|]+/).map(trimSeps).filter(hasContent);
    if (!parts.length) return null;
    var raw = parts[0];
    var sk = skel(raw), hits = findMakes(sk).filter(function (h) { return h.strip; });
    // Убираем марку из начала («VOLKSWAGEN PASSAT» → «PASSAT»; «ВАЗ 217030 LADA PRIORA» → «PRIORA»).
    var cut = 0;
    hits.forEach(function (h) {
      var before = raw.slice(cut, h.start);
      if (!hasContent(before) || (h.make === 'Lada' && /^[\s0-9\-]*$/.test(before))) cut = h.end;
    });
    var v = trimSeps(raw.slice(cut));
    if (!v || STOP_VALUES.test(v) || v.length > 32 || v.split(' ').length > 5) return null;
    var letters = v.replace(/[^A-Za-zÀ-ɏЀ-ӿ]/g, '');
    var upper = letters.length ? letters.replace(/[^A-ZÀ-ÞЀ-Я]/g, '').length / letters.length : 1;
    return {value: formatModel(v), q: upper >= 0.7 ? 1 : 0.6};
  }

  function parseMakeValue(text) {
    var parts = String(text).split(/[\/|]+/).map(trimSeps).filter(hasContent);
    for (var i = 0; i < parts.length; i++) {
      var hits = findMakes(skel(parts[i]));
      if (hits.length) return {value: hits[0].make, q: 1, known: true};
    }
    if (!parts.length) return null;
    var first = parts[0].split(' ')[0];
    if (!/^[A-Za-zÀ-ɏЀ-ӿ][A-Za-zÀ-ɏЀ-ӿ\-]{1,19}$/.test(first) || STOP_VALUES.test(first)) return null;
    return {value: titleWord(first), q: 0.55, known: false};
  }

  function parseMakeModelValue(text) {
    var parts = String(text).split(/[\/|]+/).map(trimSeps).filter(hasContent);
    if (!parts.length) return null;
    var pick = parts[0];
    for (var i = 0; i < parts.length; i++) {
      if (findMakes(skel(parts[i])).some(function (h) { return h.strip; })) { pick = parts[i]; break; }
    }
    var hits = findMakes(skel(pick)).filter(function (h) { return h.strip; });
    var make, model;
    if (hits.length) {
      make = {value: hits[0].make, q: 1};
      model = parseModelValue(pick);
    } else {
      var toks = pick.split(' ');
      make = parseMakeValue(toks[0]);
      model = toks.length > 1 ? parseModelValue(toks.slice(1).join(' ')) : null;
    }
    if (!make && !model) return null;
    return {make: make, model: model};
  }

  var PARSERS = {
    plate: function (t, ctx) {
      var p = parsePlate(t, ctx.docType);
      return p ? {value: p.value, q: p.country === ctx.docType ? 1 : p.strong ? 0.9 : 0.8, country: p.country} : null;
    },
    vin: parseVinValue,
    make: parseMakeValue,
    model: parseModelValue,
    type: parseModelValue,
    makeModel: parseMakeModelValue,
    year: parseYearValue,
    firstReg: parseDateYearValue,
    cc: parseCcValue,
    fuel: function (t) { return parseFuel(t, true); },
    color: parseColorValue,
    category: parseCategoryValue,
    massMax: parseMassValue,
    massEmpty: parseMassValue
  };
  var LOOSE_CTX = {maxYear: 9999, docType: null};
  var FIELD_OF = {plate: 'plate', vin: 'vin', make: 'make', model: 'model', type: 'model', year: 'year',
    firstReg: 'year', cc: 'engine_cc', fuel: 'fuel', color: 'color', category: 'category', massMax: 'mass',
    massEmpty: 'mass_empty', makeModel: 'make'};

  // ---------------------------------------------------------------------------
  // Строки и ряды
  // ---------------------------------------------------------------------------
  function normalizeInput(input) {
    var pages = input;
    if (pages && !Array.isArray(pages) && typeof pages === 'object' && Array.isArray(pages.pages)) pages = pages.pages;
    if (typeof pages === 'string') pages = [pages.split(/\r?\n/)];
    if (!Array.isArray(pages)) return [];
    if (pages.length && pages.every(function (p) { return typeof p === 'string'; })) pages = [pages];
    var out = [];
    pages.forEach(function (pg, pi) {
      var ls = Array.isArray(pg) ? pg : pg && Array.isArray(pg.lines) ? pg.lines : typeof pg === 'string' ? pg.split(/\r?\n/) : [];
      ls.forEach(function (ln, li) {
        var text = cleanText(typeof ln === 'string' ? ln : ln && ln.text);
        if (!text) return;
        var b = ln && typeof ln === 'object' ? ln.box : null;
        var has = !!(b && isFinite(b.x) && isFinite(b.y) && isFinite(b.w) && isFinite(b.h) && b.h > 0);
        var conf = ln && typeof ln === 'object' && typeof ln.confidence === 'number' ? clamp01(ln.confidence) : 1;
        out.push({
          id: out.length, page: pi, text: text, skel: skel(text), conf: conf,
          x: has ? +b.x : 0, y: has ? +b.y : li * 0.03, w: has ? +b.w : 1, h: has ? +b.h : 0.02
        });
      });
    });
    return dropWatermarks(out);
  }

  // Водяные знаки / защитные надписи по диагонали Vision возвращает как «строку» высотой в несколько строк
  // текста (например, «2980P ECIMEN»). Они ломают группировку рядов — отбрасываем.
  function dropWatermarks(lines) {
    var byPage = {};
    lines.forEach(function (l) { (byPage[l.page] = byPage[l.page] || []).push(l.h); });
    var median = {};
    Object.keys(byPage).forEach(function (pg) {
      var hs = byPage[pg].slice().sort(function (a, b) { return a - b; });
      median[pg] = hs.length >= 5 ? hs[Math.floor(hs.length / 2)] : 0;
    });
    return lines.filter(function (l) { return !(median[l.page] && l.h > median[l.page] * 3.5); })
      .map(function (l, i) { l.id = i; return l; });
  }

  function buildRows(lines) {
    var sorted = lines.slice().sort(function (a, b) {
      return a.page - b.page || (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x;
    });
    var rows = [];
    sorted.forEach(function (ln) {
      var cy = ln.y + ln.h / 2, r = rows[rows.length - 1];
      if (r && r.page === ln.page && Math.abs(cy - r.cy) <= 0.5 * Math.min(ln.h, r.h)) r.lines.push(ln);
      else rows.push({page: ln.page, cy: cy, h: ln.h, lines: [ln]});
    });
    rows.forEach(function (row, ri) {
      row.index = ri;
      row.lines.sort(function (a, b) { return a.x - b.x; });
      var text = '', sk = '';
      row.lines.forEach(function (ln, i) {
        if (i) { text += '   '; sk += '   '; }
        ln.start = text.length;
        text += ln.text; sk += ln.skel;
        ln.end = text.length;
        ln.row = row;
      });
      row.text = text;
      row.skel = sk;
      row.mask = new Array(text.length).fill(false);
    });
    return rows;
  }

  function lineAt(row, idx) {
    for (var i = row.lines.length - 1; i >= 0; i--) if (row.lines[i].start <= idx) return row.lines[i];
    return row.lines[0];
  }

  function detectSpans(row) {
    var spans = [];
    row.lines.forEach(function (ln) {
      var c = parseCode(ln.skel);
      if (c) spans.push({kind: c.kind, start: ln.start + c.from, end: ln.start + c.to, via: 'code', code: c.code, single: c.single});
    });
    KW.forEach(function (ck) {
      findKw(row.skel, ck).forEach(function (m) {
        spans.push({kind: ck.kind, start: m.start, end: m.end, via: 'label', lat: !ck.cyr && !ck.neutral, cyr: ck.cyr});
      });
    });
    spans.sort(function (a, b) {
      return (b.via === 'code') - (a.via === 'code') || (b.end - b.start) - (a.end - a.start) || a.start - b.start;
    });
    var acc = [];
    spans.forEach(function (s) {
      for (var i = 0; i < acc.length; i++) {
        var a = acc[i];
        if (s.start < a.end && a.start < s.end) {
          if (a.kind === s.kind) {
            a.start = Math.min(a.start, s.start); a.end = Math.max(a.end, s.end);
            a.lat = a.lat || s.lat; a.cyr = a.cyr || s.cyr;
          }
          return;
        }
      }
      acc.push(s);
    });
    acc.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    acc.forEach(function (s) {
      var p = merged[merged.length - 1];
      if (p && p.kind === s.kind && SEP_ONLY_RE.test(row.text.slice(p.end, s.start))) {
        p.end = Math.max(p.end, s.end);
        if (p.via !== s.via) p.via = 'code+label';
        p.lat = p.lat || s.lat; p.cyr = p.cyr || s.cyr;
      } else {
        merged.push({kind: s.kind, start: s.start, end: s.end, via: s.via, code: s.code, single: s.single, lat: s.lat, cyr: s.cyr});
      }
    });
    // Однобуквенный код, который на деле начало номера («B 123 ABC», «K BA 123») или само значение
    // предыдущей подписи («Категория ТС (ABCD, прицеп)  B») — не код.
    row.spans = merged.filter(function (s, i) {
      if (!(s.via === 'code' && s.single)) return true;
      var ln = lineAt(row, s.start), p = parsePlate(ln.text);
      if (p && p.index <= s.start - ln.start + 1 && p.coverage > 0.6) return false;
      var codeOnly = !hasContent(ln.text.slice(s.end - ln.start));
      var prev = merged[i - 1];
      if (codeOnly && prev && VEHICLE_KINDS[prev.kind] && lineAt(row, prev.start) !== ln) {
        var prevSeg = row.text.slice(prev.end, s.start);
        if (!PARSERS[prev.kind](prevSeg, LOOSE_CTX)) return false;
      }
      return true;
    });
    row.lines.forEach(function (ln) {
      ln.spans = row.spans.filter(function (s) { return s.start >= ln.start && s.start < ln.end; });
      var covered = ln.text.split('').map(function () { return false; });
      row.spans.forEach(function (s) {
        for (var k = Math.max(s.start, ln.start); k < Math.min(s.end, ln.end); k++) covered[k - ln.start] = true;
      });
      ln.labelOnly = ln.spans.length > 0 && ln.text.split('').every(function (c, i) { return covered[i] || !ALNUM_RE.test(foldChar(c)); });
    });
  }

  // Конец значения подписи: следующая подпись или начало следующей колонки подписей.
  function segEnd(row, si) {
    var sp = row.spans[si], end = si + 1 < row.spans.length ? row.spans[si + 1].start : row.text.length;
    (row.cuts || []).forEach(function (c) { if (c > sp.end && c < end) end = c; });
    return end;
  }

  // Многоколоночные листы (румынский A4): x, с которых в нескольких рядах начинаются подписи.
  function computeColumnCuts(rows) {
    var byPage = {};
    rows.forEach(function (row) {
      row.lines.forEach(function (ln) {
        if (ln.x < 0.25 || !ln.spans.length || ln.spans[0].start - ln.start > 2) return;
        if (!VEHICLE_KINDS[ln.spans[0].kind] && ln.spans[0].kind !== 'owner') return;
        var key = Math.round(ln.x * 20) / 20;
        var pg = byPage[row.page] || (byPage[row.page] = {});
        pg[key] = (pg[key] || 0) + 1;
      });
    });
    rows.forEach(function (row) {
      var pg = byPage[row.page] || {}, bounds = Object.keys(pg).filter(function (k) { return pg[k] >= 3; }).map(Number);
      row.cuts = [];
      if (!bounds.length) return;
      row.lines.forEach(function (ln, i) {
        if (i && bounds.some(function (b) { return Math.abs(ln.x - b) <= 0.04; })) row.cuts.push(ln.start);
      });
    });
  }

  function blank(row, a, b) {
    var o = '';
    for (var i = a; i < b; i++) o += row.mask[i] ? ' ' : row.text.charAt(i);
    return o;
  }
  function maskLine(ln) {
    ln.blocked = true;
    for (var k = ln.start; k < ln.end; k++) ln.row.mask[k] = true;
  }

  // Личные данные: 13-значные IDNP/IDNO/CNP, адресные сокращения.
  var PERSONAL_RE = /(^|[^0-9])[0-9]{13}(?![0-9])/;
  var ADDRESS_RE = new RegExp('(^|[^A-Z0-9\\u0400-\\u04FF])(' + ['STR', 'BD', 'BLD', 'BUL', 'BLVD', 'AP', 'APT', 'BL', 'SC', 'ET',
    'MUN', 'JUD', 'COM', 'SAT', 'SECT', 'SECTOR', 'ORAS', 'УЛ', 'КВ', 'КОРП', 'ПР', 'ПРОСП', 'ПЕР', 'МКР', 'ВУЛ', 'ПРОВ', 'МКР']
    .map(function (w) { return escapeRe(skel(w)); }).join('|') + ')\\.\\s*[A-Z0-9\\u0400-\\u04FF]');

  function columnOf(row, ln, spanIndex) {
    var next = null;
    for (var k = spanIndex + 1; k < row.spans.length; k++) {
      var l2 = lineAt(row, row.spans[k].start);
      if (l2 !== ln && l2.x > ln.x) { next = l2; break; }
    }
    return {from: ln.x - 0.03, to: next ? next.x - 0.005 : 1.01};
  }

  function applyOwnerBlocking(rows) {
    rows.forEach(function (row) {
      row.lines.forEach(function (ln) {
        if (PERSONAL_RE.test(ln.text) || ADDRESS_RE.test(ln.skel)) maskLine(ln);
      });
    });
    rows.forEach(function (row, ri) {
      row.spans.forEach(function (sp, si) {
        if (sp.kind !== 'owner') return;
        var end = segEnd(row, si);
        for (var k = sp.start; k < end; k++) row.mask[k] = true;
        if (hasContent(row.text.slice(sp.end, end))) return;
        // Значение под подписью владельца — блокируем строки ниже в той же колонке.
        var ln = lineAt(row, sp.start), col = columnOf(row, ln, si), maxDy = Math.max(row.h, 0.01) * 5.5;
        for (var r = ri + 1; r < rows.length && r <= ri + 4; r++) {
          var R = rows[r], stop = false;
          if (R.page !== row.page || R.cy - row.cy > maxDy) break;
          R.lines.forEach(function (l) {
            if (l.x < col.from || l.x >= col.to) return;
            if (l.spans.length) { stop = true; return; }
            maskLine(l);
          });
          if (stop) break;
        }
      });
    });
  }

  function findBelow(rows, ri, row, si) {
    var sp = row.spans[si], ln = lineAt(row, sp.start), col = columnOf(row, ln, si);
    var maxDy = Math.max(row.h, 0.01) * 4.5;
    for (var r = ri + 1; r < rows.length && r <= ri + 3; r++) {
      var R = rows[r];
      if (R.page !== row.page || R.cy - row.cy > maxDy) break;
      var picked = [], stop = false;
      R.lines.forEach(function (l) {
        if (stop || l.x < col.from || l.x >= col.to) return;
        if (l.spans.length) {
          var sameLabelOnly = l.labelOnly && l.spans.every(function (s) { return s.kind === sp.kind; });
          if (!sameLabelOnly) stop = true;
          return;
        }
        if (l.blocked) { stop = true; return; }
        picked.push(l);
      });
      if (picked.length) {
        return {
          text: picked.map(function (l) { return blank(R, l.start, l.end); }).join('   '),
          conf: Math.min.apply(null, picked.map(function (l) { return l.conf; })),
          lines: picked
        };
      }
      if (stop) return null;
    }
    return null;
  }

  function confRange(row, a, b) {
    var c = 1;
    row.lines.forEach(function (l) { if (l.start < b && a < l.end) c = Math.min(c, l.conf); });
    return c;
  }

  // ---------------------------------------------------------------------------
  // Страна документа
  // ---------------------------------------------------------------------------
  var DOC_HINTS = [
    ['MD', ['REPUBLICA MOLDOVA', 'РЕСПУБЛИКА МОЛДОВА', 'MOLDOVA', 'МОЛДОВА', 'IDNP', 'IDNO']],
    ['RO', ['ROMANIA', 'DRPCIV', 'CNP']],
    ['RU', ['РОССИЙСКАЯ ФЕДЕРАЦИЯ', 'РОССИЯ', 'ГИБДД', 'ГОСАВТОИНСПЕКЦИЯ', 'МВД РОССИИ']],
    ['UA', ['УКРАЇНА', 'УКРАИНА', 'СВІДОЦТВО', 'РЕЄСТРАЦІЮ', 'МВС УКРАЇНИ', 'НОМЕРНИЙ ЗНАК']],
    ['KZ', ['ҚАЗАҚСТАН', 'КАЗАХСТАН', 'ТІРКЕУ', 'КУӘЛІГІ']]
  ].map(function (e) { return [e[0], e[1].map(function (k) { return compileKw(k, 'doc'); })]; });

  function detectDocType(rows) {
    var all = rows.map(function (r) { return r.skel; }).join('\n');
    var score = {MD: 0, RO: 0, RU: 0, UA: 0, KZ: 0};
    DOC_HINTS.forEach(function (e) {
      e[1].forEach(function (ck) { ck.re.lastIndex = 0; if (ck.re.test(all)) score[e[0]] += 3; });
    });
    var lat = 0, cyr = 0, codes = 0;
    rows.forEach(function (r) {
      r.spans.forEach(function (s) {
        if (s.via !== 'label' || s.kind === 'other' || s.kind === 'owner') { if (s.via !== 'label') codes++; }
        if (s.lat) lat++;
        if (s.cyr) cyr++;
      });
    });
    if (lat >= 2 && cyr >= 2) score.MD += 2;
    else if (lat >= 2) score.RO += 1;
    else if (cyr >= 2) score.RU += 1;
    var best = null;
    ['MD', 'RO', 'RU', 'UA', 'KZ'].forEach(function (k) { if (score[k] > 0 && (!best || score[k] > score[best])) best = k; });
    if (!best && codes >= 2) best = 'EU';
    return best;
  }

  // ---------------------------------------------------------------------------
  // Кандидаты
  // ---------------------------------------------------------------------------
  function addCand(store, field, parsed, conf, via, lineIds, extra) {
    if (!parsed || parsed.value == null || parsed.value === '') return;
    var list = store[field] || (store[field] = []);
    var key = typeof parsed.value === 'string' ? parsed.value.toUpperCase() : parsed.value;
    var ex = null;
    for (var i = 0; i < list.length; i++) if (list[i].key === key) { ex = list[i]; break; }
    conf = clamp01(conf);
    var src = lineIds.join(',');
    if (ex) {
      if (ex.sources.indexOf(src) < 0) ex.sources.push(src);
      if (conf > ex.conf) { ex.conf = conf; ex.parsed = parsed; ex.via = via; ex.extra = extra || ex.extra; }
    } else {
      list.push({key: key, parsed: parsed, conf: conf, via: via, sources: [src], extra: extra || null});
    }
  }

  function addLine(out, field, text, lineIds) {
    var t = collapse(text);
    if (!hasContent(t) || PERSONAL_RE.test(t)) return;
    for (var i = 0; i < out.length; i++) if (out[i].text === t && out[i].field === field) return;
    out.push({field: field, text: t, ids: lineIds});
  }

  function extract(rows, ctx, store, lineOut) {
    rows.forEach(function (row, ri) {
      row.spans.forEach(function (sp, si) {
        if (!VEHICLE_KINDS[sp.kind]) return;
        var end = segEnd(row, si);
        var seg = blank(row, sp.end, end);
        var parser = PARSERS[sp.kind];
        var ids = row.lines.filter(function (l) { return l.start < end && sp.start < l.end; }).map(function (l) { return l.id; });
        var base = sp.via === 'code+label' ? 0.96 : sp.via === 'code' ? 0.92 : 0.9;
        var lc = confRange(row, sp.start, end);
        var got = hasContent(seg) ? parser(seg, ctx) : null;
        if (sp.kind === 'model' && /^\s*[0-9A-Z]{1,2}\s*$/.test(seg) && /MODEL$/.test(row.skel.slice(sp.start, sp.end))) {
          got = parseModelValue('MODEL ' + seg.trim());
        }
        var belowText = null;
        if (!got) {
          var below = findBelow(rows, ri, row, si);
          if (below) {
            got = parser(below.text, ctx);
            if (got) {
              base -= 0.06; lc = Math.min(lc, below.conf); belowText = below.text;
              ids = ids.concat(below.lines.map(function (l) { return l.id; }));
            }
          }
        }
        var field = FIELD_OF[sp.kind];
        var labelText = collapse(blank(row, sp.start, end)) + (belowText ? ' ↓ ' + collapse(belowText) : '');
        addLine(lineOut, field, labelText, ids);
        if (!got) return;
        var ocr = 0.8 + 0.2 * lc;
        if (sp.kind === 'makeModel') {
          if (got.make) addCand(store, 'make', got.make, base * got.make.q * ocr, 'label', ids);
          if (got.model) addCand(store, 'model', got.model, base * got.model.q * ocr, 'label', ids);
          return;
        }
        if (sp.kind === 'type') base = 0.45;
        if (sp.kind === 'firstReg') base *= 0.82;
        addCand(store, field, got, base * got.q * ocr, sp.via, ids);
      });
    });
  }

  // Поиск по шаблонам без подписи (VIN, номер, марка, топливо, объём с «см³»).
  function ownerKindOf(row, ln) {
    if (ln.spans.length) return ln.spans[0].kind;
    var kind = null;
    row.spans.forEach(function (s) { if (s.start < ln.start) kind = s.kind; });
    return kind;
  }

  function globalScan(rows, ctx, store, lineOut) {
    rows.forEach(function (row) {
      row.lines.forEach(function (ln) {
        if (ln.blocked) return;
        var t = blank(row, ln.start, ln.end);
        if (!hasContent(t)) return;
        var kind = ownerKindOf(row, ln), ocr = 0.8 + 0.2 * ln.conf, ids = [ln.id];

        findVins(t).forEach(function (f) {
          if (!vinPlausible(f.value)) return;
          var st = vinCheckStatus(f.value);
          if (st === 'fail') return;
          addCand(store, 'vin', {value: f.value, q: 1, check: st}, (st === 'ok' ? 0.9 : 0.8) * ocr, 'pattern', ids);
          addLine(lineOut, 'vin', t, ids);
        });

        if (!kind || kind === 'plate' || kind === 'other') {
          var p = parsePlate(t, ctx.docType);
          if (p && p.coverage >= 0.5) {
            var c = (p.strong ? 0.6 : 0.45) + (p.country === ctx.docType ? 0.1 : 0);
            addCand(store, 'plate', {value: p.value, q: 1, country: p.country}, c * ocr, 'pattern', ids);
            addLine(lineOut, 'plate', t, ids);
          }
        }

        if (!kind || kind === 'make' || kind === 'model' || kind === 'makeModel' || kind === 'type' || kind === 'other') {
          var mk = findMakes(ln.skel);
          if (mk.length) {
            addCand(store, 'make', {value: mk[0].make, q: 1}, (kind === 'model' || kind === 'type' ? 0.5 : 0.6) * ocr, 'pattern', ids);
            addLine(lineOut, 'make', t, ids);
          }
        }

        if (!kind || kind === 'fuel' || kind === 'other') {
          var f = parseFuel(t, false);
          if (f) { addCand(store, 'fuel', f, 0.5 * ocr, 'pattern', ids); addLine(lineOut, 'fuel', t, ids); }
        }

        if (!kind || kind === 'cc') {
          var m = /([0-9][0-9 .,]{1,5}[0-9]|[0-9]{2,4})\s*(CM3|CMC|CC|KYБ|CUB)(?![A-Z])/.exec(fixDigits(skel(t)));
          if (m) {
            var cc = parseCcValue(m[1]);
            if (cc) { addCand(store, 'engine_cc', cc, 0.55 * ocr, 'pattern', ids); addLine(lineOut, 'engine_cc', t, ids); }
          }
        }
      });
    });
  }

  function best(store, field) {
    var list = store[field];
    if (!list || !list.length) return null;
    list.forEach(function (c) { c.score = Math.min(0.99, c.conf + 0.03 * (c.sources.length - 1)); });
    list.sort(function (a, b) { return b.score - a.score; });
    return list[0];
  }

  var MAIN_FIELDS = ['plate', 'vin', 'make', 'model', 'year', 'engine_cc', 'fuel', 'color', 'category'];

  /**
   * Разбирает результат OCR техпаспорта.
   * @param {Array|Object|string} pages  r.pages из HelperScan.scanDocument() (или сам r)
   * @param {{now?: Date}} [opts]
   * @returns {{docType, plate, plate_country, vin, make, model, year, engine_cc, engine, fuel, color, color_key,
   *            category, mass, mass_empty, confidence, hints, candidates, warnings, found}}
   */
  function parseVehicleDoc(pages, opts) {
    opts = opts || {};
    var now = opts.now instanceof Date ? opts.now : new Date();
    var ctx = {now: now, maxYear: now.getFullYear() + 1, docType: null};
    var lines = normalizeInput(pages);
    var rows = buildRows(lines);
    rows.forEach(detectSpans);
    computeColumnCuts(rows);
    applyOwnerBlocking(rows);
    ctx.docType = detectDocType(rows);

    var store = {}, lineOut = [];
    extract(rows, ctx, store, lineOut);
    globalScan(rows, ctx, store, lineOut);

    var res = {
      docType: ctx.docType, plate: null, plate_country: null, vin: null, make: null, model: null, year: null,
      engine_cc: null, engine: null, fuel: null, color: null, color_key: null, category: null, mass: null,
      mass_empty: null, confidence: {}, hints: {}, candidates: [], warnings: [], found: 0
    };
    ['plate', 'vin', 'make', 'model', 'year', 'engine_cc', 'fuel', 'color', 'category', 'mass', 'mass_empty'].forEach(function (f) {
      var b = best(store, f);
      if (!b) return;
      res[f] = b.parsed.value;
      res.confidence[f] = round2(b.score);
      if (f === 'plate') res.plate_country = b.parsed.country || null;
      if (f === 'color') res.color_key = b.parsed.key || null;
      if (f === 'year') res.hints.year_source = b.parsed.date ? 'first_registration' : 'manufacture';
      if (f === 'vin') res.hints.vin_check = b.parsed.check || 'n/a';
    });

    // Подсказки по VIN: марка (WMI) и модельный год (10-й символ, слабая подсказка).
    if (res.vin) {
      var vm = makeFromVin(res.vin), vy = vinModelYear(res.vin, now);
      if (vm) res.hints.vin_make = vm;
      if (vy) res.hints.vin_year = vy;
      if (vm) {
        if (!res.make) {
          res.make = vm; res.confidence.make = 0.6; res.hints.make_source = 'vin';
        } else if (res.make === vm) {
          res.confidence.make = round2(Math.min(0.99, res.confidence.make + 0.05));
        } else {
          res.confidence.make = round2(res.confidence.make * 0.75);
          res.warnings.push('Марка в документе (' + res.make + ') не совпадает с VIN (' + vm + ') — проверьте.');
        }
      }
      if (vy) {
        if (!res.year) {
          res.year = vy; res.confidence.year = 0.3; res.hints.year_source = 'vin';
        } else if (Math.abs(res.year - vy) <= 1) {
          res.confidence.year = round2(Math.min(0.99, res.confidence.year + 0.03));
        }
      }
    }
    if (res.make && MAKES.indexOf(res.make) < 0) res.hints.make_not_in_list = true;
    if (res.fuel === 'ev') { res.engine_cc = null; delete res.confidence.engine_cc; }
    res.engine = ccToLiters(res.engine_cc);
    if (res.engine) res.confidence.engine = res.confidence.engine_cc;
    if (!res.plate_country && res.plate) res.plate_country = null;
    if (!res.docType && res.plate_country) res.docType = res.plate_country;

    res.found = MAIN_FIELDS.filter(function (f) { return res[f] != null; }).length;
    res.candidates = lineOut.map(function (c) { return {field: c.field, text: c.text}; });
    if (!lines.length) res.warnings.push('Текст не распознан. Сфотографируйте техпаспорт ровно, целиком и без бликов.');
    else if (!res.found) res.warnings.push('Не нашли данных автомобиля. Проверьте, что в кадре сторона с маркой и VIN.');
    return res;
  }

  /**
   * Поля для формы автомобиля приложения (ui.onb.d / car): {make, model, year, fuel, engine, vin, plate}.
   * Возвращает только найденные поля с уверенностью ≥ minConfidence (по умолчанию 0).
   */
  function toCarForm(res, minConfidence) {
    var min = typeof minConfidence === 'number' ? minConfidence : 0, out = {};
    if (!res) return out;
    ['make', 'model', 'year', 'fuel', 'engine', 'vin', 'plate'].forEach(function (f) {
      if (res[f] == null) return;
      var c = res.confidence && res.confidence[f];
      if (typeof c === 'number' && c < min) return;
      out[f] = f === 'year' ? String(res[f]) : res[f];
    });
    return out;
  }

  return {
    VERSION: VERSION,
    MAKES: MAKES.slice(),
    COLOR_NAMES_RU: COLOR_NAMES_RU,
    parseVehicleDoc: parseVehicleDoc,
    toCarForm: toCarForm,
    normalizeMake: normalizeMake,
    makeFromVin: makeFromVin,
    vinModelYear: vinModelYear,
    vinCheckDigitOk: vinCheckDigitOk,
    parseVin: function (t) { var v = parseVinValue(t); return v ? v.value : null; },
    parsePlate: function (t, prefer) { var p = parsePlate(t, prefer); return p ? {value: p.value, country: p.country} : null; },
    parseFuel: function (t) { var f = parseFuel(t, true); return f ? f.value : null; },
    ccToLiters: ccToLiters
  };
});
