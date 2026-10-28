/* HSE store: localStorage persistence */
(function (global) {
  const KEY = "kfm-hse-observations-v1";

  function cloneSeed() {
    const s = JSON.parse(JSON.stringify(global.HSE_SEED || { target: 40, observations: [], photos: {} }));
    if (!s.photos) s.photos = {};
    if (!s.target) s.target = 40;
    if (!s.targetMode) s.targetMode = "CUMULATIVE";
    return s;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return cloneSeed();
      const data = JSON.parse(raw);
      if (!data.observations) data.observations = [];
      if (!data.photos) data.photos = {};
      if (!data.target) data.target = 40;
      if (!data.targetMode) data.targetMode = "CUMULATIVE";
      return data;
    } catch (e) {
      console.warn("Failed to load store, using seed", e);
      return cloneSeed();
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error("Save failed (storage full?)", e);
      return false;
    }
  }

  function reset() {
    const data = cloneSeed();
    save(data);
    return data;
  }

  function isCloseoutReady(data, woNo) {
    const wo = String(woNo || "");
    if (!wo) return false;
    const inReg = (data.observations || []).some((o) => String(o.woNo) === wo);
    if (!inReg) return false;
    const p = (data.photos || {})[wo] || {};
    return !!(p.before && p.during && p.after);
  }

  function photoStatus(data, woNo) {
    const p = (data.photos || {})[String(woNo)] || {};
    return {
      before: !!p.before,
      during: !!p.during,
      after: !!p.after,
      ready: isCloseoutReady(data, woNo),
    };
  }

  global.HSEStore = { KEY, load, save, reset, cloneSeed, isCloseoutReady, photoStatus };
})(window);
