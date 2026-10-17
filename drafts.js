/* Small local drafts only. Never pass credentials, photos or payment data here. */
(function (root) {
  'use strict';
  const PREFIX = 'helper.drafts.v1:', TTL = 7 * 86400000, LIMIT = 64;
  const key = (scope, kind) => PREFIX + encodeURIComponent(scope) + ':' + encodeURIComponent(kind);
  const valid = x => x && x.v === 1 && Number.isFinite(x.at) && Date.now() - x.at < TTL && x.at <= Date.now() && x.data && typeof x.data === 'object' && !Array.isArray(x.data);
  const api = {
    get(storage, scope, kind) {
      try {
        const k = key(scope, kind), x = JSON.parse(storage.getItem(k));
        if (valid(x)) return x.data;
        storage.removeItem(k);
      } catch (_) {}
      return null;
    },
    put(storage, scope, kind, data) {
      try {
        const raw = JSON.stringify({v: 1, at: Date.now(), data});
        if (raw.length > 50000) return false;
        const target = key(scope, kind);
        // Typing updates one small draft; scan/prune storage only when adding a new key.
        if (storage.getItem(target) !== null) { storage.setItem(target, raw); return true; }
        const entries = [];
        for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) entries.push(k); }
        const live = [];
        entries.forEach(k => {
          let x; try { x = JSON.parse(storage.getItem(k)); } catch (_) {}
          if (!valid(x)) storage.removeItem(k); else live.push({k, at: x.at});
        });
        live.sort((a, b) => a.at - b.at);
        while (live.length >= LIMIT) storage.removeItem(live.shift().k);
        storage.setItem(key(scope, kind), raw);
        return true;
      } catch (_) { return false; }
    },
    drop(storage, scope, kind) {
      try { storage.removeItem(key(scope, kind)); } catch (_) {}
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HelperDrafts = api;
})(typeof window === 'object' ? window : this);
