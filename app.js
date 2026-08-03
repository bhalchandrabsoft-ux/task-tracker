/* ============================================================================
   ROTATION — Branch Task Duty Tracker
   Single-file offline PWA logic.

   Module map (each is a self-contained IIFE exposing a small API):
     Storage         -> IndexedDB wrapper (employees, tasks, holidays, records)
     DateUtil        -> calendar/date math, working-day + special-day detection
     HolidayManager  -> CRUD over holidays + holiday lookup
     EmployeeManager -> CRUD over employees
     TaskManager     -> CRUD over tasks
     Scheduler       -> the rotation algorithm (blocks, sequences, prediction)
     Reports         -> aggregate stats + CSV export
     UI              -> rendering, view routing, event wiring (the "app")
   ============================================================================ */

(function(){
"use strict";

function uid(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,10);
}

/* ============================================================
   STORAGE — IndexedDB wrapper, with an automatic localStorage
   fallback.

   Why the fallback exists: in Safari Private Browsing (and some
   locked-down WebView/preview contexts), indexedDB.open() is
   known to silently HANG — it never fires onsuccess or onerror,
   so every await on it stalls forever and the whole app appears
   frozen the moment you try to save anything. There is no event
   to catch, so the only reliable guard is a timeout race: if
   IndexedDB hasn't opened within a couple of seconds, or isn't
   present at all, switch to a synchronous localStorage-backed
   store with the exact same async API. This also satisfies the
   "IndexedDB (preferred) or LocalStorage" requirement directly.
   ============================================================ */
const Storage = (function(){
  const DB_NAME = "rotation-db";
  const DB_VERSION = 1;
  const OPEN_TIMEOUT_MS = 2500;
  const STORE_NAMES = ["employees","tasks","holidays","records"];
  let backendPromise = null;
  let usingFallback = false;

  /* ---- IndexedDB-backed implementation ---- */
  function idbBackend(db){
    function tx(store, mode){ return db.transaction(store, mode).objectStore(store); }
    return {
      getAll(store){
        return new Promise((resolve, reject) => {
          const req = tx(store, "readonly").getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      },
      put(store, value){
        return new Promise((resolve, reject) => {
          const req = tx(store, "readwrite").put(value);
          req.onsuccess = () => resolve(value);
          req.onerror = () => reject(req.error);
        });
      },
      bulkPut(store, values){
        return new Promise((resolve, reject) => {
          const t = db.transaction(store, "readwrite");
          const os = t.objectStore(store);
          values.forEach(v => os.put(v));
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        });
      },
      del(store, id){
        return new Promise((resolve, reject) => {
          const req = tx(store, "readwrite").delete(id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      clear(store){
        return new Promise((resolve, reject) => {
          const req = tx(store, "readwrite").clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      getSetting(key, fallback){
        return new Promise((resolve) => {
          const req = tx("settings", "readonly").get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
          req.onerror = () => resolve(fallback);
        });
      },
      setSetting(key, value){
        return new Promise((resolve, reject) => {
          const req = tx("settings", "readwrite").put({ key, value });
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      }
    };
  }

  /* ---- localStorage-backed fallback implementation ---- */
  function localBackend(){
    const nsKey = (store) => "rotation:" + store;
    function readArr(store){
      try { return JSON.parse(localStorage.getItem(nsKey(store)) || "[]"); }
      catch(e){ return []; }
    }
    function writeArr(store, arr){
      try { localStorage.setItem(nsKey(store), JSON.stringify(arr)); } catch(e){ /* quota exceeded etc: best effort */ }
    }
    function readSettings(){
      try { return JSON.parse(localStorage.getItem("rotation:settings") || "{}"); }
      catch(e){ return {}; }
    }
    function writeSettings(obj){
      try { localStorage.setItem("rotation:settings", JSON.stringify(obj)); } catch(e){}
    }
    return {
      async getAll(store){ return readArr(store); },
      async put(store, value){
        const arr = readArr(store);
        const idx = arr.findIndex(x => x.id === value.id);
        if (idx >= 0) arr[idx] = value; else arr.push(value);
        writeArr(store, arr);
        return value;
      },
      async bulkPut(store, values){
        const arr = readArr(store);
        values.forEach(v => {
          const idx = arr.findIndex(x => x.id === v.id);
          if (idx >= 0) arr[idx] = v; else arr.push(v);
        });
        writeArr(store, arr);
      },
      async del(store, id){ writeArr(store, readArr(store).filter(x => x.id !== id)); },
      async clear(store){ writeArr(store, []); },
      async getSetting(key, fallback){ const s = readSettings(); return (key in s) ? s[key] : fallback; },
      async setSetting(key, value){ const s = readSettings(); s[key] = value; writeSettings(s); }
    };
  }

  /* ---- Backend selection: IndexedDB if it opens promptly, else localStorage ---- */
  function pickBackend(){
    if (backendPromise) return backendPromise;
    backendPromise = new Promise((resolve) => {
      if (!window.indexedDB){ usingFallback = true; resolve(localBackend()); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        usingFallback = true;
        console.warn("Rotation: IndexedDB did not respond in time — using localStorage instead.");
        resolve(localBackend());
      }, OPEN_TIMEOUT_MS);

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("employees")) db.createObjectStore("employees", { keyPath:"id" });
          if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath:"id" });
          if (!db.objectStoreNames.contains("holidays")) db.createObjectStore("holidays", { keyPath:"id" });
          if (!db.objectStoreNames.contains("records")){
            const s = db.createObjectStore("records", { keyPath:"id" });
            s.createIndex("byTaskDate", ["taskId","date"], { unique:true });
            s.createIndex("byTask", "taskId", { unique:false });
          }
          if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath:"key" });
        };
        req.onsuccess = (e) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve(idbBackend(e.target.result));
        };
        req.onerror = () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          usingFallback = true;
          resolve(localBackend());
        };
      } catch (err){
        if (!settled){
          settled = true; clearTimeout(timer);
          usingFallback = true;
          resolve(localBackend());
        }
      }
    });
    return backendPromise;
  }

  async function getAll(store){ const b = await pickBackend(); return b.getAll(store); }
  async function put(store, value){ const b = await pickBackend(); return b.put(store, value); }
  async function bulkPut(store, values){ const b = await pickBackend(); return b.bulkPut(store, values); }
  async function del(store, id){ const b = await pickBackend(); return b.del(store, id); }
  async function clear(store){ const b = await pickBackend(); return b.clear(store); }
  async function clearAll(){ await Promise.all(STORE_NAMES.map(clear)); }
  async function getSetting(key, fallback){ const b = await pickBackend(); return b.getSetting(key, fallback); }
  async function setSetting(key, value){ const b = await pickBackend(); return b.setSetting(key, value); }

  async function exportAll(){
    const [employees, tasks, holidays, records] = await Promise.all([
      getAll("employees"), getAll("tasks"), getAll("holidays"), getAll("records")
    ]);
    return { version:1, exportedAt:new Date().toISOString(), employees, tasks, holidays, records };
  }

  async function importAll(payload){
    if (!payload || typeof payload !== "object") throw new Error("Invalid backup file");
    await clearAll();
    if (Array.isArray(payload.employees)) await bulkPut("employees", payload.employees);
    if (Array.isArray(payload.tasks)) await bulkPut("tasks", payload.tasks);
    if (Array.isArray(payload.holidays)) await bulkPut("holidays", payload.holidays);
    if (Array.isArray(payload.records)) await bulkPut("records", payload.records);
  }

  function isUsingFallback(){ return usingFallback; }

  return { getAll, put, bulkPut, del, clear, clearAll, getSetting, setSetting, exportAll, importAll, isUsingFallback };
})();

/* ============================================================
   DATE UTIL — calendar math, YYYY-MM-DD strings used internally.
   ============================================================ */
const DateUtil = (function(){
  function pad(n){ return String(n).padStart(2,"0"); }
  function toISO(d){ return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }
  function fromISO(s){ const p = s.split("-").map(Number); return new Date(p[0], p[1]-1, p[2]); }
  function addDays(d, n){ const r = new Date(d); r.setDate(r.getDate()+n); return r; }
  function isSameDay(a,b){ return toISO(a) === toISO(b); }

  function saturdaysOfMonth(year, month){
    const out = [];
    const d = new Date(year, month, 1);
    while (d.getMonth() === month){
      if (d.getDay() === 6) out.push(new Date(d));
      d.setDate(d.getDate()+1);
    }
    return out;
  }

  function weekendFlags(date){
    const day = date.getDay();
    if (day === 0) return { isSunday:true, isSecondSat:false, isFourthSat:false };
    if (day !== 6) return { isSunday:false, isSecondSat:false, isFourthSat:false };
    const sats = saturdaysOfMonth(date.getFullYear(), date.getMonth());
    const idx = sats.findIndex(s => isSameDay(s, date));
    return { isSunday:false, isSecondSat: idx === 1, isFourthSat: idx === 3 };
  }

  function monthLabel(year, month){
    return new Date(year, month, 1).toLocaleString(undefined, { month:"long" });
  }

  function monthGrid(year, month){
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const cells = [];
    for (let i=0;i<startPad;i++) cells.push(null);
    for (let d=1; d<=daysInMonth; d++) cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }

  return { pad, toISO, fromISO, addDays, isSameDay, saturdaysOfMonth, weekendFlags, monthLabel, monthGrid };
})();

/* ============================================================
   HOLIDAY MANAGER
   holiday: { id, date:"YYYY-MM-DD" (anchor), recurring:bool, description }
   ============================================================ */
const HolidayManager = (function(){
  let cache = [];

  async function load(){ cache = await Storage.getAll("holidays"); cache.sort((a,b)=>a.date.localeCompare(b.date)); return cache; }
  function all(){ return cache; }

  function isHoliday(date){
    const iso = DateUtil.toISO(date);
    const mmdd = iso.slice(5);
    return cache.find(h => h.recurring ? h.date.slice(5) === mmdd : h.date === iso) || null;
  }

  async function add(h){
    const rec = { id: h.id || uid(), date:h.date, recurring: !!h.recurring, description: h.description || "" };
    await Storage.put("holidays", rec);
    await load();
    return rec;
  }
  async function update(h){ await Storage.put("holidays", h); await load(); }
  async function remove(id){ await Storage.del("holidays", id); await load(); }

  return { load, all, isHoliday, add, update, remove };
})();

/* ============================================================
   EMPLOYEE MANAGER
   employee: { id, name, color }
   ============================================================ */
const EmployeeManager = (function(){
  let cache = [];
  const PALETTE = ["#5B7FA6","#B8873B","#6E8F5C","#A65B6E","#7A6EA6","#4C9A9A","#B0793F","#5C6BA6"];

  async function load(){ cache = await Storage.getAll("employees"); cache.sort((a,b)=>a.name.localeCompare(b.name)); return cache; }
  function all(){ return cache; }
  function byId(id){ return cache.find(e => e.id === id) || null; }
  function nextColor(){ return PALETTE[cache.length % PALETTE.length]; }

  async function add(name, color){
    const rec = { id: uid(), name: name.trim(), color: color || nextColor() };
    await Storage.put("employees", rec);
    await load();
    return rec;
  }
  async function update(rec){ await Storage.put("employees", rec); await load(); }
  async function remove(id){
    await Storage.del("employees", id);
    const tasks = await Storage.getAll("tasks");
    for (const t of tasks){
      if (t.employeeIds && t.employeeIds.includes(id)){
        t.employeeIds = t.employeeIds.filter(x => x !== id);
        await Storage.put("tasks", t);
      }
    }
    await load();
  }

  return { load, all, byId, nextColor, PALETTE };
})();

/* ============================================================
   TASK MANAGER
   task: { id, name, employeeIds:[...] }
   ============================================================ */
const TaskManager = (function(){
  let cache = [];

  async function load(){ cache = await Storage.getAll("tasks"); cache.sort((a,b)=>a.name.localeCompare(b.name)); return cache; }
  function all(){ return cache; }
  function byId(id){ return cache.find(t => t.id === id) || null; }

  async function add(name, employeeIds){
    const rec = { id: uid(), name: name.trim(), employeeIds: employeeIds || [] };
    await Storage.put("tasks", rec);
    await load();
    return rec;
  }
  async function update(rec){ await Storage.put("tasks", rec); await load(); }
  async function remove(id){
    await Storage.del("tasks", id);
    const allRecs = await Storage.getAll("records");
    for (const r of allRecs){ if (r.taskId === id) await Storage.del("records", r.id); }
    await load();
  }

  return { load, all, byId, add, update, remove };
})();

/* ============================================================
   RECORDS — the actual recorded history of "who performed the
   task on this working day". This is the only ground truth the
   Scheduler trusts; everything else is derived/predicted live.
   record: { id, taskId, date:"YYYY-MM-DD", employeeId, notes }
   ============================================================ */
const RecordStore = (function(){
  let cache = []; // all records, all tasks

  async function load(){ cache = await Storage.getAll("records"); return cache; }
  function forTask(taskId){
    return cache.filter(r => r.taskId === taskId).sort((a,b)=> a.date.localeCompare(b.date));
  }
  function find(taskId, date){
    return cache.find(r => r.taskId === taskId && r.date === date) || null;
  }

  async function set(taskId, date, employeeId, notes){
    const existing = find(taskId, date);
    const rec = existing
      ? Object.assign({}, existing, { employeeId, notes: notes !== undefined ? notes : existing.notes })
      : { id: uid(), taskId, date, employeeId, notes: notes || "" };
    await Storage.put("records", rec);
    await load();
    return rec;
  }

  async function setNotes(taskId, date, notes){
    const existing = find(taskId, date);
    if (!existing) return null;
    existing.notes = notes;
    await Storage.put("records", existing);
    await load();
    return existing;
  }

  async function clear(taskId, date){
    const existing = find(taskId, date);
    if (existing){ await Storage.del("records", existing.id); await load(); }
  }

  return { load, forTask, find, set, setNotes, clear };
})();

/* ============================================================
   SCHEDULER — the rotation algorithm.

   Core idea: walk every WORKING DAY in chronological order,
   starting from the task's first recorded entry. For each day,
   use the explicit record if one exists; otherwise predict.

   BLOCK: a run of consecutive working days performed by the
   same employee (holidays/weekends are skipped entirely and do
   not break a block — they simply don't exist in the walk).

   TARGET SIZE: the block size every subsequent block should
   mirror. It starts at 1 (plain alternation) and is reset to
   the size of each block once that block finishes — so a
   manual override that creates a 2-day (or N-day) block
   automatically makes the *next* block 2 (or N) days too, and
   that becomes the new standard going forward until another
   override changes it again. This is exactly the "General Rule"
   in the spec: mirror the most recently completed block.

   SEQUENCE: one full rotation cycle through every employee
   assigned to the task, at the current target size. For two
   employees this is exactly "one A-block + the matching
   B-block", matching the spec's coloring examples. For N
   employees it's one block per employee. Every date in a
   sequence shares one color; the color advances only when a
   sequence completes.
   ============================================================ */
const Scheduler = (function(){

  const SEQ_COLOR_COUNT = 8; // matches CSS --seq-0..--seq-7

  function nextEmployeeId(currentId, employeeIds){
    const idx = employeeIds.indexOf(currentId);
    if (idx === -1) return employeeIds[0];
    return employeeIds[(idx + 1) % employeeIds.length];
  }

  // Build the list of working-day Date objects (ascending) between
  // two ISO date strings, inclusive, skipping Sundays, 2nd/4th
  // Saturdays, and holidays.
  function workingDaysBetween(startISO, endISO){
    const start = DateUtil.fromISO(startISO);
    const end = DateUtil.fromISO(endISO);
    const out = [];
    let d = new Date(start);
    while (d <= end){
      const flags = DateUtil.weekendFlags(d);
      const holiday = HolidayManager.isHoliday(d);
      if (!flags.isSunday && !flags.isSecondSat && !flags.isFourthSat && !holiday){
        out.push(new Date(d));
      }
      d = DateUtil.addDays(d, 1);
    }
    return out;
  }

  /*
   * computeSchedule(task, horizonEndISO)
   * Returns a Map<dateISO, {
   *   employeeId, isManual, blockIndex, blockPosition, blockSize,
   *   sequenceIndex, colorSlot, notes
   * }> covering every working day from the task's first record
   * through horizonEndISO. Days before the first record are left
   * out entirely (nothing to predict from yet).
   */
  function computeSchedule(task, horizonEndISO){
    const result = new Map();
    const employeeIds = (task.employeeIds || []).filter(id => EmployeeManager.byId(id));
    const records = RecordStore.forTask(task.id);
    if (employeeIds.length === 0 || records.length === 0) return result;

    const recordMap = new Map(records.map(r => [r.date, r]));
    const startISO = records[0].date;
    const endISO = horizonEndISO > startISO ? horizonEndISO : startISO;
    const workingDays = workingDaysBetween(startISO, endISO);

    const blocks = [];               // completed (or trailing in-progress) blocks
    let currentBlock = null;         // { employeeId, dates:[isoStrings] }
    let targetSize = 1;

    for (const dateObj of workingDays){
      const iso = DateUtil.toISO(dateObj);
      const rec = recordMap.get(iso);
      const isManual = !!rec;
      let empId;

      if (isManual){
        empId = rec.employeeId;
      } else if (currentBlock && currentBlock.dates.length < targetSize && employeeIds.includes(currentBlock.employeeId)){
        empId = currentBlock.employeeId;
      } else {
        const fromId = currentBlock ? currentBlock.employeeId : employeeIds[employeeIds.length - 1];
        empId = nextEmployeeId(fromId, employeeIds);
      }

      if (currentBlock && currentBlock.employeeId === empId){
        currentBlock.dates.push(iso);
      } else {
        if (currentBlock){
          blocks.push(currentBlock);
          targetSize = currentBlock.dates.length; // mirror the block just completed
        }
        currentBlock = { employeeId: empId, dates: [iso] };
      }
      result.set(iso, { employeeId: empId, isManual, notes: rec ? rec.notes : "" });
    }
    if (currentBlock) blocks.push(currentBlock);

    // Assign block numbering + sequence grouping + color slots.
    let sequenceIndex = 0;
    const rosterSize = Math.max(employeeIds.length, 1);
    blocks.forEach((b, i) => {
      const posInSequence = i % rosterSize;
      if (posInSequence === 0 && i !== 0) sequenceIndex++;
      const colorSlot = sequenceIndex % SEQ_COLOR_COUNT;
      b.blockIndex = i + 1;
      b.sequenceIndex = sequenceIndex + 1;
      b.colorSlot = colorSlot;
      b.dates.forEach((iso, posInBlock) => {
        const entry = result.get(iso);
        entry.blockIndex = b.blockIndex;
        entry.blockPosition = posInBlock + 1;
        entry.blockSize = b.dates.length;
        entry.sequenceIndex = b.sequenceIndex;
        entry.colorSlot = b.colorSlot;
      });
    });

    return result;
  }

  // Convenience: schedule map plus the raw block list, for reports.
  function computeScheduleWithBlocks(task, horizonEndISO){
    const map = computeSchedule(task, horizonEndISO);
    const blockSeen = new Set();
    const blocks = [];
    for (const [, entry] of map){
      if (entry.blockIndex && !blockSeen.has(entry.blockIndex)){
        blockSeen.add(entry.blockIndex);
      }
    }
    return map;
  }

  return { workingDaysBetween, computeSchedule, computeScheduleWithBlocks };
})();

/* ============================================================
   REPORTS
   ============================================================ */
const Reports = (function(){

  function isWorkingDay(dateObj){
    const flags = DateUtil.weekendFlags(dateObj);
    const holiday = HolidayManager.isHoliday(dateObj);
    return !flags.isSunday && !flags.isSecondSat && !flags.isFourthSat && !holiday;
  }

  // Employee-wise counts for a task across a date range [startISO, endISO].
  function employeeCounts(task, startISO, endISO){
    const schedule = Scheduler.computeSchedule(task, endISO);
    const counts = new Map();
    (task.employeeIds || []).forEach(id => counts.set(id, { manual:0, predicted:0 }));
    for (const [iso, entry] of schedule){
      if (iso < startISO || iso > endISO) continue;
      if (!counts.has(entry.employeeId)) counts.set(entry.employeeId, { manual:0, predicted:0 });
      const c = counts.get(entry.employeeId);
      if (entry.isManual) c.manual++; else c.predicted++;
    }
    return counts;
  }

  function blockHistory(task, endISO){
    const schedule = Scheduler.computeSchedule(task, endISO);
    const byBlock = new Map();
    for (const [iso, entry] of schedule){
      if (!entry.blockIndex) continue;
      if (!byBlock.has(entry.blockIndex)){
        byBlock.set(entry.blockIndex, {
          blockIndex: entry.blockIndex, employeeId: entry.employeeId,
          size: entry.blockSize, sequenceIndex: entry.sequenceIndex,
          start: iso, end: iso
        });
      } else {
        byBlock.get(entry.blockIndex).end = iso;
      }
    }
    return Array.from(byBlock.values());
  }

  function workingDaysInRange(startISO, endISO){
    return Scheduler.workingDaysBetween(startISO, endISO).length;
  }

  function holidaysInRange(startISO, endISO){
    return HolidayManager.all().filter(h => {
      if (h.recurring){
        // count once per year the recurring anniversary falls in range (approx: check every year touched)
        let hit = 0;
        let y = DateUtil.fromISO(startISO).getFullYear();
        const yEnd = DateUtil.fromISO(endISO).getFullYear();
        for (; y <= yEnd; y++){
          const cand = h.date.slice(5);
          const iso = y + "-" + cand;
          if (iso >= startISO && iso <= endISO) hit++;
        }
        return hit > 0;
      }
      return h.date >= startISO && h.date <= endISO;
    }).length;
  }

  function missedAssignments(task, startISO, endISO){
    // "Missed" = working days in range with no manual record at all (still awaiting entry).
    const schedule = Scheduler.computeSchedule(task, endISO);
    let missed = 0;
    for (const [iso, entry] of schedule){
      if (iso < startISO || iso > endISO) continue;
      if (!entry.isManual) missed++;
    }
    return missed;
  }

  function toCSV(rows){
    return rows.map(row => row.map(cell => {
      const s = String(cell === undefined || cell === null ? "" : cell);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
    }).join(",")).join("\r\n");
  }

  function downloadCSV(filename, rows){
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return { employeeCounts, blockHistory, workingDaysInRange, holidaysInRange, missedAssignments, toCSV, downloadCSV, isWorkingDay };
})();

/* ============================================================
   UI — rendering + event wiring. This is the "app" layer that
   ties every manager above into the on-screen experience.
   ============================================================ */
const UI = (function(){
  const state = {
    view: "calendar",         // calendar | people | reports | more
    taskId: null,
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    theme: "light"
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function toast(msg){
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove("show"), 1800);
  }

  /* ---------- Overlay / Sheet helpers ---------- */
  const overlay = $("#overlayGeneric");
  const sheet = $("#sheetGeneric");

  // iOS Safari does not reliably respect `overflow:hidden` on <body> to
  // stop background scrolling — and when an <input> inside a
  // position:fixed sheet receives focus (keyboard opens), iOS
  // auto-scrolls the layout viewport to reveal it, which can visually
  // detach fixed-position elements from the screen (the sheet appears
  // to sit mid-page with content above and below it, exactly as if the
  // page had scrolled underneath it). Pinning <body> itself with
  // position:fixed while the sheet is open — and restoring the exact
  // scroll offset on close — is the standard, reliable fix.
  let savedScrollY = 0;
  function lockBodyScroll(){
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.position = "fixed";
    document.body.style.top = "-" + savedScrollY + "px";
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
  }
  function unlockBodyScroll(){
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    window.scrollTo(0, savedScrollY);
  }

  function openSheet(html, opts){
    sheet.innerHTML = '<div class="sheet-grip"></div>' + html;
    overlay.classList.toggle("center", !!(opts && opts.center));
    overlay.classList.add("open");
    lockBodyScroll();
  }
  function closeSheet(){
    overlay.classList.remove("open");
    unlockBodyScroll();
  }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSheet(); });

  /* ---------- Theme ---------- */
  async function applyTheme(theme){
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    await Storage.setSetting("theme", theme);
  }

  /* ---------- Task strip (header) ---------- */
  function renderTaskStrip(){
    const strip = $("#taskStrip");
    const tasks = TaskManager.all();
    if (!state.taskId && tasks.length) state.taskId = tasks[0].id;
    strip.innerHTML = "";
    tasks.forEach(t => {
      const chip = document.createElement("button");
      chip.className = "task-chip" + (t.id === state.taskId ? " active" : "");
      chip.textContent = t.name;
      chip.addEventListener("click", () => { state.taskId = t.id; render(); });
      strip.appendChild(chip);
    });
    const addChip = document.createElement("button");
    addChip.className = "task-chip add-chip";
    addChip.textContent = "+ Task";
    addChip.addEventListener("click", openTaskEditor);
    strip.appendChild(addChip);
  }

  /* ---------- Month navigation ---------- */
  function renderMonthNav(){
    $("#monthTitle").textContent = DateUtil.monthLabel(state.year, state.month);
    $("#yearTitle").textContent = String(state.year);
  }

  /* ---------- Calendar ---------- */
  const dayKindLabel = {
    sun:"Sun", sat2:"Sat", holiday:"Holiday"
  };

  function classifyDay(dateObj, schedule){
    const flags = DateUtil.weekendFlags(dateObj);
    const holiday = HolidayManager.isHoliday(dateObj);
    if (flags.isSunday) return { kind:"sun", special:true, tag:"Sunday" };
    if (flags.isSecondSat || flags.isFourthSat) return { kind:"sat2", special:true, tag: flags.isSecondSat ? "2nd Sat" : "4th Sat" };
    if (holiday) return { kind:"holiday", special:true, tag: holiday.description || "Holiday" };
    const iso = DateUtil.toISO(dateObj);
    const entry = schedule.get(iso);
    if (!entry) return { kind:"empty", special:false, tag:"" };
    return { kind:"seq" + entry.colorSlot, special:false, entry };
  }

  function renderCalendar(){
    const grid = $("#calGrid");
    grid.innerHTML = "";
    const task = TaskManager.byId(state.taskId);
    const cells = DateUtil.monthGrid(state.year, state.month);

    let schedule = new Map();
    if (task){
      // horizon: end of the currently viewed month (so predictions render
      // for future days too), but never before today+90d for smooth scrolling ahead.
      const viewEnd = new Date(state.year, state.month + 1, 0);
      const today = new Date();
      const farAhead = DateUtil.addDays(today, 120);
      const horizon = viewEnd > farAhead ? viewEnd : farAhead;
      schedule = Scheduler.computeSchedule(task, DateUtil.toISO(horizon));
    }

    const todayISO = DateUtil.toISO(new Date());

    cells.forEach(dateObj => {
      const cell = document.createElement("div");
      if (!dateObj){ cell.className = "day-cell pad"; grid.appendChild(cell); return; }

      const iso = DateUtil.toISO(dateObj);
      const info = classifyDay(dateObj, schedule);
      cell.className = "day-cell" + (info.special ? " special" : "") + (iso === todayISO ? " today" : "");
      cell.setAttribute("data-kind", info.kind);
      cell.setAttribute("data-date", iso);

      const num = document.createElement("span");
      num.className = "dnum";
      num.textContent = dateObj.getDate();
      cell.appendChild(num);

      if (info.special){
        const tag = document.createElement("span");
        tag.className = "dtag";
        tag.style.marginTop = "10px";
        tag.textContent = info.tag.length > 9 ? info.tag.slice(0,8) + "…" : info.tag;
        cell.appendChild(tag);
      } else if (info.entry){
        const emp = EmployeeManager.byId(info.entry.employeeId);
        const letter = document.createElement("span");
        letter.className = "dletter";
        letter.textContent = emp ? emp.name.trim().charAt(0).toUpperCase() : "?";
        cell.appendChild(letter);
        if (info.entry.isManual) cell.classList.add("manual"); else cell.classList.add("predicted");
      }

      cell.addEventListener("click", () => openDayDetail(iso));
      grid.appendChild(cell);
    });

    renderLegend(task);
  }

  function renderLegend(task){
    const legend = $("#legend");
    legend.innerHTML = "";
    const items = [
      ["Sunday","var(--sun)"], ["2nd/4th Sat","var(--sat2)"], ["Holiday","var(--holiday)"]
    ];
    items.forEach(([label,color]) => {
      const span = document.createElement("span");
      span.innerHTML = '<i style="background:' + color + '"></i>' + label;
      legend.appendChild(span);
    });
    const dotNote = document.createElement("span");
    dotNote.innerHTML = '<i style="background:transparent;border:1px solid var(--line-strong)"></i>solid dot = recorded · italic = predicted';
    legend.appendChild(dotNote);
    if (!task){
      const note = document.createElement("span");
      note.textContent = "Create a task to begin tracking.";
      legend.appendChild(note);
    }
  }

  /* ---------- Day detail sheet ---------- */
  function openDayDetail(iso){
    const task = TaskManager.byId(state.taskId);
    if (!task){ toast("Create a task first"); return; }
    const dateObj = DateUtil.fromISO(iso);
    const flags = DateUtil.weekendFlags(dateObj);
    const holiday = HolidayManager.isHoliday(dateObj);
    const isWorking = !flags.isSunday && !flags.isSecondSat && !flags.isFourthSat && !holiday;

    const viewEnd = DateUtil.addDays(new Date(), 120);
    const horizonEnd = DateUtil.fromISO(iso) > viewEnd ? DateUtil.fromISO(iso) : viewEnd;
    const schedule = Scheduler.computeSchedule(task, DateUtil.toISO(horizonEnd));
    const entry = schedule.get(iso);
    const rec = RecordStore.find(task.id, iso);

    const dateLabel = dateObj.toLocaleDateString(undefined, { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const statusLabel = !isWorking ? (flags.isSunday ? "Sunday (off)" : (holiday ? "Holiday — " + (holiday.description || "") : "Weekend Saturday (off)")) : "Working day";

    let bodyHTML = '<div class="sheet-head"><h2>' + escapeHTML(dateLabel) + '</h2><button class="sheet-close" id="closeDay">✕</button></div><div class="sheet-body">';
    bodyHTML += '<div class="detail-grid">';
    bodyHTML += detailItem("Task", task.name);
    bodyHTML += detailItem("Status", statusLabel);
    if (isWorking && entry){
      const emp = EmployeeManager.byId(entry.employeeId);
      bodyHTML += detailItem("Assigned to", emp ? emp.name : "—");
      bodyHTML += detailItem("Block", "#" + entry.blockIndex + " · day " + entry.blockPosition + " of " + entry.blockSize);
      bodyHTML += detailItem("Sequence", '<span class="seq-swatch" data-kind="seq' + entry.colorSlot + '" style="background:var(--seq-' + entry.colorSlot + ')"></span>#' + entry.sequenceIndex);
      bodyHTML += detailItem("Entry type", entry.isManual ? "Recorded" : "Predicted");
    }
    bodyHTML += "</div>";

    if (isWorking){
      bodyHTML += '<div class="field"><label>Who performed this task</label><div class="emp-pick-grid" id="empPickGrid"></div></div>';
      bodyHTML += '<div class="field"><label>Notes</label><textarea id="dayNotes" placeholder="Optional note…">' + escapeHTML(rec ? rec.notes || "" : "") + '</textarea></div>';
      bodyHTML += '<div class="btn-row"><button class="btn btn-primary" id="saveDayBtn">Save</button>';
      if (rec) bodyHTML += '<button class="btn btn-ghost" id="clearDayBtn">Clear record</button>';
      bodyHTML += "</div>";
      bodyHTML += '<p class="hint-note">Recording a different employee than expected creates an override — the rotation recalculates automatically from this point forward.</p>';
    } else {
      bodyHTML += '<p class="hint-note">Non-working days are skipped automatically and never break the rotation sequence.</p>';
    }
    bodyHTML += "</div>";

    openSheet(bodyHTML);
    $("#closeDay").addEventListener("click", closeSheet);

    if (isWorking){
      let selected = rec ? rec.employeeId : (entry ? entry.employeeId : null);
      const grid = $("#empPickGrid");
      const roster = task.employeeIds.map(id => EmployeeManager.byId(id)).filter(Boolean);
      if (roster.length === 0){
        grid.innerHTML = '<p class="hint-note">This task has no employees assigned yet. Edit the task to add its roster.</p>';
      }
      roster.forEach(emp => {
        const pick = document.createElement("button");
        pick.className = "emp-pick" + (emp.id === selected ? " selected" : "");
        pick.innerHTML = '<span class="dot" style="background:' + emp.color + '"></span>' + escapeHTML(emp.name);
        pick.addEventListener("click", () => {
          selected = emp.id;
          $$(".emp-pick", grid).forEach(b => b.classList.remove("selected"));
          pick.classList.add("selected");
        });
        grid.appendChild(pick);
      });

      $("#saveDayBtn").addEventListener("click", async () => {
        if (!selected){ toast("Pick who performed the task"); return; }
        const notes = $("#dayNotes").value;
        await RecordStore.set(task.id, iso, selected, notes);
        closeSheet();
        render();
        toast("Saved");
      });
      const clearBtn = $("#clearDayBtn");
      if (clearBtn){
        clearBtn.addEventListener("click", async () => {
          await RecordStore.clear(task.id, iso);
          closeSheet();
          render();
          toast("Record cleared");
        });
      }
    }
  }

  function detailItem(k, v){
    return '<div class="detail-item"><div class="k">' + escapeHTML(k) + '</div><div class="v">' + v + "</div></div>";
  }

  function escapeHTML(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  /* ---------- People view (Employees + Task rosters) ---------- */
  function renderPeopleView(){
    const wrap = $("#mainSections");
    const employees = EmployeeManager.all();
    let html = '<div class="section-card"><h3>Employees</h3><div class="section-body" id="empList"></div>';
    html += '<div class="section-body" style="padding-top:0;"><button class="btn btn-primary" id="addEmpBtn">+ Add employee</button></div></div>';

    const tasks = TaskManager.all();
    html += '<div class="section-card"><h3>Tasks &amp; rosters</h3><div class="section-body" id="taskList"></div>';
    html += '<div class="section-body" style="padding-top:0;"><button class="btn btn-primary" id="addTaskBtn2">+ Add task</button></div></div>';

    wrap.innerHTML = html;

    const empList = $("#empList");
    if (employees.length === 0){
      empList.innerHTML = '<div class="empty-hint"><span class="big">👥</span>No employees yet. Add your branch team to begin.</div>';
    } else {
      employees.forEach(emp => {
        const row = document.createElement("div");
        row.className = "list-row";
        row.innerHTML =
          '<div class="who"><div class="avatar" style="background:' + emp.color + '">' + escapeHTML(emp.name.charAt(0).toUpperCase()) + '</div>' +
          '<div><div class="name">' + escapeHTML(emp.name) + '</div></div></div>' +
          '<div class="row-actions"><button class="mini-btn" data-edit="' + emp.id + '">✎</button><button class="mini-btn danger" data-del="' + emp.id + '">🗑</button></div>';
        empList.appendChild(row);
      });
      empList.addEventListener("click", (e) => {
        const editId = e.target.getAttribute("data-edit");
        const delId = e.target.getAttribute("data-del");
        if (editId) openEmployeeEditor(EmployeeManager.byId(editId));
        if (delId) confirmDeleteEmployee(delId);
      });
    }

    const taskList = $("#taskList");
    if (tasks.length === 0){
      taskList.innerHTML = '<div class="empty-hint"><span class="big">🗂</span>No tasks yet. Add a recurring duty like Vault Inspection.</div>';
    } else {
      tasks.forEach(t => {
        const roster = t.employeeIds.map(id => EmployeeManager.byId(id)).filter(Boolean);
        const row = document.createElement("div");
        row.className = "list-row";
        row.innerHTML =
          '<div class="who"><div><div class="name">' + escapeHTML(t.name) + '</div>' +
          '<div class="meta">' + (roster.length ? roster.map(r=>escapeHTML(r.name)).join(", ") : "No employees assigned") + '</div></div></div>' +
          '<div class="row-actions"><button class="mini-btn" data-edit="' + t.id + '">✎</button><button class="mini-btn danger" data-del="' + t.id + '">🗑</button></div>';
        taskList.appendChild(row);
      });
      taskList.addEventListener("click", (e) => {
        const editId = e.target.getAttribute("data-edit");
        const delId = e.target.getAttribute("data-del");
        if (editId) openTaskEditor(TaskManager.byId(editId));
        if (delId) confirmDeleteTask(delId);
      });
    }

    $("#addEmpBtn").addEventListener("click", () => openEmployeeEditor(null));
    $("#addTaskBtn2").addEventListener("click", () => openTaskEditor(null));
  }

  function openEmployeeEditor(existing){
    const isEdit = !!existing;
    const color = existing ? existing.color : EmployeeManager.nextColor();
    let html = '<div class="sheet-head"><h2>' + (isEdit ? "Edit employee" : "Add employee") + '</h2><button class="sheet-close" id="closeE">✕</button></div>';
    html += '<div class="sheet-body">';
    html += '<div class="field"><label>Name</label><input type="text" id="empName" value="' + (isEdit ? escapeHTML(existing.name) : "") + '" placeholder="e.g. Aditi Rao"></div>';
    html += '<div class="field"><label>Color</label><div class="color-row" id="colorRow"></div></div>';
    html += '<div class="btn-row"><button class="btn btn-primary" id="saveEmpBtn">' + (isEdit ? "Save changes" : "Add employee") + '</button></div>';
    if (isEdit) html += '<div class="btn-row"><button class="btn btn-danger" id="delEmpBtn">Delete employee</button></div>';
    html += "</div>";
    openSheet(html, { center:true });
    $("#closeE").addEventListener("click", closeSheet);

    let selectedColor = color;
    const colorRow = $("#colorRow");
    EmployeeManager.PALETTE.forEach(c => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "color-dot" + (c === selectedColor ? " selected" : "");
      dot.style.background = c;
      dot.addEventListener("click", () => {
        selectedColor = c;
        $$(".color-dot", colorRow).forEach(d => d.classList.remove("selected"));
        dot.classList.add("selected");
      });
      colorRow.appendChild(dot);
    });

    $("#saveEmpBtn").addEventListener("click", async () => {
      const name = $("#empName").value.trim();
      if (!name){ toast("Enter a name"); return; }
      if (isEdit){
        existing.name = name; existing.color = selectedColor;
        await EmployeeManager.update(existing);
      } else {
        await EmployeeManager.add(name, selectedColor);
      }
      closeSheet(); render(); toast("Saved");
    });
    if (isEdit){
      $("#delEmpBtn").addEventListener("click", () => { closeSheet(); confirmDeleteEmployee(existing.id); });
    }
  }

  function confirmDeleteEmployee(id){
    const emp = EmployeeManager.byId(id);
    let html = '<div class="sheet-head"><h2>Delete employee</h2><button class="sheet-close" id="closeDE">✕</button></div>';
    html += '<div class="sheet-body"><p class="hint-note">Delete ' + escapeHTML(emp ? emp.name : "") + '? They will be removed from any task rosters. Historical records stay intact for reporting.</p>';
    html += '<div class="btn-row"><button class="btn btn-ghost" id="cancelDE">Cancel</button><button class="btn btn-danger" id="confirmDE">Delete</button></div></div>';
    openSheet(html, { center:true });
    $("#closeDE").addEventListener("click", closeSheet);
    $("#cancelDE").addEventListener("click", closeSheet);
    $("#confirmDE").addEventListener("click", async () => {
      await EmployeeManager.remove(id);
      closeSheet(); render(); toast("Employee deleted");
    });
  }

  function openTaskEditor(existing){
    const isEdit = !!existing;
    let html = '<div class="sheet-head"><h2>' + (isEdit ? "Edit task" : "Add task") + '</h2><button class="sheet-close" id="closeT">✕</button></div>';
    html += '<div class="sheet-body">';
    html += '<div class="field"><label>Task name</label><input type="text" id="taskName" value="' + (isEdit ? escapeHTML(existing.name) : "") + '" placeholder="e.g. Vault Inspection"></div>';
    html += '<div class="field"><label>Assigned employees</label><div class="emp-pick-grid" id="taskRosterGrid"></div>';
    if (EmployeeManager.all().length === 0) html += '<p class="hint-note">Add employees first, then assign them to this task.</p>';
    html += '</div>';
    html += '<div class="btn-row"><button class="btn btn-primary" id="saveTaskBtn">' + (isEdit ? "Save changes" : "Add task") + '</button></div>';
    if (isEdit) html += '<div class="btn-row"><button class="btn btn-danger" id="delTaskBtn">Delete task</button></div>';
    html += "</div>";
    openSheet(html, { center:true });
    $("#closeT").addEventListener("click", closeSheet);

    const selectedIds = new Set(isEdit ? existing.employeeIds : []);
    const grid = $("#taskRosterGrid");
    EmployeeManager.all().forEach(emp => {
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "emp-pick" + (selectedIds.has(emp.id) ? " selected" : "");
      pick.innerHTML = '<span class="dot" style="background:' + emp.color + '"></span>' + escapeHTML(emp.name);
      pick.addEventListener("click", () => {
        if (selectedIds.has(emp.id)) selectedIds.delete(emp.id); else selectedIds.add(emp.id);
        pick.classList.toggle("selected");
      });
      grid.appendChild(pick);
    });

    $("#saveTaskBtn").addEventListener("click", async () => {
      const name = $("#taskName").value.trim();
      if (!name){ toast("Enter a task name"); return; }
      const ids = Array.from(selectedIds);
      if (isEdit){
        existing.name = name; existing.employeeIds = ids;
        await TaskManager.update(existing);
      } else {
        const rec = await TaskManager.add(name, ids);
        state.taskId = rec.id;
      }
      closeSheet(); render(); toast("Saved");
    });
    if (isEdit){
      $("#delTaskBtn").addEventListener("click", () => { closeSheet(); confirmDeleteTask(existing.id); });
    }
  }

  function confirmDeleteTask(id){
    const task = TaskManager.byId(id);
    let html = '<div class="sheet-head"><h2>Delete task</h2><button class="sheet-close" id="closeDT">✕</button></div>';
    html += '<div class="sheet-body"><p class="hint-note">Delete "' + escapeHTML(task ? task.name : "") + '" and all of its recorded history? This cannot be undone.</p>';
    html += '<div class="btn-row"><button class="btn btn-ghost" id="cancelDT">Cancel</button><button class="btn btn-danger" id="confirmDT">Delete</button></div></div>';
    openSheet(html, { center:true });
    $("#closeDT").addEventListener("click", closeSheet);
    $("#cancelDT").addEventListener("click", closeSheet);
    $("#confirmDT").addEventListener("click", async () => {
      await TaskManager.remove(id);
      if (state.taskId === id) state.taskId = null;
      closeSheet(); render(); toast("Task deleted");
    });
  }

  /* ---------- Reports view ---------- */
  function renderReportsView(){
    const wrap = $("#mainSections");
    const tasks = TaskManager.all();
    if (tasks.length === 0){
      wrap.innerHTML = '<div class="section-card"><div class="empty-hint"><span class="big">📊</span>Add a task to see reports here.</div></div>';
      return;
    }
    const task = TaskManager.byId(state.taskId) || tasks[0];
    state.taskId = task.id;

    const now = new Date();
    const monthStart = DateUtil.toISO(new Date(state.year, state.month, 1));
    const monthEnd = DateUtil.toISO(new Date(state.year, state.month + 1, 0));
    const yearStart = DateUtil.toISO(new Date(state.year, 0, 1));
    const yearEnd = DateUtil.toISO(new Date(state.year, 11, 31));

    const monthCounts = Reports.employeeCounts(task, monthStart, monthEnd);
    const yearCounts = Reports.employeeCounts(task, yearStart, yearEnd);
    const workingDaysMonth = Reports.workingDaysInRange(monthStart, monthEnd);
    const holidaysMonth = Reports.holidaysInRange(monthStart, monthEnd);
    const missedMonth = Reports.missedAssignments(task, monthStart, DateUtil.toISO(now) < monthEnd ? DateUtil.toISO(now) : monthEnd);
    const blocks = Reports.blockHistory(task, monthEnd).slice(-12).reverse();

    let html = '<div class="section-card"><h3>Reports — ' + escapeHTML(task.name) + '</h3><div class="section-body">';
    html += '<div class="stat-strip">';
    html += statBox(workingDaysMonth, "Working days");
    html += statBox(holidaysMonth, "Holidays");
    html += statBox(missedMonth, "Unrecorded");
    html += "</div>";

    html += '<div class="field"><label>Task</label><select id="reportTaskSelect">' +
      tasks.map(t => '<option value="' + t.id + '"' + (t.id === task.id ? " selected" : "") + '>' + escapeHTML(t.name) + '</option>').join("") +
      '</select></div>';

    html += "<h4 style=\"margin:4px 0 8px 0;\">" + DateUtil.monthLabel(state.year, state.month) + " " + state.year + " — by employee</h4>";
    html += '<table class="report-tbl"><thead><tr><th>Employee</th><th>Recorded</th><th>Predicted</th></tr></thead><tbody>';
    for (const [empId, c] of monthCounts){
      const emp = EmployeeManager.byId(empId);
      html += "<tr><td>" + escapeHTML(emp ? emp.name : "—") + "</td><td>" + c.manual + "</td><td>" + c.predicted + "</td></tr>";
    }
    html += "</tbody></table>";

    html += "<h4 style=\"margin:4px 0 8px 0;\">" + state.year + " — by employee (year to date)</h4>";
    html += '<table class="report-tbl"><thead><tr><th>Employee</th><th>Recorded</th><th>Predicted</th></tr></thead><tbody>';
    for (const [empId, c] of yearCounts){
      const emp = EmployeeManager.byId(empId);
      html += "<tr><td>" + escapeHTML(emp ? emp.name : "—") + "</td><td>" + c.manual + "</td><td>" + c.predicted + "</td></tr>";
    }
    html += "</tbody></table>";

    html += '<h4 style="margin:4px 0 8px 0;">Recent block &amp; sequence history</h4>';
    if (blocks.length === 0){
      html += '<p class="hint-note">No history yet — record a day on the calendar to get started.</p>';
    } else {
      html += '<table class="report-tbl"><thead><tr><th>Block</th><th>Employee</th><th>Size</th><th>Sequence</th><th>Dates</th></tr></thead><tbody>';
      blocks.forEach(b => {
        const emp = EmployeeManager.byId(b.employeeId);
        html += "<tr><td>#" + b.blockIndex + "</td><td>" + escapeHTML(emp ? emp.name : "—") + "</td><td>" + b.size + "</td><td>#" + b.sequenceIndex + "</td><td>" + b.start + (b.start !== b.end ? " → " + b.end : "") + "</td></tr>";
      });
      html += "</tbody></table>";
    }

    html += '<div class="btn-row"><button class="btn btn-secondary" id="exportMonthCsv">Export month CSV</button><button class="btn btn-secondary" id="exportYearCsv">Export year CSV</button></div>';
    html += "</div></div>";

    wrap.innerHTML = html;

    $("#reportTaskSelect").addEventListener("change", (e) => { state.taskId = e.target.value; renderReportsView(); });
    $("#exportMonthCsv").addEventListener("click", () => {
      const rows = [["Date","Task","Employee","Type","Block","Sequence","Notes"]];
      const schedule = Scheduler.computeSchedule(task, monthEnd);
      for (const [iso, entry] of schedule){
        if (iso < monthStart || iso > monthEnd) continue;
        const emp = EmployeeManager.byId(entry.employeeId);
        rows.push([iso, task.name, emp ? emp.name : "", entry.isManual ? "Recorded" : "Predicted", entry.blockIndex, entry.sequenceIndex, entry.notes || ""]);
      }
      Reports.downloadCSV(task.name + "-" + monthStart.slice(0,7) + ".csv", rows);
    });
    $("#exportYearCsv").addEventListener("click", () => {
      const rows = [["Date","Task","Employee","Type","Block","Sequence","Notes"]];
      const schedule = Scheduler.computeSchedule(task, yearEnd);
      for (const [iso, entry] of schedule){
        if (iso < yearStart || iso > yearEnd) continue;
        const emp = EmployeeManager.byId(entry.employeeId);
        rows.push([iso, task.name, emp ? emp.name : "", entry.isManual ? "Recorded" : "Predicted", entry.blockIndex, entry.sequenceIndex, entry.notes || ""]);
      }
      Reports.downloadCSV(task.name + "-" + state.year + ".csv", rows);
    });
  }

  function statBox(num, label){
    return '<div class="stat-box"><div class="num">' + num + '</div><div class="lbl">' + escapeHTML(label) + '</div></div>';
  }

  /* ---------- More view: Holidays + Backup + Appearance ---------- */
  function renderMoreView(){
    const wrap = $("#mainSections");
    const holidays = HolidayManager.all();
    let html = '<div class="section-card"><h3>Holidays</h3><div class="section-body" id="holList"></div>';
    html += '<div class="section-body" style="padding-top:0;"><button class="btn btn-primary" id="addHolBtn">+ Add holiday</button></div></div>';

    html += '<div class="section-card"><h3>Appearance</h3><div class="section-body">';
    html += '<div class="settings-row"><span>Dark mode</span><div class="switch' + (state.theme === "dark" ? " on" : "") + '" id="themeSwitch"></div></div>';
    html += "</div></div>";

    html += '<div class="section-card"><h3>Backup</h3><div class="section-body">';
    html += '<div class="btn-row"><button class="btn btn-secondary" id="exportJsonBtn">Export backup (JSON)</button></div>';
    html += '<div class="btn-row"><button class="btn btn-secondary" id="importJsonBtn">Import backup</button><input type="file" id="importJsonFile" accept="application/json" style="display:none;"></div>';
    html += '<div class="btn-row"><button class="btn btn-danger" id="resetAllBtn">Reset all data</button></div>';
    html += '</div></div>';

    html += '<div class="section-card"><h3>Install on iPhone</h3><div class="section-body"><p class="hint-note">Open this page in Safari, tap the Share icon, then "Add to Home Screen". Once installed, the app runs fully offline — no signal or Wi-Fi required.</p></div></div>';

    wrap.innerHTML = html;

    const holList = $("#holList");
    if (holidays.length === 0){
      holList.innerHTML = '<div class="empty-hint"><span class="big">🏳</span>No holidays added yet.</div>';
    } else {
      holidays.forEach(h => {
        const row = document.createElement("div");
        row.className = "list-row";
        const label = h.recurring ? (DateUtil.fromISO("2001-" + h.date.slice(5)).toLocaleDateString(undefined,{month:"short", day:"numeric"}) + " (yearly)") : DateUtil.fromISO(h.date).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});
        row.innerHTML = '<div class="who"><div><div class="name">' + escapeHTML(h.description || "Holiday") + '</div><div class="meta">' + label + '</div></div></div>' +
          '<div class="row-actions"><button class="mini-btn" data-edit="' + h.id + '">✎</button><button class="mini-btn danger" data-del="' + h.id + '">🗑</button></div>';
        holList.appendChild(row);
      });
      holList.addEventListener("click", (e) => {
        const editId = e.target.getAttribute("data-edit");
        const delId = e.target.getAttribute("data-del");
        if (editId) openHolidayEditor(HolidayManager.all().find(h => h.id === editId));
        if (delId) confirmDeleteHoliday(delId);
      });
    }

    $("#addHolBtn").addEventListener("click", () => openHolidayEditor(null));
    $("#themeSwitch").addEventListener("click", async () => {
      await applyTheme(state.theme === "dark" ? "light" : "dark");
      renderMoreView();
      renderCalendar();
    });
    $("#exportJsonBtn").addEventListener("click", async () => {
      const data = await Storage.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type:"application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "rotation-backup-" + DateUtil.toISO(new Date()) + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Backup exported");
    });
    $("#importJsonBtn").addEventListener("click", () => $("#importJsonFile").click());
    $("#importJsonFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        await Storage.importAll(payload);
        await loadAll();
        state.taskId = TaskManager.all()[0] ? TaskManager.all()[0].id : null;
        render();
        toast("Backup imported");
      } catch (err){
        toast("Import failed — invalid file");
      }
      e.target.value = "";
    });
    $("#resetAllBtn").addEventListener("click", () => {
      let html2 = '<div class="sheet-head"><h2>Reset all data</h2><button class="sheet-close" id="closeRA">✕</button></div>';
      html2 += '<div class="sheet-body"><p class="hint-note">This permanently deletes every employee, task, holiday and recorded history on this device. Consider exporting a backup first. This cannot be undone.</p>';
      html2 += '<div class="btn-row"><button class="btn btn-ghost" id="cancelRA">Cancel</button><button class="btn btn-danger" id="confirmRA">Erase everything</button></div></div>';
      openSheet(html2, { center:true });
      $("#closeRA").addEventListener("click", closeSheet);
      $("#cancelRA").addEventListener("click", closeSheet);
      $("#confirmRA").addEventListener("click", async () => {
        await Storage.clearAll();
        await loadAll();
        state.taskId = null;
        closeSheet(); render(); toast("All data cleared");
      });
    });
  }

  function openHolidayEditor(existing){
    const isEdit = !!existing;
    let html = '<div class="sheet-head"><h2>' + (isEdit ? "Edit holiday" : "Add holiday") + '</h2><button class="sheet-close" id="closeH">✕</button></div>';
    html += '<div class="sheet-body">';
    html += '<div class="field"><label>Date</label><input type="date" id="holDate" value="' + (isEdit ? existing.date : DateUtil.toISO(new Date())) + '"></div>';
    html += '<div class="check-row"><input type="checkbox" id="holRecurring" ' + (isEdit && existing.recurring ? "checked" : "") + '><label for="holRecurring" style="margin:0; text-transform:none; font-size:14px; font-weight:500; color:var(--text);">Repeats every year on this date</label></div>';
    html += '<div class="field"><label>Description</label><input type="text" id="holDesc" value="' + (isEdit ? escapeHTML(existing.description) : "") + '" placeholder="e.g. Bank Foundation Day"></div>';
    html += '<div class="btn-row"><button class="btn btn-primary" id="saveHolBtn">' + (isEdit ? "Save changes" : "Add holiday") + '</button></div>';
    if (isEdit) html += '<div class="btn-row"><button class="btn btn-danger" id="delHolBtn">Delete holiday</button></div>';
    html += "</div>";
    openSheet(html, { center:true });
    $("#closeH").addEventListener("click", closeSheet);
    $("#saveHolBtn").addEventListener("click", async () => {
      const date = $("#holDate").value;
      if (!date){ toast("Pick a date"); return; }
      const recurring = $("#holRecurring").checked;
      const description = $("#holDesc").value.trim();
      if (isEdit){
        await HolidayManager.update({ id: existing.id, date, recurring, description });
      } else {
        await HolidayManager.add({ date, recurring, description });
      }
      closeSheet(); render(); toast("Saved");
    });
    if (isEdit){
      $("#delHolBtn").addEventListener("click", () => { closeSheet(); confirmDeleteHoliday(existing.id); });
    }
  }

  function confirmDeleteHoliday(id){
    const h = HolidayManager.all().find(x => x.id === id);
    let html = '<div class="sheet-head"><h2>Delete holiday</h2><button class="sheet-close" id="closeDH">✕</button></div>';
    html += '<div class="sheet-body"><p class="hint-note">Delete "' + escapeHTML(h ? (h.description || "Holiday") : "") + '"? Working-day calculations will update immediately.</p>';
    html += '<div class="btn-row"><button class="btn btn-ghost" id="cancelDH">Cancel</button><button class="btn btn-danger" id="confirmDH">Delete</button></div></div>';
    openSheet(html, { center:true });
    $("#closeDH").addEventListener("click", closeSheet);
    $("#cancelDH").addEventListener("click", closeSheet);
    $("#confirmDH").addEventListener("click", async () => {
      await HolidayManager.remove(id);
      closeSheet(); render(); toast("Holiday deleted");
    });
  }

  /* ---------- View router ---------- */
  function renderCalendarView(){
    $("#mainSections").innerHTML = "";
    $$(".cal-wrap, .legend, .month-nav").forEach(el => el.style.display = "");
    renderCalendar();
  }

  function setView(view){
    state.view = view;
    $$(".tab-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-view") === view));
    const showCalendarChrome = view === "calendar";
    $(".month-nav").style.display = showCalendarChrome ? "flex" : "none";
    $(".cal-wrap").style.display = showCalendarChrome ? "block" : "none";
    $("#legend").style.display = showCalendarChrome ? "flex" : "none";

    if (view === "calendar") renderCalendar();
    else if (view === "people") renderPeopleView();
    else if (view === "reports") renderReportsView();
    else if (view === "more") renderMoreView();

    if (view !== "calendar") $("#mainSections").scrollIntoView({ behavior:"instant", block:"start" });
  }

  function render(){
    renderTaskStrip();
    renderMonthNav();
    setView(state.view);
  }

  /* ---------- Wiring ---------- */
  function wireStaticControls(){
    $("#prevMonth").addEventListener("click", () => {
      state.month--; if (state.month < 0){ state.month = 11; state.year--; }
      renderMonthNav(); if (state.view === "calendar") renderCalendar(); else if (state.view === "reports") renderReportsView();
    });
    $("#nextMonth").addEventListener("click", () => {
      state.month++; if (state.month > 11){ state.month = 0; state.year++; }
      renderMonthNav(); if (state.view === "calendar") renderCalendar(); else if (state.view === "reports") renderReportsView();
    });
    $("#btnToday").addEventListener("click", () => {
      const now = new Date();
      state.year = now.getFullYear(); state.month = now.getMonth();
      renderMonthNav(); if (state.view === "calendar") renderCalendar(); else if (state.view === "reports") renderReportsView();
    });
    $("#monthTitleWrap").addEventListener("click", openMonthYearJump);
    $("#btnSettings").addEventListener("click", () => { setView("more"); });
    $$(".tab-btn").forEach(btn => btn.addEventListener("click", () => setView(btn.getAttribute("data-view"))));
  }

  function openMonthYearJump(){
    let html = '<div class="sheet-head"><h2>Jump to month</h2><button class="sheet-close" id="closeJ">✕</button></div>';
    html += '<div class="sheet-body">';
    html += '<div class="field-row"><div class="field"><label>Month</label><select id="jumpMonth">' +
      Array.from({length:12}, (_,i) => '<option value="' + i + '"' + (i === state.month ? " selected" : "") + '>' + DateUtil.monthLabel(2000,i) + '</option>').join("") +
      '</select></div><div class="field"><label>Year</label><input type="number" id="jumpYear" value="' + state.year + '"></div></div>';
    html += '<div class="btn-row"><button class="btn btn-primary" id="jumpGoBtn">Go</button></div>';
    html += "</div>";
    openSheet(html, { center:true });
    $("#closeJ").addEventListener("click", closeSheet);
    $("#jumpGoBtn").addEventListener("click", () => {
      state.month = Number($("#jumpMonth").value);
      state.year = Number($("#jumpYear").value) || state.year;
      closeSheet(); renderMonthNav();
      if (state.view === "calendar") renderCalendar(); else if (state.view === "reports") renderReportsView();
    });
  }

  /* ---------- Boot ---------- */
  async function loadAll(){
    await Promise.all([EmployeeManager.load(), TaskManager.load(), HolidayManager.load(), RecordStore.load()]);
  }

  async function init(){
    const savedTheme = await Storage.getSetting("theme", (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
    await applyTheme(savedTheme);
    await loadAll();
    const tasks = TaskManager.all();
    state.taskId = tasks[0] ? tasks[0].id : null;
    wireStaticControls();
    render();

    if (tasks.length === 0){
      setTimeout(() => toast("Add your team, then create a task to start tracking"), 400);
    }

    if ("serviceWorker" in navigator){
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", UI.init);

/* ============================================================
   GLOBAL SAFETY NET — if any async action fails for a reason we
   didn't anticipate (storage quota, a corrupt record, etc.), the
   button it came from must never just sit there doing nothing.
   This surfaces it as a toast and logs the real error to the
   console, instead of the UI silently hanging.
   ============================================================ */
function showGlobalError(msg){
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show", "error");
  clearTimeout(showGlobalError._h);
  showGlobalError._h = setTimeout(() => t.classList.remove("show", "error"), 6000);
}
function errorDetail(reason){
  if (!reason) return "unknown error";
  const name = reason.name || "";
  const msg = reason.message || String(reason);
  return (name ? name + ": " : "") + msg;
}
window.addEventListener("unhandledrejection", (e) => {
  console.error("Rotation: unhandled error —", e.reason);
  showGlobalError("Save failed — " + errorDetail(e.reason));
});
window.addEventListener("error", (e) => {
  console.error("Rotation: uncaught error —", e.error || e.message);
  showGlobalError("App error — " + errorDetail(e.error) + (e.message ? " " + e.message : ""));
});

})();
